# LangGraph's own annotations are partly generic-unknown (e.g. CachePolicy[Unknown]), which
# strict pyright reports on every add_node/compile call. Only that check is relaxed here.
# pyright: reportUnknownMemberType=false, reportMissingTypeStubs=false
"""A5.1: the M3 agent loop, rebuilt as a LangGraph graph.

    START ──► call_model ──(no tool calls)──────────────► END
                  ▲   │ tool calls
                  │   ▼
                  └─ run_tools ──(8 steps or token budget)──► stop_early ──► END

Same behaviour as `agent.loop.run_agent` (tests/test_react_graph.py runs both on the same
script and compares the results). What the framework now does for us:

- **The loop and its exits are edges**, not `for`/`return`: `route_after_model` and
  `route_after_tools` are the only decisions, and the graph can be drawn from them.
- **State is explicit and merged by reducers**: each node returns only what it changed, and
  the `Annotated[..., reducer]` fields say how that merges (append messages, sum usage).
- **Checkpointing for free**: compiled with a checkpointer, the state is saved after every
  node, so a run can be inspected, paused or resumed (A5.3, A5.4). The hand-written loop
  keeps its state in local variables that die with the process.
- **Streaming**: `astream` yields after every node, and `stream_mode="custom"` carries our
  own tool events (A5.5).

What it doesn't do: the tool execution, validation, error wording and tracing are still our
code (`tools.registry`, `agent.loop.run_tool`); the framework only moves state between them.

State is plain JSON (messages and steps as dicts) so any checkpointer can store it. The
things that must *not* be stored (the LLM client, the HR client holding the user's token,
the trace) come in as the run's `context`, which LangGraph never checkpoints.
"""

import asyncio
from dataclasses import dataclass
from typing import Annotated, Any, Required, TypedDict

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.runtime import Runtime

from agent.loop import (
    BUDGET_ANSWER,
    EMPTY_ANSWER,
    MAX_STEPS,
    TOKEN_BUDGET,
    AgentRun,
    AgentStep,
    StopReason,
    ToolCallStep,
    max_steps_answer,
    parsed_arguments,
    run_tool,
)
from llm.base import LLMClient
from llm.types import Message, PromptRef, Usage
from tools.base import ToolContext
from tools.registry import ToolRegistry, result_content
from tracing.trace import Trace


def add_usage(total: dict[str, int], new: dict[str, int]) -> dict[str, int]:
    return {
        "prompt_tokens": total.get("prompt_tokens", 0) + new.get("prompt_tokens", 0),
        "completion_tokens": total.get("completion_tokens", 0) + new.get("completion_tokens", 0),
    }


