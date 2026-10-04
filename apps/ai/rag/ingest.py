"""A4.2: HR API policies → chunks with embeddings in the `ai` schema.

1. List policies (`GET /policies`) and download each version's file, as the least-privilege
   service login (Employee role: `policy:read`).
2. Parse (Markdown, PDF text layer, DOCX), chunk, embed.
3. Upsert by content hash: a version whose file and chunk set are unchanged is skipped
   without calling the embeddings API, so re-running is cheap and idempotent. Versions the
   API no longer lists are removed.
"""

import hashlib
import logging
from dataclasses import dataclass, field

from pydantic import TypeAdapter

from app.hr_client import HrApiClient
from contracts import generated as api
from rag.chunking import Chunker, chunk
from rag.embeddings import Embedder
from rag.parsing import UnsupportedPolicyFile, to_text
from rag.store import PolicyStore, PolicyVersionMeta

logger = logging.getLogger("hr_ai.rag")

_POLICIES = TypeAdapter(list[api.Policy])


@dataclass
class IngestReport:
    chunker: str
    chunk_size: int
    embedding_model: str
    versions: int = 0
    embedded: int = 0
    unchanged: int = 0
    removed: int = 0
    chunks: int = 0
    # "Title vN: reason" for files that couldn't be read; the rest still get ingested.
    failed: list[str] = field(default_factory=list[str])


async def ingest_policies(
    hr: HrApiClient,
    store: PolicyStore,
    embedder: Embedder,
    *,
    chunker: Chunker = "heading",
    chunk_size: int = 256,
) -> IngestReport:
    report = IngestReport(chunker, chunk_size, embedder.model)
    policies = _POLICIES.validate_python(await hr.get("/policies"))
    seen: list[str] = []
    for policy in policies:
        for version in policy.versions:
            report.versions += 1
            version_id = str(version.id)
            seen.append(version_id)
            meta = PolicyVersionMeta(
                id=version_id,
                title=policy.title,
                category=policy.category,
                version=version.version,
                effective_from=version.effective_from,
                file_name=version.file_name,
                mime_type=version.mime_type,
            )
            data, _ = await hr.download(f"/policies/{version_id}/file")
            content_hash = hashlib.sha256(data).hexdigest()
            if await store.stored_hash(version_id) == content_hash and await store.has_chunks(
                version_id, chunker, chunk_size, embedder.model
            ):
                report.unchanged += 1
                continue
            try:
                text = to_text(data, mime_type=version.mime_type, file_name=version.file_name)
            except UnsupportedPolicyFile as error:
                report.failed.append(f"{policy.title} v{version.version}: {error}")
                continue
            chunks = chunk(text, chunker=chunker, size=chunk_size)
            # The title goes in with every chunk: "Leave Policy (v2) > 1. Entitlements" says
            # what the bare table "| Annual leave | 18 |" is about.
            vectors = await embedder.embed_documents(
                [f"{' > '.join(c.heading_path)}\n\n{c.content}" for c in chunks],
                titles=[f"{policy.title} v{version.version}"] * len(chunks),
            )
            await store.save_version(
                meta,
                content_hash,
                chunker=chunker,
                size=chunk_size,
                model=embedder.model,
                chunks=chunks,
                vectors=vectors,
            )
            report.embedded += 1
            report.chunks += len(chunks)
    report.removed = await store.remove_versions_except(seen)
    logger.info("rag.ingest", extra={"fields": report.__dict__})
    return report
