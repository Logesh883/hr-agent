"""One trace per agent request, with an observation (span) for every LLM call and tool call.

The trace is recorded in memory while the agent runs and exported afterwards (see
`tracing.langfuse`), so tracing can never slow down or break an answer.
"""

from collections.abc import Generator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field

from llm.types import Usage


def _now() -> datetime:
    return datetime.now(UTC)


def _id() -> str:
    return str(uuid4())


class Observation(BaseModel):
    """A timed step inside a trace. `generation` is Langfuse's name for an LLM call."""

    id: str = Field(default_factory=_id)
    kind: Literal["span", "generation"] = "span"
    name: str
    parent_id: str | None = None
    start_time: datetime = Field(default_factory=_now)
    end_time: datetime | None = None
    input: Any = None
    output: Any = None
    metadata: dict[str, Any] = {}
    level: Literal["DEFAULT", "WARNING", "ERROR"] = "DEFAULT"
    status_message: str | None = None
    # Generations only.
    model: str | None = None
    model_parameters: dict[str, Any] | None = None
    usage: Usage | None = None

    @property
    def latency_ms(self) -> float:
        end = self.end_time or _now()
        return round((end - self.start_time).total_seconds() * 1000, 1)


class Trace(BaseModel):
    id: str = Field(default_factory=_id)
    name: str
    user_id: str | None = None
    input: Any = None
    output: Any = None
    metadata: dict[str, Any] = {}
    tags: list[str] = []
    start_time: datetime = Field(default_factory=_now)
    end_time: datetime | None = None
    observations: list[Observation] = []
    # Names of real people seen in this run (the user, employees in tool results); masked
    # wherever they appear before export.
    known_names: set[str] = set()

    @contextmanager
    def observe(
        self,
        name: str,
        *,
        kind: Literal["span", "generation"] = "span",
        input: Any = None,
        parent: Observation | None = None,
        **fields: Any,
    ) -> Generator[Observation]:
        """Times the block. An exception marks the observation as an error and propagates."""
        observation = Observation(
            name=name,
            kind=kind,
            input=input,
            parent_id=parent.id if parent else None,
            **fields,
        )
        self.observations.append(observation)
        try:
            yield observation
        except Exception as error:
            observation.level = "ERROR"
            observation.status_message = f"{type(error).__name__}: {error}"
            raise
        finally:
            observation.end_time = _now()

    def finish(self, output: Any) -> None:
        self.output = output
        self.end_time = _now()

    @property
    def usage(self) -> Usage:
        """Token usage summed over every LLM call in the trace."""
        total = Usage()
        for observation in self.observations:
            if observation.usage:
                total.prompt_tokens += observation.usage.prompt_tokens
                total.completion_tokens += observation.usage.completion_tokens
        return total
