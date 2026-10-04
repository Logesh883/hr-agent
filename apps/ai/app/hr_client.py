"""Typed client for the NestJS HR API.

Every call carries the signed-in user's bearer token, so RBAC, data scope, business rules
and audit apply exactly as if the user had clicked in the web app. Error bodies follow the
API's `ApiError` contract (packages/contracts/src/common.ts) and become `HrApiError`.
"""

from datetime import date
from typing import Any, Self

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    """Base for HR API payloads: camelCase on the wire, snake_case in Python."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ApiIssue(ApiModel):
    """A request field that failed validation (400)."""

    path: str
    message: str


class ApiProblem(ApiModel):
    """A business rule the request broke (422), e.g. insufficient leave balance."""

    code: str
    message: str


class _ApiErrorBody(ApiModel):
    status_code: int | None = None
    # Our own errors send a string; NestJS built-ins can send a list of strings.
    message: str | list[str] | None = None
    issues: list[ApiIssue] = []
    problems: list[ApiProblem] = []
    code: str | None = None


class HrApiError(Exception):
    """The HR API answered with an error status."""

    def __init__(
        self,
        status_code: int,
        message: str,
        *,
        issues: list[ApiIssue] | None = None,
        problems: list[ApiProblem] | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(f"HR API {status_code}: {message}")
        self.status_code = status_code
        self.message = message
        self.issues = issues or []
        self.problems = problems or []
        self.code = code

    @classmethod
    def from_response(cls, response: httpx.Response) -> Self:
        body = _ApiErrorBody()
        try:
            body = _ApiErrorBody.model_validate(response.json())
        except (ValueError, ValidationError):
            pass  # Not our JSON error shape (e.g. a proxy's HTML page); fall back below.

        message = body.message
        if isinstance(message, list):
            message = "; ".join(message)
        return cls(
            response.status_code,
            message or response.reason_phrase or "Request failed",
            issues=body.issues,
            problems=body.problems,
            code=body.code,
        )


class HrApiUnavailableError(Exception):
    """The HR API could not be reached (connection refused, timeout, …)."""


class SessionUser(ApiModel):
    id: str
    email: str
    name: str
    role: str
    employee_id: str | None
    permissions: list[str]
    must_change_password: bool


class LoginResponse(ApiModel):
    access_token: str
    expires_at: str
    user: SessionUser


class EmployeeRef(ApiModel):
    id: str
    employee_code: str
    first_name: str
    last_name: str

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"


class Employee(EmployeeRef):
    """The fields the agent uses from the API's Employee; the rest is ignored."""

    job_title: str
    location: str
    status: str


class Department(ApiModel):
    id: str
    name: str
    code: str
    status: str
    employee_count: int


class LeaveRequest(ApiModel):
    id: str
    employee: EmployeeRef
    type: str
    start_date: date
    end_date: date
    days: float
    status: str
    can_decide: bool


class HrApiClient:
    """Calls the HR API as one user.

    Share one `httpx.AsyncClient` (it pools connections); create one of these per request.
    """

    def __init__(self, http: httpx.AsyncClient, token: str | None = None) -> None:
        self._http = http
        self._token = token

    def with_token(self, token: str) -> "HrApiClient":
        return HrApiClient(self._http, token)

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        """Sends a request and returns the decoded JSON body (None for an empty body)."""
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            response = await self._http.request(
                method, path, json=json, params=params, headers=headers
            )
        except httpx.TransportError as error:
            raise HrApiUnavailableError(f"HR API unreachable: {error!r}") from error

        if response.is_error:
            raise HrApiError.from_response(response)
        return response.json() if response.content else None

    async def download(self, path: str) -> tuple[bytes, str]:
        """A file endpoint's body and Content-Type."""
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            response = await self._http.get(path, headers=headers)
        except httpx.TransportError as error:
            raise HrApiUnavailableError(f"HR API unreachable: {error!r}") from error
        if response.is_error:
            raise HrApiError.from_response(response)
        return response.content, response.headers.get("content-type", "")

    async def get(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        return await self.request("GET", path, params=params)

    async def post(self, path: str, json: Any = None) -> Any:
        return await self.request("POST", path, json=json)

    async def patch(self, path: str, json: Any = None) -> Any:
        return await self.request("PATCH", path, json=json)

    async def delete(self, path: str) -> Any:
        return await self.request("DELETE", path)

    async def login(self, email: str, password: str) -> LoginResponse:
        data = await self.post("/auth/login", {"email": email, "password": password})
        return LoginResponse.model_validate(data)

    async def me(self) -> SessionUser:
        return SessionUser.model_validate(await self.get("/auth/me"))

    async def search_employees(self, q: str, *, page_size: int = 20) -> list[Employee]:
        """Active and probation employees whose name, email or code contains every word of q."""
        data = await self.get("/employees", params={"q": q, "pageSize": page_size})
        return [Employee.model_validate(item) for item in data["items"]]

    async def list_departments(self) -> list[Department]:
        """List departments visible to the signed-in user for name/code resolution."""
        data = await self.get("/departments")
        return [Department.model_validate(item) for item in data]

    async def pending_leave_to_decide(
        self,
        *,
        employee_id: str | None = None,
        leave_type: str | None = None,
        overlapping: tuple[date, date] | None = None,
    ) -> list[LeaveRequest]:
        """Pending requests the caller may approve or reject (`view=approvals`), oldest start
        first. `overlapping` keeps requests that touch that date range."""
        params: dict[str, Any] = {"view": "approvals", "pageSize": 100}
        if employee_id:
            params["employeeId"] = employee_id
        if leave_type:
            params["type"] = leave_type
        if overlapping:
            params["from"], params["to"] = (d.isoformat() for d in overlapping)
        data = await self.get("/leave-requests", params=params)
        return [LeaveRequest.model_validate(item) for item in data["items"]]