def append(old: list[dict[str, Any]], new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return old + new


def merge_steps(steps: list[dict[str, Any]], new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Steps by number: run_tools re-sends the current step with its tool calls filled in."""
    merged = {step["step"]: step for step in steps}
    merged.update({step["step"]: step for step in new})
    return [merged[number] for number in sorted(merged)]


class ReactState(TypedDict, total=False):
    """The graph's state; the reducers say how a node's update merges into it."""

    # Message.model_dump(mode="json") dicts, oldest first.
    messages: Required[Annotated[list[dict[str, Any]], append]]
    # AgentStep dumps.
    steps: Annotated[list[dict[str, Any]], merge_steps]
    usage: Annotated[dict[str, int], add_usage]
    answer: str
    stop_reason: StopReason


class ReactUpdate(TypedDict, total=False):
    """What a node returns: only the keys it changed."""

    messages: list[dict[str, Any]]
    steps: list[dict[str, Any]]
    usage: dict[str, int]
    answer: str
    stop_reason: StopReason


@dataclass(frozen=True)
class AgentContext:
    """Per-run dependencies. Never checkpointed: the HR client holds the user's token."""

    llm: LLMClient
    registry: ToolRegistry
    tools: ToolContext
    trace: Trace
    prompt: PromptRef | None = None
    max_steps: int = MAX_STEPS
    token_budget: int = TOKEN_BUDGET
    max_tokens: int = 1024


async def call_model(state: ReactState, runtime: Runtime[AgentContext]) -> ReactUpdate:
    ctx = runtime.context
    conversation = [Message.model_validate(m) for m in state["messages"]]
    number = len(state.get("steps", [])) + 1
    with ctx.trace.observe(
        f"llm step {number}",
        kind="generation",
        input=[m.to_wire() for m in conversation],
        model_parameters={"temperature": 0, "max_tokens": ctx.max_tokens},
        metadata={"prompt": str(ctx.prompt) if ctx.prompt else None},
    ) as generation:
        response = await ctx.llm.chat(
            conversation,
            tools=ctx.registry.specs(),
            temperature=0,
            max_tokens=ctx.max_tokens,
            prompt=ctx.prompt,
        )
        generation.model = response.model
        generation.usage = response.usage
        generation.output = {
            "text": response.text,
            "tool_calls": [c.model_dump() for c in response.tool_calls],
            "finish_reason": response.finish_reason,
        }
    step = AgentStep(
        step=number, text=response.text, usage=response.usage, latency_ms=response.latency_ms
    )
    update: ReactUpdate = {
        "steps": [step.model_dump(mode="json")],
        "usage": response.usage.model_dump(),
    }
    if not response.tool_calls:
        update["answer"] = (response.text or "").strip() or EMPTY_ANSWER
        update["stop_reason"] = "answered"
        return update
    assistant = Message(role="assistant", content=response.text, tool_calls=response.tool_calls)
    update["messages"] = [assistant.model_dump(mode="json")]
    return update


async def run_tools(state: ReactState, runtime: Runtime[AgentContext]) -> ReactUpdate:
    ctx = runtime.context
    write = get_stream_writer()
    last = Message.model_validate(state["messages"][-1])
    calls = last.tool_calls or []
    for call in calls:
        write({"event": "tool_started", "tool": call.name, "id": call.id})
    results = await asyncio.gather(
        *(run_tool(ctx.registry, ctx.tools, call, ctx.trace) for call in calls)
    )
    step = AgentStep.model_validate(state.get("steps", [])[-1])
    messages: list[dict[str, Any]] = []
    for call, (result, latency_ms) in zip(calls, results, strict=True):
        write({"event": "tool_finished", "tool": call.name, "id": call.id, "ok": result.ok})
        messages.append(Message.tool(call.id, result_content(result)).model_dump(mode="json"))
        step.tool_calls.append(
            ToolCallStep(
                id=call.id,
                tool=call.name,
                arguments=parsed_arguments(call.arguments),
                ok=result.ok,
                error=result.error,
                data=result.data,
                latency_ms=latency_ms,
            )
        )
    return {"messages": messages, "steps": [step.model_dump(mode="json")]}


def stop_early(state: ReactState, runtime: Runtime[AgentContext]) -> ReactUpdate:
    if _over_budget(state, runtime.context):
        return {"answer": BUDGET_ANSWER, "stop_reason": "token_budget"}
    return {"answer": max_steps_answer(runtime.context.max_steps), "stop_reason": "max_steps"}


def route_after_model(state: ReactState) -> str:
    return END if state.get("stop_reason") else "run_tools"


def route_after_tools(state: ReactState, runtime: Runtime[AgentContext]) -> str:
    ctx = runtime.context
    if _over_budget(state, ctx) or len(state.get("steps", [])) >= ctx.max_steps:
        return "stop_early"
    return "call_model"


def _over_budget(state: ReactState, ctx: AgentContext) -> bool:
    usage = state.get("usage", {})
    return usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0) >= ctx.token_budget


def build_react_graph(
    checkpointer: BaseCheckpointSaver[Any] | None = None,
) -> CompiledStateGraph[ReactState, AgentContext, ReactState, ReactState]:
    graph = StateGraph(ReactState, context_schema=AgentContext)
    graph.add_node("call_model", call_model)
    graph.add_node("run_tools", run_tools)
    graph.add_node("stop_early", stop_early)
    graph.add_edge(START, "call_model")
    graph.add_conditional_edges("call_model", route_after_model, ["run_tools", END])
    graph.add_conditional_edges("run_tools", route_after_tools, ["call_model", "stop_early"])
    graph.add_edge("stop_early", END)
    return graph.compile(checkpointer=checkpointer)


REACT_GRAPH = build_react_graph()


async def run_react_graph(messages: list[Message], context: AgentContext) -> AgentRun:
    """Drop-in for `agent.loop.run_agent`: same inputs, same `AgentRun` out."""
    state = await REACT_GRAPH.ainvoke(
        {"messages": [m.model_dump(mode="json") for m in messages]}, context=context
    )
    return react_result(state, context.trace)


def react_result(state: ReactState | dict[str, Any], trace: Trace) -> AgentRun:
    answer: str = state.get("answer", EMPTY_ANSWER)
    reason: StopReason = state.get("stop_reason", "answered")
    steps = [AgentStep.model_validate(s) for s in state.get("steps", [])]
    trace.finish({"answer": answer, "stop_reason": reason})
    trace.metadata["stop_reason"] = reason
    trace.metadata["steps"] = len(steps)
    return AgentRun(
        answer=answer,
        stop_reason=reason,
        steps=steps,
        usage=Usage.model_validate(state.get("usage", {})),
        trace_id=trace.id,
    )
