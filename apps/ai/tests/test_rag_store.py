"""Ingestion and search against real Postgres + pgvector (the SQL is the logic here).

Skipped unless AI_TEST_DATABASE_URL is set. It migrates that database's `ai` schema and
empties its tables, so it refuses any database whose name doesn't contain "test":

    cd apps/ai && AI_TEST_DATABASE_URL=postgresql://hr:hr@localhost:5433/hr_test \\
        uv run pytest tests/test_rag_store.py

The HR API is mocked (respx) and embeddings are `FakeEmbedder`'s, so no keys are needed.
"""

import argparse
import os
from collections.abc import AsyncIterator, Iterator
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from alembic import command
from alembic.config import Config
from sqlalchemy import text

from app.hr_client import HrApiClient
from app.settings import Settings
from rag.db import create_engine
from rag.fake import FakeEmbedder
from rag.ingest import ingest_policies
from rag.retrieval import PolicyRetriever, RetrievalConfig
from rag.store import PolicyStore
from tests.hr_data import BASE_URL, USER_ID

DATABASE_URL = os.environ.get("AI_TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(
    not DATABASE_URL, reason="set AI_TEST_DATABASE_URL to run against Postgres"
)

TODAY = date(2026, 10, 4)

LEAVE_V1 = """# Leave Policy (v1)

## Entitlements
- Annual leave: 15 working days per calendar year.
"""
LEAVE_V2 = """# Leave Policy (v2)

## 1. Entitlements
| Type | Days per calendar year |
| --- | --- |
| Annual leave | 18 |

Unused leave does not carry over to the next year.

## 4. Approval
Leave is approved by the employee's direct manager.
"""
ATTENDANCE = """# Attendance Policy

## 2. Late arrival
Checking in after 10:30 (India Standard Time) is recorded as a late check-in.
"""
HYBRID = """# Hybrid Work Policy

Employees work from the office at least three days a week.
"""


def _id(n: int) -> str:
    return f"6c1f0a2e-0006-4000-8000-{n:012d}"


def version(n: int, number: int, effective: str, state: str) -> dict[str, Any]:
    return {
        "id": _id(n),
        "version": number,
        "effectiveFrom": effective,
        "fileName": f"policy_{n}.md",
        "mimeType": "text/markdown; charset=utf-8",
        "sizeBytes": 100,
        "summary": None,
        "publishedBy": {"id": USER_ID, "name": "Lakshmi Pillai"},
        "publishedAt": "2025-12-18T00:00:00.000Z",
        "state": state,
    }


def policy(title: str, category: str, *versions: dict[str, Any]) -> dict[str, Any]:
    current = next((v for v in versions if v["state"] == "CURRENT"), None)
    return {"title": title, "category": category, "current": current, "versions": list(versions)}


POLICIES = [
    policy(
        "Leave Policy",
        "LEAVE",
        version(2, 2, "2026-01-01", "CURRENT"),
        version(1, 1, "2025-01-01", "SUPERSEDED"),
    ),
    policy("Attendance Policy", "ATTENDANCE", version(3, 1, "2026-01-01", "CURRENT")),
    policy("Hybrid Work Policy", "OTHER", version(4, 1, "2026-11-01", "UPCOMING")),
]
FILES = {_id(1): LEAVE_V1, _id(2): LEAVE_V2, _id(3): ATTENDANCE, _id(4): HYBRID}


@pytest.fixture(scope="module")
def migrated() -> Iterator[str]:
    url = Settings(database_url=DATABASE_URL).ai_db_url
    if "test" not in url.rsplit("/", 1)[-1]:
        pytest.fail(f"Refusing to empty the `ai` tables of a non-test database: {url}")
    config = Config(Path(__file__).parents[1] / "alembic.ini")
    config.cmd_opts = argparse.Namespace(x=[f"url={url}"])
    command.upgrade(config, "head")
    yield url


@pytest.fixture
async def store(migrated: str) -> AsyncIterator[PolicyStore]:
    store = PolicyStore(create_engine(migrated))
    async with store.engine.begin() as conn:
        await conn.execute(text("TRUNCATE ai.policy_version CASCADE"))
    yield store
    await store.aclose()


def list_policies(request: httpx.Request) -> httpx.Response:
    # Read at call time, so a test can edit POLICIES and FILES between ingestions.
    return httpx.Response(200, json=POLICIES)


def policy_file(request: httpx.Request, version_id: str) -> httpx.Response:
    return httpx.Response(200, text=FILES[version_id], headers={"content-type": "text/markdown"})


@pytest.fixture
async def hr() -> AsyncIterator[HrApiClient]:
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as mock:
        mock.get("/policies").mock(side_effect=list_policies)
        mock.get(path__regex=r"/policies/(?P<version_id>[0-9a-f-]+)/file").mock(
            side_effect=policy_file
        )
        async with httpx.AsyncClient(base_url=BASE_URL) as http:
            yield HrApiClient(http, "service-token")


