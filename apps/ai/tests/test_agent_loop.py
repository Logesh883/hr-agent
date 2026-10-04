"""The hand-written agent loop, driven by a FakeLLM script and a respx-mocked HR API."""

import json
from collections.abc import AsyncIterator
from datetime import date

import httpx
import pytest
import respx

from agent.ask import READ_REGISTRY, answer_question, build_ask_messages
from agent.loop import run_agent
from app.hr_client import HrApiClient, SessionUser
from llm.fake import FakeLLM
from llm.types import LLMResponse, Message, Usage
from prompts import load_prompt
from tests.hr_data import BASE_URL, SNEHA, SNEHA_ID, balances, calls, page, session_user, tool_call
from tools.base import ToolContext
from tracing.trace import Trace

QUESTION = "How many annual leave days does Sneha have left?"


@pytest.fixture
async def ctx() -> AsyncIterator[ToolContext]:
    async with httpx.AsyncClient(base_url=BASE_URL) as http:
        user = SessionUser.model_validate(session_user("HR_OPS", "Lakshmi Pillai", None))
        yield ToolContext(hr=HrApiClient(http, "hr-token"), user=user, today=date(2026, 10, 3))


def tool_messages(fake: FakeLLM, call_number: int) -> list[Message]:
    return [m for m in fake.calls[call_number].messages if m.role == "tool"]


@respx.mock
async def test_search_then_balances_then_answer(ctx: ToolContext) -> None:
    respx.get(f"{BASE_URL}/employees").respond(json=page(SNEHA))
    respx.get(f"{BASE_URL}/employees/{SNEHA_ID}/leave-balances").respond(json=balances(9))
    fake = FakeLLM(
        [
            calls(tool_call("search_employee", '{"query": "Sneha"}')),
            calls(tool_call("get_leave_balances", f'{{"employee_id": "{SNEHA_ID}"}}', "call_2")),
            "Sneha Patel has 9 annual leave days left in 2026 (2 more are pending approval).",
        ]
    )

    run = await answer_question(fake, ctx, QUESTION)

    assert run.stop_reason == "answered"
    assert run.answer.startswith("Sneha Patel has 9 annual leave days left")
    assert [c.tool for s in run.steps for c in s.tool_calls] == [
        "search_employee",
        "get_leave_balances",
    ]
    # Every call offers the same nine tools, deterministically.
    assert all(c.tools == READ_REGISTRY.specs() and c.temperature == 0 for c in fake.calls)
    # The second LLM call saw the search result, as a tool message answering call_1.
    (search_result,) = tool_messages(fake, 1)
    assert search_result.tool_call_id == "call_1"
    assert SNEHA_ID in (search_result.content or "")
    # Usage is summed over the three LLM calls.
    assert len(run.steps) == 3
    assert run.usage.prompt_tokens == sum(s.usage.prompt_tokens for s in run.steps)
    assert run.usage.prompt_tokens > 200


@respx.mock
async def test_parallel_tool_calls_all_run_and_answer_in_order(ctx: ToolContext) -> None:
    respx.get(f"{BASE_URL}/employees").respond(json=page(SNEHA))
    respx.get(f"{BASE_URL}/employees/{SNEHA_ID}/leave-balances").respond(json=balances(9))
    fake = FakeLLM(
        [
            calls(
                tool_call("search_employee", '{"query": "Sneha"}', "a"),
                tool_call("get_leave_balances", f'{{"employee_id": "{SNEHA_ID}"}}', "b"),
            ),
            "Done.",
        ]
    )

    run = await answer_question(fake, ctx, QUESTION)

    assert [m.tool_call_id for m in tool_messages(fake, 1)] == ["a", "b"]
    assert [c.ok for c in run.steps[0].tool_calls] == [True, True]


async def test_bad_tool_calls_go_back_to_the_model_as_errors(ctx: ToolContext) -> None:
    fake = FakeLLM(
        [
            calls(
                tool_call("delete_employee", "{}", "a"),
                tool_call("get_leave_balances", '{"employee_id": "Sneha"}', "b"),
            ),
            "I couldn't look that up.",
        ]
    )

    run = await answer_question(fake, ctx, QUESTION)

    first, second = (json.loads(m.content or "") for m in tool_messages(fake, 1))
    assert first["ok"] is False and first["error"].startswith("Unknown tool 'delete_employee'")
    assert second["ok"] is False and "valid UUID" in second["error"]
    assert run.stop_reason == "answered"


async def test_stops_after_the_step_limit(ctx: ToolContext) -> None:
    fake = FakeLLM([calls(tool_call("unknown", "{}")) for _ in range(3)])
    messages, _ = build_ask_messages(QUESTION, ctx)

    run = await run_agent(fake, READ_REGISTRY, ctx, messages, trace=Trace(name="test"), max_steps=3)

    assert run.stop_reason == "max_steps"
    assert len(fake.calls) == 3
    assert run.answer.startswith("I couldn't finish within 3 steps")


async def test_stops_when_the_token_budget_is_spent(ctx: ToolContext) -> None:
    expensive = LLMResponse(
        text=None,
        tool_calls=[tool_call("unknown", "{}")],
        usage=Usage(prompt_tokens=900, completion_tokens=200),
    )
    fake = FakeLLM([expensive, expensive])
    messages, _ = build_ask_messages(QUESTION, ctx)

    run = await run_agent(
        fake, READ_REGISTRY, ctx, messages, trace=Trace(name="test"), token_budget=2000
    )

    assert run.stop_reason == "token_budget"
    assert run.usage.total_tokens == 2200


async def test_an_empty_reply_is_not_passed_off_as_an_answer(ctx: ToolContext) -> None:
    run = await answer_question(FakeLLM([""]), ctx, QUESTION)

    assert run.answer == "I couldn't produce an answer."


def test_system_prompt_says_who_is_asking(ctx: ToolContext) -> None:
    messages, prompt = build_ask_messages(QUESTION, ctx)

    system, user = messages
    assert prompt.name == "ask"
    assert "Today is 2026-10-03 (Saturday)" in (system.content or "")
    assert "Signed in: Lakshmi Pillai, role HR_OPS" in (system.content or "")
    assert "no employee record" in (system.content or "")
    # The question is the user message, unchanged: data, not instructions.
    assert user.role == "user" and user.content == QUESTION


@respx.mock
async def test_the_trace_has_a_generation_per_llm_call_and_a_span_per_tool(
    ctx: ToolContext,
) -> None:
    respx.get(f"{BASE_URL}/employees").respond(json=page(SNEHA))
    fake = FakeLLM([calls(tool_call("search_employee", '{"query": "Sneha"}')), "Found her."])
    trace = Trace(name="agent.ask")

    run = await answer_question(fake, ctx, QUESTION, trace=trace)

    assert run.trace_id == trace.id
    assert [(o.kind, o.name) for o in trace.observations] == [
        ("generation", "llm step 1"),
        ("span", "tool search_employee"),
        ("generation", "llm step 2"),
    ]
    first, tool, _ = trace.observations
    assert first.usage == Usage(prompt_tokens=100, completion_tokens=10)
    assert first.model == "fake-model"
    assert tool.input == {"query": "Sneha"}
    assert tool.output["ok"] is True
    assert all(o.end_time is not None for o in trace.observations)
    assert trace.output == {"answer": "Found her.", "stop_reason": "answered"}
    assert trace.metadata["prompt"] == str(load_prompt("ask").ref)
