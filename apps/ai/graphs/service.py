"""Running HR agent graphs on behalf of users (A5.5): start, resume, and keep the record.

A run executes in a background task: the API answers `202` at once, and the client
follows `/events`. The user's HR token is held only by that task (in the run's context)
and is never written anywhere; resuming a run therefore needs the user's token again.

Status lifecycle (workflow_run.status):

    running ──► waiting ──(resume with an answer)──► running ──► completed | failed
       │
       └──(process died: marked at startup)──► interrupted ──(resume)──► running

Only the user who started a run can see or resume it.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

import httpx

from agent.budget import RateLimiter, RunBudget
from app.faults import FaultInjector, FaultRule
from app.hr_client import HrApiClient, SessionUser
from graphs.hr_agent import HrContext
from graphs.persistence import TERMINAL, RunRecord, RunStore
from graphs.runner import Answer, EventSink, HrGraph, RunOutcome, resume_run, start_run
from llm.base import LLMClient
from rag.retrieval import PolicyRetriever
from tools.base import Outbox, ToolContext
from tracing.langfuse import TraceExporter
from tracing.trace import Trace

logger = logging.getLogger("hr_ai.runs")


class RunConflict(Exception):
    """The run isn't in a state that allows this (e.g. resuming a running run)."""


@dataclass(frozen=True)
class Caller:
    """Who is acting: their HR API token (memory only) and who it belongs to."""

    token: str
    user: SessionUser


Action = Callable[[HrContext, EventSink], Awaitable[RunOutcome]]


