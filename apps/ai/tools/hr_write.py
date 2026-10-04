"""A6.2: tools that change HR data. Each wraps one HR API write, with the user's token.

Every write tool:
- validates its request against the generated contract model before sending;
- sends the step's `Idempotency-Key` (ctx.idempotency_key), so a retried or resumed step
  returns the first result instead of acting twice;
- has a `preview`: what would change, as {"summary", "before", "after"}, computed by reading
  only. The approval step shows it (A6.4) before anything is written.

Which of these need approval is not decided here: the risk policy (agent/risk.py) does,
per tool and per field.
"""

from datetime import date
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field

from app.hr_client import HrApiError
from contracts import generated as api
from tools.base import Risk, Tool, ToolContext, ToolError, ToolInput
from tools.hr_read import EmployeeId, LeaveType

EMPLOYEE_FIELDS = ("job_title", "location", "phone", "employment_type", "status")


def _body(model: type[BaseModel], **values: Any) -> dict[str, Any]:
    """A request body checked against the generated contract; camelCase, unset fields out."""
    return model.model_validate(values).model_dump(mode="json", by_alias=True, exclude_none=True)


async def _employee(ctx: ToolContext, employee_id: UUID) -> api.Employee:
    return api.Employee.model_validate(await ctx.hr.get(f"/employees/{employee_id}"))


def _employee_view(e: api.Employee) -> dict[str, Any]:
    return {
        "name": f"{e.first_name} {e.last_name}",
        "employee_code": e.employee_code,
        "job_title": e.job_title,
        "department": e.department.name if e.department else None,
        "manager": f"{e.manager.first_name} {e.manager.last_name}" if e.manager else None,
        "location": e.location,
        "status": e.status,
    }


async def _department_name(ctx: ToolContext, department_id: UUID) -> str:
    data = await ctx.hr.get(f"/departments/{department_id}")
    return str(data.get("name", department_id))


async def _person_name(ctx: ToolContext, employee_id: UUID | None) -> str | None:
    if employee_id is None:
        return None
    e = await _employee(ctx, employee_id)
    return f"{e.first_name} {e.last_name}"


# ---- create_employee ---------------------------------------------------------------------


class CreateEmployeeInput(ToolInput):
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    email: EmailStr = Field(description="Work email, exactly as the user gave it. Never guess.")
    job_title: str = Field(min_length=1, max_length=150)
    department_id: UUID = Field(description="A department id from list_departments.")
    manager_id: UUID | None = Field(default=None, description="An id from search_employee.")
    location: str = Field(min_length=1, max_length=100)
    joining_date: date
    employment_type: Literal["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"] = Field(
        default="FULL_TIME", description="Omit unless the user said otherwise."
    )


def _create_body(args: CreateEmployeeInput) -> dict[str, Any]:
    return _body(
        api.CreateEmployee,
        first_name=args.first_name,
        last_name=args.last_name,
        email=args.email,
        job_title=args.job_title,
        department_id=args.department_id,
        manager_id=args.manager_id,
        location=args.location,
        joining_date=args.joining_date,
        employment_type=args.employment_type,
    )


async def preview_create_employee(ctx: ToolContext, args: CreateEmployeeInput) -> dict[str, Any]:
    after = {
        "name": f"{args.first_name} {args.last_name}",
        "email": args.email,
        "job_title": args.job_title,
        "department": await _department_name(ctx, args.department_id),
        "manager": await _person_name(ctx, args.manager_id),
        "location": args.location,
        "joining_date": args.joining_date.isoformat(),
        "employment_type": args.employment_type,
        "status": "PROBATION",
    }
    return {"summary": f"Create employee {after['name']}", "before": None, "after": after}


async def create_employee(ctx: ToolContext, args: CreateEmployeeInput) -> dict[str, Any]:
    data = await ctx.hr.post("/employees", _create_body(args), idempotency_key=ctx.idempotency_key)
    e = api.Employee.model_validate(data)
    return {"id": str(e.id), "version": e.version} | _employee_view(e)


# ---- update_employee / change_manager / change_department ---------------------------------


