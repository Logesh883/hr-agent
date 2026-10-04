"""Each read tool calls the right endpoint with the user's token, sends contract-shaped
parameters, and returns a trimmed result."""

from collections.abc import AsyncIterator
from datetime import date
from typing import Any

import httpx
import pytest
import respx

from app.hr_client import HrApiClient, SessionUser
from llm.types import ToolCall
from tests.hr_data import (
    BASE_URL,
    LEAVE_ID,
    RAHUL_REF,
    SNEHA,
    SNEHA_ID,
    SNEHA_REF,
    balances,
    page,
    session_user,
)
from tools.base import ToolContext, ToolResult
from tools.hr_read import READ_TOOLS
from tools.registry import ToolRegistry

REGISTRY = ToolRegistry(READ_TOOLS)


@pytest.fixture
async def ctx() -> AsyncIterator[ToolContext]:
    async with httpx.AsyncClient(base_url=BASE_URL) as http:
        user = SessionUser.model_validate(session_user("HR_OPS", "Lakshmi Pillai", None))
        yield ToolContext(hr=HrApiClient(http, "hr-token"), user=user, today=date(2026, 10, 3))


async def run(ctx: ToolContext, name: str, arguments: str) -> ToolResult:
    return await REGISTRY.execute(ToolCall(id="c1", name=name, arguments=arguments), ctx)


def params(route: respx.Route) -> dict[str, str]:
    return dict(route.calls.last.request.url.params)


def test_registry_has_exactly_the_planned_read_tools() -> None:
    assert REGISTRY.names == [
        "search_employee",
        "get_employee",
        "get_leave_balances",
        "preview_leave",
        "list_leave_requests",
        "get_attendance_month",
        "get_onboarding_status",
        "list_employee_documents",
        "get_payroll_readiness",
    ]
    assert all(tool.risk == "read" for tool in READ_TOOLS)


@respx.mock
async def test_search_employee_forwards_the_token_and_returns_ids(ctx: ToolContext) -> None:
    route = respx.get(f"{BASE_URL}/employees").respond(json=page(SNEHA))

    result = await run(ctx, "search_employee", '{"query": "Sneha"}')

    request = route.calls.last.request
    assert request.headers["authorization"] == "Bearer hr-token"
    assert params(route) == {"q": "Sneha", "page": "1", "pageSize": "25"}
    assert result.data == {
        "total": 1,
        "employees": [
            {
                "id": SNEHA_ID,
                "name": "Sneha Patel",
                "employee_code": "EMP006",
                "job_title": "Software Engineer",
                "department": "Engineering",
                "location": "Bangalore",
                "status": "ACTIVE",
            }
        ],
    }


@respx.mock
async def test_get_employee_leaves_out_phone_and_date_of_birth(ctx: ToolContext) -> None:
    respx.get(f"{BASE_URL}/employees/{SNEHA_ID}").respond(json=SNEHA)

    result = await run(ctx, "get_employee", f'{{"employee_id": "{SNEHA_ID}"}}')

    assert result.ok
    assert result.data["manager"]["name"] == "Rahul Sharma"
    assert result.data["joining_date"] == "2023-06-05"
    assert "phone" not in result.data and "date_of_birth" not in result.data


async def test_tools_reject_a_name_where_an_id_is_needed(ctx: ToolContext) -> None:
    result = await run(ctx, "get_employee", '{"employee_id": "Sneha"}')

    assert result.error and "employee_id: Input should be a valid UUID" in result.error


@respx.mock
async def test_get_leave_balances(ctx: ToolContext) -> None:
    route = respx.get(f"{BASE_URL}/employees/{SNEHA_ID}/leave-balances").respond(json=balances(9))

    result = await run(ctx, "get_leave_balances", f'{{"employee_id": "{SNEHA_ID}"}}')

    assert params(route) == {}
    assert result.data["year"] == 2026
    assert result.data["balances"][0] == {
        "type": "ANNUAL",
        "year": 2026,
        "entitled": 18.0,
        "used": 7.0,
        "pending": 2.0,
        "available": 9.0,
    }


