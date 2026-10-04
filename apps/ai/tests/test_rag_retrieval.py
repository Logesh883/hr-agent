"""Retrieval logic (fusion, reranking) and the `search_policy` tool, with a stub store.

The SQL itself is tested against Postgres in test_rag_store.py.
"""

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import cast

import httpx
import pytest

from agent.ask import ASK_REGISTRY, READ_REGISTRY, answer_question
from app.hr_client import HrApiClient, SessionUser
from llm.fake import FakeLLM
from llm.types import ToolCall
from rag.fake import FakeEmbedder
from rag.retrieval import (
    PolicyRetriever,
    RetrievalConfig,
    hit_payload,
    reciprocal_rank_fusion,
)
from rag.store import PolicyHit, PolicyStore, SearchScope
from tests.hr_data import BASE_URL, calls, session_user, tool_call
from tools.base import ToolContext

TODAY = date(2026, 10, 4)


def hit(chunk_id: int, section: str = "1. Entitlements", **overrides: object) -> PolicyHit:
    values: dict[str, object] = {
        "chunk_id": chunk_id,
        "policy_version_id": "v2",
        "title": "Leave Policy",
        "category": "LEAVE",
        "version": 2,
        "effective_from": date(2026, 1, 1),
        "heading_path": ("Leave Policy (v2)", section),
        "content": f"chunk {chunk_id}",
        "score": 0.5,
        "upcoming": False,
    }
    return PolicyHit(**(values | overrides))  # pyright: ignore[reportArgumentType]


@dataclass
class StubStore:
    vector: list[PolicyHit] = field(default_factory=list[PolicyHit])
    keyword: list[PolicyHit] = field(default_factory=list[PolicyHit])
    scopes: list[SearchScope] = field(default_factory=list[SearchScope])

    async def vector_search(
        self, query_vector: Sequence[float], scope: SearchScope, *, k: int
    ) -> list[PolicyHit]:
        self.scopes.append(scope)
        return self.vector[:k]

    async def keyword_search(self, query: str, scope: SearchScope, *, k: int) -> list[PolicyHit]:
        self.scopes.append(scope)
        return self.keyword[:k]


def retriever(
    store: StubStore, *, llm: FakeLLM | None = None, mode: str = "hybrid"
) -> PolicyRetriever:
    return PolicyRetriever(
        cast(PolicyStore, store),
        FakeEmbedder(),
        RetrievalConfig("heading", 256, mode),  # pyright: ignore[reportArgumentType]
        llm=llm,
    )


def test_rrf_rewards_agreement_over_one_strong_rank() -> None:
    vector = [hit(1), hit(2), hit(3)]
    keyword = [hit(3), hit(4), hit(2)]

    fused = reciprocal_rank_fusion([vector, keyword])

    # 3: ranks 3 and 1; 2: ranks 2 and 3; 1: rank 1 only; 4: rank 2 only.
    assert [h.chunk_id for h in fused] == [3, 2, 1, 4]
    assert fused[0].score == pytest.approx(1 / 63 + 1 / 61)


async def test_modes_call_the_matching_searches() -> None:
    store = StubStore(vector=[hit(1), hit(2)], keyword=[hit(2), hit(9)])
    search = retriever(store)
    scope = search.scope(TODAY)

    assert [h.chunk_id for h in await search.search("q", scope, mode="vector")] == [1, 2]
    assert [h.chunk_id for h in await search.search("q", scope, mode="keyword")] == [2, 9]
    assert [h.chunk_id for h in await search.search("q", scope, k=2)] == [2, 1]
    assert scope.embedding_model == "fake-embedding" and scope.chunk_size == 256


async def test_rerank_orders_by_llm_score_with_fused_order_breaking_ties() -> None:
    store = StubStore(vector=[hit(1), hit(2), hit(3)], keyword=[hit(1), hit(2), hit(3)])
    llm = FakeLLM(
        ['{"scores": [{"id": 1, "score": 1}, {"id": 2, "score": 3}, {"id": 3, "score": 1}]}']
    )

    hits = await retriever(store, llm=llm).search(
        "Can leave carry over?", retriever(store).scope(TODAY), mode="rerank"
    )

    assert [(h.chunk_id, h.score) for h in hits] == [(2, 3.0), (1, 1.0), (3, 1.0)]
    (call,) = llm.calls
    assert call.response_format == {"type": "json_object"}
    passages = call.messages[1].content or ""
    assert passages.startswith("Question: Can leave carry over?")
    assert "[2] Leave Policy v2 §1 Entitlements\nchunk 2" in passages


