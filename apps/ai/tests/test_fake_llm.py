import pytest

from llm.fake import FakeLLM
from llm.types import LLMResponse, Message, ToolCall


async def test_replays_script_in_order_and_records_calls() -> None:
    tool_reply = LLMResponse(
        text=None, tool_calls=[ToolCall(id="c1", name="search_employees", arguments="{}")]
    )
    llm = FakeLLM(["first", tool_reply])

    first = await llm.chat([Message.user("one")], temperature=0.3)
    second = await llm.chat([Message.user("two")], tools=[{"type": "function"}])

    assert first.text == "first"
    assert first.usage.completion_tokens == 1
    assert second.tool_calls[0].name == "search_employees"
    assert [c.messages[0].content for c in llm.calls] == ["one", "two"]
    assert llm.calls[0].temperature == 0.3
    assert llm.calls[1].tools == [{"type": "function"}]


async def test_raises_scripted_errors_and_fails_loudly_when_empty() -> None:
    llm = FakeLLM([TimeoutError("scripted")])

    with pytest.raises(TimeoutError):
        await llm.chat([Message.user("x")])
    with pytest.raises(AssertionError, match="script is empty"):
        await llm.chat([Message.user("x")])


async def test_streams_scripted_text() -> None:
    llm = FakeLLM()
    llm.queue("two words")

    chunks = [c async for c in llm.stream([Message.user("x")])]

    assert "".join(c.text for c in chunks) == "two words"
    assert chunks[-1].done
    assert chunks[-1].latency_ms is not None
