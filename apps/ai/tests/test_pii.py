"""A8.3: no raw personal data in traces or logs.

Unit cases for each kind of identifier, then the real thing: the whole "Onboard Priya" run
(questions, approval, two writes, read-backs, answer) exported as the OTLP request that
would go to Langfuse, searched for every personal value that passed through it.
"""

import io
import json
import logging
from datetime import date

import httpx
import pytest
import respx
from langgraph.checkpoint.memory import InMemorySaver

from app.hr_client import HrApiClient, SessionUser
from app.log import JsonFormatter
from graphs.hr_agent import HrContext, build_hr_graph
from graphs.runner import resume_run, start_run
from llm.fake import FakeLLM
from tests import test_onboard_priya as priya
from tests.hr_data import session_user
from tests.test_hr_graph import Events
from tests.test_onboard_priya import PARSE, PLAN, REQUEST
from tools.base import ToolContext
from tracing.langfuse import otlp_request
from tracing.masking import Masker
from tracing.trace import Trace

# The Priya scenario's fixtures: its HTTP client and mocked HR API.
http = priya.http
hr_api = priya.hr_api


@pytest.mark.parametrize(
    ("text", "masked"),
    [
        ("Aadhaar 1234 5678 9012 on file", "Aadhaar [aadhaar] on file"),
        ("account 001234567890123 at HDFC0001234", "account [account number] at [ifsc]"),
        ("PAN ABCDE1234F", "PAN [pan]"),
        ("DOB: 1996-03-08, joined 2023-06-05", "DOB: [date of birth], joined 2023-06-05"),
        ("born on 8/3/1996", "born on [date of birth]"),
        ("call +91 98450 11006", "call [phone]"),
        ("key gsk_abcdefghijklmnopqrstuv1234", "key [key]"),
        ("key AIzaSyA1234567890abcdefghijklmnopqrstu", "key [key]"),
        # Kept: ids, dates that aren't birth dates, counts.
        (
            "employee 5c0b1f8e-0000-4000-8000-000000000006",
            "employee 5c0b1f8e-0000-4000-8000-000000000006",
        ),
        ("12 days from 2026-10-12", "12 days from 2026-10-12"),
    ],
)
def test_identifiers_are_masked_by_shape(text: str, masked: str) -> None:
    assert Masker().mask(text) == masked


def test_identifiers_are_masked_by_key_in_any_casing() -> None:
    record = {
        "dateOfBirth": "1996-03-08",
        "bank_account": "x",
        "accountNumber": "y",
        "IFSC": "z",
        "panNumber": "p",
        "apiKey": "k",
        "joiningDate": "2023-06-05",
    }
    assert Masker().mask(record) == {
        "dateOfBirth": "[personal data]",
        "bank_account": "[personal data]",
        "accountNumber": "[personal data]",
        "IFSC": "[personal data]",
        "panNumber": "[personal data]",
        "apiKey": "[redacted]",
        "joiningDate": "2023-06-05",
    }


def test_log_lines_are_masked() -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger = logging.getLogger("hr_ai.test_pii")
    logger.addHandler(handler)
    try:
        logger.warning(
            "lookup for priya.rao@acme.example failed",
            extra={"fields": {"phone": "+91 98450 11006", "note": "Bearer abc.def", "days": 3}},
        )
    finally:
        logger.removeHandler(handler)

    line = json.loads(stream.getvalue())
    assert line["event"] == "lookup for [email] failed"
    assert line["phone"] == "[personal data]"
    assert line["note"] == "Bearer [token]"
    assert line["days"] == 3


async def test_a_whole_run_exports_no_personal_data(
    http: httpx.AsyncClient, hr_api: respx.MockRouter
) -> None:
    trace = Trace(name="agent.run", input={"request": REQUEST}, known_names={"Lakshmi Pillai"})
    user = SessionUser.model_validate(session_user("HR_OPS", "Lakshmi Pillai", None))
    llm = FakeLLM(
        [
            PARSE,
            PLAN,
            "Priya Rao (priya.rao@acme.example) is created, reporting to Rahul Sharma. "
            "Her phone +91 98450 11006 and date of birth 1996-03-08 are still missing.",
        ]
    )

    def context() -> HrContext:
        tools = ToolContext(hr=HrApiClient(http, "hr-token"), user=user, today=date(2026, 10, 4))
        return HrContext(llm=llm, tools=tools, trace=trace)

    graph = build_hr_graph(InMemorySaver())
    await start_run(graph, "pii", REQUEST, context(), Events())
    await resume_run(graph, "pii", "Rao", context(), Events())
    await resume_run(graph, "pii", "priya.rao@acme.example", context(), Events())
    done = await resume_run(graph, "pii", {"decision": "approve"}, context(), Events())
    assert done.status == "completed"
    trace.finish({"answer": done.values["answer"]})

    exported = json.dumps(otlp_request(trace), ensure_ascii=False)

    for value in (
        "priya.rao@acme.example",
        "Priya",
        "Rao",
        "Rahul",
        "Sharma",
        "Lakshmi",
        "Pillai",
        "98450",
        "1996-03-08",
        "hr-token",
    ):
        assert value not in exported, value
    # Masked, not dropped: the trace still shows what happened.
    assert "[person]" in exported and "create_employee" in exported