class RunService:
    def __init__(
        self,
        *,
        graph: HrGraph,
        store: RunStore,
        llm: LLMClient,
        exporter: TraceExporter,
        hr_api_url: str,
        hr_api_timeout: float = 10.0,
        policies: PolicyRetriever | None = None,
        outbox: Outbox | None = None,
        today: Callable[[], date] = date.today,
        faults: list[FaultRule] | None = None,
        budget: RunBudget | None = None,
        limiter: RateLimiter | None = None,
    ) -> None:
        self.graph = graph
        self.store = store
        self.llm = llm
        self.exporter = exporter
        self.hr_api_url = hr_api_url
        self.hr_api_timeout = hr_api_timeout
        self.policies = policies
        self.outbox = outbox
        self.today = today
        self.faults = faults
        self.budget = budget or RunBudget()
        # A8.4: per-user runs a minute and runs at once. None: unlimited (tests).
        self.limiter = limiter
        self._tasks: dict[str, asyncio.Task[None]] = {}

    async def start(self, caller: Caller, request: str) -> tuple[RunRecord, asyncio.Task[None]]:
        await self._acquire(caller)
        run = RunRecord.new(user_id=caller.user.id, user_role=caller.user.role, request=request)
        await self.store.create(run)
        await self.store.add_event(run.id, {"event": "run_started", "request": request})

        async def action(ctx: HrContext, on_event: EventSink) -> RunOutcome:
            return await start_run(self.graph, run.thread_id, request, ctx, on_event)

        return run, self._launch(run, caller, action)

    async def resume(
        self, caller: Caller, run_id: str, answer: Answer
    ) -> tuple[RunRecord, asyncio.Task[None]]:
        run = await self.get_for(caller, run_id)
        if run is None:
            raise LookupError(run_id)
        if run.status == "waiting" and not answer:
            raise RunConflict("This run is waiting for an answer to its question.")
        if run.status == "interrupted" and answer:
            raise RunConflict("This run isn't waiting for an answer; resume it without one.")
        if run.status not in ("waiting", "interrupted"):
            raise RunConflict(f"A {run.status} run can't be resumed.")
        await self._acquire(caller)
        await self.store.update(run.id, status="running", question=None)
        await self.store.add_event(run.id, {"event": "run_resumed", "answer": answer})

        async def action(ctx: HrContext, on_event: EventSink) -> RunOutcome:
            return await resume_run(self.graph, run.thread_id, answer, ctx, on_event)

        return run, self._launch(run, caller, action)

    async def get_for(self, caller: Caller | SessionUser, run_id: str) -> RunRecord | None:
        """The run, if it belongs to this user; otherwise None (as if it didn't exist)."""
        user = caller.user if isinstance(caller, Caller) else caller
        run = await self.store.get(run_id)
        return run if run is not None and run.user_id == user.id else None

    async def state(self, run: RunRecord) -> dict[str, Any]:
        snapshot = await self.graph.aget_state({"configurable": {"thread_id": run.thread_id}})
        return dict(snapshot.values)

    async def wait(self, run_id: str) -> None:
        """Until the run's current task ends (finished, waiting for the user, or failed)."""
        task = self._tasks.get(run_id)
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)

    async def aclose(self) -> None:
        for task in list(self._tasks.values()):
            task.cancel()
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    async def _acquire(self, caller: Caller) -> None:
        if self.limiter is not None:
            await self.limiter.acquire(caller.user.id)  # raises RateLimited

    def _launch(self, run: RunRecord, caller: Caller, action: Action) -> asyncio.Task[None]:
        task = asyncio.create_task(self._execute(run, caller, action))
        # Keep a reference: the event loop only holds weak ones, and a collected task dies.
        self._tasks[run.id] = task

        def done(_: asyncio.Task[None]) -> None:
            self._tasks.pop(run.id, None)
            if self.limiter is not None:
                self.limiter.release(caller.user.id)

        task.add_done_callback(done)
        return task

    async def _execute(self, run: RunRecord, caller: Caller, action: Action) -> None:
        trace = Trace(
            name="agent.run",
            user_id=caller.user.id,
            input={"request": run.request},
            metadata={"run_id": run.id, "role": caller.user.role},
            tags=["run"],
            known_names={caller.user.name},
        )

        recorded: set[str] = set()

        async def on_event(event: dict[str, Any]) -> None:
            await self.store.add_event(run.id, event)
            if event["event"] == "approval_decided":
                await self.store.record_approval(run.id, event["step"], event)
            if event["event"] == "node_finished":
                # Record each node's LLM and tool calls as soon as it's done, so a killed
                # process loses at most the node it was in.
                recorded.update(await self.store.record_trace(run.id, trace, skip=recorded))

        transport = FaultInjector(self.faults) if self.faults else None
        async with httpx.AsyncClient(
            base_url=self.hr_api_url, timeout=self.hr_api_timeout, transport=transport
        ) as http:
            tools = ToolContext(
                # The run id goes to the HR API as X-Agent-Run-Id: its audit entries are
                # then marked AI, with this run.
                hr=HrApiClient(http, caller.token, agent_run_id=run.id),
                user=caller.user,
                today=self.today(),
                policies=self.policies,
                outbox=self.outbox,
            )
            context = HrContext(llm=self.llm, tools=tools, trace=trace, budget=self.budget)
            try:
                # The graph stops itself between nodes when over its time budget; this is
                # the last resort for a node that hangs mid-call.
                async with asyncio.timeout(self.budget.max_seconds * 2):
                    outcome = await action(context, on_event)
            except asyncio.CancelledError:
                # Shutdown: the checkpoint keeps what's done; startup marks it interrupted.
                trace.finish({"error": "cancelled"})
                raise
            except TimeoutError:
                logger.warning("run.timeout", extra={"fields": {"run_id": run.id}})
                trace.finish({"error": "timeout"})
                await self.store.update(
                    run.id,
                    status="failed",
                    error="TimeoutError: the run took too long and was stopped",
                    completed_at=datetime.now(UTC),
                )
                await on_event(
                    {"event": "failed", "error": "The run took too long and was stopped."}
                )
            except Exception as error:
                logger.exception("run.failed", extra={"fields": {"run_id": run.id}})
                trace.finish({"error": repr(error)})
                await self.store.update(
                    run.id,
                    status="failed",
                    error=f"{type(error).__name__}: {error}",
                    completed_at=datetime.now(UTC),
                )
                await on_event({"event": "failed", "error": "The run failed unexpectedly."})
            else:
                trace.finish({"status": outcome.status, "answer": outcome.answer})
                await self.store.update(run.id, **_status_fields(outcome))
            finally:
                await self._record(run, trace, recorded)

    async def _record(self, run: RunRecord, trace: Trace, recorded: set[str]) -> None:
        try:
            await self.store.record_trace(run.id, trace, skip=recorded)
            current = await self.store.get(run.id)
            if current is not None:
                await self.store.update(run.id, trace_ids=[*current.trace_ids, trace.id])
        except Exception:
            logger.exception("run.record_failed", extra={"fields": {"run_id": run.id}})
        await self.exporter.export(trace)


def _status_fields(outcome: RunOutcome) -> dict[str, Any]:
    parsed: dict[str, Any] = outcome.values.get("parsed") or {}
    intent = parsed.get("intent")
    if outcome.status == "waiting":
        return {"status": "waiting", "question": outcome.question, "workflow_type": intent}
    status = "failed" if outcome.values.get("status") == "failed" else "completed"
    return {
        "status": status,
        "question": None,
        "answer": outcome.answer,
        "workflow_type": intent,
        "completed_at": datetime.now(UTC),
    }


def is_finished(run: RunRecord) -> bool:
    return run.status in TERMINAL
