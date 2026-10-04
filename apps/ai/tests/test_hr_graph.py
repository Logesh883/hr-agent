"""The HR agent graph end to end: FakeLLM scripts the model, respx mocks the HR API, and an
in-memory checkpointer holds the thread between start and resume."""

import json
from collections.abc import AsyncIterator
from datetime import date
from typing import Any

import httpx
import pytest
import respx
from langgraph.checkpoint.memory import InMemorySaver

from app.hr_client import HrApiClient, SessionUser
from graphs.hr_agent import HrContext, build_hr_graph
from graphs.runner import HrGraph, RunOutcome, resume_run, start_run
from llm.fake import FakeLLM
from tests.hr_data import (
    ARUN,
    ARUN_ID,
    BASE_URL,
    RAHUL_ID,
    SNEHA,
    SNEHA_ID,
    balances,
    employee,
    page,
    ref,
    session_user,
)
from tools.base import ToolContext
from tracing.trace import Trace


def parse(
    intent: str, confidence: float = 0.95, question: str | None = None, **entities: Any
) -> str:
    return json.dumps(
        {
            "intent": intent,
            "entities": entities,
            "confidence": confidence,
            "clarifying_question": question,
        }
    )


def plan_json(*steps: tuple[str, str, dict[str, Any]], goal: str = "Answer the request") -> str:
    return json.dumps(
        {
            "goal": goal,
            "steps": [
                {"id": i, "tool": t, "arguments": a, "reason": "needed", "risk": "read"}
                for i, t, a in steps
            ],
        }
    )


COMPARE_PLAN = plan_json(
    ("s1", "search_employee", {"query": "Sneha"}),
    ("s2", "search_employee", {"query": "Arun"}),
    ("s3", "get_leave_balances", {"employee_id": "$s1.employees.0.id"}),
    ("s4", "get_leave_balances", {"employee_id": "$s2.employees.0.id"}),
)


class Events:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []

    async def __call__(self, event: dict[str, Any]) -> None:
        self.items.append(event)

    def nodes(self) -> list[str]:
        return [e["node"] for e in self.items if e["event"] == "node_finished"]

    def kinds(self) -> list[str]:
        return [e["event"] for e in self.items]


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        yield client


@pytest.fixture
def graph() -> HrGraph:
    return build_hr_graph(checkpointer=InMemorySaver())


def context(http: httpx.AsyncClient, llm: FakeLLM) -> HrContext:
    user = SessionUser.model_validate(session_user("HR_OPS", "Lakshmi Pillai", None))
    tools = ToolContext(hr=HrApiClient(http, "hr-token"), user=user, today=date(2026, 10, 4))
    return HrContext(llm=llm, tools=tools, trace=Trace(name="agent.run"))


def mock_people() -> None:
    respx.get(f"{BASE_URL}/employees", params={"q": "Sneha"}).respond(json=page(SNEHA))
    respx.get(f"{BASE_URL}/employees", params={"q": "Arun"}).respond(json=page(ARUN))
    respx.get(f"{BASE_URL}/employees/{SNEHA_ID}/leave-balances").respond(json=balances(9))
    respx.get(f"{BASE_URL}/employees/{ARUN_ID}/leave-balances").respond(json=balances(4))


@respx.mock
async def test_a_multi_step_request_is_planned_checked_run_and_answered(
    http: httpx.AsyncClient, graph: HrGraph
) -> None:
    mock_people()
    llm = FakeLLM(
        [
            parse("leave_balance", people=["Sneha", "Arun"], leave_type="ANNUAL"),
            COMPARE_PLAN,
            "Sneha has 9 annual leave days left; Arun has 4.",
        ]
    )
    events = Events()

    outcome = await start_run(
        graph, "t1", "Compare Sneha's and Arun's annual leave", context(http, llm), events
    )

    assert outcome.status == "completed"
    assert outcome.answer == "Sneha has 9 annual leave days left; Arun has 4."
    assert events.nodes() == [
        "understand",
        "retrieve_policy",
        "plan",
        "validate_plan",
        *["execute_step"] * 4,
        "verify",
        "respond",
    ]
    results = outcome.values["results"]
    assert [r["status"] for r in results.values()] == ["done"] * 4
    # References were resolved by code to the ids the searches returned.
    assert results["s4"]["arguments"] == {"employee_id": ARUN_ID}
    assert outcome.values["verification"] == {"ok": True, "problems": [], "findings": []}
    # Tool events stream between the node events.
    assert events.kinds().count("tool_started") == 4
    assert events.items[-1] == {
        "event": "finished",
        "status": "answered",
        "answer": outcome.answer,
    }
    # The respond step saw every result and was told nothing failed.
    respond_prompt = llm.calls[-1].messages[1].content or ""
    assert "s4 get_leave_balances" in respond_prompt and "Steps that failed" not in respond_prompt