async def chunk_count(store: PolicyStore, where: str = "true") -> int:
    async with store.engine.connect() as conn:
        return int(await conn.scalar(text(f"SELECT count(*) FROM ai.policy_chunk WHERE {where}")))


async def test_ingest_is_idempotent_and_reembeds_only_what_changed(
    store: PolicyStore, hr: HrApiClient
) -> None:
    embedder = FakeEmbedder()

    first = await ingest_policies(hr, store, embedder, chunk_size=256)
    second = await ingest_policies(hr, store, embedder, chunk_size=256)

    assert (first.versions, first.embedded, first.unchanged) == (4, 4, 0)
    assert (second.embedded, second.unchanged) == (0, 4)
    assert len(embedder.calls) == 4  # nothing re-embedded the second time
    total = await chunk_count(store)
    assert total == first.chunks

    # A second chunk size sits alongside the first.
    other = await ingest_policies(hr, store, embedder, chunk_size=32)
    assert other.embedded == 4
    assert await chunk_count(store, "chunk_size = 256") == total

    # An edited file replaces that version's chunks for every size.
    FILES[_id(3)] = ATTENDANCE.replace("10:30", "10:45")
    try:
        edited = await ingest_policies(hr, store, embedder, chunk_size=256)
    finally:
        FILES[_id(3)] = ATTENDANCE
    assert (edited.embedded, edited.unchanged) == (1, 3)
    assert await chunk_count(store, f"policy_version_id = '{_id(3)}' AND chunk_size = 32") == 0


async def test_versions_the_api_dropped_are_removed(store: PolicyStore, hr: HrApiClient) -> None:
    await ingest_policies(hr, store, FakeEmbedder())
    removed_policy = POLICIES.pop()
    try:
        report = await ingest_policies(hr, store, FakeEmbedder())
    finally:
        POLICIES.append(removed_policy)

    assert report.removed == 1
    assert await chunk_count(store, f"policy_version_id = '{_id(4)}'") == 0


@pytest.fixture
async def retriever(store: PolicyStore, hr: HrApiClient) -> PolicyRetriever:
    embedder = FakeEmbedder()
    await ingest_policies(hr, store, embedder, chunk_size=256)
    return PolicyRetriever(store, embedder, RetrievalConfig("heading", 256))


async def test_current_questions_see_the_version_in_force_and_upcoming_ones(
    retriever: PolicyRetriever,
) -> None:
    hits = await retriever.search("annual leave days", retriever.scope(TODAY), k=10, mode="vector")

    leave = {(h.title, h.version) for h in hits if h.title == "Leave Policy"}
    assert leave == {("Leave Policy", 2)}  # v1 is superseded
    hybrid = [h for h in hits if h.title == "Hybrid Work Policy"]
    assert hybrid and all(h.upcoming for h in hybrid)
    assert all(not h.upcoming for h in hits if h.title != "Hybrid Work Policy")


async def test_as_of_a_past_date_finds_the_rules_in_force_then(retriever: PolicyRetriever) -> None:
    scope = retriever.scope(date(2025, 6, 1), include_upcoming=False)

    hits = await retriever.search("annual leave days", scope, k=10)

    assert {(h.title, h.version) for h in hits} == {("Leave Policy", 1)}
    assert hits[0].citation == "Leave Policy v1, Entitlements"


async def test_keyword_search_matches_any_word_and_ranks_more_matches_higher(
    retriever: PolicyRetriever,
) -> None:
    scope = retriever.scope(TODAY)

    hits = await retriever.search("Can unused leave carry over?", scope, mode="keyword")

    assert hits[0].citation == "Leave Policy v2 §1 Entitlements"
    assert "carry over" in hits[0].content
    # Words in headings count too, and stop words alone match nothing (no error).
    late = await retriever.search("late arrival", scope, mode="keyword")
    assert late[0].citation == "Attendance Policy v1 §2 Late arrival"
    assert await retriever.search("what is the", scope, mode="keyword") == []


async def test_vector_search_returns_k_by_similarity_and_filters_by_category(
    retriever: PolicyRetriever,
) -> None:
    hits = await retriever.search("checking in late", retriever.scope(TODAY), k=2, mode="vector")
    only_leave = await retriever.search(
        "checking in late", retriever.scope(TODAY, category="LEAVE"), k=5, mode="vector"
    )

    assert len(hits) == 2 and hits[0].score >= hits[1].score
    assert hits[0].title == "Attendance Policy"
    assert only_leave and {h.category for h in only_leave} == {"LEAVE"}


async def test_hybrid_fuses_both_searches(retriever: PolicyRetriever) -> None:
    hits = await retriever.search("late check-in after 10:30", retriever.scope(TODAY), k=3)

    assert hits[0].citation == "Attendance Policy v1 §2 Late arrival"
