"""A4.5: retrieval quality on labelled policy questions (recall@5, MRR).

Each case names the policy version that answers it and an evidence phrase from that
version's text. A retrieved chunk is a hit when it comes from that version *and* contains
the phrase, so the check is the same for any chunker or size: a chunk that has the right
section heading but lost the sentence to a cut doesn't count.

    recall@5  share of questions with a hit in the top 5 (what the agent actually reads)
    MRR       mean of 1/rank of the first hit in the top 10 (0 if none): rewards rank 1
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from time import perf_counter

from pydantic import BaseModel, ConfigDict

from rag.embeddings import Embedder
from rag.retrieval import Mode, PolicyRetriever
from rag.store import PolicyHit

TOP_K = 10
RECALL_AT = 5


class RagCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    question: str
    # Questions about the past ("in 2025") are asked as of a date then.
    as_of: date | None = None
    policy: str
    version: int
    section: str
    evidence: str


@dataclass
class ModeResult:
    label: str
    mode: Mode
    recall: float = 0.0
    mrr: float = 0.0
    latency_ms: float = 0.0
    # Case id → rank of the first hit (None: not in the top 10).
    ranks: dict[str, int | None] = field(default_factory=dict[str, int | None])

    @property
    def misses(self) -> list[str]:
        return [case_id for case_id, rank in self.ranks.items() if rank is None or rank > RECALL_AT]


def load_cases(path: Path) -> list[RagCase]:
    cases = [
        RagCase.model_validate_json(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if len({case.id for case in cases}) != len(cases):
        raise ValueError(f"{path}: duplicate case ids")
    return cases


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def is_hit(hit: PolicyHit, case: RagCase) -> bool:
    return (
        hit.title == case.policy
        and hit.version == case.version
        and _squash(case.evidence) in _squash(hit.content)
    )


def first_hit_rank(hits: Sequence[PolicyHit], case: RagCase) -> int | None:
    return next((rank for rank, hit in enumerate(hits, start=1) if is_hit(hit, case)), None)


async def evaluate(
    retriever: PolicyRetriever, cases: Sequence[RagCase], *, mode: Mode, today: date, label: str
) -> ModeResult:
    result = ModeResult(label=label, mode=mode)
    elapsed = 0.0
    for case in cases:
        scope = retriever.scope(case.as_of or today, include_upcoming=case.as_of is None)
        start = perf_counter()
        hits = await retriever.search(case.question, scope, k=TOP_K, mode=mode)
        elapsed += perf_counter() - start
        result.ranks[case.id] = first_hit_rank(hits, case)
    ranks = list(result.ranks.values())
    result.recall = sum(1 for r in ranks if r is not None and r <= RECALL_AT) / len(ranks)
    result.mrr = sum(1 / r for r in ranks if r is not None) / len(ranks)
    result.latency_ms = elapsed * 1000 / len(ranks)
    return result


class CachedQueryEmbedder:
    """Wraps an embedder so each question is embedded once for the whole eval: the query
    vector doesn't depend on how the policies were chunked. Saves API calls and rate limit."""

    def __init__(self, inner: Embedder) -> None:
        self.inner = inner
        self.model = inner.model
        self.dimensions = inner.dimensions
        self._queries: dict[str, list[float]] = {}

    async def embed_documents(
        self, texts: Sequence[str], *, titles: Sequence[str] | None = None
    ) -> list[list[float]]:
        return await self.inner.embed_documents(texts, titles=titles)

    async def embed_query(self, text: str) -> list[float]:
        if text not in self._queries:
            self._queries[text] = await self.inner.embed_query(text)
        return self._queries[text]

    async def aclose(self) -> None:
        await self.inner.aclose()


def results_table(results: Sequence[ModeResult]) -> str:
    lines = [
        "| Chunks | Retrieval | Recall@5 | MRR | Avg latency |",
        "| --- | --- | ---: | ---: | ---: |",
    ]
    best = max(results, key=lambda r: (r.recall, r.mrr))
    for r in results:
        mark = " **(best)**" if r is best else ""
        lines.append(
            f"| {r.label} | {r.mode}{mark} | {r.recall:.2f} | {r.mrr:.3f} | "
            f"{r.latency_ms:,.0f} ms |"
        )
    return "\n".join(lines)
