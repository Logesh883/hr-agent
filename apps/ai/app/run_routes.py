"""A5.5: agent runs over HTTP.

    POST /agent/runs                {request}           start; 202 + the run
    GET  /agent/runs/{id}                                status, question or answer, plan progress
    GET  /agent/runs/{id}/events                         server-sent events: the run's timeline
    POST /agent/runs/{id}/resume    {answer?}           answer its question, or continue an
                                                         interrupted run; 202

Every call carries the user's HR API bearer token. A run is visible only to the user who
started it (anyone else gets 404, as if it didn't exist).

The event stream replays the stored timeline (from `Last-Event-ID` when a client
reconnects), then follows new events until the run finishes or waits for the user. Events
are read from the database, so a stream works the same after a server restart.
"""

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.agent_routes import bearer_token, get_policy_retriever, signed_in_user
from app.hr_client import HrApiClient
from app.llm_routes import get_llm
from app.settings import Settings
from graphs.hr_agent import build_hr_graph
from graphs.persistence import PostgresRunStore, RunRecord, open_checkpointer, summarize_state
from graphs.service import Caller, RunConflict, RunService
from rag.db import create_engine
from tracing.langfuse import TraceExporter

router = APIRouter(prefix="/agent/runs", tags=["agent runs"])

POLL_SECONDS = 0.5
KEEPALIVE_SECONDS = 15.0


class StartRun(BaseModel):
    request: str = Field(min_length=1, max_length=4000)


class ResumeRun(BaseModel):
    # The answer to the run's question; omit to continue an interrupted run.
    answer: str | None = Field(default=None, max_length=2000)


class RunView(BaseModel):
    id: str
    status: str
    request: str
    workflow_type: str | None
    question: dict[str, Any] | None
    answer: str | None
    error: str | None
    trace_ids: list[str]
    started_at: str
    updated_at: str
    completed_at: str | None
    # From the checkpoint: route, clarifications, policy citations, plan progress.
    progress: dict[str, Any] | None = None

    @classmethod
    def of(cls, run: RunRecord, progress: dict[str, Any] | None = None) -> "RunView":
        return cls(
            id=run.id,
            status=run.status,
            request=run.request,
            workflow_type=run.workflow_type,
            question=run.question,
            answer=run.answer,
            # Details stay in the logs; the user gets a plain statement.
            error="The run failed unexpectedly." if run.error else None,
            trace_ids=run.trace_ids,
            started_at=run.started_at.isoformat(),
            updated_at=run.updated_at.isoformat(),
            completed_at=run.completed_at.isoformat() if run.completed_at else None,
            progress=progress,
        )


async def get_run_service(request: Request) -> RunService:
    """Built on first use: opens the checkpointer pool, and marks runs that were `running`
    when the last process stopped as `interrupted`, so they can be resumed."""
    state = request.app.state
    if getattr(state, "run_service", None) is not None:
        return state.run_service
    lock: asyncio.Lock = state.run_service_lock
    async with lock:
        if getattr(state, "run_service", None) is None:
            llm = get_llm(request)
            settings: Settings = state.settings
            exporter: TraceExporter = state.trace_exporter
            stack = AsyncExitStack()
            checkpointer = await stack.enter_async_context(open_checkpointer(settings.ai_db_url))
            store = PostgresRunStore(create_engine(settings.ai_db_url))
            stack.push_async_callback(store.aclose)
            await store.mark_interrupted()
            state.run_service = RunService(
                graph=build_hr_graph(checkpointer),
                store=store,
                llm=llm,
                exporter=exporter,
                hr_api_url=settings.hr_api_url,
                hr_api_timeout=settings.hr_api_timeout,
                policies=get_policy_retriever(request, llm),
            )
            state.run_service_stack = stack
    return state.run_service


async def _caller(request: Request, authorization: str | None) -> Caller:
    token = bearer_token(authorization)
    settings: Settings = request.app.state.settings
    async with httpx.AsyncClient(
        base_url=settings.hr_api_url, timeout=settings.hr_api_timeout
    ) as http:
        user = await signed_in_user(HrApiClient(http, token))
    return Caller(token=token, user=user)


Service = Annotated[RunService, Depends(get_run_service)]


@router.post("", status_code=202, response_model=RunView)
async def start(
    body: StartRun,
    request: Request,
    service: Service,
    authorization: Annotated[str | None, Header()] = None,
) -> RunView:
    caller = await _caller(request, authorization)
    run, _ = await service.start(caller, body.request)
    return RunView.of(run)


@router.get("/{run_id}", response_model=RunView)
async def get(
    run_id: str,
    request: Request,
    service: Service,
    authorization: Annotated[str | None, Header()] = None,
) -> RunView:
    caller = await _caller(request, authorization)
    run = await _owned(service, caller, run_id)
    return RunView.of(run, summarize_state(await service.state(run)))


@router.post("/{run_id}/resume", status_code=202, response_model=RunView)
async def resume(
    run_id: str,
    body: ResumeRun,
    request: Request,
    service: Service,
    authorization: Annotated[str | None, Header()] = None,
) -> RunView:
    caller = await _caller(request, authorization)
    await _owned(service, caller, run_id)
    try:
        run, _ = await service.resume(caller, run_id, body.answer)
    except RunConflict as error:
        raise HTTPException(409, str(error)) from error
    return RunView.of(run.model_copy(update={"status": "running", "question": None}))


@router.get("/{run_id}/events")
async def events(
    run_id: str,
    request: Request,
    service: Service,
    authorization: Annotated[str | None, Header()] = None,
    last_event_id: Annotated[str | None, Header()] = None,
) -> StreamingResponse:
    caller = await _caller(request, authorization)
    await _owned(service, caller, run_id)
    after = int(last_event_id) if last_event_id and last_event_id.isdigit() else 0
    return StreamingResponse(
        event_stream(service, run_id, after, request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


async def event_stream(
    service: RunService, run_id: str, after: int, request: Request | None = None
) -> AsyncIterator[str]:
    idle = 0.0
    while True:
        new = await service.store.events(run_id, after=after)
        for event_id, event in new:
            after = event_id
            yield f"id: {event_id}\nevent: {event['event']}\ndata: {json.dumps(event)}\n\n"
        if new:
            idle = 0.0
        run = await service.store.get(run_id)
        if run is None or run.status != "running":
            # One last read: events written just before the status changed.
            for event_id, event in await service.store.events(run_id, after=after):
                yield f"id: {event_id}\nevent: {event['event']}\ndata: {json.dumps(event)}\n\n"
            return
        if request is not None and await request.is_disconnected():
            return
        await asyncio.sleep(POLL_SECONDS)
        idle += POLL_SECONDS
        if idle >= KEEPALIVE_SECONDS:
            idle = 0.0
            yield ": keep-alive\n\n"


async def _owned(service: RunService, caller: Caller, run_id: str) -> RunRecord:
    run = await service.get_for(caller, run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    return run
