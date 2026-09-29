import json
import logging
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest
import respx

from app.log import JsonFormatter
from llm.base import LLMError
from llm.openai_compat import OpenAICompatibleClient
from llm.types import Message, PromptRef, ToolCall, ToolSpec

BASE_URL = "http://llm.test/v1"
URL = f"{BASE_URL}/chat/completions"
MESSAGES = [Message.system("Be brief."), Message.user("Hi")]


def completion(
    text: str | None = "Hello!", *, finish: str = "stop", **message: Any
) -> dict[str, Any]:
    return {
        "model": "test-model-2026",
        "choices": [{"message": {"content": text, **message}, "finish_reason": finish}],
        "usage": {"prompt_tokens": 12, "completion_tokens": 3},
    }


@pytest.fixture
async def llm() -> AsyncIterator[OpenAICompatibleClient]:
    async with httpx.AsyncClient(base_url=BASE_URL) as http:
        yield OpenAICompatibleClient(
            provider="groq",
            base_url=BASE_URL,
            model="test-model",
            api_key="secret-key",
            max_retries=2,
            backoff_base=0,
            http=http,
        )


class Records(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


@pytest.fixture
def llm_logs() -> Iterator[Records]:
    logger = logging.getLogger("hr_ai.llm")
    handler = Records()
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    yield handler
    logger.removeHandler(handler)


def fields(record: logging.LogRecord) -> dict[str, Any]:
    return getattr(record, "fields")  # noqa: B009


@respx.mock
async def test_sends_openai_request_and_parses_reply(llm: OpenAICompatibleClient) -> None:
    route = respx.post(URL).respond(json=completion())

    response = await llm.chat(MESSAGES, temperature=0.2, max_tokens=50)

    request = route.calls.last.request
    assert request.headers["authorization"] == "Bearer secret-key"
    assert json.loads(request.content) == {
        "model": "test-model",
        "messages": [
            {"role": "system", "content": "Be brief."},
            {"role": "user", "content": "Hi"},
        ],
        "temperature": 0.2,
        "max_tokens": 50,
    }
    assert response.text == "Hello!"
    assert response.model == "test-model-2026"
    assert response.finish_reason == "stop"
    assert (response.usage.prompt_tokens, response.usage.completion_tokens) == (12, 3)
    assert response.usage.total_tokens == 15
    assert response.latency_ms > 0


@respx.mock
async def test_passes_tools_and_response_format_and_parses_tool_calls(
    llm: OpenAICompatibleClient,
) -> None:
    tool_call = {
        "id": "call_1",
        "type": "function",
        "function": {"name": "get_leave_balance", "arguments": '{"employeeId": "e1"}'},
    }
    route = respx.post(URL).respond(
        json=completion(None, tool_calls=[tool_call], finish="tool_calls")
    )
    tools: list[ToolSpec] = [
        {"type": "function", "function": {"name": "get_leave_balance", "parameters": {}}}
    ]

    response = await llm.chat(MESSAGES, tools=tools, response_format={"type": "json_object"})

    body = json.loads(route.calls.last.request.content)
    assert body["tools"] == tools
    assert body["response_format"] == {"type": "json_object"}
    assert response.text is None
    assert response.finish_reason == "tool_calls"
    assert response.tool_calls == [
        ToolCall(id="call_1", name="get_leave_balance", arguments='{"employeeId": "e1"}')
    ]


@respx.mock
async def test_sends_tool_turns_in_openai_format(llm: OpenAICompatibleClient) -> None:
    route = respx.post(URL).respond(json=completion())
    call = ToolCall(id="call_1", name="get_leave_balance", arguments="{}")

    await llm.chat(
        [
            Message.user("Balance?"),
            Message(role="assistant", tool_calls=[call]),
            Message.tool("call_1", '{"casual": 4}'),
        ]
    )

    sent = json.loads(route.calls.last.request.content)["messages"]
    assert sent[1]["tool_calls"] == [
        {
            "id": "call_1",
            "type": "function",
            "function": {"name": "get_leave_balance", "arguments": "{}"},
        }
    ]
    assert sent[2] == {"role": "tool", "content": '{"casual": 4}', "tool_call_id": "call_1"}


@respx.mock
async def test_retries_rate_limits_and_server_errors(llm: OpenAICompatibleClient) -> None:
    route = respx.post(URL).mock(
        side_effect=[
            httpx.Response(429, headers={"retry-after": "0"}, json={"error": {"message": "slow"}}),
            httpx.Response(503),
            httpx.Response(200, json=completion()),
        ]
    )

    response = await llm.chat(MESSAGES)

    assert route.call_count == 3
    assert response.text == "Hello!"


@respx.mock
async def test_retries_timeouts(llm: OpenAICompatibleClient) -> None:
    route = respx.post(URL).mock(
        side_effect=[httpx.ReadTimeout("slow"), httpx.Response(200, json=completion())]
    )

    assert (await llm.chat(MESSAGES)).text == "Hello!"
    assert route.call_count == 2


@respx.mock
async def test_gives_up_after_max_retries(llm: OpenAICompatibleClient) -> None:
    route = respx.post(URL).respond(429, json={"error": {"message": "Rate limit reached"}})

    with pytest.raises(LLMError, match="HTTP 429: Rate limit reached") as caught:
        await llm.chat(MESSAGES)

    assert caught.value.status_code == 429
    assert route.call_count == 3  # first try + max_retries=2


@respx.mock
async def test_does_not_retry_client_errors(llm: OpenAICompatibleClient) -> None:
    # Gemini's compatible endpoint wraps errors in a list.
    route = respx.post(URL).respond(400, json=[{"error": {"message": "Invalid model"}}])

    with pytest.raises(LLMError, match="HTTP 400: Invalid model"):
        await llm.chat(MESSAGES)

    assert route.call_count == 1


@respx.mock
async def test_unexpected_response_shape_is_an_llm_error(llm: OpenAICompatibleClient) -> None:
    respx.post(URL).respond(json={"nope": True})

    with pytest.raises(LLMError, match="unexpected response"):
        await llm.chat(MESSAGES)


def sse(*events: dict[str, Any] | str) -> bytes:
    lines = [f"data: {e if isinstance(e, str) else json.dumps(e)}\n\n" for e in events]
    return "".join(lines).encode()


@respx.mock
async def test_streams_text_then_totals(llm: OpenAICompatibleClient) -> None:
    route = respx.post(URL).respond(
        content=sse(
            {"choices": [{"delta": {"role": "assistant", "content": ""}}]},
            {"choices": [{"delta": {"content": "Hel"}}]},
            {"choices": [{"delta": {"content": "lo"}, "finish_reason": "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 2}},
            "[DONE]",
        ),
        headers={"content-type": "text/event-stream"},
    )

    chunks = [chunk async for chunk in llm.stream(MESSAGES)]

    body = json.loads(route.calls.last.request.content)
    assert body["stream"] is True
    assert body["stream_options"] == {"include_usage": True}
    assert [c.text for c in chunks if not c.done] == ["Hel", "lo"]
    last = chunks[-1]
    assert last.done
    assert last.usage is not None and last.usage.completion_tokens == 2
    assert last.finish_reason == "stop"
    assert last.ttft_ms is not None and last.latency_ms is not None
    assert last.ttft_ms <= last.latency_ms


@respx.mock
async def test_stream_error_event_raises(llm: OpenAICompatibleClient) -> None:
    respx.post(URL).respond(
        content=sse(
            {"choices": [{"delta": {"content": "Hi"}}]}, {"error": {"message": "overloaded"}}
        )
    )

    with pytest.raises(LLMError, match="overloaded"):
        _ = [chunk async for chunk in llm.stream(MESSAGES)]


@respx.mock
async def test_logs_one_json_line_per_call_without_content(
    llm: OpenAICompatibleClient, llm_logs: Records
) -> None:
    respx.post(URL).respond(json=completion())

    await llm.chat(MESSAGES, prompt=PromptRef(name="dev_chat", version="1"))

    calls = [r for r in llm_logs.records if r.getMessage() == "llm.call"]
    assert len(calls) == 1
    logged = fields(calls[0])
    assert logged["provider"] == "groq"
    assert logged["model"] == "test-model"
    assert logged["prompt"] == "dev_chat@1"
    assert (logged["prompt_tokens"], logged["completion_tokens"]) == (12, 3)
    assert logged["status"] == "ok"
    line = JsonFormatter().format(calls[0])
    assert json.loads(line)["event"] == "llm.call"
    assert "Hi" not in line and "Be brief" not in line


@respx.mock
async def test_logs_retries_and_failures(llm: OpenAICompatibleClient, llm_logs: Records) -> None:
    respx.post(URL).respond(500)

    with pytest.raises(LLMError, match="HTTP 500: Internal Server Error"):
        await llm.chat(MESSAGES)

    events = [r.getMessage() for r in llm_logs.records]
    assert events == ["llm.retry", "llm.retry", "llm.call"]
    assert fields(llm_logs.records[-1])["status"] == "error"


@respx.mock
async def test_lists_models(llm: OpenAICompatibleClient) -> None:
    route = respx.get(f"{BASE_URL}/models").respond(
        json={"object": "list", "data": [{"id": "b-model"}, {"id": "a-model:free"}]}
    )

    assert await llm.list_models() == ["a-model:free", "b-model"]
    assert route.calls.last.request.headers["authorization"] == "Bearer secret-key"


@respx.mock
async def test_error_includes_openrouter_upstream_reason(llm: OpenAICompatibleClient) -> None:
    respx.post(URL).respond(
        429,
        json={
            "error": {
                "message": "Provider returned error",
                "code": 429,
                "metadata": {"raw": "model is temporarily rate-limited upstream"},
            }
        },
    )

    with pytest.raises(
        LLMError, match="Provider returned error: model is temporarily rate-limited"
    ):
        await llm.chat(MESSAGES)
