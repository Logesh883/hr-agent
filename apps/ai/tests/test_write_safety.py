"""M6 safety rules in code: the risk policy (A6.3), provenance (A6.5), and how the write
tools call the HR API (A6.2): idempotency keys, run ids, optimistic locking, preview first."""

import json
from collections.abc import AsyncIterator
from datetime import date
from typing import Any, cast

import httpx
import pytest
import respx
from respx.models import Call

from agent.provenance import question_for, unsupported_arguments
from agent.risk import default_policy
from app.hr_client import HrApiClient, SessionUser
from graphs.persistence import MemoryOutbox
from llm.types import ToolCall
from tests.hr_data import ARUN, ARUN_ID, BASE_URL, ENG_ID, RAHUL_ID, SNEHA, SNEHA_ID, session_user
from tools.base import ToolContext, ToolResult
from tools.hr_write import DEPARTMENT_TOOL, WRITE_TOOLS, CreateEmployeeInput
from tools.registry import ToolRegistry

REGISTRY = ToolRegistry([*WRITE_TOOLS, DEPARTMENT_TOOL])


def tool(name: str):
    found = REGISTRY.get(name)
    assert found is not None
    return found


# ---- risk policy -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "arguments", "level", "asks"),
    [
        ("create_employee", {}, "medium", True),
        ("start_onboarding", {}, "low", False),
        ("approve_leave", {}, "high", True),
        ("update_employee", {"job_title": "Lead"}, "low", False),
        # A field can raise the level: changing status is medium even though the tool is low.
        ("update_employee", {"job_title": "Lead", "status": "ACTIVE"}, "medium", True),
        ("search_employee", {}, None, False),
    ],
)
def test_risk_comes_from_the_policy_file(
    name: str, arguments: dict[str, Any], level: str | None, asks: bool
) -> None:
    from agent.ask import READ_REGISTRY

    policy = default_policy()
    found = REGISTRY.get(name) or READ_REGISTRY.get(name)
    assert found is not None

    assert policy.assess(found, arguments) == level
    assert policy.needs_approval(policy.assess(found, arguments)) is asks


def test_medium_approval_is_configurable_and_high_is_not() -> None:
    relaxed = default_policy().model_copy(
        update={"approval": {"low": False, "medium": False, "high": False}}
    )

    assert relaxed.needs_approval("medium") is False
    assert relaxed.needs_approval("high") is True  # high always asks, whatever the file says


# ---- provenance --------------------------------------------------------------------------

USER_TEXT = (
    "Onboard Priya as a Software Engineer joining October 12, reporting to Rahul in Bangalore."
)
PARSED = {
    "intent": "onboard_employee",
    "entities": {"people": ["Priya"], "joining_date": "2026-10-12"},
}


def check(arguments: dict[str, Any]) -> list[str]:
    return unsupported_arguments(
        arguments, CreateEmployeeInput, user_text=USER_TEXT, parsed=PARSED, own_employee_id=None
    )


def test_values_from_the_users_words_the_parse_and_references_are_supported() -> None:
    assert (
        check(
            {
                "first_name": "Priya",
                "job_title": "Software Engineer",
                "location": "Bangalore",
                "joining_date": "2026-10-12",  # the parser worked it out from "October 12"
                "manager_id": "$s2.employees.0.id",
                "department_id": "$s3.departments.0.id",
                "employment_type": "FULL_TIME",  # the tool's documented default
            }
        )
        == []
    )


def test_invented_values_and_question_marks_are_unsupported() -> None:
    assert check({"last_name": "?", "email": "priya@acme.example", "location": "Pune"}) == [
        "last_name",
        "email",
        "location",
    ]
    assert question_for("email", {"first_name": "Priya", "last_name": "?"}, "create_employee") == (
        "What is Priya's work email address? I won't guess it."
    )


# ---- write tools against the HR API -------------------------------------------------------


@pytest.fixture
async def ctx() -> AsyncIterator[ToolContext]:
    async with httpx.AsyncClient(base_url=BASE_URL) as http:
        user = SessionUser.model_validate(session_user("HR_OPS", "Lakshmi Pillai", None))
        yield ToolContext(
            hr=HrApiClient(http, "hr-token", agent_run_id="11111111-2222-4333-8444-555555555555"),
            user=user,
            today=date(2026, 10, 4),
            idempotency_key="run:plan:s4",
            outbox=MemoryOutbox(),
        )


async def run(ctx: ToolContext, name: str, arguments: dict[str, Any]) -> ToolResult:
    return await REGISTRY.execute(ToolCall(id="c", name=name, arguments=json.dumps(arguments)), ctx)


