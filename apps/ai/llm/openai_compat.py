"""Client for any OpenAI-compatible chat completions API (Groq, Gemini, OpenRouter, HF, …).

Plain httpx rather than a provider SDK, so every request, retry and streamed line is visible
and the rest of the code never depends on one vendor.
"""

import asyncio
import json
import logging
import random
from collections.abc import AsyncIterator
from typing import Any, cast

import httpx
from pydantic import BaseModel, ValidationError

from llm.base import LLMClient, LLMError
from llm.types import LLMResponse, Message, StreamChunk, ToolCall, ToolSpec, Usage

logger = logging.getLogger("hr_ai.llm")

# Rate limited or a server-side hiccup: worth another try. Other 4xx errors are our fault.
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
MAX_RETRY_AFTER_SECONDS = 60.0


class _WireFunction(BaseModel):
    name: str
    arguments: str | None = None


class _WireToolCall(BaseModel):
    id: str
    function: _WireFunction
    extra_content: dict[str, Any] | None = None


class _WireMessage(BaseModel):
    content: str | None = None
    tool_calls: list[_WireToolCall] | None = None


class _WireChoice(BaseModel):
    message: _WireMessage
    finish_reason: str | None = None


class _WireUsage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0


class _WireResponse(BaseModel):
    model: str | None = None
    choices: list[_WireChoice]
    usage: _WireUsage | None = None


class _WireModel(BaseModel):
    id: str


class _WireModelList(BaseModel):
    data: list[_WireModel]


class _WireDelta(BaseModel):
    content: str | None = None


class _WireStreamChoice(BaseModel):
    delta: _WireDelta = _WireDelta()
    finish_reason: str | None = None


class _WireStreamChunk(BaseModel):
    choices: list[_WireStreamChoice] = []
    usage: _WireUsage | None = None


