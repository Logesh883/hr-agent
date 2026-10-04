"""What a tool is: a name and description for the model, a typed input, and a `run` function.

The model only ever sees `spec()`: the name, the description and a JSON schema of the input.
Everything else (validation, timeouts, error wording, permissions) is code in this package.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from typing import TYPE_CHECKING, Any, cast

from pydantic import BaseModel, ConfigDict

from app.hr_client import HrApiClient, SessionUser
from llm.types import ToolSpec

if TYPE_CHECKING:
    from rag.retrieval import PolicyRetriever


class Risk(StrEnum):
    """How much harm a wrong call can do. M3 has only reads; M6 adds writes behind approval."""

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


class ToolError(Exception):
    """A failure the model can act on, worded for it ("Search for the employee first")."""


class ToolResult(BaseModel):
    """The uniform shape every tool call ends in, success or not."""

    ok: bool
    data: Any = None
    # Plain-language reason for the model; never a stack trace.
    error: str | None = None

    @classmethod
    def success(cls, data: Any) -> "ToolResult":
        return cls(ok=True, data=data)

    @classmethod
    def failure(cls, error: str) -> "ToolResult":
        return cls(ok=False, error=error)


@dataclass(frozen=True)
class Tool[ArgsT: ToolInput]:
    name: str
    # The model picks tools by their descriptions: say what it returns and when to use it.
    description: str
    input_model: type[ArgsT]
    run: Callable[[ToolContext, ArgsT], Awaitable[Any]]
    risk: Risk = Risk.READ
    timeout_s: float = 15.0

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
