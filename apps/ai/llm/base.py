import logging
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Sequence
from time import perf_counter
from typing import Any

from llm.types import LLMResponse, Message, PromptRef, StreamChunk, ToolSpec

logger = logging.getLogger("hr_ai.llm")


class LLMError(Exception):
    """A model call failed after any retries."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class LLMClient(ABC):
    """One interface for every model. Subclasses implement `_chat` and `_stream`.

    The public methods time the call and write exactly one `llm.call` log line, success or
    failure, with token usage and latency. Message content is never logged: it may hold
    employee data.
    """

    provider: str
    model: str

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
        start = perf_counter()
        try:
            response = await self._chat(
                list(messages),
                tools=tools,
                response_format=response_format,
                temperature=temperature,
                max_tokens=max_tokens,
            )
        except Exception as error:
            self._log(prompt, start, temperature, error=error)
            raise
        response.latency_ms = _elapsed_ms(start)
        self._log(
            prompt,
            start,
            temperature,
            prompt_tokens=response.usage.prompt_tokens,
            completion_tokens=response.usage.completion_tokens,
            finish_reason=response.finish_reason,
            tool_calls=len(response.tool_calls),
        )
        return response

    async def stream(
        self,
        messages: Sequence[Message],
        *,
        temperature: float = 0.0,
        max_tokens: int = 1024,
        prompt: PromptRef | None = None,
    ) -> AsyncIterator[StreamChunk]:
        """Yields text as it's generated; the final chunk has `done=True` with the totals."""
        start = perf_counter()
        ttft_ms: float | None = None
        try:
            async for chunk in self._stream(
                list(messages), temperature=temperature, max_tokens=max_tokens
            ):
                if chunk.text and ttft_ms is None:
                    ttft_ms = _elapsed_ms(start)
                if not chunk.done:
                    yield chunk
                    continue
                chunk.latency_ms = _elapsed_ms(start)
                chunk.ttft_ms = ttft_ms
                try:
                    # Hand over the totals first, so a caller printing the reply can finish
                    # its line before the log line appears; `finally` logs even if it stops.
                    yield chunk
                finally:
                    usage = chunk.usage
                    self._log(
                        prompt,
                        start,
                        temperature,
                        stream=True,
                        latency_ms=chunk.latency_ms,
                        ttft_ms=ttft_ms,
                        prompt_tokens=usage.prompt_tokens if usage else None,
                        completion_tokens=usage.completion_tokens if usage else None,
                        finish_reason=chunk.finish_reason,
                    )
        except Exception as error:
            self._log(prompt, start, temperature, stream=True, error=error)
            raise

    @abstractmethod
    async def _chat(
        self,
        messages: list[Message],
        *,
        tools: list[ToolSpec] | None,
        response_format: dict[str, Any] | None,
        temperature: float,
        max_tokens: int,
    ) -> LLMResponse: ...

    @abstractmethod
    def _stream(
        self, messages: list[Message], *, temperature: float, max_tokens: int
    ) -> AsyncIterator[StreamChunk]:
        """Must end with one chunk that has `done=True`."""
        ...

    async def aclose(self) -> None:  # noqa: B027 (optional hook, not abstract)
        """Releases connections or model memory. Default: nothing to release."""

    def _log(
        self,
        prompt: PromptRef | None,
        start: float,
        temperature: float,
        *,
        error: Exception | None = None,
        **fields: Any,
    ) -> None:
        record: dict[str, Any] = {
            "provider": self.provider,
            "model": self.model,
            "prompt": str(prompt) if prompt else None,
            "temperature": temperature,
            "latency_ms": _elapsed_ms(start),
            "status": "error" if error else "ok",
            **fields,
        }
        if error:
            record["error"] = f"{type(error).__name__}: {error}"
            logger.warning("llm.call", extra={"fields": record})
        else:
            logger.info("llm.call", extra={"fields": record})


def _elapsed_ms(start: float) -> float:
    return round((perf_counter() - start) * 1000, 1)
