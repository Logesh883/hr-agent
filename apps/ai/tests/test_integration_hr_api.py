"""Read tools and the agent loop against the real HR API, on the seeded `hr_test` database.

Skipped unless HR_TEST_API_URL points at a running API. To run it:

    # once: migrate and seed hr_test (the API's e2e suite does the same)
    cd packages/db && DATABASE_URL=postgresql://hr:hr@localhost:5433/hr_test \\
        pnpm exec prisma migrate deploy && DATABASE_URL=… pnpm exec prisma db seed
    # the API on another port, against hr_test
    cd apps/api && pnpm build && DATABASE_URL=postgresql://hr:hr@localhost:5433/hr_test \\
        STORAGE_DIR=../../storage-test API_PORT=4100 node dist/main
    # then
    cd apps/ai && HR_TEST_API_URL=http://localhost:4100 uv run pytest -k integration

This is where contract drift shows up for real: every tool validates the live responses
against the generated models, so a field the API stopped sending fails here.
"""

import os
from collections.abc import AsyncIterator
from datetime import date

import httpx
import pytest

from agent.ask import READ_REGISTRY, answer_question
from app.hr_client import HrApiClient
from llm.fake import FakeLLM
from llm.types import ToolCall
from tests.hr_data import calls, tool_call
from tools.base import ToolContext, ToolResult

API_URL = os.environ.get("HR_TEST_API_URL", "")
PASSWORD = os.environ.get("HR_TEST_PASSWORD", "Password123!")  # the seed's demo password

pytestmark = pytest.mark.skipif(not API_URL, reason="set HR_TEST_API_URL to run against the API")


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(base_url=API_URL, timeout=15) as client:
        yield client


async def sign_in(http: httpx.AsyncClient, email: str) -> ToolContext:
    login = await HrApiClient(http).login(email, PASSWORD)
    return ToolContext(
        hr=HrApiClient(http, login.access_token), user=login.user, today=date.today()
    )


async def run(ctx: ToolContext, name: str, arguments: str) -> ToolResult:
    return await READ_REGISTRY.execute(ToolCall(id="c", name=name, arguments=arguments), ctx)


async def find(ctx: ToolContext, name: str) -> str:
    result = await run(ctx, "search_employee", f'{{"query": "{name}"}}')
    assert result.ok, result.error
    (match,) = result.data["employees"]
    return match["id"]


async def test_every_read_tool_works_as_hr(http: httpx.AsyncClient) -> None:
    hr = await sign_in(http, "hr@hr.local")
    sneha = await find(hr, "Sneha Patel")
    month = hr.today.strftime("%Y-%m")
    next_year = hr.today.year + 1
    employee = f'{{"employee_id": "{sneha}"}}'

    results = {
        "get_employee": await run(hr, "get_employee", employee),
        "get_leave_balances": await run(hr, "get_leave_balances", employee),
        "preview_leave": await run(
            hr,
            "preview_leave",
            f'{{"employee_id": "{sneha}", "leave_type": "ANNUAL", '
            f'"start_date": "{next_year}-02-01", "end_date": "{next_year}-02-26"}}',
        ),
        "list_leave_requests": await run(hr, "list_leave_requests", employee),
        "get_attendance_month": await run(hr, "get_attendance_month", f'{{"month": "{month}"}}'),
        "get_onboarding_status": await run(hr, "get_onboarding_status", employee),
        "list_employee_documents": await run(hr, "list_employee_documents", employee),
        "get_payroll_readiness": await run(hr, "get_payroll_readiness", f'{{"month": "{month}"}}'),
    }

    failed = {name: r.error for name, r in results.items() if not r.ok}
    assert not failed
    assert results["get_employee"].data["manager"]["name"] == "Rahul Sharma"
    # 20 working days of annual leave is more than anyone is entitled to: the preview says why.
    problems = results["preview_leave"].data["problems"]
    assert "INSUFFICIENT_BALANCE" in {p["code"] for p in problems}


async def test_manager_sees_their_report(http: httpx.AsyncClient) -> None:
    manager = await sign_in(http, "manager@hr.local")
    sneha = await find(manager, "Sneha Patel")

    result = await run(manager, "get_leave_balances", f'{{"employee_id": "{sneha}"}}')

    assert result.ok, result.error


async def test_employee_is_limited_to_their_own_records(http: httpx.AsyncClient) -> None:
    hr = await sign_in(http, "hr@hr.local")
    arun = await find(hr, "Arun Kumar")
    sneha = await sign_in(http, "employee@hr.local")
    month = sneha.today.strftime("%Y-%m")

    search = await run(sneha, "search_employee", '{"query": "Arun"}')
    colleague = await run(sneha, "get_leave_balances", f'{{"employee_id": "{arun}"}}')
    own = await run(sneha, "get_leave_balances", f'{{"employee_id": "{sneha.user.employee_id}"}}')
    payroll = await run(sneha, "get_payroll_readiness", f'{{"month": "{month}"}}')

    assert search.error == (
        "You don't have access to that. The HR system refused: "
        "Your role (EMPLOYEE) lacks permission: employee:read."
    )
    assert colleague.error == "You don't have access to that employee, or no such employee exists."
    assert own.ok, own.error
    assert payroll.error and "lacks permission: payroll:read" in payroll.error


async def test_agent_loop_against_the_real_api(http: httpx.AsyncClient) -> None:
    manager = await sign_in(http, "manager@hr.local")
    sneha = await find(manager, "Sneha Patel")
    fake = FakeLLM(
        [
            calls(tool_call("search_employee", '{"query": "Sneha"}')),
            calls(tool_call("get_leave_balances", f'{{"employee_id": "{sneha}"}}', "call_2")),
            "Here is Sneha's balance.",
        ]
    )

    run_ = await answer_question(fake, manager, "How many annual leave days does Sneha have?")

    assert [c.ok for s in run_.steps for c in s.tool_calls] == [True, True]
    balances = run_.steps[1].tool_calls[0].data["balances"]
    assert {b["type"] for b in balances} == {"ANNUAL", "SICK", "CASUAL", "UNPAID"}