class UpdateEmployeeInput(ToolInput):
    employee_id: EmployeeId
    job_title: str | None = Field(default=None, min_length=1, max_length=150)
    location: str | None = Field(default=None, min_length=1, max_length=100)
    phone: str | None = Field(default=None, max_length=50)
    employment_type: Literal["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"] | None = None
    status: Literal["ACTIVE", "PROBATION"] | None = None


class ChangeManagerInput(ToolInput):
    employee_id: EmployeeId
    manager_id: UUID = Field(description="The new manager's id, from search_employee.")


class ChangeDepartmentInput(ToolInput):
    employee_id: EmployeeId
    department_id: UUID = Field(description="The new department's id, from list_departments.")


def _changes(args: ToolInput) -> dict[str, Any]:
    return args.model_dump(exclude={"employee_id"}, exclude_none=True)


async def _patch_employee(ctx: ToolContext, employee_id: UUID, changes: dict[str, Any]) -> Any:
    """Optimistic locking from the tool's side: read the version, write with it. If someone
    changed the record in between, the API answers 409 and nothing is overwritten."""
    if not changes:
        raise ToolError("Nothing to change: give at least one field.")
    for attempt in range(2):
        current = await _employee(ctx, employee_id)
        body = _body(api.UpdateEmployee, **changes, version=current.version)
        # The first attempt's 409 is stored under its key as a final answer, so a retry
        # with a fresh version needs its own (still stable) key.
        key = ctx.idempotency_key and (ctx.idempotency_key + (f":r{attempt}" if attempt else ""))
        try:
            data = await ctx.hr.patch(f"/employees/{employee_id}", body, idempotency_key=key)
        except HrApiError as error:
            # A7.3 "409 stale version: re-read and retry once".
            if (
                error.status_code == 409
                and "changed by someone else" in error.message
                and attempt == 0
            ):
                continue
            raise
        e = api.Employee.model_validate(data)
        return {"id": str(e.id), "version": e.version} | _employee_view(e)
    raise AssertionError("unreachable")


async def _preview_patch(
    ctx: ToolContext, employee_id: UUID, changes: dict[str, Any]
) -> dict[str, Any]:
    current = await _employee(ctx, employee_id)
    before = _employee_view(current)
    after = dict(before)
    for name, value in changes.items():
        if name == "manager_id":
            after["manager"] = await _person_name(ctx, value)
        elif name == "department_id":
            after["department"] = await _department_name(ctx, value)
        else:
            after[name] = value
    changed = {k: v for k, v in after.items() if before.get(k) != v}
    return {
        "summary": f"Update {before['name']}: {', '.join(changed) or 'no visible change'}",
        "before": {k: before.get(k) for k in changed},
        "after": changed,
    }


async def update_employee(ctx: ToolContext, args: UpdateEmployeeInput) -> dict[str, Any]:
    return await _patch_employee(ctx, args.employee_id, _changes(args))


async def preview_update_employee(ctx: ToolContext, args: UpdateEmployeeInput) -> dict[str, Any]:
    return await _preview_patch(ctx, args.employee_id, _changes(args))


async def change_manager(ctx: ToolContext, args: ChangeManagerInput) -> dict[str, Any]:
    return await _patch_employee(ctx, args.employee_id, {"manager_id": args.manager_id})


async def preview_change_manager(ctx: ToolContext, args: ChangeManagerInput) -> dict[str, Any]:
    return await _preview_patch(ctx, args.employee_id, {"manager_id": args.manager_id})


async def change_department(ctx: ToolContext, args: ChangeDepartmentInput) -> dict[str, Any]:
    return await _patch_employee(ctx, args.employee_id, {"department_id": args.department_id})


async def preview_change_department(
    ctx: ToolContext, args: ChangeDepartmentInput
) -> dict[str, Any]:
    return await _preview_patch(ctx, args.employee_id, {"department_id": args.department_id})


# ---- onboarding --------------------------------------------------------------------------


class StartOnboardingInput(ToolInput):
    employee_id: EmployeeId


