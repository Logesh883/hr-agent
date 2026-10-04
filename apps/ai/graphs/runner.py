# LangGraph's annotations are partly generic-unknown; see graphs/react.py.
# pyright: reportUnknownMemberType=false, reportMissingTypeStubs=false
"""Driving the HR graph: start, resume after a question, or continue after a crash.

One thread per run (`thread_id`). Every call streams the graph and turns what it emits
into timeline events for the caller (the CLI prints them; the API stores and streams them):

    node_started   {node}                  from the traced() wrapper
    node_finished  {node, summary}         from stream_mode="updates"
    tool_started / tool_finished {tool, step, ok}
    waiting        {question, options?}    the graph paused for the user
    finished       {status, answer}

After the stream ends, the checkpoint says what happened: pending interrupts mean the run
is waiting for an answer; otherwise it's finished and the state holds the answer.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal, cast

from langchain_core.runnables import RunnableConfig
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from graphs.hr_agent import HrContext, HrState

EventSink = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass(frozen=True)
class RunOutcome:
    status: Literal["waiting", "completed"]
    values: dict[str, Any]
    # The interrupt's payload while waiting: {"type", "question", "options"?}.
    question: dict[str, Any] | None = None

    @property
    def answer(self) -> str | None:
        return self.values.get("answer")


HrGraph = CompiledStateGraph[HrState, HrContext, HrState, HrState]


def thread_config(thread_id: str) -> RunnableConfig:
    return {"configurable": {"thread_id": thread_id}}


async def start_run(
    graph: HrGraph, thread_id: str, request: str, context: HrContext, on_event: EventSink
) -> RunOutcome:
    return await _drive(graph, {"request": request}, thread_id, context, on_event)


async def resume_run(
    graph: HrGraph, thread_id: str, answer: str | None, context: HrContext, on_event: EventSink
) -> RunOutcome:
    """With an answer: reply to the pending question. Without: continue from the last
    checkpoint (e.g. after the server restarted mid-run)."""
    payload = None if answer is None else Command(resume=answer)
    return await _drive(graph, payload, thread_id, context, on_event)


async def _drive(
    graph: HrGraph,
    payload: HrState | Command[Any] | None,
    thread_id: str,
    context: HrContext,
    on_event: EventSink,
) -> RunOutcome:
    config = thread_config(thread_id)
    async for mode, chunk in graph.astream(
        payload, config, context=context, stream_mode=["updates", "custom"]
    ):
        if mode == "custom":
            await on_event(cast(dict[str, Any], chunk))
            continue
        for node, update in cast(dict[str, Any], chunk).items():
            if node != "__interrupt__":
                await on_event(
                    {"event": "node_finished", "node": node, "summary": summarize(node, update)}
                )
    snapshot = await graph.aget_state(config)
    values = dict(snapshot.values)
    if snapshot.interrupts:
        question = cast(dict[str, Any], snapshot.interrupts[0].value)
        await on_event({"event": "waiting", **question})
        return RunOutcome("waiting", values, question)
    await on_event(
        {"event": "finished", "status": values.get("status"), "answer": values.get("answer")}
    )
    return RunOutcome("completed", values)


def summarize(node: str, update: Any) -> dict[str, Any]:
    """A few fields per node for the timeline; the full state stays in the checkpoint."""
    if not isinstance(update, dict):
        return {}
    data = cast(dict[str, Any], update)
    if node == "understand":
        parsed = data.get("parsed", {})
        return {"intent": parsed.get("intent"), "route": data.get("route")}
    if node == "retrieve_policy":
        return {"passages": [p["citation"] for p in data.get("policy", [])]}
    if node == "plan":
        plan: dict[str, Any] = data.get("plan") or {}
        steps: list[dict[str, Any]] = plan.get("steps", [])
        return {
            "goal": plan.get("goal"),
            "steps": [f"{s['id']} {s['tool']}" for s in steps],
        }
    if node == "validate_plan":
        return {"problems": data.get("plan_problems", [])}
    if node == "execute_step":
        return {
            step_id: {"tool": r.get("tool"), "status": r.get("status"), "error": r.get("error")}
            for step_id, r in data.get("results", {}).items()
        }
    if node == "verify":
        return data.get("verification", {})
    if node == "clarify":
        return {"clarifications": data.get("clarifications", [])}
    return {}