class OpenAICompatibleClient(LLMClient):
    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key: str | None = None,
        timeout: float = 60.0,
        max_retries: int = 3,
        backoff_base: float = 0.5,
        provider: str = "custom",
        http: httpx.AsyncClient | None = None,
    ) -> None:
        # Provider name only labels logs; behaviour is the same for every compatible API.
        self.provider = provider
        self.model = model
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._max_retries = max_retries
        self._backoff_base = backoff_base
        self._http = http or httpx.AsyncClient(base_url=base_url, timeout=timeout)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def list_models(self) -> list[str]:
        """Model ids the provider offers (GET /models), to choose LLM_MODEL from."""
        try:
            response = await self._http.get("models", headers=self._headers)
        except httpx.TransportError as error:
            raise LLMError(f"provider unreachable: {error!r}") from error
        if response.is_error:
            raise LLMError(
                f"HTTP {response.status_code}: {_error_text(_json_or_text(response))}",
                status_code=response.status_code,
            )
        return sorted(model.id for model in _WireModelList.model_validate(response.json()).data)

    async def _chat(
        self,
        messages: list[Message],
        *,
        tools: list[ToolSpec] | None,
        response_format: dict[str, Any] | None,
        temperature: float,
        max_tokens: int,
    ) -> LLMResponse:
        body = self._body(messages, temperature, max_tokens)
        if tools:
            body["tools"] = tools
        if response_format:
            body["response_format"] = response_format

        response = await self._send(body, stream=False)
        try:
            data = _WireResponse.model_validate(response.json())
        except (ValueError, ValidationError) as error:
            raise LLMError(f"{self.model}: unexpected response: {response.text[:300]}") from error
        if not data.choices:
            raise LLMError(f"{self.model}: response has no choices")

        choice = data.choices[0]
        usage = data.usage or _WireUsage()
        return LLMResponse(
            text=choice.message.content,
            tool_calls=[
                ToolCall(
                    id=call.id,
                    name=call.function.name,
                    arguments=call.function.arguments or "{}",
                    extra_content=call.extra_content,
                )
                for call in choice.message.tool_calls or []
            ],
            usage=Usage(
                prompt_tokens=usage.prompt_tokens, completion_tokens=usage.completion_tokens
            ),
            model=data.model or self.model,
            finish_reason=choice.finish_reason,
        )

    async def _stream(
        self, messages: list[Message], *, temperature: float, max_tokens: int
    ) -> AsyncIterator[StreamChunk]:
        body = self._body(messages, temperature, max_tokens)
        body["stream"] = True
        # Ask for token counts in a final chunk; providers that don't support it just omit it.
        body["stream_options"] = {"include_usage": True}

        response = await self._send(body, stream=True)
        usage: Usage | None = None
        finish_reason: str | None = None
        try:
            # Server-sent events: "data: {json}" lines, ending with "data: [DONE]".
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line.removeprefix("data:").strip()
                if payload == "[DONE]":
                    break
                raw = json.loads(payload)
                if isinstance(raw, dict) and "error" in raw:
                    raise LLMError(f"{self.model}: stream error: {_error_text(raw)}")
                chunk = _WireStreamChunk.model_validate(raw)
                if chunk.usage:
                    usage = Usage(
                        prompt_tokens=chunk.usage.prompt_tokens,
                        completion_tokens=chunk.usage.completion_tokens,
                    )
                for choice in chunk.choices:
                    finish_reason = choice.finish_reason or finish_reason
                    if choice.delta.content:
                        yield StreamChunk(text=choice.delta.content)
        finally:
            await response.aclose()
        yield StreamChunk(done=True, usage=usage, finish_reason=finish_reason)

    def _body(self, messages: list[Message], temperature: float, max_tokens: int) -> dict[str, Any]:
        return {
            "model": self.model,
            "messages": [m.to_wire() for m in messages],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

    async def _send(self, body: dict[str, Any], *, stream: bool) -> httpx.Response:
        """POSTs, retrying rate limits, 5xx errors and network failures with backoff."""
        for attempt in range(self._max_retries + 1):
            last_attempt = attempt == self._max_retries
            request = self._http.build_request(
                "POST", "chat/completions", json=body, headers=self._headers
            )
            try:
                response = await self._http.send(request, stream=stream)
            except httpx.TransportError as error:  # connect errors and timeouts
                if last_attempt:
                    raise LLMError(f"{self.model}: provider unreachable: {error!r}") from error
                await self._wait(attempt, reason=type(error).__name__)
                continue

            if response.status_code in RETRY_STATUSES and not last_attempt:
                await response.aclose()
                await self._wait(attempt, reason=str(response.status_code), response=response)
                continue
            if response.is_error:
                await response.aread()
                await response.aclose()
                raise LLMError(
                    f"{self.model}: HTTP {response.status_code}: "
                    f"{_error_text(_json_or_text(response)) or response.reason_phrase}",
                    status_code=response.status_code,
                )
            return response
        raise AssertionError("unreachable")

    async def _wait(
        self, attempt: int, *, reason: str, response: httpx.Response | None = None
    ) -> None:
        # Exponential backoff (0.5s, 1s, 2s, …) with jitter so parallel callers don't retry in
        # lockstep. A Retry-After header from the provider wins.
        delay = self._backoff_base * 2**attempt * random.uniform(1.0, 1.5)
        retry_after = response.headers.get("retry-after") if response else None
        if retry_after:
            try:
                delay = min(float(retry_after), MAX_RETRY_AFTER_SECONDS)
            except ValueError:
                pass  # An HTTP date instead of seconds; keep our own backoff.
        logger.info(
            "llm.retry",
            extra={
                "fields": {
                    "provider": self.provider,
                    "model": self.model,
                    "attempt": attempt + 1,
                    "reason": reason,
                    "delay_s": round(delay, 2),
                }
            },
        )
        await asyncio.sleep(delay)


def _json_or_text(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return response.text[:300]


def _error_text(body: Any) -> str:
    """Pulls the message out of the common error shapes: {"error": {"message": …}} or a list."""
    if isinstance(body, list):
        items = cast(list[Any], body)
        body = items[0] if items else ""
    if isinstance(body, dict):
        data = cast(dict[str, Any], body)
        error: Any = data.get("error", data)
        if isinstance(error, dict):
            details = cast(dict[str, Any], error)
            message: Any = details.get("message")
            # OpenRouter hides the real reason (e.g. "rate-limited upstream") in metadata.raw.
            metadata: Any = details.get("metadata")
            raw: Any = (
                cast(dict[str, Any], metadata).get("raw") if isinstance(metadata, dict) else None
            )
            if message is not None:
                return f"{message}: {raw}" if raw else str(message)
        return str(cast(object, error))
    return str(body)