@respx.mock
async def test_preview_leave_sends_a_contract_shaped_body(ctx: ToolContext) -> None:
    route = respx.post(f"{BASE_URL}/leave-requests/preview").respond(
        json={
            "workingDays": 20,
            "nonWorkingDays": [{"date": "2027-02-06", "reason": "Weekend"}],
            "balance": balances(9)[0] | {"year": 2027},
            "balanceAfter": -11,
            "problems": [
                {
                    "code": "INSUFFICIENT_BALANCE",
                    "message": "Only 9 annual leave days are available; this needs 20.",
                }
            ],
        }
    )

    result = await run(
        ctx,
        "preview_leave",
        f'{{"employee_id": "{SNEHA_ID}", "leave_type": "ANNUAL", '
        '"start_date": "2027-02-01", "end_date": "2027-02-26"}',
    )

    assert route.calls.last.request.read() == (
        b'{"employeeId":"' + SNEHA_ID.encode() + b'","type":"ANNUAL",'
        b'"startDate":"2027-02-01","endDate":"2027-02-26"}'
    )
    assert result.data["problems"][0]["code"] == "INSUFFICIENT_BALANCE"
    assert result.data["balance_after"] == -11
    assert result.data["note"] == "This is a preview only. Nothing was submitted."


async def test_preview_leave_needs_an_explicit_employee(ctx: ToolContext) -> None:
    result = await run(
        ctx,
        "preview_leave",
        '{"leave_type": "SICK", "start_date": "2026-10-12", "end_date": "2026-10-12"}',
    )

    assert result.error and "employee_id: Field required" in result.error


async def test_preview_leave_rejects_end_before_start_without_calling_the_api(
    ctx: ToolContext,
) -> None:
    result = await run(
        ctx,
        "preview_leave",
        f'{{"employee_id": "{SNEHA_ID}", "leave_type": "SICK", '
        '"start_date": "2026-10-12", "end_date": "2026-10-10"}',
    )

    assert result.error == "end_date must be on or after start_date."


@respx.mock
async def test_list_leave_requests_maps_filters_to_api_params(ctx: ToolContext) -> None:
    item = {
        "id": LEAVE_ID,
        "employee": SNEHA_REF,
        "type": "ANNUAL",
        "startDate": "2026-10-19",
        "endDate": "2026-10-23",
        "days": 5,
        "reason": "Diwali",
        "status": "PENDING",
        "requestedBy": {"id": SNEHA_ID, "name": "Sneha Patel"},
        "decidedBy": None,
        "decidedAt": None,
        "decisionComment": None,
        "createdAt": "2026-10-01T09:00:00.000Z",
        "canDecide": True,
        "canCancel": False,
    }
    route = respx.get(f"{BASE_URL}/leave-requests").respond(json=page(item))

    result = await run(
        ctx,
        "list_leave_requests",
        '{"view": "approvals", "leave_type": "ANNUAL", "from_date": "2026-10-01", '
        '"to_date": "2026-10-31"}',
    )

    assert params(route) == {
        "view": "approvals",
        "type": "ANNUAL",
        "from": "2026-10-01",
        "to": "2026-10-31",
        "page": "1",
        "pageSize": "25",
    }
    assert result.data["requests"][0]["employee"]["name"] == "Sneha Patel"


@respx.mock
async def test_get_attendance_month_caps_anomalies_and_reports_the_total(
    ctx: ToolContext,
) -> None:
    anomaly: dict[str, Any] = {
        "code": "LATE_CHECK_IN",
        "message": "Checked in at 11:05, after 10:30.",
        "date": "2026-09-15",
        "employee": SNEHA_REF,
    }
    route = respx.get(f"{BASE_URL}/attendance/monthly").respond(
        json={
            "month": "2026-09",
            "workingDays": 21,
            "rows": [
                {
                    "employee": SNEHA_REF,
                    "workingDays": 21,
                    "present": 18,
                    "halfDays": 1,
                    "absent": 1,
                    "onLeave": 1,
                    "missing": 0,
                    "anomalies": 30,
                }
            ],
            "anomalies": [anomaly] * 30,
        }
    )

    result = await run(ctx, "get_attendance_month", '{"month": "2026-09"}')

    assert params(route) == {"month": "2026-09"}
    assert result.data["anomalies_total"] == 30
    assert len(result.data["anomalies"]) == 25
    assert result.data["employees"][0]["absent"] == 1


async def test_month_must_be_yyyy_mm(ctx: ToolContext) -> None:
    result = await run(ctx, "get_attendance_month", '{"month": "September"}')

    assert result.error and "month: String should match pattern" in result.error