@respx.mock
async def test_missing_information_pauses_for_the_user_and_resumes_the_same_thread(
    http: httpx.AsyncClient, graph: HrGraph
) -> None:
    rahul = employee(ref(RAHUL_ID, "Rahul", "Sharma", "EMP002"), jobTitle="Engineering Manager")
    respx.get(f"{BASE_URL}/employees", params={"q": "Rahul"}).respond(json=page(rahul))
    request = "Onboard Priya as a Software Engineer reporting to Rahul"
    llm = FakeLLM(
        [
            parse(
                "onboard_employee", people=["Priya"], job_title="Software Engineer", manager="Rahul"
            ),
            parse(
                "onboard_employee",
                people=["Priya"],
                job_title="Software Engineer",
                manager="Rahul",
                joining_date="2026-10-12",
                location="Bangalore",
            ),
            plan_json(("s1", "search_employee", {"query": "Rahul"})),
            "Rahul Sharma exists and can be Priya's manager; creating her record comes later.",
        ]
    )
    first = Events()

    waiting = await start_run(graph, "t2", request, context(http, llm), first)

    assert waiting.status == "waiting"
    # joining_date is the first required field missing for onboarding.
    assert waiting.question == {"type": "clarification", "question": "When does Priya join?"}
    assert first.nodes() == ["understand"]
    assert first.items[-1]["event"] == "waiting"

    second = Events()
    done = await resume_run(graph, "t2", "12 October, in Bangalore", context(http, llm), second)

    assert done.status == "completed"
    assert done.values["clarifications"] == [
        {"question": "When does Priya join?", "answer": "12 October, in Bangalore"}
    ]
    assert second.nodes()[:2] == ["clarify", "understand"]
    # The second parse saw the original request plus the answer.
    reparse = llm.calls[1].messages[-1].content or ""
    assert request in reparse and "Answer: 12 October, in Bangalore" in reparse


@respx.mock
@pytest.mark.parametrize(
    "answer",
    ["EMP005", "Arun Kumar (EMP005, Senior Software Engineer, Engineering)"],
    ids=["code", "option as offered"],
)
async def test_several_matches_pause_to_ask_which_one(
    http: httpx.AsyncClient, graph: HrGraph, answer: str
) -> None:
    respx.get(f"{BASE_URL}/employees", params={"q": "Kumar"}).respond(json=page(SNEHA, ARUN))
    balance_route = respx.get(f"{BASE_URL}/employees/{ARUN_ID}/leave-balances").respond(
        json=balances(4)
    )
    llm = FakeLLM(
        [
            parse("leave_balance", people=["Kumar", "Sneha"]),
            plan_json(
                ("s1", "search_employee", {"query": "Kumar"}),
                ("s2", "get_leave_balances", {"employee_id": "$s1.employees.0.id"}),
            ),
            "Arun Kumar has 4 days left.",
        ]
    )

    waiting = await start_run(graph, "t3", "Leave for Kumar?", context(http, llm), Events())

    assert waiting.status == "waiting"
    assert waiting.question is not None and waiting.question["type"] == "choice"
    assert waiting.question["options"] == [
        "Sneha Patel (EMP006, Software Engineer, Engineering)",
        "Arun Kumar (EMP005, Senior Software Engineer, Engineering)",
    ]

    done = await resume_run(graph, "t3", answer, context(http, llm), Events())

    assert done.status == "completed"
    assert balance_route.call_count == 1
    assert done.values["choices"] == {"$s1.employees.0.id": 1}
    # The finished search wasn't run again when the step resumed.
    assert respx.calls.call_count == 2


@respx.mock
async def test_an_invalid_plan_goes_back_to_the_planner_with_the_problems(
    http: httpx.AsyncClient, graph: HrGraph
) -> None:
    mock_people()
    llm = FakeLLM(
        [
            parse("leave_balance", people=["Sneha", "Arun"]),
            plan_json(("s1", "delete_employee", {"leave_id": "x"})),
            COMPARE_PLAN,
            "Sneha 9, Arun 4.",
        ]
    )

    outcome = await start_run(graph, "t4", "Sneha vs Arun leave", context(http, llm), Events())

    assert outcome.status == "completed"
    assert outcome.values["plan_attempts"] == 2
    retry_prompt = llm.calls[2].messages[1].content or ""
    assert "s1 (delete_employee): no such tool" in retry_prompt


