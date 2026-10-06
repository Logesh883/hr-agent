"""Read-only HR tools. Each wraps one existing HR API endpoint, called with the user's token.

Requests are checked against the generated contract models (contracts/generated.py) before
they are sent, and responses are validated against them on the way back, so a contract
change in TypeScript shows up here as a type or validation error instead of a silent drift.

Results are trimmed to what an answer needs: fewer tokens, and less personal data sent to
the model (no phone numbers or dates of birth, for example).
"""

from datetime import date
from typing import Annotated, Any, Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, Field, TypeAdapter

from contracts import generated as api
from tools.base import Shape, Tool, ToolContext, ToolError, ToolInput

LeaveType = Literal["ANNUAL", "SICK", "CASUAL", "UNPAID"]
EmployeeId = Annotated[
    UUID,
    Field(description="An employee id returned by search_employee (or the user's own id)."),
]
Month = Annotated[
    str, Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$", description="Calendar month as YYYY-MM.")
]

# Longest list a tool returns; the total is always reported so the model knows what's missing.
MAX_ITEMS = 25

_BALANCES = TypeAdapter(list[api.LeaveBalance])
_DOCUMENTS = TypeAdapter(list[api.EmployeeDocument])


def _params(model: type[BaseModel], **values: Any) -> dict[str, Any]:
    """Validates request parameters against a generated contract model; camelCase out."""
    return model.model_validate(values).model_dump(mode="json", by_alias=True, exclude_none=True)


class _PersonLike(Protocol):
    """Any generated model with the EmployeeRef fields (they don't share a base class)."""

    @property
    def id(self) -> UUID: ...
    @property
    def employee_code(self) -> str: ...
    @property
    def first_name(self) -> str: ...
    @property
    def last_name(self) -> str: ...


PERSON: dict[str, Shape] = {"id": None, "name": None, "employee_code": None}


def _person(ref: _PersonLike) -> dict[str, Any]:
    return {
        "id": str(ref.id),
        "name": f"{ref.first_name} {ref.last_name}",
        "employee_code": ref.employee_code,
    }


# search_employee


class SearchEmployeeInput(ToolInput):
    query: str = Field(
        min_length=1,
        max_length=100,
        description="A name, employee code or email, as the user wrote it (e.g. 'Sneha').",
    )


async def search_employee(ctx: ToolContext, args: SearchEmployeeInput) -> dict[str, Any]:
    params = _params(api.EmployeeSearchQuery, q=args.query, page_size=MAX_ITEMS)
    page = api.EmployeePage.model_validate(await ctx.hr.get("/employees", params=params))
    return {
        "total": page.total,
        "employees": [
            _person(e)
            | {
                "job_title": e.job_title,
                "department": e.department.name if e.department else None,
                "location": e.location,
                "status": e.status,
            }
            for e in page.items
        ],
    }


# get_employee


class GetEmployeeInput(ToolInput):
    employee_id: EmployeeId


async def get_employee(ctx: ToolContext, args: GetEmployeeInput) -> dict[str, Any]:
    e = api.Employee.model_validate(await ctx.hr.get(f"/employees/{args.employee_id}"))
    return _person(e) | {
        "email": e.email,
        "job_title": e.job_title,
        "department": e.department.name if e.department else None,
        "manager": _person(e.manager) if e.manager else None,
        "location": e.location,
        "joining_date": e.joining_date.isoformat(),
        "employment_type": e.employment_type,
        "status": e.status,
    }


# get_leave_balances


class LeaveBalancesInput(ToolInput):
    employee_id: EmployeeId
    year: int | None = Field(
        default=None, ge=2000, le=2100, description="Calendar year; default: this year."
    )


async def get_leave_balances(ctx: ToolContext, args: LeaveBalancesInput) -> dict[str, Any]:
    params = _params(api.LeaveBalanceQuery, year=args.year)
    balances = _BALANCES.validate_python(
        await ctx.hr.get(f"/employees/{args.employee_id}/leave-balances", params=params)
    )
    return {
        "year": balances[0].year if balances else args.year or ctx.today.year,
        # available = entitled - used - pending; null for unpaid leave, which has no limit.
        "balances": [b.model_dump(mode="json") for b in balances],
    }


# preview_leave


class PreviewLeaveInput(ToolInput):
    # Required, not "omit for yourself": a model that drops the id would otherwise silently
    # preview the signed-in user's own leave and report it as someone else's.
    employee_id: UUID = Field(
        description="Whose leave to check: an id from search_employee, or the user's own "
        "employee id."
    )
    leave_type: LeaveType
    start_date: date = Field(description="First day off, YYYY-MM-DD.")
    end_date: date = Field(description="Last day off, YYYY-MM-DD (same as start for one day).")


