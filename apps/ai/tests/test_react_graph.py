# pyright: reportUnknownMemberType=false
"""A5.1: the LangGraph version of the agent loop behaves exactly like the hand-written one."""

from collections.abc import AsyncIterator, Callable
from datetime import date
from typing import Any, cast

import httpx
import pytest
import respx
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver

from agent.ask import READ_REGISTRY, build_ask_messages
from agent.loop import AgentRun, run_agent
from app.hr_client import HrApiClient, SessionUser
from graphs.react import AgentContext, build_react_graph, run_react_graph
from llm.fake import FakeLLM, ScriptItem
from llm.types import LLMResponse, Usage
from tests.hr_data import BASE_URL, SNEHA, SNEHA_ID, balances, calls, page, session_user, tool_call
from tools.base import ToolContext
from tracing.trace import Trace

QUESTION = "How many annual leave days does Sneha have left?"


@pytest.fixture
async def ctx() -> AsyncIterator[ToolContext]:
    async with httpx.AsyncClient(base_url=BASE_URL) as http:
        user = SessionUser.model_validate(session_user("HR_OPS", "Lakshmi Pillai", None))
        yield ToolContext(hr=HrApiClient(http, "hr-token"), user=user, today=date(2026, 10, 3))


def expensive() -> LLMResponse:
    return LLMResponse(
        text=None,
        tool_calls=[tool_call("unknown", "{}")],
        usage=Usage(prompt_tokens=900, completion_tokens=200),
    )


SCRIPTS: dict[str, Callable[[], list[ScriptItem]]] = {
    "search_balance_answer": lambda: [
        calls(tool_call("search_employee", '{"query": "Sneha"}')),
        calls(tool_call("get_leave_balances", f'{{"employee_id": "{SNEHA_ID}"}}', "call_2")),
        "Sneha Patel has 9 annual leave days left.",
    ],
    "parallel_calls": lambda: [
        calls(
            tool_call("search_employee", '{"query": "Sneha"}', "a"),
            tool_call("get_leave_balances", f'{{"employee_id": "{SNEHA_ID}"}}', "b"),
        ),
        "Done.",
    ],
    "bad_calls": lambda: [
        calls(tool_call("delete_employee", "{}", "a"), tool_call("get_leave_balances", "{}", "b")),
        "I couldn't look that up.",
    ],
    "max_steps": lambda: [calls(tool_call("unknown", "{}")) for _ in range(3)],
    "token_budget": lambda: [expensive(), expensive()],
    "empty_reply": lambda: [""],
}


def comparable(run: AgentRun) -> dict[str, Any]:
    """Everything except timings and the trace id, which differ between any two runs."""
    data = run.model_dump(exclude={"trace_id"})
    for step in data["steps"]:
        step.pop("latency_ms")
        for call in step["tool_calls"]:
            call.pop("latency_ms")
    return data


@pytest.mark.parametrize("name", SCRIPTS)
@respx.mock
async def test_graph_and_hand_written_loop_give_the_same_run(ctx: ToolContext, name: str) -> None:
    respx.get(f"{BASE_URL}/employees").respond(json=page(SNEHA))
    respx.get(f"{BASE_URL}/employees/{SNEHA_ID}/leave-balances").respond(json=balances(9))
    messages, prompt = build_ask_messages(QUESTION, ctx)
    by_hand = await run_agent(
        FakeLLM(SCRIPTS[name]()),
        READ_REGISTRY,
        ctx,
        messages,
        trace=Trace(name="loop"),
        prompt=prompt,
        max_steps=3,
        token_budget=2000,
    )
    graph_trace = Trace(name="graph")
    by_graph = await run_react_graph(
        messages,
        AgentContext(
            llm=FakeLLM(SCRIPTS[name]()),
            registry=READ_REGISTRY,
            tools=ctx,
            trace=graph_trace,
            prompt=prompt,
            max_steps=3,
            token_budget=2000,
        ),
    )

    assert comparable(by_graph) == comparable(by_hand)
    assert by_graph.trace_id == graph_trace.id
    assert graph_trace.output == {"answer": by_hand.answer, "stop_reason": by_hand.stop_reason}


@respx.mock
async def test_the_checkpointer_saves_state_after_every_node(ctx: ToolContext) -> None:
    respx.get(f"{BASE_URL}/employees").respond(json=page(SNEHA))
    graph = build_react_graph(checkpointer=InMemorySaver())
    messages, _ = build_ask_messages(QUESTION, ctx)
    fake = FakeLLM([calls(tool_call("search_employee", '{"query": "Sneha"}')), "Found her."])
    config: RunnableConfig = {"configurable": {"thread_id": "t1"}}
    context = AgentContext(llm=fake, registry=READ_REGISTRY, tools=ctx, trace=Trace(name="t"))

    await graph.ainvoke(
        {"messages": [m.model_dump(mode="json") for m in messages]}, config, context=context
    )

    history = [snapshot async for snapshot in graph.aget_state_history(config)]
    # Newest first: input, then a checkpoint after each node that ran.
    sources = [
        snapshot.metadata.get("source") for snapshot in reversed(history) if snapshot.metadata
    ]
    nodes = [tuple(snapshot.next) for snapshot in reversed(history)]
    assert sources[0] == "input"
    assert nodes == [("__start__",), ("call_model",), ("run_tools",), ("call_model",), ()]
    final = history[0].values
    assert final["answer"] == "Found her."
    assert len(final["messages"]) == 4  # system, user, assistant tool call, tool result
    # The user's token isn't in the checkpoint: it lives in the (unsaved) context.
    assert "hr-token" not in repr(final)


@respx.mock
async def test_tool_events_stream_as_they_happen(ctx: ToolContext) -> None:
    respx.get(f"{BASE_URL}/employees").respond(json=page(SNEHA))
    messages, _ = build_ask_messages(QUESTION, ctx)
    fake = FakeLLM([calls(tool_call("search_employee", '{"query": "Sneha"}')), "Found her."])
    context = AgentContext(llm=fake, registry=READ_REGISTRY, tools=ctx, trace=Trace(name="t"))

    seen: list[Any] = []
    async for mode, chunk in build_react_graph().astream(
        {"messages": [m.model_dump(mode="json") for m in messages]},
        context=context,
        stream_mode=["updates", "custom"],
    ):
        event = cast(dict[str, Any], chunk)
        seen.append((mode, list(event) if mode == "updates" else event["event"]))

    assert seen == [
        ("updates", ["call_model"]),
        ("custom", "tool_started"),
        ("custom", "tool_finished"),
        ("updates", ["run_tools"]),
        ("updates", ["call_model"]),
    ]
