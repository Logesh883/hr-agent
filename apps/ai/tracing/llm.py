"""`TracedLLM`: wraps an LLM client so each `chat` call becomes a generation in the trace.

The M3 loop records its own generations. The HR graph's other model calls (parse the
request, plan, write the answer) go through this wrapper, so every LLM call in a run shows
up in Langfuse and in the `agent_run` records (A5.6) with its model, prompt version, tokens
and latency.
"""

from collections.abc import AsyncIterator, Sequence
from typing import Any

from llm.base import LLMClient
from llm.types import LLMResponse, Message, PromptRef, StreamChunk, ToolSpec
from tracing.trace import Trace


class TracedLLM(LLMClient):
    def __init__(self, inner: LLMClient, trace: Trace, name: str) -> None:
        self.inner = inner
        self.trace = trace
        self.name = name
        self.provider = inner.provider
        self.model = inner.model

    async def chat(
        self,
        messages: Sequence[Message],
        *,
        tools: list[ToolSpec] | None = None,
        response_format: dict[str, Any] | None = None,
        temperature: float = 0.0,
        max_tokens: int = 1024,
        prompt: PromptRef | None = None,
    ) -> LLMResponse:
        with self.trace.observe(
            self.name,
            kind="generation",
            input=[m.to_wire() for m in messages],
            model_parameters={"temperature": temperature, "max_tokens": max_tokens},
            metadata={"prompt": str(prompt) if prompt else None},
        ) as generation:
            response = await self.inner.chat(
                messages,
                tools=tools,
                response_format=response_format,
                temperature=temperature,
                max_tokens=max_tokens,
                prompt=prompt,
            )
            generation.model = response.model or self.inner.model
            generation.usage = response.usage
            generation.output = {
                "text": response.text,
                "tool_calls": [c.model_dump() for c in response.tool_calls],
                "finish_reason": response.finish_reason,
            }
        return response

    async def _chat(
        self,
        messages: list[Message],
        *,
        tools: list[ToolSpec] | None,
        response_format: dict[str, Any] | None,
        temperature: float,
        max_tokens: int,
    ) -> LLMResponse:
        raise NotImplementedError("TracedLLM overrides chat()")

    async def _stream(
        self, messages: list[Message], *, temperature: float, max_tokens: int
    ) -> AsyncIterator[StreamChunk]:
        async for chunk in self.inner.stream(
            messages, temperature=temperature, max_tokens=max_tokens
        ):
            yield chunk