async def preview_leave(ctx: ToolContext, args: PreviewLeaveInput) -> dict[str, Any]:
    if args.end_date < args.start_date:
        raise ToolError("end_date must be on or after start_date.")
    body = _params(
        api.CreateLeaveRequest,
        employee_id=args.employee_id,
        type=args.leave_type,
        start_date=args.start_date,
        end_date=args.end_date,
    )
    preview = api.LeavePreview.model_validate(await ctx.hr.post("/leave-requests/preview", body))
    return {
        "working_days": preview.working_days,
        "non_working_days": [d.model_dump(mode="json") for d in preview.non_working_days],
        "balance": preview.balance.model_dump(mode="json") if preview.balance else None,
        "balance_after": preview.balance_after,
        # Plain-language reasons the request would be refused; empty means it would be allowed.
        "problems": [p.model_dump(mode="json") for p in preview.problems],
        "note": "This is a preview only. Nothing was submitted.",
    }


# list_leave_requests


class ListLeaveInput(ToolInput):
    view: Literal["mine", "approvals", "all"] = Field(
        default="all",
        description="mine: the user's own requests; approvals: pending requests the user may "
        "approve or reject; all: every request the user can see.",
    )
    employee_id: UUID | None = Field(default=None, description="Only this employee's requests.")
    status: Literal["PENDING", "APPROVED", "REJECTED", "CANCELLED"] | None = None
    leave_type: LeaveType | None = None
    from_date: date | None = Field(default=None, description="Requests overlapping on or after.")
    to_date: date | None = Field(default=None, description="Requests overlapping on or before.")


async def list_leave_requests(ctx: ToolContext, args: ListLeaveInput) -> dict[str, Any]:
    params = _params(
        api.LeaveSearchQuery,
        view=args.view,
        employee_id=args.employee_id,
        status=args.status,
        type=args.leave_type,
        from_=args.from_date,
        to=args.to_date,
        page_size=MAX_ITEMS,
    )
    page = api.LeaveRequestPage.model_validate(await ctx.hr.get("/leave-requests", params=params))
    return {
        "total": page.total,
        "requests": [
            {
                "id": str(r.id),
                "employee": _person(r.employee),
                "type": r.type,
                "start_date": r.start_date.isoformat(),
                "end_date": r.end_date.isoformat(),
                "days": r.days,
                "status": r.status,
                "reason": r.reason,
                "decided_by": r.decided_by.name if r.decided_by else None,
            }
            for r in page.items
        ],
    }


# get_attendance_month


class AttendanceMonthInput(ToolInput):
    month: Month
    employee_id: UUID | None = Field(
        default=None, description="One employee; omit for everyone the user can see."
    )


async def get_attendance_month(ctx: ToolContext, args: AttendanceMonthInput) -> dict[str, Any]:
    params = _params(api.MonthlyAttendanceQuery, month=args.month, employee_id=args.employee_id)
    report = api.MonthlyAttendance.model_validate(
        await ctx.hr.get("/attendance/monthly", params=params)
    )
    return {
        "month": report.month,
        "working_days_so_far": report.working_days,
        "employees": [
            _person(row.employee)
            | {
                "present": row.present,
                "half_days": row.half_days,
                "absent": row.absent,
                "on_leave": row.on_leave,
                "missing": row.missing,
                "anomalies": row.anomalies,
            }
            for row in report.rows
        ],
        "anomalies_total": len(report.anomalies),
        # Newest first, as the API orders them.
        "anomalies": [
            {
                "date": a.date.isoformat(),
                "employee": f"{a.employee.first_name} {a.employee.last_name}",
                "code": a.code,
                "message": a.message,
            }
            for a in report.anomalies[:MAX_ITEMS]
        ],
    }


# get_onboarding_status


class OnboardingInput(ToolInput):
    employee_id: EmployeeId


async def get_onboarding_status(ctx: ToolContext, args: OnboardingInput) -> dict[str, Any]:
    status = api.EmployeeOnboarding.model_validate(
        await ctx.hr.get(f"/employees/{args.employee_id}/onboarding")
    )
    return {
        "employee": _person(status.employee)
        | {"joining_date": status.employee.joining_date.isoformat()},
        "started": status.started,
        "progress": status.progress.model_dump(mode="json"),
        # What HR still has to chase (missing documents, details, …).
        "missing_info": [m.message for m in status.missing_info],
        "open_tasks": [
            {
                "title": t.title,
                "assignee": t.assignee,
                "due_date": t.due_date.isoformat(),
                "overdue": t.is_overdue,
            }
            for t in status.tasks
            if t.status == "PENDING"
        ],
    }


