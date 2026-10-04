"""The set of tools an agent may use, and the one place a model's tool call gets executed.

`execute` is where code, not the model, decides: an unknown tool, malformed JSON, arguments
that fail validation, a timeout or an HR API refusal all become a `ToolResult` with a plain
error the model can read and act on. Nothing reaches `Tool.run` unvalidated.
"""

import asyncio
import json
import logging
from collections.abc import Iterable
from time import perf_counter
from typing import Any

from pydantic import TypeAdapter, ValidationError

from app.hr_client import HrApiError, HrApiUnavailableError
from llm.types import ToolCall, ToolSpec
from tools.base import Tool, ToolContext, ToolError, ToolResult

logger = logging.getLogger("hr_ai.tools")

# A tool result goes back into the prompt; past this size it crowds out everything else.
MAX_RESULT_CHARS = 8000

_JSON = TypeAdapter[Any](Any)


class ToolRegistry:
    def __init__(self, tools: Iterable[Tool[Any]]) -> None:
        self._tools: dict[str, Tool[Any]] = {}
        for tool in tools:
            if tool.name in self._tools:
                raise ValueError(f"Duplicate tool name: {tool.name}")
            self._tools[tool.name] = tool

    @property
    def names(self) -> list[str]:
        return list(self._tools)

    def get(self, name: str) -> Tool[Any] | None:
        return self._tools.get(name)

    def specs(self) -> list[ToolSpec]:
        return [tool.spec() for tool in self._tools.values()]

    async def execute(self, call: ToolCall, ctx: ToolContext) -> ToolResult:
        """Validate, run with a timeout, and turn every failure into a readable `ToolResult`."""
        start = perf_counter()
        result = await self._execute(call, ctx)
        logger.info(
            "tool.call",
            extra={
                "fields": {
                    "tool": call.name,
                    "ok": result.ok,
                    "latency_ms": round((perf_counter() - start) * 1000, 1),
                    # The error is ours (no employee data); the data itself is never logged.
                    "error": result.error,
                }
            },
        )
        return result

    async def _execute(self, call: ToolCall, ctx: ToolContext) -> ToolResult:
        tool = self._tools.get(call.name)
        if tool is None:
            return ToolResult.failure(
                f"Unknown tool '{call.name}'. Available tools: {', '.join(self._tools)}."
            )
        try:
            raw = json.loads(call.arguments or "{}")
        except json.JSONDecodeError as error:
            return ToolResult.failure(f"Arguments must be a JSON object ({error.msg}).")
        try:
            args = tool.input_model.model_validate(raw)
        except ValidationError as error:
            return ToolResult.failure(f"Invalid arguments: {validation_summary(error)}")

        try:
            async with asyncio.timeout(tool.timeout_s):
                data = await tool.run(ctx, args)
        except TimeoutError:
            return ToolResult.failure(f"The tool timed out after {tool.timeout_s:g} seconds.")
        except ToolError as error:
            return ToolResult.failure(str(error))
        except HrApiError as error:
            return ToolResult.failure(describe_hr_error(error))
        except HrApiUnavailableError:
            return ToolResult.failure("The HR system is unavailable right now. Try again later.")
        except ValidationError:
            # The HR API answered with a shape our contracts don't describe: a bug, not the
            # model's fault, so it gets no detail it could try to "fix".
            logger.exception("tool.bad_response", extra={"fields": {"tool": tool.name}})
            return ToolResult.failure("The HR system returned data in an unexpected format.")
        except Exception:
            logger.exception("tool.crash", extra={"fields": {"tool": tool.name}})
            return ToolResult.failure("The tool failed unexpectedly.")
        return ToolResult.success(_JSON.dump_python(data, mode="json"))


def result_content(result: ToolResult) -> str:
    """The tool message content sent back to the model: compact JSON, capped in size."""
    text = result.model_dump_json(exclude_none=True)
    if len(text) <= MAX_RESULT_CHARS:
        return text
    return json.dumps(
        {
            "ok": result.ok,
            "truncated": True,
            "note": "The result was too large and was cut off. Narrow the request "
            "(a single employee, a shorter date range) for complete data.",
            "partial": text[:MAX_RESULT_CHARS],
        },
        ensure_ascii=False,
    )


def describe_hr_error(error: HrApiError) -> str:
    """HR API errors, reworded for the model. 403 and 404 are permissions, not bugs."""
    if error.status_code == 401:
        return "The user's session has expired. Ask them to sign in again."
    if error.status_code == 403:
        return f"You don't have access to that. The HR system refused: {error.message}."
    if error.status_code == 404:
        if error.message == "Employee not found":
            # The API answers 404 for employees outside the user's scope, so it doesn't reveal
            # who exists. The model must not claim either way.
            return "You don't have access to that employee, or no such employee exists."
        return f"{error.message}. It doesn't exist or you don't have access to it."
    if error.issues:
        details = "; ".join(f"{issue.path or 'request'}: {issue.message}" for issue in error.issues)
        return f"The HR system rejected the request: {details}."
    if error.problems:
        details = "; ".join(problem.message for problem in error.problems)
        return f"The HR system refused: {details}"
    return f"The HR system refused the request ({error.status_code}): {error.message}."


def validation_summary(error: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(part) for part in item['loc']) or 'arguments'}: {item['msg']}"
        for item in error.errors(include_input=False)
    )
