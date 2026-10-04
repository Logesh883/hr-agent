"""A7.1: what must be true after each write, checked by reading it back.

"The API returned 201" says the request was accepted, not that the business state is
right. Each write tool declares post-conditions here; after a successful write the graph
re-reads the record and compares (A7.2). Any mismatch is reported and stops every later
write: the run doesn't build on a state it can't confirm.

Some checks need the state *before* the write (an approval must move the days from pending
to used), so an expectation can take a snapshot first.

A7.4: compensations. Undoing a write automatically is only safe when the undo is itself
harmless and certainly ours. Here that's one case: cancelling a leave request this run
created that's still pending. Everything else (an employee created, a manager changed, an
approval given) is reported for a person to decide, never silently reversed.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from contracts import generated as api
from tools.base import ToolContext

Snapshot = Callable[[ToolContext, dict[str, Any]], Awaitable[Any]]
Check = Callable[[ToolContext, dict[str, Any], dict[str, Any], Any], Awaitable[list[str]]]


@dataclass(frozen=True)
class Expectation:
    check: Check
    before: Snapshot | None = None


def _differences(expected: dict[str, Any], actual: dict[str, Any]) -> list[str]:
    return [
        f"{name} is {actual.get(name)!r}, expected {value!r}"
        for name, value in expected.items()
        if value is not None and str(actual.get(name)) != str(value)
    ]


async def _employee(ctx: ToolContext, employee_id: Any) -> api.Employee:
    return api.Employee.model_validate(await ctx.hr.get(f"/employees/{employee_id}"))


def _fields(e: api.Employee) -> dict[str, Any]:
    return {
        "first_name": e.first_name,
        "last_name": e.last_name,
        "email": e.email,
        "job_title": e.job_title,
        "location": e.location,
        "joining_date": e.joining_date.isoformat(),
        "employment_type": e.employment_type,
        "status": e.status,
        "phone": e.phone,
        "department_id": str(e.department.id) if e.department else None,
        "manager_id": str(e.manager.id) if e.manager else None,
    }


async def _employee_has(
    ctx: ToolContext, args: dict[str, Any], result: dict[str, Any], before: Any
) -> list[str]:
    employee_id = result.get("id") or args.get("employee_id")
    actual = _fields(await _employee(ctx, employee_id))
    expected = {k: v for k, v in args.items() if k in actual}
    if "email" in expected:
        expected["email"] = str(expected["email"]).lower()  # the API stores emails lowercased
    return _differences(expected, actual)


async def _onboarding_started(
    ctx: ToolContext, args: dict[str, Any], result: dict[str, Any], before: Any
) -> list[str]:
    status = api.EmployeeOnboarding.model_validate(
        await ctx.hr.get(f"/employees/{args['employee_id']}/onboarding")
    )
    problems = [] if status.started else ["onboarding isn't started"]
    if not status.tasks:
        problems.append("the onboarding checklist has no tasks")
    return problems


async def _leave(ctx: ToolContext, leave_id: Any) -> api.LeaveRequest:
    return api.LeaveRequest.model_validate(await ctx.hr.get(f"/leave-requests/{leave_id}"))


async def _balance(ctx: ToolContext, leave: api.LeaveRequest) -> api.LeaveBalance | None:
    balances = [
        api.LeaveBalance.model_validate(b)
        for b in await ctx.hr.get(
            f"/employees/{leave.employee.id}/leave-balances",
            params={"year": leave.start_date.year},
        )
    ]
    return next((b for b in balances if b.type == leave.type), None)


async def _balance_before_decision(ctx: ToolContext, args: dict[str, Any]) -> Any:
    leave = await _leave(ctx, args["leave_request_id"])
    balance = await _balance(ctx, leave)
    return balance.model_dump(mode="json") if balance else None


def _leave_status_is(status: str) -> Check:
    async def check(
        ctx: ToolContext, args: dict[str, Any], result: dict[str, Any], before: Any
    ) -> list[str]:
        leave = await _leave(ctx, args.get("leave_request_id") or result.get("id"))
        problems = (
            [] if leave.status == status else [f"status is {leave.status}, expected {status}"]
        )
        if status == "APPROVED" and before is not None:
            # Approving moves the request's days from pending to used.
            after = await _balance(ctx, leave)
            if after is not None:
                if abs(after.used - before["used"] - leave.days) > 0.01:
                    problems.append(
                        f"used days went {before['used']:g} → {after.used:g}, "
                        f"expected +{leave.days:g}"
                    )
                if abs(before["pending"] - after.pending - leave.days) > 0.01:
                    problems.append(
                        f"pending days went {before['pending']:g} → {after.pending:g}, "
                        f"expected -{leave.days:g}"
                    )
        return problems

    return check


async def _leave_created(
    ctx: ToolContext, args: dict[str, Any], result: dict[str, Any], before: Any
) -> list[str]:
    leave = await _leave(ctx, result["id"])
    expected = {
        "status": "PENDING",
        "type": args.get("leave_type"),
        "start_date": args.get("start_date"),
        "end_date": args.get("end_date"),
    }
    actual = {
        "status": leave.status,
        "type": leave.type,
        "start_date": leave.start_date.isoformat(),
        "end_date": leave.end_date.isoformat(),
    }
    return _differences(expected, actual)


EXPECTATIONS: dict[str, Expectation] = {
    "create_employee": Expectation(_employee_has),
    "update_employee": Expectation(_employee_has),
    "change_manager": Expectation(_employee_has),
    "change_department": Expectation(_employee_has),
    "start_onboarding": Expectation(_onboarding_started),
    "create_leave_request": Expectation(_leave_created),
    "approve_leave": Expectation(_leave_status_is("APPROVED"), before=_balance_before_decision),
    "reject_leave": Expectation(_leave_status_is("REJECTED")),
}


# ---- compensations -----------------------------------------------------------------------

Compensation = Callable[[ToolContext, dict[str, Any]], Awaitable[str]]


async def _cancel_created_leave(ctx: ToolContext, result: dict[str, Any]) -> str:
    leave = await _leave(ctx, result["id"])
    if leave.status != "PENDING":
        # Someone already acted on it: no longer ours to undo.
        raise RuntimeError(f"left as is: it's {leave.status.lower()} now")
    await ctx.hr.post(
        f"/leave-requests/{leave.id}/cancel",
        idempotency_key=ctx.idempotency_key and f"{ctx.idempotency_key}:undo",
    )
    return "cancelled the leave request this run created"


COMPENSATIONS: dict[str, Compensation] = {"create_leave_request": _cancel_created_leave}