async def start_onboarding(ctx: ToolContext, args: StartOnboardingInput) -> dict[str, Any]:
    data = await ctx.hr.post(
        f"/employees/{args.employee_id}/onboarding", idempotency_key=ctx.idempotency_key
    )
    onboarding = api.EmployeeOnboarding.model_validate(data)
    return {
        "employee_id": str(args.employee_id),
        "tasks": len(onboarding.tasks),
        "missing_info": [m.model_dump(mode="json") for m in onboarding.missing_info],
    }


async def preview_start_onboarding(ctx: ToolContext, args: StartOnboardingInput) -> dict[str, Any]:
    name = await _person_name(ctx, args.employee_id)
    return {
        "summary": f"Start onboarding for {name}",
        "before": None,
        "after": {"onboarding": "checklist created from the standard template"},
    }


class UpdateOnboardingTaskInput(ToolInput):
    task_id: UUID = Field(description="A task id from get_onboarding_status.")
    status: Literal["PENDING", "IN_PROGRESS", "DONE", "SKIPPED"] | None = None
    notes: str | None = Field(default=None, max_length=1000)
    due_date: date | None = None


async def update_onboarding_task(
    ctx: ToolContext, args: UpdateOnboardingTaskInput
) -> dict[str, Any]:
    body = _body(
        api.UpdateOnboardingTask, status=args.status, notes=args.notes, due_date=args.due_date
    )
    data = await ctx.hr.patch(
        f"/onboarding/tasks/{args.task_id}", body, idempotency_key=ctx.idempotency_key
    )
    return api.OnboardingTask.model_validate(data).model_dump(mode="json")


async def preview_update_onboarding_task(
    ctx: ToolContext, args: UpdateOnboardingTaskInput
) -> dict[str, Any]:
    after = args.model_dump(mode="json", exclude={"task_id"}, exclude_none=True)
    return {"summary": "Update onboarding task", "before": None, "after": after}


# ---- leave -------------------------------------------------------------------------------


class CreateLeaveInput(ToolInput):
    employee_id: EmployeeId
    leave_type: LeaveType
    start_date: date
    end_date: date
    reason: str | None = Field(default=None, max_length=500)


def _leave_body(args: CreateLeaveInput) -> dict[str, Any]:
    return _body(
        api.CreateLeaveRequest,
        employee_id=args.employee_id,
        type=args.leave_type,
        start_date=args.start_date,
        end_date=args.end_date,
        reason=args.reason,
    )


async def preview_create_leave(ctx: ToolContext, args: CreateLeaveInput) -> dict[str, Any]:
    preview = api.LeavePreview.model_validate(
        await ctx.hr.post("/leave-requests/preview", _leave_body(args))
    )
    name = await _person_name(ctx, args.employee_id)
    return {
        "summary": f"Request {preview.working_days:g} days of {args.leave_type.lower()} leave "
        f"for {name}, {args.start_date} to {args.end_date}",
        "before": {"available": preview.balance.available if preview.balance else None},
        "after": {"available": preview.balance_after},
        "problems": [p.message for p in preview.problems],
    }


async def create_leave_request(ctx: ToolContext, args: CreateLeaveInput) -> dict[str, Any]:
    # Always previews first: a request the rules refuse is reported, never sent.
    preview = api.LeavePreview.model_validate(
        await ctx.hr.post("/leave-requests/preview", _leave_body(args))
    )
    if preview.problems:
        raise ToolError(
            "The leave request breaks the rules: " + "; ".join(p.message for p in preview.problems)
        )
    data = await ctx.hr.post(
        "/leave-requests", _leave_body(args), idempotency_key=ctx.idempotency_key
    )
    leave = api.LeaveRequest.model_validate(data)
    return {"id": str(leave.id), "status": leave.status, "days": leave.days}


class DecideLeaveInput(ToolInput):
    leave_request_id: UUID = Field(description="A leave request id from list_leave_requests.")
    comment: str | None = Field(default=None, max_length=500)


class RejectLeaveInput(ToolInput):
    leave_request_id: UUID = Field(description="A leave request id from list_leave_requests.")
    reason: str = Field(min_length=1, max_length=500, description="Required; the employee sees it.")


async def _leave(ctx: ToolContext, leave_id: UUID) -> api.LeaveRequest:
    return api.LeaveRequest.model_validate(await ctx.hr.get(f"/leave-requests/{leave_id}"))


