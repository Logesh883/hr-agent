"""Reading and writing the `ai` policy tables: ingestion upserts, vector and keyword search.

Both searches answer only from the versions in scope (`SearchScope`): for each policy, the
version in force on `as_of`, plus (when asked) versions that take effect later, which are
returned flagged as upcoming. Superseded versions are never searched unless `as_of` is a
date when they were in force: that's how "how much annual leave did we get in 2025?" finds
Leave Policy v1 while today's questions find v2.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import bindparam, delete, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from rag.chunking import Chunk, section_label
from rag.db import EMBEDDING_DIMENSIONS, policy_chunk, policy_version


@dataclass(frozen=True)
class PolicyVersionMeta:
    id: str
    title: str
    category: str
    version: int
    effective_from: date
    file_name: str
    mime_type: str


@dataclass(frozen=True)
class SearchScope:
    as_of: date
    chunker: str
    chunk_size: int
    embedding_model: str
    # Also search versions that take effect after `as_of` (returned with `upcoming=True`).
    include_upcoming: bool = True
    category: str | None = None


@dataclass(frozen=True)
class PolicyHit:
    chunk_id: int
    policy_version_id: str
    title: str
    category: str
    version: int
    effective_from: date
    heading_path: tuple[str, ...]
    content: str
    # Raw score from the search that found it: cosine similarity or text rank.
    score: float
    upcoming: bool

    @property
    def section(self) -> str:
        return self.heading_path[-1] if len(self.heading_path) > 1 else ""

    @property
    def citation(self) -> str:
        """How to cite the chunk: e.g. `Leave Policy v2 §1 Entitlements`, or
        `Code of Conduct v1, Raising concerns` for an unnumbered heading."""
        name = f"{self.title} v{self.version}"
        if not self.section:
            return name
        label = section_label(self.section)
        return f"{name} {label}" if label.startswith("§") else f"{name}, {label}"


# Versions in scope: per title, the latest version in force on :as_of; plus later versions
# when :include_upcoming. DISTINCT ON keeps the first row per title in ORDER BY order.
_SCOPE = """
in_scope AS (
    SELECT id FROM (
        SELECT DISTINCT ON (title) id
        FROM ai.policy_version
        WHERE effective_from <= :as_of
        ORDER BY title, effective_from DESC, version DESC
    ) in_force
    UNION ALL
    SELECT id FROM ai.policy_version WHERE :include_upcoming AND effective_from > :as_of
)"""

_HIT_COLUMNS = """
    c.id, v.id AS version_id, v.title, v.category, v.version, v.effective_from,
    c.heading_path, c.content, v.effective_from > :as_of AS upcoming"""

_CHUNK_FILTER = """
    c.policy_version_id IN (SELECT id FROM in_scope)
    AND c.chunker = :chunker AND c.chunk_size = :chunk_size
    AND c.embedding_model = :embedding_model
    AND (CAST(:category AS text) IS NULL OR v.category = :category)"""

VECTOR_SQL = text(
    f"""
WITH {_SCOPE}
SELECT {_HIT_COLUMNS}, 1 - (c.embedding <=> :query_vector) AS score
FROM ai.policy_chunk c JOIN ai.policy_version v ON v.id = c.policy_version_id
WHERE {_CHUNK_FILTER}
ORDER BY c.embedding <=> :query_vector
LIMIT :k"""
).bindparams(bindparam("query_vector", type_=Vector(EMBEDDING_DIMENSIONS)))

# Postgres full-text search, OR-ing the question's words: `websearch_to_tsquery` would AND
# them, and a question rarely shares *every* word with its answer. to_tsvector stems the
# question and drops stop words; each lexeme is quoted and joined with `|` ('simple', so
# the stems aren't stemmed again). A question of only stop words becomes an empty query,
# which matches nothing. ts_rank_cd rewards matching more terms, close together.
KEYWORD_SQL = text(
    f"""
