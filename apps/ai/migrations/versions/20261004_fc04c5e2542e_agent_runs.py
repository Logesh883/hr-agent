"""A5.6: workflow_run, agent_run, tool_call and workflow_event.

LangGraph's checkpoint tables live in `ai` too, but its own `setup()` creates and migrates
them (graphs/persistence.py); env.py keeps Alembic away from them.

Revision ID: fc04c5e2542e
Revises: 18b2d03666f3
Create Date: 2026-10-04 09:53:46.858714

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "fc04c5e2542e"
down_revision: str | None = "18b2d03666f3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "workflow_run",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("thread_id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("user_role", sa.Text(), nullable=False),
        sa.Column("request", sa.Text(), nullable=False),
        sa.Column("workflow_type", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("question", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("answer", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "trace_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("thread_id"),
        schema="ai",
    )
    op.create_index(
        "workflow_run_user_idx",
        "workflow_run",
        ["user_id", "started_at"],
        unique=False,
        schema="ai",
    )
    op.create_table(
        "agent_run",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("workflow_run_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=True),
        sa.Column("prompt_version", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("completion_tokens", sa.Integer(), nullable=True),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["workflow_run_id"], ["ai.workflow_run.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        schema="ai",
    )
    op.create_index(
        "agent_run_workflow_idx", "agent_run", ["workflow_run_id"], unique=False, schema="ai"
    )
    op.create_table(
        "tool_call",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("workflow_run_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("tool_name", sa.Text(), nullable=False),
        sa.Column("input", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("output", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["workflow_run_id"], ["ai.workflow_run.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        schema="ai",
    )
    op.create_index(
        "tool_call_workflow_idx", "tool_call", ["workflow_run_id"], unique=False, schema="ai"
    )
    op.create_table(
        "workflow_event",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("workflow_run_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("data", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["workflow_run_id"], ["ai.workflow_run.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        schema="ai",
    )
    op.create_index(
        "workflow_event_run_idx",
        "workflow_event",
        ["workflow_run_id", "id"],
        unique=False,
        schema="ai",
    )


def downgrade() -> None:
    op.drop_index("workflow_event_run_idx", table_name="workflow_event", schema="ai")
    op.drop_table("workflow_event", schema="ai")
    op.drop_index("tool_call_workflow_idx", table_name="tool_call", schema="ai")
    op.drop_table("tool_call", schema="ai")
    op.drop_index("agent_run_workflow_idx", table_name="agent_run", schema="ai")
    op.drop_table("agent_run", schema="ai")
    op.drop_index("workflow_run_user_idx", table_name="workflow_run", schema="ai")
    op.drop_table("workflow_run", schema="ai")
