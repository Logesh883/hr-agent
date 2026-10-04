import asyncio
import json
from collections.abc import AsyncIterator
from datetime import date
from typing import Any

import httpx
import pytest
from pydantic import Field

from app.hr_client import ApiProblem, HrApiClient, HrApiError, HrApiUnavailableError, SessionUser
from llm.types import ToolCall
from tests.hr_data import BASE_URL, session_user
from tools.base import Tool, ToolContext, ToolError, ToolInput, ToolResult
from tools.registry import MAX_RESULT_CHARS, ToolRegistry, result_content


class EchoInput(ToolInput):
    day: date = Field(description="A day, YYYY-MM-DD.")
    title: str | None = None


async def echo(ctx: ToolContext, args: EchoInput) -> dict[str, Any]:
    return {"day": args.day, "user": ctx.user.name}


def raising(error: Exception) -> Tool[EchoInput]:
    async def run(ctx: ToolContext, args: EchoInput) -> None:
        raise error

    return Tool(name="boom", description="Fails.", input_model=EchoInput, run=run)


ECHO = Tool(name="echo", description="Echoes a day.", input_model=EchoInput, run=echo)


@pytest.fixture
async def ctx() -> AsyncIterator[ToolContext]:
    async with httpx.AsyncClient(base_url=BASE_URL) as http:
        user = SessionUser.model_validate(session_user("HR_OPS", "Lakshmi Pillai", None))
        yield ToolContext(hr=HrApiClient(http, "t"), user=user, today=date(2026, 10, 3))


def call(name: str, arguments: str) -> ToolCall:
    return ToolCall(id="c1", name=name, arguments=arguments)


def test_spec_is_openai_format_without_pydantic_titles() -> None:
    spec = ECHO.spec()

    assert spec["type"] == "function"
    function = spec["function"]
    assert function["name"] == "echo"
    params = function["parameters"]
    assert "title" not in params
    assert params["additionalProperties"] is False
    assert params["required"] == ["day"]
    # A field called "title" survives; only pydantic's schema titles are dropped.
    assert set(params["properties"]) == {"day", "title"}
    assert params["properties"]["day"] == {
        "description": "A day, YYYY-MM-DD.",
        "format": "date",
        "type": "string",
    }


def test_duplicate_tool_names_are_rejected() -> None:
    with pytest.raises(ValueError, match="Duplicate"):
        ToolRegistry([ECHO, ECHO])


async def test_valid_call_runs_and_returns_json_data(ctx: ToolContext) -> None:
    result = await ToolRegistry([ECHO]).execute(call("echo", '{"day": "2026-10-12"}'), ctx)

    assert result.ok
    assert result.data == {"day": "2026-10-12", "user": "Lakshmi Pillai"}


async def test_unknown_tool_lists_the_real_ones(ctx: ToolContext) -> None:
    result = await ToolRegistry([ECHO]).execute(call("delete_everyone", "{}"), ctx)

    assert not result.ok
    assert result.error == "Unknown tool 'delete_everyone'. Available tools: echo."


async def test_invalid_json_is_reported(ctx: ToolContext) -> None:
    result = await ToolRegistry([ECHO]).execute(call("echo", '{"day": '), ctx)

    assert not result.ok
    assert result.error and result.error.startswith("Arguments must be a JSON object")


@pytest.mark.parametrize(
    ("arguments", "expected"),
    [
        ('{"day": "next Friday"}', "day: Input should be a valid date"),
        ("{}", "day: Field required"),
        ('{"day": "2026-10-12", "admin": true}', "admin: Extra inputs are not permitted"),
    ],
)
async def test_arguments_are_validated_before_the_tool_runs(
    ctx: ToolContext, arguments: str, expected: str
) -> None:
    ran = False

    async def run(ctx: ToolContext, args: EchoInput) -> None:
        nonlocal ran
        ran = True

    tool = Tool(name="echo", description="", input_model=EchoInput, run=run)
    result = await ToolRegistry([tool]).execute(call("echo", arguments), ctx)

    assert not ran
    assert result.error and expected in result.error


async def test_slow_tools_time_out(ctx: ToolContext) -> None:
    async def slow(ctx: ToolContext, args: EchoInput) -> None:
        await asyncio.sleep(1)

    tool = Tool(name="slow", description="", input_model=EchoInput, run=slow, timeout_s=0.01)
    result = await ToolRegistry([tool]).execute(call("slow", '{"day": "2026-10-12"}'), ctx)

    assert result.error == "The tool timed out after 0.01 seconds."


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (ToolError("Search for the employee first."), "Search for the employee first."),
        (
            HrApiError(403, "Your role (EMPLOYEE) lacks permission: payroll:read"),
            "You don't have access to that. The HR system refused: "
            "Your role (EMPLOYEE) lacks permission: payroll:read.",
        ),
        (
            HrApiError(404, "Employee not found"),
            "You don't have access to that employee, or no such employee exists.",
        ),
        (
            HrApiError(422, "Leave not allowed", problems=[ApiProblem(code="X", message="No.")]),
            "The HR system refused: No.",
        ),
        (
            HrApiError(401, "Unauthorized"),
            "The user's session has expired. Ask them to sign in again.",
        ),
        (HrApiUnavailableError("down"), "The HR system is unavailable right now. Try again later."),
        (RuntimeError("secret stack detail"), "The tool failed unexpectedly."),
    ],
)
async def test_failures_become_plain_errors_the_model_can_use(
    ctx: ToolContext, error: Exception, expected: str
) -> None:
    result = await ToolRegistry([raising(error)]).execute(
        call("boom", '{"day": "2026-10-12"}'), ctx
    )

    assert not result.ok
    assert result.error == expected


async def test_large_results_are_cut_with_a_note(ctx: ToolContext) -> None:
    async def huge(ctx: ToolContext, args: EchoInput) -> list[str]:
        return ["x" * 100] * 500

    tool = Tool(name="huge", description="", input_model=EchoInput, run=huge)
    result = await ToolRegistry([tool]).execute(call("huge", '{"day": "2026-10-12"}'), ctx)

    content = json.loads(result_content(result))
    assert content["truncated"] is True
    assert "Narrow the request" in content["note"]
    assert len(content["partial"]) == MAX_RESULT_CHARS


def test_small_results_are_sent_whole_without_empty_fields() -> None:
    assert result_content(ToolResult.success({"a": 1})) == '{"ok":true,"data":{"a":1}}'
    assert result_content(ToolResult.failure("No.")) == '{"ok":false,"error":"No."}'
