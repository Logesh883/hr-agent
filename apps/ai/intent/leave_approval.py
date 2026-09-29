"""Which leave request does "approve X's leave" mean? Decided in code, from real records.

The model only says whose leave (and maybe dates or a type). This looks up that person's
pending requests through the HR API, as the signed-in user, and:

- none pending      → says so
- exactly one       → selects it (the agent still confirms before approving)
- several           → lists them and asks which one
- dates/type given  → uses them to narrow the list; if nothing matches, shows what is pending
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel

from app.hr_client import Employee, HrApiClient, LeaveRequest
from intent.schema import Intent, ParsedRequest

LEAVE_LABELS = {
    "ANNUAL": "Annual leave",
    "SICK": "Sick leave",
    "CASUAL": "Casual leave",
    "UNPAID": "Unpaid leave",
}

Outcome = Literal[
    "selected",  # exactly one request: `request`
    "choose",  # several (or the person wasn't named): `candidates`, and `message` asks which
    "none",  # nothing pending that the user can decide
    "person_not_found",
    "person_ambiguous",  # several employees match the name: `people`
    "one_at_a_time",  # the request named several people
]


class LeaveChoice(BaseModel):
    outcome: Outcome
    # What to tell the user: a question for choose / person_ambiguous / one_at_a_time.
    message: str
    request: LeaveRequest | None = None
    candidates: list[LeaveRequest] = []
    people: list[Employee] = []


async def choose_leave_to_approve(hr: HrApiClient, parsed: ParsedRequest) -> LeaveChoice:
    if parsed.intent is not Intent.APPROVE_LEAVE:
        raise ValueError(f"expected approve_leave, got {parsed.intent}")
    entities = parsed.entities

    if len(entities.people) > 1:
        names = " or ".join(entities.people)
        return LeaveChoice(
            outcome="one_at_a_time",
            message=f"Let's take them one at a time. Whose leave first: {names}?",
        )

    employee: Employee | None = None
    if entities.people:
        name = entities.people[0]
        matches = await find_employees_by_name(hr, name)
        if not matches:
            return LeaveChoice(
                outcome="person_not_found",
                message=f"I couldn't find an employee named {name} that you can see.",
            )
        if len(matches) > 1:
            options = "\n".join(
                f"{i}. {e.full_name} ({e.employee_code}, {e.job_title}, {e.location})"
                for i, e in enumerate(matches, 1)
            )
            return LeaveChoice(
                outcome="person_ambiguous",
                message=f"I found {len(matches)} people named {name}:\n{options}\nWhich one?",
                people=matches,
            )
        employee = matches[0]

    employee_id = employee.id if employee else None
    overlapping = _date_range(entities.start_date, entities.end_date)
    narrowed = entities.leave_type is not None or overlapping is not None
    pending = await hr.pending_leave_to_decide(
        employee_id=employee_id, leave_type=entities.leave_type, overlapping=overlapping
    )

    def summary(requests: list[LeaveRequest]) -> str:
        if employee:
            return f"{employee.full_name} has {_count(requests)} pending"
        return f"You have {_count(requests)} to approve"

    if not pending and narrowed:
        # The details didn't match; show what *is* pending rather than a flat "no".
        everything = await hr.pending_leave_to_decide(employee_id=employee_id)
        if everything:
            return LeaveChoice(
                outcome="choose",
                message=(
                    f"No pending request matches {_criteria(entities.leave_type, overlapping)}. "
                    f"{summary(everything)}:\n{_numbered(everything, employee)}\n"
                    "Which one should I approve?"
                ),
                candidates=everything,
            )

    if not pending:
        if employee:
            message = f"{employee.full_name} has no pending leave requests that you can approve."
        else:
            message = "You have no pending leave requests to approve."
        return LeaveChoice(outcome="none", message=message)

    if len(pending) == 1 and employee:
        return LeaveChoice(
            outcome="selected",
            message=f"Found {employee.full_name}'s {describe(pending[0])}.",
            request=pending[0],
        )

    # Several requests, or nobody named: never pick one ourselves.
    return LeaveChoice(
        outcome="choose",
        message=(
            f"{summary(pending)}:\n{_numbered(pending, employee)}\nWhich one should I approve?"
        ),
        candidates=pending,
    )


async def find_employees_by_name(hr: HrApiClient, name: str) -> list[Employee]:
    """Employees called `name`. The API matches substrings ("Neha" also finds "Sneha"), so
    exact first, last or full name matches win when there are any."""
    found = await hr.search_employees(name)
    wanted = name.strip().casefold()
    exact = [
        e
        for e in found
        if wanted in {e.first_name.casefold(), e.last_name.casefold(), e.full_name.casefold()}
    ]
    return exact or found


def describe(request: LeaveRequest) -> str:
    """e.g. "Annual leave, 19-23 Oct 2026 (5 days)"."""
    label = LEAVE_LABELS.get(request.type, request.type.title())
    days = f"{request.days:g} day{'' if request.days == 1 else 's'}"
    return f"{label}, {_format_range(request.start_date, request.end_date)} ({days})"


def _numbered(requests: list[LeaveRequest], employee: Employee | None) -> str:
    lines: list[str] = []
    for i, request in enumerate(requests, 1):
        who = "" if employee else f"{request.employee.first_name} {request.employee.last_name}: "
        lines.append(f"{i}. {who}{describe(request)}")
    return "\n".join(lines)


def _count(requests: list[LeaveRequest]) -> str:
    return "1 leave request" if len(requests) == 1 else f"{len(requests)} leave requests"


def _date_range(start: date | None, end: date | None) -> tuple[date, date] | None:
    if start is None:
        return None
    return start, end or start


def _criteria(leave_type: str | None, overlapping: tuple[date, date] | None) -> str:
    parts: list[str] = []
    if leave_type:
        parts.append(LEAVE_LABELS.get(leave_type, leave_type).lower())
    if overlapping:
        parts.append(_format_range(*overlapping))
    return " on ".join(parts)


def _format_range(start: date, end: date) -> str:
    if start == end:
        return f"{start.day} {start:%b %Y}"
    if (start.year, start.month) == (end.year, end.month):
        return f"{start.day}-{end.day} {end:%b %Y}"
    if start.year == end.year:
        return f"{start.day} {start:%b} - {end.day} {end:%b %Y}"
    return f"{start.day} {start:%b %Y} - {end.day} {end:%b %Y}"
