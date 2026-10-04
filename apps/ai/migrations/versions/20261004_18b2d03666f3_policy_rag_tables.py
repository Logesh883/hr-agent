"""A4.1: policy_version and policy_chunk, with pgvector HNSW and full-text indexes.

Revision ID: 18b2d03666f3
Revises:
Create Date: 2026-10-04 08:59:37.025615
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects.postgresql import TSVECTOR, UUID

revision: str = "18b2d03666f3"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Into `ai`, not `public`: the HR schema stays exactly as Prisma manages it.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA ai")
    op.create_table(
        "policy_version",
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("category", sa.Text, nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("effective_from", sa.Date, nullable=False),
        sa.Column("file_name", sa.Text, nullable=False),
        sa.Column("mime_type", sa.Text, nullable=False),
        sa.Column("content_hash", sa.Text, nullable=False),
        sa.Column(
            "ingested_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("title", "version"),
        schema="ai",
    )
    op.create_table(
        "policy_chunk",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column(
            "policy_version_id",
            UUID(as_uuid=False),
            sa.ForeignKey("ai.policy_version.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("chunker", sa.Text, nullable=False),
        sa.Column("chunk_size", sa.Integer, nullable=False),
        sa.Column("chunk_index", sa.Integer, nullable=False),
        sa.Column("heading_path", sa.Text, nullable=False),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("token_count", sa.Integer, nullable=False),
        sa.Column("embedding_model", sa.Text, nullable=False),
        sa.Column("embedding", Vector(768), nullable=False),
        sa.Column(
            "tsv",
            TSVECTOR,
            sa.Computed("to_tsvector('english', heading_path || ' ' || content)", persisted=True),
        ),
        sa.UniqueConstraint("policy_version_id", "chunker", "chunk_size", "chunk_index"),
        schema="ai",
    )
    # HNSW: a graph index, good recall without training (IVFFlat needs data to build lists).
    # Cosine ops to match the `<=>` operator retrieval uses.
    op.create_index(
        "policy_chunk_embedding_hnsw",
        "policy_chunk",
        ["embedding"],
        schema="ai",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )
    op.create_index(
        "policy_chunk_tsv_gin", "policy_chunk", ["tsv"], schema="ai", postgresql_using="gin"
    )


def downgrade() -> None:
    op.drop_table("policy_chunk", schema="ai")
    op.drop_table("policy_version", schema="ai")
    op.execute("DROP EXTENSION IF EXISTS vector")