@pytest.mark.parametrize("reply", ["not json", '{"scores": "high"}', RuntimeError("down")])
async def test_a_failed_rerank_keeps_the_fused_order(reply: object) -> None:
    from llm.base import LLMError

    store = StubStore(vector=[hit(1), hit(2)], keyword=[hit(2)])
    script = LLMError("down") if isinstance(reply, RuntimeError) else reply
    llm = FakeLLM([script])  # pyright: ignore[reportArgumentType]

    hits = await retriever(store, llm=llm).search("q", retriever(store).scope(TODAY), mode="rerank")

    assert [h.chunk_id for h in hits] == [2, 1]


def test_hit_payload_carries_the_citation_and_flags_upcoming_versions() -> None:
    current = hit_payload(hit(1))
    upcoming = hit_payload(
        hit(
            2,
            title="Hybrid Work Policy",
            version=1,
            effective_from=date(2026, 11, 1),
            heading_path=("Hybrid Work Policy",),
            upcoming=True,
        )
    )

    assert current == {
        "citation": "Leave Policy v2 §1 Entitlements",
        "policy": "Leave Policy",
        "version": 2,
        "effective_from": "2026-01-01",
        "section": "1. Entitlements",
        "text": "chunk 1",
    }
    assert upcoming["citation"] == "Hybrid Work Policy v1"
    assert upcoming["section"] is None
    assert upcoming["status"] == "upcoming: not in force until 2026-11-01"
    assert hit(3, section="Late arrival").citation == "Leave Policy v2, Late arrival"


# ---- the tool ------------------------------------------------------------------------------


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        yield client


def context(http: httpx.AsyncClient, policies: PolicyRetriever | None) -> ToolContext:
    user = SessionUser.model_validate(session_user("EMPLOYEE", "Sneha Patel", None))
    return ToolContext(hr=HrApiClient(http, "t"), user=user, today=TODAY, policies=policies)


async def run_tool(ctx: ToolContext, arguments: str) -> dict[str, object]:
    result = await ASK_REGISTRY.execute(
        ToolCall(id="c", name="search_policy", arguments=arguments), ctx
    )
    assert result.ok, result.error
    return result.data


async def test_search_policy_defaults_to_today_including_upcoming(http: httpx.AsyncClient) -> None:
    store = StubStore(vector=[hit(1)], keyword=[hit(1)])

    data = await run_tool(context(http, retriever(store)), '{"query": "annual leave days"}')

    assert data["as_of"] == "2026-10-04"
    assert data["passages"] == [hit_payload(hit(1, score=1 / 61 + 1 / 61))]
    assert all(s.as_of == TODAY and s.include_upcoming for s in store.scopes)


async def test_search_policy_as_of_the_past_excludes_later_versions(
    http: httpx.AsyncClient,
) -> None:
    store = StubStore()

    data = await run_tool(
        context(http, retriever(store)), '{"query": "annual leave", "as_of": "2025-06-01"}'
    )

    assert data["passages"] == [] and "may not cover" in str(data["note"])
    assert all(s.as_of == date(2025, 6, 1) and not s.include_upcoming for s in store.scopes)


async def test_search_policy_without_embeddings_is_a_clear_error(http: httpx.AsyncClient) -> None:
    result = await ASK_REGISTRY.execute(
        ToolCall(id="c", name="search_policy", arguments='{"query": "leave"}'), context(http, None)
    )

    assert result.error == "Policy search isn't available right now."


async def test_the_agent_is_offered_search_policy_only_when_it_works(
    http: httpx.AsyncClient,
) -> None:
    store = StubStore(vector=[hit(1)], keyword=[hit(1)])
    with_rag = FakeLLM(
        [
            calls(tool_call("search_policy", '{"query": "unused leave carry over"}')),
            "No: unused leave does not carry over [Leave Policy v2 §1 Entitlements].",
        ]
    )
    without = FakeLLM(["I can't look up policies."])

    run = await answer_question(with_rag, context(http, retriever(store)), "Does leave carry over?")
    await answer_question(without, context(http, None), "Does leave carry over?")

    assert run.answer.endswith("[Leave Policy v2 §1 Entitlements].")
    assert "search_policy" in [t["function"]["name"] for t in with_rag.calls[0].tools or []]
    assert without.calls[0].tools == READ_REGISTRY.specs()
    assert "search_policy" in (with_rag.calls[0].messages[0].content or "")
