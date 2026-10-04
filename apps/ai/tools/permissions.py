"""A8.1: which tools a user is offered, from the same permission map the HR API enforces.

Each tool needs the permission of the HR API endpoint it calls (packages/contracts
permissions.ts, `ROLE_PERMISSIONS`). The signed-in user's permissions come from the API's
session (`/auth/me`), derived from that map, so the agent and the API can't disagree.

A tool the user lacks the permission for isn't just refused: it's never offered. The model
doesn't see it in its tool list or the planner's prompt, so an employee's agent can't even
try to approve leave. The registry still checks again on every call (the second lock), and
the HR API checks a third time.
"""

import json
from collections.abc import Iterable
from functools import cache
from typing import Any

from app.settings import WORKSPACE_ROOT
from tools.base import Tool

TOOL_PERMISSIONS: dict[str, str] = {
    # reads
    "search_employee": "employee:read",
    "get_employee": "employee:read",
    "get_leave_balances": "leave:request",
    "preview_leave": "leave:request",
    "list_leave_requests": "leave:request",
    "get_attendance_month": "attendance:read",
    "get_onboarding_status": "onboarding:read",
    "list_employee_documents": "document:read",
    "get_payroll_readiness": "payroll:read",
    "search_policy": "policy:read",
    "list_departments": "department:read",
    # writes
    "create_employee": "employee:create",
    "update_employee": "employee:update",
    "change_manager": "employee:update",
    "change_department": "employee:update",
    "start_onboarding": "onboarding:manage",
    # The API lets anyone with onboarding:read update tasks they're allowed to (their own).
    "update_onboarding_task": "onboarding:read",
    "create_leave_request": "leave:request",
    "approve_leave": "leave:approve",
    "reject_leave": "leave:approve",
    "propose_attendance_correction": "attendance:propose",
    # No API behind it (an outbox stub); welcome and onboarding mail is HR's job.
    "send_email": "onboarding:manage",
}


def permitted(tool: Tool[Any], permissions: Iterable[str]) -> bool:
    """Tools not in the map (test doubles) need nothing; every real tool is in it (tested)."""
    required = TOOL_PERMISSIONS.get(tool.name)
    return required is None or required in set(permissions)


PERMISSION_MAP_PATH = WORKSPACE_ROOT / "packages" / "contracts" / "json-schema" / "permissions.json"


@cache
def role_permissions() -> dict[str, list[str]]:
    """ROLE_PERMISSIONS as exported from the contracts (`pnpm contracts:generate`). The
    running agent uses the session's permissions; this is for tests and evals."""
    return json.loads(PERMISSION_MAP_PATH.read_text())["ROLE_PERMISSIONS"]
