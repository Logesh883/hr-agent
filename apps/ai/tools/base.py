"""What a tool is: a name and description for the model, a typed input, and a `run` function.

The model only ever sees `spec()`: the name, the description and a JSON schema of the input.
Everything else (validation, timeouts, error wording, permissions) is code in this package.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Literal, Protocol, cast

from pydantic import BaseModel, ConfigDict

from app.hr_client import HrApiClient, SessionUser
from llm.types import ToolSpec

if TYPE_CHECKING:
    from rag.retrieval import PolicyRetriever


class Risk(StrEnum):
    """Whether a tool changes anything. How *risky* a particular write is (low / medium /
    high, and so whether it needs approval) is the risk policy's call (agent/risk.py)."""

    READ = "read"
    WRITE = "write"


class ToolInput(BaseModel):
    """Base for tool arguments. Unknown fields are an error, so a typo can't be ignored."""

    model_config = ConfigDict(extra="forbid")


@dataclass(frozen=True)
class ToolContext:
    """What a tool runs with. The HR client carries the signed-in user's token."""

    hr: HrApiClient
    user: SessionUser
    today: date
    # Policy search (M4); None when embeddings aren't configured, and then the agent isn't
    # offered `search_policy` at all.
    policies: "PolicyRetriever | None" = None
    # Write tools send this as Idempotency-Key: stable for one plan step, so a retried or
    # resumed step returns the first result instead of acting twice.
    idempotency_key: str | None = None
    # Where send_email writes (it never sends). None: the tool refuses.
    outbox: "Outbox | None" = None


class Outbox(Protocol):
    async def add(self, message: dict[str, Any]) -> str: ...


class ToolError(Exception):
    """A failure the model can act on, worded for it ("Search for the employee first")."""


# What kind of failure, so code can decide what to do next (M7, A7.3):
#   invalid      the call was wrong (bad arguments, 400): fix it or ask the user
#   rule         a business rule refused it (422 problems): relay them word for word
#   forbidden    403 / not_found 404: stop and explain
#   conflict     409: stale version (re-read, retry once) or a duplicate
#   busy         409: the same Idempotency-Key is still being handled; retry shortly
#   server, unavailable, timeout, busy: transient, worth retrying
#   auth, bad_response, crash, tool: stop
ErrorKind = Literal[
    "invalid",
    "rule",
    "forbidden",
    "not_found",
    "conflict",
    "busy",
    "server",
    "unavailable",
    "timeout",
    "auth",
    "bad_response",
    "crash",
    "tool",
]
TRANSIENT: frozenset[str] = frozenset({"server", "unavailable", "timeout", "busy"})


class ToolResult(BaseModel):
    """The uniform shape every tool call ends in, success or not."""

    ok: bool
    data: Any = None
    # Plain-language reason for the model; never a stack trace.
    error: str | None = None
    error_kind: ErrorKind | None = None
    status_code: int | None = None

    @classmethod
    def success(cls, data: Any) -> "ToolResult":
        return cls(ok=True, data=data)

    @classmethod
    def failure(
        cls, error: str, kind: ErrorKind = "tool", status_code: int | None = None
    ) -> "ToolResult":
        return cls(ok=False, error=error, error_kind=kind, status_code=status_code)

    @property
    def transient(self) -> bool:
        return self.error_kind in TRANSIENT


type Shape = dict[str, "Shape"] | list["Shape"] | None


@dataclass(frozen=True)
class Tool[ArgsT: ToolInput]:
    name: str
    # The model picks tools by their descriptions: say what it returns and when to use it.
    description: str
    input_model: type[ArgsT]
    run: Callable[[ToolContext, ArgsT], Awaitable[Any]]
    risk: Risk = Risk.READ
    timeout_s: float = 15.0
    # Write tools: what would change, as {"summary", "before", "after"}, computed without
    # changing anything. Shown for approval (A6.4).
    preview: Callable[[ToolContext, ArgsT], Awaitable[dict[str, Any]]] | None = None
    # The fields of the tool's result, so a plan's `$sN.…` references can be checked
    # before anything runs: {"key": shape} for an object, [shape] for a list, None for a
    # value. The planner is shown it too. None: not declared, references aren't checked.
    returns: "Shape" = None

    def spec(self) -> ToolSpec:
        """The OpenAI-format definition sent to the model."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": tool_parameters(self.input_model),
            },
        }


def tool_parameters(model: type[BaseModel]) -> dict[str, Any]:
    """The input model's JSON schema without pydantic's `title` keys, which only cost tokens.

    Field descriptions stay: they are how the model learns what to pass.
    """
    return _strip_titles(model.model_json_schema())


def _strip_titles(node: Any, *, field_names: bool = False) -> Any:
    """Drops every `title` key, except a field that happens to be called "title"."""
    if isinstance(node, dict):
        items = cast(dict[str, Any], node)
        return {
            key: _strip_titles(value, field_names=not field_names and key == "properties")
            for key, value in items.items()
            if field_names or key != "title"
        }
    if isinstance(node, list):
        return [_strip_titles(item) for item in cast(list[Any], node)]
    return node