@respx.mock
async def test_get_onboarding_status_lists_open_tasks_and_missing_info(ctx: ToolContext) -> None:
    task = {
        "id": LEAVE_ID,
        "title": "Submit PAN card",
        "description": None,
        "category": "DOCUMENTS",
        "assignee": "EMPLOYEE",
        "dueDate": "2026-10-10",
        "status": "PENDING",
        "requiredDocumentType": "PAN_CARD",
        "completedAt": None,
        "completedBy": None,
        "notes": None,
        "isOverdue": False,
        "canUpdate": True,
    }
    respx.get(f"{BASE_URL}/employees/{SNEHA_ID}/onboarding").respond(
        json={
            "employee": SNEHA_REF
            | {"jobTitle": "Engineer", "joiningDate": "2026-10-01", "departmentName": None},
            "started": True,
            "tasks": [task, task | {"title": "Sign offer", "status": "DONE"}],
            "progress": {"total": 2, "done": 1, "skipped": 0, "overdue": 0, "percent": 50},
            "missingInfo": [{"code": "NO_PHONE", "message": "No phone number on file."}],
            "canStart": False,
        }
    )

    result = await run(ctx, "get_onboarding_status", f'{{"employee_id": "{SNEHA_ID}"}}')

    assert result.data["missing_info"] == ["No phone number on file."]
    assert [t["title"] for t in result.data["open_tasks"]] == ["Submit PAN card"]


@respx.mock
async def test_list_employee_documents(ctx: ToolContext) -> None:
    respx.get(f"{BASE_URL}/employees/{SNEHA_ID}/documents").respond(
        json=[
            {
                "id": LEAVE_ID,
                "employee": SNEHA_REF,
                "type": "BANK_DETAILS",
                "fileName": "Bank_Details_Sneha_Patel.pdf",
                "mimeType": "application/pdf",
                "sizeBytes": 1024,
                "status": "FLAGGED",
                "uploadedBy": {"id": SNEHA_ID, "name": "Sneha Patel"},
                "uploadedAt": "2026-09-01T10:00:00.000Z",
                "reviewedBy": None,
                "reviewedAt": None,
                "reviewNote": "Account holder name doesn't match.",
                "canReview": True,
            }
        ]
    )

    result = await run(ctx, "list_employee_documents", f'{{"employee_id": "{SNEHA_ID}"}}')

    assert result.data == {
        "documents": [
            {
                "type": "BANK_DETAILS",
                "status": "FLAGGED",
                "file_name": "Bank_Details_Sneha_Patel.pdf",
                "uploaded_at": "2026-09-01",
                "review_note": "Account holder name doesn't match.",
            }
        ]
    }


@respx.mock
async def test_get_payroll_readiness_returns_only_flagged_employees(ctx: ToolContext) -> None:
    row: dict[str, Any] = {
        "employee": SNEHA_REF,
        "department": "Engineering",
        "employmentType": "FULL_TIME",
        "joiningDate": "2023-06-05",
        "newJoiner": False,
        "workingDays": 22,
        "daysWorked": 21,
        "paidLeaveDays": 1,
        "unpaidLeaveDays": 0,
        "unexplainedDays": 0,
        "lopDays": 0,
        "payableDays": 22,
        "flags": [],
    }
    respx.get(f"{BASE_URL}/payroll/preparation").respond(
        json={
            "month": "2026-09",
            "through": "2026-09-30",
            "complete": True,
            "summary": {
                "headcount": 2,
                "newJoiners": 0,
                "exits": 0,
                "employeesWithFlags": 1,
                "lopDays": 1,
            },
            "rows": [
                row,
                row
                | {
                    "employee": RAHUL_REF,
                    "lopDays": 1,
                    "flags": [{"code": "MISSING_PAN", "message": "No verified PAN card."}],
                },
            ],
            "changes": [],
        }
    )

    result = await run(ctx, "get_payroll_readiness", '{"month": "2026-09"}')

    assert result.data["flagged_total"] == 1
    assert result.data["flagged"] == [
        {
            "id": RAHUL_REF["id"],
            "name": "Rahul Sharma",
            "employee_code": "EMP002",
            "lop_days": 1.0,
            "flags": ["No verified PAN card."],
        }
    ]


@respx.mock
async def test_a_response_that_breaks_the_contract_is_not_passed_to_the_model(
    ctx: ToolContext,
) -> None:
    respx.get(f"{BASE_URL}/employees/{SNEHA_ID}").respond(json={"id": SNEHA_ID, "name": "?"})

    result = await run(ctx, "get_employee", f'{{"employee_id": "{SNEHA_ID}"}}')

    assert result.error == "The HR system returned data in an unexpected format."
