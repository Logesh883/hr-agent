from collections import deque
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass
from typing import Any

from llm.base import LLMClient
from llm.types import LLMResponse, Message, StreamChunk, ToolSpec, Usage

ScriptItem = LLMResponse | str | Exception


@dataclass
class FakeCall:
    messages: list[Message]
    tools: list[ToolSpec] | None
    response_format: dict[str, Any] | None
    temperature: float
    max_tokens: int


class FakeLLM(LLMClient):
    """Replays scripted responses so agent logic can be tested without a model.

    Each call (chat or stream) takes the next item: a string (plain text reply), an
    `LLMResponse` (e.g. with tool calls), or an exception to raise. Calls are recorded in
    `calls` so tests can assert on what the agent sent.
    """

    provider = "fake"

    def __init__(self, script: Iterable[ScriptItem] = (), *, model: str = "fake-model") -> None:
        self.model = model
        self._script: deque[ScriptItem] = deque(script)
        self.calls: list[FakeCall] = []

    def queue(self, *items: ScriptItem) -> None:
        self._script.extend(items)

    async def _chat(
        self,
        messages: list[Message],
        *,
        tools: list[ToolSpec] | None,
        response_format: dict[str, Any] | None,
        temperature: float,
        max_tokens: int,
    ) -> LLMResponse:
        self.calls.append(FakeCall(messages, tools, response_format, temperature, max_tokens))
        return self._next(messages)

    async def _stream(
        self, messages: list[Message], *, temperature: float, max_tokens: int
    ) -> AsyncIterator[StreamChunk]:
        self.calls.append(FakeCall(messages, None, None, temperature, max_tokens))
        response = self._next(messages)
        words = (response.text or "").split(" ")
        for index, word in enumerate(words):
            yield StreamChunk(text=word if index == 0 else f" {word}")
        yield StreamChunk(done=True, usage=response.usage, finish_reason=response.finish_reason)

    def _next(self, messages: list[Message]) -> LLMResponse:
        if not self._script:
            raise AssertionError(f"FakeLLM script is empty (call #{len(self.calls)})")
        item = self._script.popleft()
        if isinstance(item, Exception):
            raise item
        if isinstance(item, str):
            # Rough token counts (words), so usage logging has something to show.
            prompt_words = sum(len((m.content or "").split()) for m in messages)
            return LLMResponse(
                text=item,
                usage=Usage(prompt_tokens=prompt_words, completion_tokens=len(item.split())),
                model=self.model,
                finish_reason="stop",
            )
        return item.model_copy(deep=True)
