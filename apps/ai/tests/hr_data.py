"""HR API response bodies for tests, shaped like the @hr/contracts response schemas.

Ids are real UUIDs because the generated contract models validate them as UUIDs.
"""

from typing import Any

from llm.types import LLMResponse, ToolCall, Usage

BASE_URL = "http://hr.test"

SNEHA_ID = "5c0b1f8e-0000-4000-8000-000000000006"
ARUN_ID = "5c0b1f8e-0000-4000-8000-000000000005"
RAHUL_ID = "5c0b1f8e-0000-4000-8000-000000000002"
LAKSHMI_ID = "5c0b1f8e-0000-4000-8000-000000000014"
ENG_ID = "5c0b1f8e-0000-4000-8000-0000000000e1"
LEAVE_ID = "5c0b1f8e-0000-4000-8000-0000000000a1"
USER_ID = "5c0b1f8e-0000-4000-8000-0000000000f1"


def ref(employee_id: str, first: str, last: str, code: str) -> dict[str, Any]:
    return {"id": employee_id, "employeeCode": code, "firstName": first, "lastName": last}


SNEHA_REF = ref(SNEHA_ID, "Sneha", "Patel", "EMP006")
ARUN_REF = ref(ARUN_ID, "Arun", "Kumar", "EMP005")
RAHUL_REF = ref(RAHUL_ID, "Rahul", "Sharma", "EMP002")


def employee(base: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    return (
        base
        | {
            "email": f"{base['firstName'].lower()}.{base['lastName'].lower()}@acme.example",
            "phone": "+91 98450 11006",
            "dateOfBirth": "1996-03-08",
            "jobTitle": "Software Engineer",
            "location": "Bangalore",
            "joiningDate": "2023-06-05",
            "employmentType": "FULL_TIME",
            "status": "ACTIVE",
            "department": {"id": ENG_ID, "name": "Engineering"},
            "manager": RAHUL_REF,
            "version": 1,
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
        }
        | overrides
    )


SNEHA = employee(SNEHA_REF)
ARUN = employee(ARUN_REF, jobTitle="Senior Software Engineer")


def page(*items: dict[str, Any]) -> dict[str, Any]:
    return {"items": list(items), "total": len(items), "page": 1, "pageSize": 25}


def balances(annual_available: float = 9) -> list[dict[str, Any]]:
    return [
        {
            "type": "ANNUAL",
            "year": 2026,
            "entitled": 18,
            "used": 18 - annual_available - 2,
            "pending": 2,
            "available": annual_available,
        },
        {"type": "SICK", "year": 2026, "entitled": 12, "used": 1, "pending": 0, "available": 11},
        {
            "type": "UNPAID",
            "year": 2026,
            "entitled": None,
            "used": 0,
            "pending": 0,
            "available": None,
        },
    ]


def session_user(role: str, name: str, employee_id: str | None) -> dict[str, Any]:
    return {
        "id": USER_ID,
        "email": f"{role.lower()}@hr.local",
        "name": name,
        "role": role,
        "employeeId": employee_id,
        "permissions": [],
        "mustChangePassword": False,
    }


def forbidden(permission: str, role: str) -> dict[str, Any]:
    """The HR API's PermissionsGuard error body."""
    return {"statusCode": 403, "message": f"Your role ({role}) lacks permission: {permission}"}


EMPLOYEE_NOT_FOUND = {"statusCode": 404, "message": "Employee not found"}


def tool_call(name: str, arguments: str, call_id: str = "call_1") -> ToolCall:
    return ToolCall(id=call_id, name=name, arguments=arguments)


def calls(*tool_calls: ToolCall, text: str | None = None) -> LLMResponse:
    """A scripted model turn that asks for these tool calls."""
    return LLMResponse(
        text=text,
        tool_calls=list(tool_calls),
        usage=Usage(prompt_tokens=100, completion_tokens=10),
        model="fake-model",
        finish_reason="tool_calls",
    )