@respx.mock
async def test_create_employee_sends_the_idempotency_key_and_run_id(ctx: ToolContext) -> None:
    created = SNEHA | {"firstName": "Priya", "lastName": "Rao", "id": SNEHA_ID}
    route = respx.post(f"{BASE_URL}/tools/create_employee").respond(json=created)

    result = await run(
        ctx,
        "create_employee",
        {
            "first_name": "Priya",
            "last_name": "Rao",
            "email": "priya.rao@acme.example",
            "job_title": "Software Engineer",
            "department_id": ENG_ID,
            "manager_id": RAHUL_ID,
            "location": "Bangalore",
            "joining_date": "2026-10-12",
        },
    )

    assert result.ok, result.error
    assert result.data["id"] == SNEHA_ID
    request = route.calls.last.request
    assert request.headers["idempotency-key"] == "run:plan:s4"
    assert request.headers["x-agent-run-id"] == "11111111-2222-4333-8444-555555555555"
    body = json.loads(request.content)
    assert body["employmentType"] == "FULL_TIME" and body["managerId"] == RAHUL_ID


@respx.mock
async def test_updates_read_the_version_first_and_write_with_it(ctx: ToolContext) -> None:
    respx.get(f"{BASE_URL}/employees/{SNEHA_ID}").respond(json=SNEHA | {"version": 7})
    patch = respx.post(f"{BASE_URL}/tools/update_employee").respond(json=SNEHA | {"version": 8})

    result = await run(ctx, "update_employee", {"employee_id": SNEHA_ID, "job_title": "Lead"})

    assert result.ok and result.data["version"] == 8
    assert json.loads(patch.calls.last.request.content) == {
        "employeeId": SNEHA_ID,
        "jobTitle": "Lead",
        "version": 7,
    }


@respx.mock
async def test_a_leave_request_that_breaks_the_rules_is_never_sent(ctx: ToolContext) -> None:
    respx.post(f"{BASE_URL}/leave-requests/preview").respond(
        json={
            "workingDays": 20,
            "nonWorkingDays": [],
            "balance": None,
            "balanceAfter": None,
            "problems": [{"code": "INSUFFICIENT_BALANCE", "message": "Only 13 days available"}],
        }
    )
    create = respx.post(f"{BASE_URL}/tools/create_leave_request").respond(json={})

    result = await run(
        ctx,
        "create_leave_request",
        {
            "employee_id": SNEHA_ID,
            "leave_type": "ANNUAL",
            "start_date": "2026-11-02",
            "end_date": "2026-11-27",
        },
    )

    assert not result.ok and "Only 13 days available" in (result.error or "")
    assert not create.called


@respx.mock
async def test_previews_show_before_and_after_without_writing(ctx: ToolContext) -> None:
    respx.get(f"{BASE_URL}/employees/{SNEHA_ID}").respond(json=SNEHA)
    respx.get(f"{BASE_URL}/employees/{ARUN_ID}").respond(json=ARUN)
    change = tool("change_manager")

    assert change.preview is not None
    preview = await change.preview(
        ctx, change.input_model.model_validate({"employee_id": SNEHA_ID, "manager_id": ARUN_ID})
    )

    assert preview["summary"] == "Update Sneha Patel: manager"
    assert preview["before"] == {"manager": "Rahul Sharma"}
    assert preview["after"] == {"manager": "Arun Kumar"}
    assert {call.request.method for call in cast(list[Call], list(respx.calls))} == {"GET"}


async def test_send_email_queues_once_and_never_sends(ctx: ToolContext) -> None:
    arguments = {"to": "priya.rao@acme.example", "subject": "Welcome", "body": "Hello Priya"}

    first = await run(ctx, "send_email", arguments)
    retried = await run(ctx, "send_email", arguments)  # same step, same idempotency key

    assert first.ok and first.data["status"].startswith("queued")
    assert retried.data["outbox_id"] == first.data["outbox_id"]
    assert isinstance(ctx.outbox, MemoryOutbox) and len(ctx.outbox.messages) == 1


@respx.mock
async def test_list_departments_filters_by_name(ctx: ToolContext) -> None:
    respx.get(f"{BASE_URL}/departments").respond(
        json=[
            {
                "id": ENG_ID,
                "name": "Engineering",
                "code": "ENG",
                "status": "ACTIVE",
                "employeeCount": 9,
            },
            {
                "id": RAHUL_ID,
                "name": "Sales",
                "code": "SAL",
                "status": "ACTIVE",
                "employeeCount": 4,
            },
        ]
    )

    result = await run(ctx, "list_departments", {"name": "engineering"})

    assert [d["id"] for d in result.data["departments"]] == [ENG_ID]
