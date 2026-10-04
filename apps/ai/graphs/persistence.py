"""A5.4 and A5.6: where runs live between requests and across restarts.

**Checkpointer (A5.4).** LangGraph's `AsyncPostgresSaver`, on a psycopg pool whose
connections use `search_path=ai`, so its tables (checkpoints, checkpoint_blobs,
checkpoint_writes, checkpoint_migrations) are created in the AI service's schema. After every
node it writes the thread's state; a new process can load the latest checkpoint of a thread
and carry on. `setup()` creates and migrates those tables (idempotent), which is why Alembic
leaves them alone.

**Run records (A5.6).** `RunStore` keeps `workflow_run` rows, the event log and the
agent_run / tool_call records. `PostgresRunStore` is the real one; `MemoryRunStore` lets the
API be tested without a database.
"""

import json
from collections.abc import AsyncGenerator, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any, Protocol, cast
from uuid import uuid4

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncEngine

from graphs.records import (
    agent_run,
    approval,
    email_outbox,
    tool_call,
    workflow_event,
    workflow_run,
)
from rag.db import SCHEMA
from tracing.trace import Trace

TERMINAL = frozenset({"completed", "failed"})


def checkpointer_url(sqlalchemy_url: str) -> str:
    """psycopg's URL for the same database, with `ai` as the schema for new tables."""
    url = sqlalchemy_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}options=-csearch_path%3D{SCHEMA}"


@asynccontextmanager
async def open_checkpointer(sqlalchemy_url: str) -> AsyncGenerator[AsyncPostgresSaver]:
    pool = AsyncConnectionPool(
        checkpointer_url(sqlalchemy_url),
        # What the saver expects: autocommit, dict rows, no server-side prepared statements.
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
        min_size=1,
        max_size=5,
        open=False,
    )
    await pool.open()
    try:
        saver = AsyncPostgresSaver(pool)  # pyright: ignore[reportArgumentType]
        await saver.setup()
        yield saver
    finally:
        await pool.close()


class RunRecord(BaseModel):
    id: str
    thread_id: str
    user_id: str
    user_role: str
    request: str
    workflow_type: str | None = None
    status: str = "running"
    question: dict[str, Any] | None = None
    answer: str | None = None
    error: str | None = None
    trace_ids: list[str] = []
    started_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None

    @classmethod
    def new(cls, *, user_id: str, user_role: str, request: str) -> "RunRecord":
        run_id = str(uuid4())
        now = datetime.now(UTC)
        return cls(
            id=run_id,
            thread_id=run_id,
            user_id=user_id,
            user_role=user_role,
            request=request,
            started_at=now,
            updated_at=now,
        )


class RunStore(Protocol):
    async def create(self, run: RunRecord) -> None: ...
    async def get(self, run_id: str) -> RunRecord | None: ...
    async def list_for(
        self, user_id: str, *, status: str | None = None, limit: int = 20
    ) -> list[RunRecord]: ...
    async def update(self, run_id: str, **fields: Any) -> None: ...
    async def add_event(self, run_id: str, event: dict[str, Any]) -> int: ...
    async def events(self, run_id: str, *, after: int = 0) -> list[tuple[int, dict[str, Any]]]: ...
    async def record_trace(
        self, run_id: str, trace: Trace, *, skip: set[str] | None = None
    ) -> set[str]: ...
    async def mark_interrupted(self) -> int: ...
    async def record_approval(
        self, run_id: str, step_id: str, decision: dict[str, Any]
    ) -> None: ...
    async def aclose(self) -> None: ...


def trace_records(
    run_id: str, trace: Trace, skip: set[str] | None = None
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], set[str]]:
    """agent_run and tool_call rows from a trace's *finished* generations and tool spans
    (except those in `skip`, already recorded), masked; plus the observation ids used."""
    masker = trace.masker()
    agents: list[dict[str, Any]] = []
    tools: list[dict[str, Any]] = []
    used: set[str] = set()
    for o in trace.observations:
        if o.end_time is None or o.id in (skip or set()):
            continue
        used.add(o.id)
        base = {
            "id": str(uuid4()),
            "workflow_run_id": run_id,
            "latency_ms": o.latency_ms,
            "created_at": o.start_time,
        }
        if o.kind == "generation":
            agents.append(
                base
                | {
                    "name": o.name,
                    "model": o.model,
                    "prompt_version": o.metadata.get("prompt"),
                    "status": "error" if o.level == "ERROR" else "ok",
                    "prompt_tokens": o.usage.prompt_tokens if o.usage else None,
                    "completion_tokens": o.usage.completion_tokens if o.usage else None,
                }
            )
        elif o.name.startswith("tool "):
            ok = _succeeded(o.output) and o.level != "ERROR"
            tools.append(
                base
                | {
                    "tool_name": o.name.removeprefix("tool "),
                    "input": _jsonable(masker.mask(o.input)),
                    "output": _jsonable(masker.mask(o.output)),
                    "status": "ok" if ok else "failed",
                    "error": masker.mask(o.status_message),
                }
            )
    return agents, tools, used


