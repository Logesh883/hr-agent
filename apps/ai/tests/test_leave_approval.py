from collections.abc import AsyncIterator
from datetime import date
from typing import Any

import httpx
import pytest
import respx

from app.hr_client import HrApiClient
from intent.leave_approval import choose_leave_to_approve, describe
from intent.schema import Entities, Intent, ModelParse, ParsedRequest

BASE_URL = "http://hr.test"
LEAVE_URL = f"{BASE_URL}/leave-requests"
EMPLOYEES_URL = f"{BASE_URL}/employees"


def employee(first: str, last: str, n: int) -> dict[str, Any]:
    return {
        "id": f"emp-{n}",
        "employeeCode": f"EMP{n:03}",
        "firstName": first,
        "lastName": last,
        "jobTitle": "Software Engineer",
        "location": "Bangalore",
        "status": "ACTIVE",
        "email": f"{first.lower()}@hr.local",
    }


SNEHA = employee("Sneha", "Patel", 6)
NEHA = employee("Neha", "Joshi", 11)


def leave(
    n: int, who: dict[str, Any], kind: str, start: str, end: str, days: float
) -> dict[str, Any]:
    return {
        "id": f"leave-{n}",
        "employee": {k: who[k] for k in ("id", "employeeCode", "firstName", "lastName")},
        "type": kind,
        "startDate": start,
        "endDate": end,
        "days": days,
        "status": "PENDING",
        "canDecide": True,
        "reason": None,
    }


DIWALI = leave(1, SNEHA, "ANNUAL", "2026-10-19", "2026-10-23", 5)
ERRAND = leave(2, SNEHA, "CASUAL", "2026-10-05", "2026-10-06", 2)


def page(*items: dict[str, Any]) -> dict[str, Any]:
    return {"items": list(items), "total": len(items), "page": 1, "pageSize": 100}


def approve(*people: str, **entities: Any) -> ParsedRequest:
    parse = ModelParse(
        intent=Intent.APPROVE_LEAVE,
        entities=Entities(people=list(people), **entities),
        confidence=0.95,
    )
    return ParsedRequest.from_model(parse)


@pytest.fixture
async def hr() -> AsyncIterator[HrApiClient]:
    async with httpx.AsyncClient(base_url=BASE_URL) as http:
        yield HrApiClient(http, token="manager-token")


@respx.mock
async def test_one_pending_request_is_selected(hr: HrApiClient) -> None:
    respx.get(EMPLOYEES_URL).respond(json=page(SNEHA))
    route = respx.get(LEAVE_URL).respond(json=page(DIWALI))

    choice = await choose_leave_to_approve(hr, approve("Sneha"))

    assert choice.outcome == "selected"
    assert choice.request is not None and choice.request.id == "leave-1"
    assert choice.message == "Found Sneha Patel's Annual leave, 19-23 Oct 2026 (5 days)."
    params = route.calls.last.request.url.params
    assert params["view"] == "approvals"
    assert params["employeeId"] == "emp-6"
    assert "from" not in params and "type" not in params


@respx.mock
async def test_several_pending_and_no_dates_asks_which_one(hr: HrApiClient) -> None:
    respx.get(EMPLOYEES_URL).respond(json=page(SNEHA))
    respx.get(LEAVE_URL).respond(json=page(ERRAND, DIWALI))

    choice = await choose_leave_to_approve(hr, approve("Sneha"))

    assert choice.outcome == "choose"
    assert choice.request is None
    assert [c.id for c in choice.candidates] == ["leave-2", "leave-1"]
    assert choice.message == (
        "Sneha Patel has 2 leave requests pending:\n"
        "1. Casual leave, 5-6 Oct 2026 (2 days)\n"
        "2. Annual leave, 19-23 Oct 2026 (5 days)\n"
        "Which one should I approve?"
    )


@respx.mock
async def test_dates_in_the_request_narrow_it_to_one(hr: HrApiClient) -> None:
    respx.get(EMPLOYEES_URL).respond(json=page(SNEHA))
    route = respx.get(LEAVE_URL).respond(json=page(ERRAND))

    choice = await choose_leave_to_approve(
        hr, approve("Sneha", start_date=date(2026, 10, 5), leave_type="CASUAL")
    )

    assert choice.outcome == "selected"
    assert choice.request is not None and choice.request.id == "leave-2"
    params = route.calls.last.request.url.params
    assert (params["from"], params["to"], params["type"]) == ("2026-10-05", "2026-10-05", "CASUAL")