def _leave_view(leave: api.LeaveRequest) -> dict[str, Any]:
    e = leave.employee
    return {
        "employee": f"{e.first_name} {e.last_name}",
        "type": leave.type,
        "dates": f"{leave.start_date} to {leave.end_date}",
        "days": leave.days,
        "status": leave.status,
    }


def _not_own(ctx: ToolContext, leave: api.LeaveRequest) -> None:
    """Nobody decides their own leave (the HR API refuses too). Checked before the approval
    is even shown, so nobody is asked to approve something that can't happen."""
    if ctx.user.employee_id and str(leave.employee.id) == ctx.user.employee_id:
        raise ToolError("You can't approve or reject your own leave request.")


async def _preview_decision(ctx: ToolContext, leave_id: UUID, status: str) -> dict[str, Any]:
    leave = await _leave(ctx, leave_id)
    _not_own(ctx, leave)
    view = _leave_view(leave)
    return {
        "summary": f"{status.title()} {view['employee']}'s {view['type'].lower()} leave "
        f"({view['dates']}, {view['days']:g} days)",
        "before": {"status": leave.status},
        "after": {"status": status},
    }


async def approve_leave(ctx: ToolContext, args: DecideLeaveInput) -> dict[str, Any]:
    _not_own(ctx, await _leave(ctx, args.leave_request_id))
    body = _body(api.ApproveLeave, comment=args.comment)
    data = await ctx.hr.post(
        f"/leave-requests/{args.leave_request_id}/approve",
        body,
        idempotency_key=ctx.idempotency_key,
    )
    return _leave_view(api.LeaveRequest.model_validate(data))


async def preview_approve_leave(ctx: ToolContext, args: DecideLeaveInput) -> dict[str, Any]:
    return await _preview_decision(ctx, args.leave_request_id, "APPROVED")


async def reject_leave(ctx: ToolContext, args: RejectLeaveInput) -> dict[str, Any]:
    _not_own(ctx, await _leave(ctx, args.leave_request_id))
    body = _body(api.RejectLeave, reason=args.reason)
    data = await ctx.hr.post(
        f"/leave-requests/{args.leave_request_id}/reject", body, idempotency_key=ctx.idempotency_key
    )
    return _leave_view(api.LeaveRequest.model_validate(data))


async def preview_reject_leave(ctx: ToolContext, args: RejectLeaveInput) -> dict[str, Any]:
    return await _preview_decision(ctx, args.leave_request_id, "REJECTED")


# ---- attendance --------------------------------------------------------------------------