def approval_row(run_id: str, step_id: str, decision: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(uuid4()),
        "workflow_run_id": run_id,
        "step_id": step_id,
        "tool": decision["tool"],
        "risk": decision["risk"],
        "decision": decision["decision"],
        "arguments": _jsonable(decision["arguments"]),
        "preview": _jsonable(decision.get("preview")),
        "comment": decision.get("comment"),
        "decided_by": decision["by"],
    }


def _succeeded(output: Any) -> bool:
    """A tool span's output is a ToolResult dump: {"ok": …}."""
    return isinstance(output, dict) and cast(dict[str, Any], output).get("ok") is True


class PostgresRunStore:
    def __init__(self, engine: AsyncEngine) -> None:
        self.engine = engine

    async def aclose(self) -> None:
        await self.engine.dispose()

    async def create(self, run: RunRecord) -> None:
        async with self.engine.begin() as conn:
            await conn.execute(insert(workflow_run).values(**run.model_dump()))

    async def get(self, run_id: str) -> RunRecord | None:
        async with self.engine.connect() as conn:
            row = (
                (await conn.execute(select(workflow_run).where(workflow_run.c.id == run_id)))
                .mappings()
                .first()
            )
        return RunRecord.model_validate(dict(row)) if row else None

    async def list_for(
        self, user_id: str, *, status: str | None = None, limit: int = 20
    ) -> list[RunRecord]:
        query = select(workflow_run).where(workflow_run.c.user_id == user_id)
        if status:
            query = query.where(workflow_run.c.status == status)
        query = query.order_by(workflow_run.c.started_at.desc()).limit(limit)
        async with self.engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
        return [RunRecord.model_validate(dict(row)) for row in rows]

    async def update(self, run_id: str, **fields: Any) -> None:
        fields["updated_at"] = datetime.now(UTC)
        async with self.engine.begin() as conn:
            await conn.execute(
                update(workflow_run).where(workflow_run.c.id == run_id).values(**fields)
            )

    async def add_event(self, run_id: str, event: dict[str, Any]) -> int:
        async with self.engine.begin() as conn:
            event_id = await conn.scalar(
                insert(workflow_event)
                .values(workflow_run_id=run_id, type=event["event"], data=_jsonable(event))
                .returning(workflow_event.c.id)
            )
        return int(event_id or 0)

    async def events(self, run_id: str, *, after: int = 0) -> list[tuple[int, dict[str, Any]]]:
        async with self.engine.connect() as conn:
            rows = await conn.execute(
                select(workflow_event.c.id, workflow_event.c.data)
                .where(workflow_event.c.workflow_run_id == run_id, workflow_event.c.id > after)
                .order_by(workflow_event.c.id)
            )
            return [(int(row.id), dict(row.data)) for row in rows]

    async def record_trace(
        self, run_id: str, trace: Trace, *, skip: set[str] | None = None
    ) -> set[str]:
        agents, tools, used = trace_records(run_id, trace, skip)
        async with self.engine.begin() as conn:
            if agents:
                await conn.execute(insert(agent_run), agents)
            if tools:
                await conn.execute(insert(tool_call), tools)
        return used

    async def record_approval(self, run_id: str, step_id: str, decision: dict[str, Any]) -> None:
        async with self.engine.begin() as conn:
            await conn.execute(insert(approval).values(**approval_row(run_id, step_id, decision)))

    async def mark_interrupted(self) -> int:
        """At startup: runs still `running` belonged to a process that's gone."""
        async with self.engine.begin() as conn:
            result = await conn.execute(
                update(workflow_run)
                .where(workflow_run.c.status == "running")
                .values(status="interrupted", updated_at=datetime.now(UTC))
            )
            return result.rowcount


