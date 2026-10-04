"""A3.5: the same question asked as a manager and as an employee.

The agent holds no permissions of its own. It forwards the user's token, so the HR API's
RBAC and data scope decide what each user gets, and its 403/404 answers reach the model as
plain errors it can relay ("You don't have access to that employee").

The mocked API below answers by token the way the real one does: managers may search
employees and see their direct reports; employees may not search (no employee:read) and
only see their own records (anyone else is a 404, so the API doesn't reveal who exists).
"""

import json
from collections.abc import AsyncIterator, Callable, Iterator
from datetime import date
from typing import cast

import httpx
import pytest
import respx
from respx.models import Call

from agent.ask import answer_question
from app.hr_client import HrApiClient, SessionUser
from llm.fake import FakeLLM
from tests.hr_data import (
    ARUN_ID,
    BASE_URL,
    EMPLOYEE_NOT_FOUND,
    RAHUL_ID,
    SNEHA,
    SNEHA_ID,
    balances,
    calls,
    forbidden,
    page,
    session_user,
    tool_call,
)
from tools.base import ToolContext

MANAGER_TOKEN = "manager-token"  # Rahul Sharma, Sneha's and Arun's manager
EMPLOYEE_TOKEN = "employee-token"  # Sneha Patel
USERS = {
    MANAGER_TOKEN: session_user("MANAGER", "Rahul Sharma", RAHUL_ID),
    EMPLOYEE_TOKEN: session_user("EMPLOYEE", "Sneha Patel", SNEHA_ID),
}
# Whose records each token may read (team scope).
SCOPE = {MANAGER_TOKEN: {RAHUL_ID, SNEHA_ID, ARUN_ID}, EMPLOYEE_TOKEN: {SNEHA_ID}}


def token_of(request: httpx.Request) -> str:
    return request.headers["authorization"].removeprefix("Bearer ")


def search_employees(request: httpx.Request) -> httpx.Response:
    if token_of(request) == EMPLOYEE_TOKEN:
        return httpx.Response(403, json=forbidden("employee:read", "EMPLOYEE"))
    return httpx.Response(200, json=page(SNEHA))


def leave_balances(employee_id: str) -> Callable[[httpx.Request], httpx.Response]:
    def respond(request: httpx.Request) -> httpx.Response:
        if employee_id not in SCOPE[token_of(request)]:
            return httpx.Response(404, json=EMPLOYEE_NOT_FOUND)
        return httpx.Response(200, json=balances(9))

    return respond


@pytest.fixture
def hr_api() -> Iterator[respx.MockRouter]:
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        router.get("/employees").mock(side_effect=search_employees)
        for employee_id in (SNEHA_ID, ARUN_ID):
            router.get(f"/employees/{employee_id}/leave-balances").mock(
                side_effect=leave_balances(employee_id)
            )
        yield router


@pytest.fixture
async def http(hr_api: respx.MockRouter) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        yield client


def context(http: httpx.AsyncClient, token: str) -> ToolContext:
    user = SessionUser.model_validate(USERS[token])
    return ToolContext(hr=HrApiClient(http, token), user=user, today=date(2026, 10, 3))


def last_tool_result(fake: FakeLLM) -> dict[str, object]:
    message = [m for m in fake.calls[-1].messages if m.role == "tool"][-1]
    return json.loads(message.content or "")


SEARCH_SNEHA = calls(tool_call("search_employee", '{"query": "Sneha"}'))


async def test_manager_can_look_up_their_report(http: httpx.AsyncClient) -> None:
    fake = FakeLLM(
        [
            SEARCH_SNEHA,
            calls(tool_call("get_leave_balances", f'{{"employee_id": "{SNEHA_ID}"}}')),
            "Sneha has 9 annual leave days left.",
        ]
    )

    run = await answer_question(fake, context(http, MANAGER_TOKEN), "Sneha's leave balance?")

    assert [c.ok for s in run.steps for c in s.tool_calls] == [True, True]
    assert last_tool_result(fake)["ok"] is True


async def test_employee_cannot_search_the_directory(http: httpx.AsyncClient) -> None:
    fake = FakeLLM([SEARCH_SNEHA, "Your account can't look up other employees."])

    run = await answer_question(fake, context(http, EMPLOYEE_TOKEN), "Arun's leave balance?")

    # A8.1: the directory search isn't even offered to an employee...
    offered = {spec["function"]["name"] for spec in fake.calls[0].tools or []}
    assert "search_employee" not in offered and "get_leave_balances" in offered
    # ...and a call to it anyway is refused before it reaches the HR API.
    assert last_tool_result(fake) == {
        "ok": False,
        "error": "'search_employee' isn't available to your role (EMPLOYEE).",
    }
    assert run.steps[0].tool_calls[0].ok is False


async def test_employee_cannot_see_a_colleagues_balance(http: httpx.AsyncClient) -> None:
    # Even with a valid id (from a link, say), the API scopes the data to the user.
    fake = FakeLLM(
        [calls(tool_call("get_leave_balances", f'{{"employee_id": "{ARUN_ID}"}}')), "No access."]
    )

    await answer_question(fake, context(http, EMPLOYEE_TOKEN), "Arun's leave balance?")

    assert last_tool_result(fake) == {
        "ok": False,
        "error": "You don't have access to that employee, or no such employee exists.",
    }


async def test_employee_can_see_their_own_balance(http: httpx.AsyncClient) -> None:
    fake = FakeLLM(
        [calls(tool_call("get_leave_balances", f'{{"employee_id": "{SNEHA_ID}"}}')), "9 days."]
    )

    await answer_question(fake, context(http, EMPLOYEE_TOKEN), "How much leave do I have?")

    # "my" resolved through the system prompt, which carries the user's own employee id.
    assert SNEHA_ID in (fake.calls[0].messages[0].content or "")
    assert last_tool_result(fake)["ok"] is True


async def test_every_request_carries_the_askers_token(
    http: httpx.AsyncClient, hr_api: respx.MockRouter
) -> None:
    fake = FakeLLM([SEARCH_SNEHA, "Done."])

    await answer_question(fake, context(http, MANAGER_TOKEN), "Find Sneha")

    assert {token_of(c.request) for c in cast(list[Call], hr_api.calls)} == {MANAGER_TOKEN}
