"""The AI service's own tables, in the `ai` schema of the HR database.

The HR API owns `public` (Prisma); the AI service owns `ai` (Alembic, `migrations/`) and
never writes HR tables. pgvector is installed into `ai` too, so the HR schema stays exactly
as Prisma left it; connections add `ai` to the search path to find its types and operators.

    policy_version  one row per HR API policy version (id = the API's id), with a hash of
                    the source file so unchanged versions are never re-embedded
    policy_chunk    a heading-aware slice of a version: text, heading path, embedding and a
                    full-text `tsvector`; one set of chunks per chunker and size, so they
                    can be compared side by side (A4.5)
"""

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Column,
    Computed,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    Table,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import TSVECTOR, UUID
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

SCHEMA = "ai"
# Fixed by the migration: changing it means a new migration and re-ingesting everything.
EMBEDDING_DIMENSIONS = 768

metadata = MetaData(schema=SCHEMA)

policy_version = Table(
    "policy_version",
    metadata,
    Column("id", UUID(as_uuid=False), primary_key=True),
    Column("title", Text, nullable=False),
    Column("category", Text, nullable=False),
    Column("version", Integer, nullable=False),
    Column("effective_from", Date, nullable=False),
    Column("file_name", Text, nullable=False),
    Column("mime_type", Text, nullable=False),
    # sha256 of the source file: unchanged files are skipped on re-ingestion.
    Column("content_hash", Text, nullable=False),
    Column("ingested_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    UniqueConstraint("title", "version"),
)

policy_chunk = Table(
    "policy_chunk",
    metadata,
    Column("id", BigInteger, primary_key=True, autoincrement=True),
    Column(
        "policy_version_id",
        UUID(as_uuid=False),
        ForeignKey(f"{SCHEMA}.policy_version.id", ondelete="CASCADE"),
        nullable=False,
    ),
    # How the version was chunked: "heading" (structure-aware) or "fixed" (sliding window),
    # and the target size in approximate tokens. Both are part of the chunk's identity.
    Column("chunker", Text, nullable=False),
    Column("chunk_size", Integer, nullable=False),
    Column("chunk_index", Integer, nullable=False),
    # "Leave Policy (v2) > 1. Entitlements": the section a citation points to.
    Column("heading_path", Text, nullable=False),
    Column("content", Text, nullable=False),
    Column("token_count", Integer, nullable=False),
    # Which model made the vector: a model change means re-embedding, never mixing.
    Column("embedding_model", Text, nullable=False),
    Column("embedding", Vector(EMBEDDING_DIMENSIONS), nullable=False),
    # Headings are searchable too ("entitlements", "late arrival").
    Column(
        "tsv",
        TSVECTOR,
        Computed("to_tsvector('english', heading_path || ' ' || content)", persisted=True),
    ),
    UniqueConstraint("policy_version_id", "chunker", "chunk_size", "chunk_index"),
    Index(
        "policy_chunk_embedding_hnsw",
        "embedding",
        postgresql_using="hnsw",
        postgresql_ops={"embedding": "vector_cosine_ops"},
    ),
    Index("policy_chunk_tsv_gin", "tsv", postgresql_using="gin"),
)


def create_engine(url: str) -> AsyncEngine:
    return create_async_engine(
        url,
        pool_pre_ping=True,
        # pgvector lives in `ai`, so `vector` and `<=>` need it on the path. `public` stays
        # the default schema; our tables are always schema-qualified.
        connect_args={"server_settings": {"search_path": f"public, {SCHEMA}"}},
    )