class ProposeCorrectionInput(ToolInput):
    employee_id: EmployeeId
    date: date
    status: Literal["PRESENT", "HALF_DAY", "ABSENT"]
    check_in: Annotated[str | None, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")] = None
    check_out: Annotated[str | None, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")] = None
    reason: str = Field(min_length=1, max_length=500, description="Why the record should change.")


def _correction_body(args: ProposeCorrectionInput) -> dict[str, Any]:
    return _body(
        api.ProposeCorrection,
        employee_id=args.employee_id,
        date=args.date,
        status=args.status,
        check_in=args.check_in,
        check_out=args.check_out,
        reason=args.reason,
    )


async def propose_attendance_correction(
    ctx: ToolContext, args: ProposeCorrectionInput
) -> dict[str, Any]:
    data = await ctx.hr.post(
        "/attendance/corrections", _correction_body(args), idempotency_key=ctx.idempotency_key
    )
    return {"id": data.get("id"), "status": data.get("status")}


async def preview_propose_correction(
    ctx: ToolContext, args: ProposeCorrectionInput
) -> dict[str, Any]:
    name = await _person_name(ctx, args.employee_id)
    after = args.model_dump(mode="json", exclude={"employee_id"}, exclude_none=True)
    return {
        "summary": f"Propose an attendance correction for {name} on {args.date} (HR approves it)",
        "before": None,
        "after": after,
    }


# ---- send_email (stub) -------------------------------------------------------------------


class SendEmailInput(ToolInput):
    to: EmailStr = Field(description="An email address the user gave or a tool returned.")
    subject: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=5000)


async def send_email(ctx: ToolContext, args: SendEmailInput) -> dict[str, Any]:
    """Writes to the outbox and never sends: email is out of scope for this project."""
    if ctx.outbox is None:
        raise ToolError("Email isn't available here.")
    message_id = await ctx.outbox.add(
        args.model_dump(mode="json") | {"idempotency_key": ctx.idempotency_key}
    )
    return {"outbox_id": message_id, "status": "queued (not sent: this is a stub)"}


async def preview_send_email(ctx: ToolContext, args: SendEmailInput) -> dict[str, Any]:
    return {
        "summary": f"Queue an email to {args.to}: {args.subject}",
        "before": None,
        "after": args.model_dump(mode="json"),
    }


# ---- list_departments (read, needed to resolve "Engineering") ----------------------------


class ListDepartmentsInput(ToolInput):
    name: str | None = Field(
        default=None,
        max_length=100,
        description="Only departments whose name or code contains this (e.g. 'Engineering').",
    )


async def list_departments(ctx: ToolContext, args: ListDepartmentsInput) -> dict[str, Any]:
    departments = await ctx.hr.list_departments()
    wanted = (args.name or "").strip().casefold()
    return {
        "departments": [
            {"id": d.id, "name": d.name, "code": d.code, "employees": d.employee_count}
            for d in departments
            if d.status == "ACTIVE"
            and (not wanted or wanted in d.name.casefold() or wanted == d.code.casefold())
        ]
    }


def _write(
    name: str, description: str, model: type[ToolInput], run: Any, preview: Any
) -> Tool[Any]:
    return Tool(
        name=name,
        description=description,
        input_model=model,
        run=run,
        preview=preview,
        risk=Risk.WRITE,
    )


WRITE_TOOLS: list[Tool[Any]] = [
    _write(
        "create_employee",
        "Create a new employee record (status PROBATION). Every value must come from the user "
        "or a lookup: never guess an email or a last name.",
        CreateEmployeeInput,
        create_employee,
        preview_create_employee,
    ),
    _write(
        "update_employee",
        "Change an employee's job title, location, phone, employment type or status.",
        UpdateEmployeeInput,
        update_employee,
        preview_update_employee,
    ),
    _write(
        "change_manager",
        "Change who an employee reports to.",
        ChangeManagerInput,
        change_manager,
        preview_change_manager,
    ),
    _write(
        "change_department",
        "Move an employee to another department.",
        ChangeDepartmentInput,
        change_department,
        preview_change_department,
    ),
    _write(
        "start_onboarding",
        "Create the onboarding checklist for an employee (after create_employee).",
        StartOnboardingInput,
        start_onboarding,
        preview_start_onboarding,
    ),
    _write(
        "update_onboarding_task",
        "Update an onboarding task's status, notes or due date.",
        UpdateOnboardingTaskInput,
        update_onboarding_task,
        preview_update_onboarding_task,
    ),
    _write(
        "create_leave_request",
        "Submit a leave request. It is checked against the leave rules first and refused if "
        "it breaks them.",
        CreateLeaveInput,
        create_leave_request,
        preview_create_leave,
    ),
    _write(
        "approve_leave",
        "Approve a pending leave request.",
        DecideLeaveInput,
        approve_leave,
        preview_approve_leave,
    ),
    _write(
        "reject_leave",
        "Reject a pending leave request, with a reason the employee will see.",
        RejectLeaveInput,
        reject_leave,
        preview_reject_leave,
    ),
    _write(
        "propose_attendance_correction",
        "Propose a fix to a past attendance record; HR approves it in the app.",
        ProposeCorrectionInput,
        propose_attendance_correction,
        preview_propose_correction,
    ),
    _write(
        "send_email",
        "Queue an email (stub: written to an outbox, never sent).",
        SendEmailInput,
        send_email,
        preview_send_email,
    ),
]

DEPARTMENT_TOOL: Tool[Any] = Tool(
    name="list_departments",
    description="List the active departments with their ids (to resolve a department name).",
    input_model=ListDepartmentsInput,
    run=list_departments,
)