@respx.mock
async def test_details_that_match_nothing_show_what_is_pending(hr: HrApiClient) -> None:
    respx.get(EMPLOYEES_URL).respond(json=page(SNEHA))
    respx.get(LEAVE_URL, params={"from": "2026-12-01"}).respond(json=page())
    respx.get(LEAVE_URL).respond(json=page(DIWALI))

    choice = await choose_leave_to_approve(
        hr, approve("Sneha", start_date=date(2026, 12, 1), end_date=date(2026, 12, 2))
    )

    assert choice.outcome == "choose"
    assert choice.message.startswith("No pending request matches 1-2 Dec 2026. ")
    assert "Sneha Patel has 1 leave request pending:\n1. Annual leave, 19-23 Oct 2026" in (
        choice.message
    )


@respx.mock
async def test_nothing_pending(hr: HrApiClient) -> None:
    respx.get(EMPLOYEES_URL).respond(json=page(SNEHA))
    respx.get(LEAVE_URL).respond(json=page())

    choice = await choose_leave_to_approve(hr, approve("Sneha"))

    assert choice.outcome == "none"
    assert choice.message == "Sneha Patel has no pending leave requests that you can approve."


@respx.mock
async def test_nobody_named_lists_all_pending_approvals(hr: HrApiClient) -> None:
    route = respx.get(LEAVE_URL).respond(json=page(DIWALI))

    choice = await choose_leave_to_approve(hr, approve())

    assert choice.outcome == "choose"  # even one: the user never said whose
    assert choice.message == (
        "You have 1 leave request to approve:\n"
        "1. Sneha Patel: Annual leave, 19-23 Oct 2026 (5 days)\n"
        "Which one should I approve?"
    )
    assert "employeeId" not in route.calls.last.request.url.params


@respx.mock
async def test_unknown_person(hr: HrApiClient) -> None:
    respx.get(EMPLOYEES_URL).respond(json=page())

    choice = await choose_leave_to_approve(hr, approve("Zara"))

    assert choice.outcome == "person_not_found"
    assert "Zara" in choice.message


@respx.mock
async def test_exact_name_beats_substring_match(hr: HrApiClient) -> None:
    # The API's search is a substring match: "Neha" also finds "Sneha".
    respx.get(EMPLOYEES_URL).respond(json=page(SNEHA, NEHA))
    route = respx.get(LEAVE_URL).respond(json=page())

    await choose_leave_to_approve(hr, approve("Neha"))

    assert route.calls.last.request.url.params["employeeId"] == "emp-11"


@respx.mock
async def test_two_people_with_the_same_name_asks_which(hr: HrApiClient) -> None:
    other_rahul = employee("Rahul", "Verma", 40)
    respx.get(EMPLOYEES_URL).respond(json=page(employee("Rahul", "Sharma", 2), other_rahul))

    choice = await choose_leave_to_approve(hr, approve("Rahul"))

    assert choice.outcome == "person_ambiguous"
    assert [p.employee_code for p in choice.people] == ["EMP002", "EMP040"]
    assert "1. Rahul Sharma (EMP002" in choice.message
    assert choice.message.endswith("Which one?")


async def test_several_people_are_taken_one_at_a_time(hr: HrApiClient) -> None:
    choice = await choose_leave_to_approve(hr, approve("Sneha", "Arun"))

    assert choice.outcome == "one_at_a_time"
    assert "Sneha or Arun" in choice.message


@pytest.mark.parametrize(
    ("start", "end", "days", "text"),
    [
        ("2026-10-09", "2026-10-09", 1, "Casual leave, 9 Oct 2026 (1 day)"),
        ("2026-10-30", "2026-11-02", 2, "Casual leave, 30 Oct - 2 Nov 2026 (2 days)"),
        ("2026-12-31", "2027-01-01", 1.5, "Casual leave, 31 Dec 2026 - 1 Jan 2027 (1.5 days)"),
    ],
)
def test_describe(start: str, end: str, days: float, text: str) -> None:
    from app.hr_client import LeaveRequest

    request = LeaveRequest.model_validate(leave(9, SNEHA, "CASUAL", start, end, days))

    assert describe(request) == text