WITH {_SCOPE},
query AS (
    SELECT coalesce(to_tsquery('simple', nullif(array_to_string(ARRAY(
        SELECT quote_literal(lexeme)
        FROM unnest(tsvector_to_array(to_tsvector('english', :query))) AS lexeme
    ), ' | '), '')), ''::tsquery) AS q
)
SELECT {_HIT_COLUMNS}, ts_rank_cd(c.tsv, query.q) AS score
FROM ai.policy_chunk c JOIN ai.policy_version v ON v.id = c.policy_version_id, query
WHERE {_CHUNK_FILTER} AND c.tsv @@ query.q
ORDER BY score DESC, c.id
LIMIT :k"""
)


class PolicyStore:
    def __init__(self, engine: AsyncEngine) -> None:
        # Vectors travel as pgvector's text format ("[0.1,0.2,…]"): the `Vector` column type
        # converts them, so asyncpg needs no codec.
        self.engine = engine

    async def aclose(self) -> None:
        await self.engine.dispose()

    # ---- ingestion --------------------------------------------------------------------

    async def stored_hash(self, version_id: str) -> str | None:
        async with self.engine.connect() as conn:
            return await conn.scalar(
                select(policy_version.c.content_hash).where(policy_version.c.id == version_id)
            )

    async def has_chunks(self, version_id: str, chunker: str, size: int, model: str) -> bool:
        async with self.engine.connect() as conn:
            found = await conn.scalar(
                select(policy_chunk.c.id)
                .where(
                    policy_chunk.c.policy_version_id == version_id,
                    policy_chunk.c.chunker == chunker,
                    policy_chunk.c.chunk_size == size,
                    policy_chunk.c.embedding_model == model,
                )
                .limit(1)
            )
            return found is not None

    async def save_version(
        self,
        meta: PolicyVersionMeta,
        content_hash: str,
        *,
        chunker: str,
        size: int,
        model: str,
        chunks: Sequence[Chunk],
        vectors: Sequence[Sequence[float]],
    ) -> None:
        """Upserts the version and replaces its chunks for this chunker/size, atomically. A
        changed file (new hash) drops every other chunk set too: they describe old text."""
        async with self.engine.begin() as conn:
            previous = await conn.scalar(
                select(policy_version.c.content_hash).where(policy_version.c.id == meta.id)
            )
            values = {**meta.__dict__, "content_hash": content_hash}
            await conn.execute(
                insert(policy_version)
                .values(**values)
                .on_conflict_do_update(
                    index_elements=[policy_version.c.id],
                    set_={**values, "ingested_at": text("now()")},
                )
            )
            stale = delete(policy_chunk).where(policy_chunk.c.policy_version_id == meta.id)
            if previous == content_hash:
                stale = stale.where(
                    policy_chunk.c.chunker == chunker, policy_chunk.c.chunk_size == size
                )
            await conn.execute(stale)
            if chunks:
                await conn.execute(
                    policy_chunk.insert(),
                    [
                        {
                            "policy_version_id": meta.id,
                            "chunker": chunker,
                            "chunk_size": size,
                            "chunk_index": chunk.index,
                            "heading_path": " > ".join(chunk.heading_path),
                            "content": chunk.content,
                            "token_count": chunk.token_count,
                            "embedding_model": model,
                            "embedding": list(vector),
                        }
                        for chunk, vector in zip(chunks, vectors, strict=True)
                    ],
                )

    async def remove_versions_except(self, keep: Sequence[str]) -> int:
        """Deletes versions the HR API no longer has (chunks cascade). Returns how many."""
        async with self.engine.begin() as conn:
            result = await conn.execute(
                delete(policy_version).where(policy_version.c.id.not_in(list(keep)))
            )
            return result.rowcount

    # ---- search -----------------------------------------------------------------------

    async def vector_search(
        self, query_vector: Sequence[float], scope: SearchScope, *, k: int
    ) -> list[PolicyHit]:
        async with self.engine.begin() as conn:
            # With a WHERE clause, HNSW finds its nearest neighbours first and filters after,
            # so it can return fewer than k rows. Iterative scans keep searching (pgvector
            # 0.8+) until k rows pass the filter.
            await conn.execute(text("SET LOCAL hnsw.iterative_scan = strict_order"))
            return await _hits(
                conn,
                VECTOR_SQL,
                {**_scope_params(scope), "query_vector": list(query_vector), "k": k},
            )

    async def keyword_search(self, query: str, scope: SearchScope, *, k: int) -> list[PolicyHit]:
        async with self.engine.connect() as conn:
            return await _hits(conn, KEYWORD_SQL, {**_scope_params(scope), "query": query, "k": k})


def _scope_params(scope: SearchScope) -> dict[str, Any]:
    return {
        "as_of": scope.as_of,
        "include_upcoming": scope.include_upcoming,
        "chunker": scope.chunker,
        "chunk_size": scope.chunk_size,
        "embedding_model": scope.embedding_model,
        "category": scope.category,
    }


async def _hits(conn: AsyncConnection, sql: Any, params: dict[str, Any]) -> list[PolicyHit]:
    rows = (await conn.execute(sql, params)).mappings()
    return [
        PolicyHit(
            chunk_id=row["id"],
            policy_version_id=str(row["version_id"]),
            title=row["title"],
            category=row["category"],
            version=row["version"],
            effective_from=row["effective_from"],
            heading_path=tuple(row["heading_path"].split(" > ")),
            content=row["content"],
            score=float(row["score"]),
            upcoming=row["upcoming"],
        )
        for row in rows
    ]
