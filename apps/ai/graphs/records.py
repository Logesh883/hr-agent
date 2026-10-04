"""A5.6: run records in the `ai` schema (the spec's data model), plus the event log.

    workflow_run   one agent run: who asked what, its status and pending question or answer
    agent_run      one LLM call in it: node, model, prompt version, tokens, latency
    tool_call      one tool call in it: tool, input, output, status, latency
    workflow_event the timeline the API streams (A5.5), in order; replayable after a restart

The LangGraph checkpoint (graphs/persistence.py) is the *state* needed to continue a run;
these tables are the *record* of what happened, for people and dashboards. They're written
from the run's trace, so the records, the Langfuse trace and the API response agree.
"""

from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Table,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID

from rag.db import SCHEMA, metadata

RUN_STATUSES = ("running", "waiting", "completed", "failed", "interrupted")

workflow_run = Table(
    "workflow_run",
    metadata,
    Column("id", UUID(as_uuid=False), primary_key=True),
    # The LangGraph thread holding this run's checkpoints.
    Column("thread_id", Text, nullable=False, unique=True),
    Column("user_id", Text, nullable=False),
    Column("user_role", Text, nullable=False),
    Column("request", Text, nullable=False),
    # The parsed intent once known ("leave_balance", …): the spec's workflowType.
    Column("workflow_type", Text),
    # running | waiting (for the user) | completed | failed | interrupted (process died)
    Column("status", Text, nullable=False),
    # The pending interrupt while waiting: {"type", "question", "options"?}.
    Column("question", JSONB),
    Column("answer", Text),
    Column("error", Text),
    Column("trace_ids", JSONB, nullable=False, server_default="[]"),
    Column("started_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("completed_at", DateTime(timezone=True)),
    Index("workflow_run_user_idx", "user_id", "started_at"),
)

agent_run = Table(
    "agent_run",
    metadata,
    Column("id", UUID(as_uuid=False), primary_key=True),
    Column(
        "workflow_run_id",
        UUID(as_uuid=False),
        ForeignKey(f"{SCHEMA}.workflow_run.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("name", Text, nullable=False),  # "llm plan", "llm step 2", …
    Column("model", Text),
    Column("prompt_version", Text),
    Column("status", Text, nullable=False),  # ok | error
    Column("prompt_tokens", Integer),
    Column("completion_tokens", Integer),
    Column("latency_ms", Float(asdecimal=False)),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Index("agent_run_workflow_idx", "workflow_run_id"),
)

tool_call = Table(
    "tool_call",
    metadata,
    Column("id", UUID(as_uuid=False), primary_key=True),
    Column(
        "workflow_run_id",
        UUID(as_uuid=False),
        ForeignKey(f"{SCHEMA}.workflow_run.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("tool_name", Text, nullable=False),
    # Masked like the trace: no tokens, contact details or names.
    Column("input", JSONB),
    Column("output", JSONB),
    Column("status", Text, nullable=False),  # ok | failed
    Column("error", Text),
    Column("latency_ms", Float(asdecimal=False)),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Index("tool_call_workflow_idx", "workflow_run_id"),
)

workflow_event = Table(
    "workflow_event",
    metadata,
    # Increasing id = order, and the SSE event id a client resumes from (Last-Event-ID).
    Column("id", BigInteger, primary_key=True, autoincrement=True),
    Column(
        "workflow_run_id",
        UUID(as_uuid=False),
        ForeignKey(f"{SCHEMA}.workflow_run.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("type", Text, nullable=False),
    Column("data", JSONB, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("workflow_event_run_idx", "workflow_run_id", "id"),
)

approval = Table(
    "approval",
    metadata,
    # A6.4: every decision on a write that needed approval, with what was shown.
    Column("id", UUID(as_uuid=False), primary_key=True),
    Column(
        "workflow_run_id",
        UUID(as_uuid=False),
        ForeignKey(f"{SCHEMA}.workflow_run.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("step_id", Text, nullable=False),
    Column("tool", Text, nullable=False),
    Column("risk", Text, nullable=False),
    # approved | edited | rejected
    Column("decision", Text, nullable=False),
    # The arguments that were approved (after any edit): exactly what ran.
    Column("arguments", JSONB, nullable=False),
    # The summary and before → after diff the person saw.
    Column("preview", JSONB),
    Column("comment", Text),
    Column("decided_by", Text, nullable=False),
    Column("decided_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index("approval_workflow_idx", "workflow_run_id"),
)

email_outbox = Table(
    "email_outbox",
    metadata,
    # send_email's stub: messages are queued here and never sent.
    Column("id", UUID(as_uuid=False), primary_key=True),
    Column("to_address", Text, nullable=False),
    Column("subject", Text, nullable=False),
    Column("body", Text, nullable=False),
    # The step's idempotency key: a retried step doesn't queue a second copy.
    Column("idempotency_key", Text, unique=True),
    Column("status", Text, nullable=False, server_default="queued"),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
)
