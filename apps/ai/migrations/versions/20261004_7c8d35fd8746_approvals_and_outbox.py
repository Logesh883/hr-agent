"""A6.4 approvals and the send_email outbox stub.

Revision ID: 7c8d35fd8746
Revises: fc04c5e2542e
Create Date: 2026-10-04 10:22:25.209602

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "7c8d35fd8746"
down_revision: str | None = "fc04c5e2542e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "email_outbox",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("to_address", sa.Text(), nullable=False),
        sa.Column("subject", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), server_default="queued", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idempotency_key"),
        schema="ai",
    )
    op.create_table(
        "approval",
        sa.Column("id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("workflow_run_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("step_id", sa.Text(), nullable=False),
        sa.Column("tool", sa.Text(), nullable=False),
        sa.Column("risk", sa.Text(), nullable=False),
        sa.Column("decision", sa.Text(), nullable=False),
        sa.Column("arguments", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("preview", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("decided_by", sa.Text(), nullable=False),
        sa.Column(
            "decided_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["workflow_run_id"], ["ai.workflow_run.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        schema="ai",
    )
    op.create_index(
        "approval_workflow_idx", "approval", ["workflow_run_id"], unique=False, schema="ai"
    )


def downgrade() -> None:
    op.drop_index("approval_workflow_idx", table_name="approval", schema="ai")
    op.drop_table("approval", schema="ai")
    op.drop_table("email_outbox", schema="ai")