async def test_a_plan_that_never_passes_is_reported_not_run(
    http: httpx.AsyncClient, graph: HrGraph
) -> None:
    bad = plan_json(("s1", "delete_employee", {}))
    llm = FakeLLM(
        [parse("leave_balance", people=["Sneha", "Arun"]), bad, bad, "I couldn't plan that."]
    )

    outcome = await start_run(graph, "t5", "Sneha vs Arun", context(http, llm), Events())

    assert outcome.values["status"] == "failed"
    assert "results" not in outcome.values or outcome.values["results"] == {}


@respx.mock
async def test_simple_questions_take_the_short_path(
    http: httpx.AsyncClient, graph: HrGraph
) -> None:
    llm = FakeLLM([parse("leave_balance"), "You have 9 annual leave days left."])
    events = Events()

    outcome = await start_run(graph, "t6", "How much leave do I have?", context(http, llm), events)

    assert outcome.answer == "You have 9 annual leave days left."
    assert events.nodes() == ["understand", "answer_simple"]


async def test_out_of_scope_requests_are_declined_without_questions(
    http: httpx.AsyncClient, graph: HrGraph
) -> None:
    llm = FakeLLM([parse("unknown", confidence=0.9)])

    outcome = await start_run(graph, "t7", "Write me a poem", context(http, llm), Events())

    assert outcome.status == "completed"
    assert outcome.answer is not None and outcome.answer.startswith("I can help with HR")


@respx.mock
async def test_a_crashed_run_continues_from_its_last_checkpoint(
    http: httpx.AsyncClient, graph: HrGraph
) -> None:
    mock_people()
    crashing = FakeLLM(
        [
            parse("leave_balance", people=["Sneha", "Arun"]),
            COMPARE_PLAN,
            RuntimeError("server killed mid-run"),
        ]
    )

    with pytest.raises(RuntimeError, match="server killed"):
        await start_run(graph, "t8", "Sneha vs Arun", context(http, crashing), Events())
    lookups = respx.calls.call_count
    assert lookups == 4  # every step ran before respond crashed

    # A new process: new LLM client, new HR client; same thread id.
    events = Events()
    outcome: RunOutcome = await resume_run(
        graph, "t8", None, context(http, FakeLLM(["Sneha 9, Arun 4."])), events
    )

    assert outcome.answer == "Sneha 9, Arun 4."
    assert events.nodes() == ["respond"]
    assert respx.calls.call_count == lookups  # nothing looked up twice


@respx.mock
async def test_an_empty_search_is_a_finding_and_dependent_steps_are_skipped(
    http: httpx.AsyncClient, graph: HrGraph
) -> None:
    respx.get(f"{BASE_URL}/employees", params={"q": "Priya"}).respond(json=page())
    llm = FakeLLM(
        [
            parse("leave_balance", people=["Priya", "Sneha"]),
            plan_json(
                ("s1", "search_employee", {"query": "Priya"}),
                ("s2", "get_leave_balances", {"employee_id": "$s1.employees.0.id"}),
            ),
            "Nobody called Priya has a record.",
        ]
    )

    outcome = await start_run(graph, "t9", "Priya's leave", context(http, llm), Events())

    results = outcome.values["results"]
    assert results["s2"]["status"] == "skipped"
    assert outcome.values["verification"] == {
        "ok": True,
        "problems": [],
        "findings": [
            "s1 (search_employee) found nothing.",
            "s2 (get_leave_balances) skipped: $s1.employees.0.id: step s1 found nothing.",
        ],
    }
    assert "Empty results (findings, not errors)" in (llm.calls[-1].messages[1].content or "")


@pytest.mark.parametrize(
    ("parsed", "asks"),
    [
        (parse("attendance_review", question="Also the policy?"), False),
        (parse("approve_leave", people=["Sneha"], question="Which request?"), True),
        (parse("onboard_employee", people=["Priya"], job_title="Engineer"), True),
        (parse("leave_balance", confidence=0.4), True),
        (parse("leave_balance"), False),
    ],
)
def test_only_needed_questions_are_asked(parsed: str, asks: bool) -> None:
    from graphs.hr_agent import should_ask
    from intent.schema import ModelParse, ParsedRequest

    assert should_ask(ParsedRequest.from_model(ModelParse.model_validate_json(parsed))) is asks