class MemoryRunStore:
    """The same behaviour in dictionaries, for tests."""

    def __init__(self) -> None:
        self.runs: dict[str, RunRecord] = {}
        self.event_log: list[tuple[int, str, dict[str, Any]]] = []
        self.agent_runs: list[dict[str, Any]] = []
        self.tool_calls: list[dict[str, Any]] = []
        self.approvals: list[dict[str, Any]] = []

    async def aclose(self) -> None:
        return None

    async def create(self, run: RunRecord) -> None:
        self.runs[run.id] = run

    async def get(self, run_id: str) -> RunRecord | None:
        run = self.runs.get(run_id)
        return run.model_copy(deep=True) if run else None

    async def list_for(
        self, user_id: str, *, status: str | None = None, limit: int = 20
    ) -> list[RunRecord]:
        runs = [
            r.model_copy(deep=True)
            for r in self.runs.values()
            if r.user_id == user_id and (status is None or r.status == status)
        ]
        return sorted(runs, key=lambda r: r.started_at, reverse=True)[:limit]

    async def update(self, run_id: str, **fields: Any) -> None:
        run = self.runs[run_id]
        self.runs[run_id] = run.model_copy(update=fields | {"updated_at": datetime.now(UTC)})

    async def add_event(self, run_id: str, event: dict[str, Any]) -> int:
        event_id = len(self.event_log) + 1
        self.event_log.append((event_id, run_id, _jsonable(event)))
        return event_id

    async def events(self, run_id: str, *, after: int = 0) -> list[tuple[int, dict[str, Any]]]:
        return [(i, e) for i, r, e in self.event_log if r == run_id and i > after]

    async def record_trace(
        self, run_id: str, trace: Trace, *, skip: set[str] | None = None
    ) -> set[str]:
        agents, tools, used = trace_records(run_id, trace, skip)
        self.agent_runs.extend(agents)
        self.tool_calls.extend(tools)
        return used

    async def record_approval(self, run_id: str, step_id: str, decision: dict[str, Any]) -> None:
        self.approvals.append(approval_row(run_id, step_id, decision))

    async def mark_interrupted(self) -> int:
        stale = [run_id for run_id, run in self.runs.items() if run.status == "running"]
        for run_id in stale:
            await self.update(run_id, status="interrupted")
        return len(stale)


def _jsonable[T](value: T) -> T:
    """Round-trips through JSON: dates become strings, and nothing unserialisable sneaks in."""
    return json.loads(json.dumps(value, default=str))


RESULT_PREVIEW_CHARS = 1200


def _short_result(record: dict[str, Any]) -> str | None:
    data = record.get("data")
    if data is None:
        return None
    text = json.dumps(data, ensure_ascii=False, default=str)
    return text if len(text) <= RESULT_PREVIEW_CHARS else text[:RESULT_PREVIEW_CHARS] + "…"


def summarize_state(values: dict[str, Any]) -> dict[str, Any]:
    """The parts of a checkpoint worth showing in GET /agent/runs/:id."""
    plan: dict[str, Any] = values.get("plan") or {}
    results: dict[str, Any] = values.get("results", {})
    steps: Sequence[dict[str, Any]] = plan.get("steps", [])
    return {
        "intent": cast(dict[str, Any], values.get("parsed") or {}).get("intent"),
        "route": values.get("route"),
        "clarifications": values.get("clarifications", []),
        "policy": [p["citation"] for p in values.get("policy", [])],
        "plan": {
            "goal": plan.get("goal"),
            "steps": [
                {
                    "id": s["id"],
                    "tool": s["tool"],
                    "reason": s.get("reason"),
                    "status": results.get(s["id"], {}).get("status", "pending"),
                    "error": results.get(s["id"], {}).get("error"),
                    "result": _short_result(results.get(s["id"], {})),
                }
                for s in steps
            ],
        }
        if plan
        else None,
        "verification": values.get("verification"),
        # The evidence behind the answer (A12.1): passages as the model saw them, and each
        # step's result, shortened.
        "passages": [
            {"citation": p["citation"], "text": p.get("text", ""), "warning": p.get("warning")}
            for p in values.get("policy", [])
        ],
        "summary": values.get("summary") or [],
        "approvals": [
            {
                "step": step_id,
                "tool": a.get("tool"),
                "decision": a.get("decision"),
                "risk": a.get("risk"),
                "comment": a.get("comment"),
            }
            for step_id, a in cast(dict[str, dict[str, Any]], values.get("approvals") or {}).items()
        ],
    }


class PostgresOutbox:
    """send_email's destination: queued rows that nothing sends. A retried step (same
    idempotency key) gets the first message's id instead of queueing another."""

    def __init__(self, engine: AsyncEngine) -> None:
        self.engine = engine

    async def add(self, message: dict[str, Any]) -> str:
        key = message.get("idempotency_key")
        async with self.engine.begin() as conn:
            if key:
                existing = await conn.scalar(
                    select(email_outbox.c.id).where(email_outbox.c.idempotency_key == key)
                )
                if existing:
                    return str(existing)
            message_id = str(uuid4())
            await conn.execute(
                insert(email_outbox).values(
                    id=message_id,
                    to_address=message["to"],
                    subject=message["subject"],
                    body=message["body"],
                    idempotency_key=key,
                )
            )
            return message_id


class MemoryOutbox:
    def __init__(self) -> None:
        self.messages: dict[str, dict[str, Any]] = {}

    async def add(self, message: dict[str, Any]) -> str:
        for message_id, queued in self.messages.items():
            if message.get("idempotency_key") and queued.get("idempotency_key") == message.get(
                "idempotency_key"
            ):
                return message_id
        message_id = str(uuid4())
        self.messages[message_id] = message
        return message_id