# list_employee_documents


class DocumentsInput(ToolInput):
    employee_id: EmployeeId


async def list_employee_documents(ctx: ToolContext, args: DocumentsInput) -> dict[str, Any]:
    documents = _DOCUMENTS.validate_python(
        await ctx.hr.get(f"/employees/{args.employee_id}/documents")
    )
    return {
        "documents": [
            {
                "type": d.type,
                "status": d.status,
                "file_name": d.file_name,
                "uploaded_at": d.uploaded_at.date().isoformat(),
                "review_note": d.review_note,
            }
            for d in documents
        ]
    }


# get_payroll_readiness


class PayrollInput(ToolInput):
    month: Month


async def get_payroll_readiness(ctx: ToolContext, args: PayrollInput) -> dict[str, Any]:
    params = _params(api.PayrollReportQuery, month=args.month)
    report = api.PayrollReport.model_validate(
        await ctx.hr.get("/payroll/preparation", params=params)
    )
    flagged = [row for row in report.rows if row.flags]
    return {
        "month": report.month,
        "through": report.through.isoformat(),
        "complete": report.complete,
        "summary": report.summary.model_dump(mode="json"),
        "flagged_total": len(flagged),
        # Only employees with something to fix; everyone else is ready.
        "flagged": [
            _person(row.employee)
            | {"lop_days": row.lop_days, "flags": [f.message for f in row.flags]}
            for row in flagged[:MAX_ITEMS]
        ],
        "changes": [
            {"employee": _person(c.employee), "kind": c.kind, "summary": c.summary}
            for c in report.changes[:MAX_ITEMS]
        ],
    }


READ_TOOLS: list[Tool[Any]] = [
    Tool(
        name="search_employee",
        description="Find employees by name, employee code or email. Returns ids to pass to "
        "the other tools, with job title, department and location. Call this first whenever "
        "the user names a person; never guess an id.",
        input_model=SearchEmployeeInput,
        run=search_employee,
        returns={
            "total": None,
            "employees": [
                PERSON | {"job_title": None, "department": None, "location": None, "status": None}
            ],
        },
    ),
    Tool(
        name="get_employee",
        description="One employee's profile: job title, department, manager, location, "
        "joining date, employment type and status.",
        input_model=GetEmployeeInput,
        run=get_employee,
    ),
    Tool(
        name="get_leave_balances",
        description="An employee's leave balances for a year, per leave type: entitled, "
        "used, pending (requested, not yet approved) and available days.",
        input_model=LeaveBalancesInput,
        run=get_leave_balances,
    ),
    Tool(
        name="preview_leave",
        description="Check whether a leave request would be allowed, without submitting it. "
        "Returns working days, the balance before and after, and plain-language problems "
        "(insufficient balance, overlap, too long, …). Use it to answer 'can X take …' and "
        "'why can't X take …' questions.",
        input_model=PreviewLeaveInput,
        run=preview_leave,
    ),
    Tool(
        name="list_leave_requests",
        description="Leave requests the user can see, newest first, filtered by employee, "
        "status, type or dates. view='approvals' lists pending requests waiting for the "
        "user's decision.",
        input_model=ListLeaveInput,
        run=list_leave_requests,
        returns={
            "total": None,
            "requests": [
                {
                    "id": None,
                    "employee": PERSON,
                    "type": None,
                    "start_date": None,
                    "end_date": None,
                    "days": None,
                    "status": None,
                    "reason": None,
                    "decided_by": None,
                }
            ],
        },
    ),
    Tool(
        name="get_attendance_month",
        description="Monthly attendance summary for one employee or everyone the user can "
        "see (a manager sees their team): days present, absent, on leave and missing, plus "
        "attendance anomalies such as late check-ins or absence without leave.",
        input_model=AttendanceMonthInput,
        run=get_attendance_month,
    ),
    Tool(
        name="get_onboarding_status",
        description="An employee's onboarding: progress, open tasks with due dates, and "
        "missing information or documents HR still needs.",
        input_model=OnboardingInput,
        run=get_onboarding_status,
    ),
    Tool(
        name="list_employee_documents",
        description="Documents an employee has uploaded (ID proof, PAN card, bank details, …) "
        "with their verification status and any review note.",
        input_model=DocumentsInput,
        run=list_employee_documents,
    ),
    Tool(
        name="get_payroll_readiness",
        description="Payroll preparation for a month: headcount, joiners and exits, loss-of-"
        "pay days, and employees with issues to fix before the payroll run.",
        input_model=PayrollInput,
        run=get_payroll_readiness,
    ),
]
