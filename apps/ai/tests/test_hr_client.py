from collections.abc import AsyncIterator

import httpx
import pytest
import respx

from app.hr_client import ApiIssue, ApiProblem, HrApiClient, HrApiError, HrApiUnavailableError

BASE_URL = "http://hr.test"

SESSION_USER = {
    "id": "u1",
    "email": "hr@hr.local",
    "name": "Lakshmi",
    "role": "HR_OPERATIONS",
    "employeeId": "e1",
    "permissions": ["employee:read", "leave:approve"],
    "mustChangePassword": False,
}


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        yield client


@pytest.fixture
def hr(http: httpx.AsyncClient) -> HrApiClient:
    return HrApiClient(http, token="user-token")


@respx.mock
async def test_forwards_bearer_token_and_parses_session_user(hr: HrApiClient) -> None:
    route = respx.get(f"{BASE_URL}/auth/me").respond(json=SESSION_USER)

    user = await hr.me()

    assert route.calls.last.request.headers["authorization"] == "Bearer user-token"
    assert user.employee_id == "e1"
    assert user.must_change_password is False


@respx.mock
async def test_login_sends_no_token(http: httpx.AsyncClient) -> None:
    route = respx.post(f"{BASE_URL}/auth/login").respond(
        json={"accessToken": "t", "expiresAt": "2026-09-30T00:00:00.000Z", "user": SESSION_USER}
    )

    result = await HrApiClient(http).login("hr@hr.local", "Password123!")

    assert "authorization" not in route.calls.last.request.headers
    assert result.access_token == "t"
    assert result.user.email == "hr@hr.local"


@respx.mock
async def test_passes_query_params_and_json_body(hr: HrApiClient) -> None:
    get_route = respx.get(f"{BASE_URL}/employees", params={"q": "sneha"}).respond(json=[])
    post_route = respx.post(f"{BASE_URL}/leave-requests").respond(201, json={"id": "l1"})

    assert await hr.get("/employees", params={"q": "sneha"}) == []
    assert await hr.post("/leave-requests", {"days": 2}) == {"id": "l1"}
    assert get_route.called
    assert post_route.calls.last.request.content == b'{"days":2}'


@respx.mock
async def test_empty_body_returns_none(hr: HrApiClient) -> None:
    respx.delete(f"{BASE_URL}/documents/d1").respond(204)

    assert await hr.delete("/documents/d1") is None


@respx.mock
async def test_validation_error_maps_issues(hr: HrApiClient) -> None:
    respx.post(f"{BASE_URL}/employees").respond(
        400,
        json={
            "statusCode": 400,
            "message": "Validation failed",
            "issues": [{"path": "email", "message": "Invalid email address"}],
        },
    )

    with pytest.raises(HrApiError) as caught:
        await hr.post("/employees", {"email": "nope"})

    assert caught.value.status_code == 400
    assert caught.value.message == "Validation failed"
    assert caught.value.issues == [ApiIssue(path="email", message="Invalid email address")]


@respx.mock
async def test_business_rule_error_maps_problems(hr: HrApiClient) -> None:
    respx.post(f"{BASE_URL}/leave-requests").respond(
        422,
        json={
            "statusCode": 422,
            "message": "Not enough casual leave left.",
            "problems": [
                {"code": "INSUFFICIENT_BALANCE", "message": "Not enough casual leave left."}
            ],
        },
    )

    with pytest.raises(HrApiError) as caught:
        await hr.post("/leave-requests", {})

    assert caught.value.status_code == 422
    assert caught.value.problems == [
        ApiProblem(code="INSUFFICIENT_BALANCE", message="Not enough casual leave left.")
    ]


@respx.mock
async def test_error_code_is_kept(hr: HrApiClient) -> None:
    respx.get(f"{BASE_URL}/employees").respond(
        403,
        json={
            "statusCode": 403,
            "message": "Change your temporary password first",
            "code": "PASSWORD_CHANGE_REQUIRED",
        },
    )

    with pytest.raises(HrApiError) as caught:
        await hr.get("/employees")

    assert caught.value.status_code == 403
    assert caught.value.code == "PASSWORD_CHANGE_REQUIRED"


@respx.mock
async def test_nest_list_message_is_joined(hr: HrApiClient) -> None:
    respx.get(f"{BASE_URL}/x").respond(
        400, json={"statusCode": 400, "message": ["a is wrong", "b is wrong"], "error": "Bad"}
    )

    with pytest.raises(HrApiError) as caught:
        await hr.get("/x")

    assert caught.value.message == "a is wrong; b is wrong"


@respx.mock
async def test_non_json_error_falls_back_to_reason_phrase(hr: HrApiClient) -> None:
    respx.get(f"{BASE_URL}/employees").respond(502, text="<html>Bad Gateway</html>")

    with pytest.raises(HrApiError) as caught:
        await hr.get("/employees")

    assert caught.value.status_code == 502
    assert caught.value.message == "Bad Gateway"
    assert caught.value.issues == []


@respx.mock
async def test_connection_failure_raises_unavailable(hr: HrApiClient) -> None:
    respx.get(f"{BASE_URL}/employees").mock(side_effect=httpx.ConnectError("refused"))

    with pytest.raises(HrApiUnavailableError):
        await hr.get("/employees")
