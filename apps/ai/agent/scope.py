"""What a request may lead to, decided by code from the parsed intent (A8.1, A8.2).

Two deterministic limits that don't depend on the model behaving:

- **The role.** An intent whose core permission the user lacks is declined up front, with
  the reason, instead of being planned, retried and refused step by step.
- **The request.** A plan may only change what the request is about: a leave approval can
  approve or reject leave, a question about policy can't change anything. Whatever talked
  the planner into an extra write (an instruction hidden in a policy passage or a document,
  a jailbreak, plain overreach), the write is refused before anything runs.
"""

from intent.schema import Intent

# The permission an intent can't be done without (the HR API's permission map).
INTENT_PERMISSION: dict[Intent, tuple[str, str]] = {
    Intent.ONBOARD_EMPLOYEE: ("employee:create", "adding employees"),
    Intent.UPDATE_EMPLOYEE: ("employee:update", "changing employee records"),
    Intent.FIND_EMPLOYEES: ("employee:read", "looking up other employees"),
    Intent.APPROVE_LEAVE: ("leave:approve", "approving or rejecting leave"),
    Intent.ATTENDANCE_CORRECTION: ("attendance:propose", "proposing attendance corrections"),
    Intent.PAYROLL_READINESS: ("payroll:read", "payroll reports"),
}

# The writes each intent may plan. Anything not listed (questions, reviews, balances,
# policy) may plan none.
INTENT_WRITES: dict[Intent, frozenset[str]] = {
    Intent.ONBOARD_EMPLOYEE: frozenset(
        {"create_employee", "start_onboarding", "update_onboarding_task", "send_email"}
    ),
    Intent.UPDATE_EMPLOYEE: frozenset({"update_employee", "change_manager", "change_department"}),
    Intent.REQUEST_LEAVE: frozenset({"create_leave_request"}),
    Intent.APPROVE_LEAVE: frozenset({"approve_leave", "reject_leave"}),
    Intent.ATTENDANCE_CORRECTION: frozenset({"propose_attendance_correction"}),
}


def refusal(intent: Intent, role: str, permissions: list[str]) -> str | None:
    """Why this user can't make this request at all, or None."""
    needed = INTENT_PERMISSION.get(intent)
    if needed is None or needed[0] in permissions:
        return None
    permission, action = needed
    return (
        f"I can't help with that: {action} needs the `{permission}` permission, which your "
        f"role ({role}) doesn't have. Please ask HR or your manager."
    )


def allowed_writes(intent: Intent) -> frozenset[str]:
    return INTENT_WRITES.get(intent, frozenset())
