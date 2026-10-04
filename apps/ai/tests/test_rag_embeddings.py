import json
import math
from collections.abc import Sequence
from typing import Any, cast

import httpx
import pytest
import respx
from respx.models import Call

from app.settings import Settings
from rag.embeddings import (
    EmbeddingConfigError,
    EmbeddingError,
    GeminiEmbedder,
    OpenAIEmbedder,
    create_embedder,
    normalize,
)
from rag.fake import FakeEmbedder

GEMINI = "https://gemini.test/v1beta"
BATCH_URL = f"{GEMINI}/models/gemini-embedding-001:batchEmbedContents"


def gemini(**kwargs: Any) -> GeminiEmbedder:
    return GeminiEmbedder(api_key="g-key", dimensions=3, base_url=GEMINI, backoff_base=0, **kwargs)


def embeddings(*vectors: Sequence[float]) -> dict[str, Any]:
    return {"embeddings": [{"values": v} for v in vectors]}


def sent(route: respx.Route, call: int = -1) -> dict[str, Any]:
    # CallList subclasses a bare `list`, so indexing it is untyped.
    recorded = cast(Call, route.calls[call])
    return json.loads(recorded.request.content)


@respx.mock
async def test_gemini_embeds_documents_with_task_type_title_and_size() -> None:
    route = respx.post(BATCH_URL).respond(json=embeddings([3, 4, 0], [0, 0, 2]))
    embedder = gemini()

    vectors = await embedder.embed_documents(["a", "b"], titles=["Leave Policy v2"] * 2)

    # Normalised to length 1: 001 doesn't normalise below its full 3072 dimensions.
    assert vectors == [[0.6, 0.8, 0.0], [0.0, 0.0, 1.0]]
    assert route.calls.last.request.headers["x-goog-api-key"] == "g-key"
    first = sent(route)["requests"][0]
    assert first == {
        "model": "models/gemini-embedding-001",
        "outputDimensionality": 3,
        "taskType": "RETRIEVAL_DOCUMENT",
        "title": "Leave Policy v2",
        "content": {"parts": [{"text": "a"}]},
    }


@respx.mock
async def test_gemini_queries_use_the_query_task_type() -> None:
    route = respx.post(BATCH_URL).respond(json=embeddings([1, 0, 0]))

    assert await gemini().embed_query("Can leave carry over?") == [1.0, 0.0, 0.0]
    (request,) = sent(route)["requests"]
    assert request["taskType"] == "RETRIEVAL_QUERY"
    assert "title" not in request


@respx.mock
async def test_newer_gemini_models_take_the_task_as_a_text_prefix() -> None:
    route = respx.post(f"{GEMINI}/models/gemini-embedding-2:batchEmbedContents").respond(
        json=embeddings([1, 0, 0])
    )
    embedder = gemini(model="gemini-embedding-2")

    await embedder.embed_query("late cutoff")
    await embedder.embed_documents(["Checking in after 10:30"], titles=["Attendance v1"])

    query, document = (sent(route, i)["requests"][0] for i in (0, 1))
    assert "taskType" not in query
    assert query["content"]["parts"][0]["text"] == "task: search result | query: late cutoff"
    assert document["content"]["parts"][0]["text"] == (
        "title: Attendance v1 | text: Checking in after 10:30"
    )


@respx.mock
async def test_gemini_batches_by_one_hundred() -> None:
    def reply(request: httpx.Request) -> httpx.Response:
        count = len(json.loads(request.content)["requests"])
        return httpx.Response(200, json=embeddings(*([[1, 0, 0]] * count)))

    route = respx.post(BATCH_URL).mock(side_effect=reply)

    vectors = await gemini().embed_documents([f"chunk {i}" for i in range(250)])

    assert len(vectors) == 250
    assert [len(sent(route, i)["requests"]) for i in range(3)] == [100, 100, 50]


@respx.mock
async def test_rate_limits_are_retried_using_geminis_retry_delay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    waits: list[float] = []

    async def no_sleep(delay: float) -> None:
        waits.append(delay)

    monkeypatch.setattr("rag.embeddings.asyncio.sleep", no_sleep)
    quota = {"error": {"code": 429, "details": [{"retryDelay": "7s"}]}}
    respx.post(BATCH_URL).mock(
        side_effect=[
            httpx.Response(429, json=quota),
            httpx.Response(200, json=embeddings([1, 0, 0])),
        ]
    )

    assert await gemini().embed_query("q") == [1.0, 0.0, 0.0]
    assert waits == [7.0]


@respx.mock
async def test_errors_and_wrong_sizes_raise() -> None:
    respx.post(BATCH_URL).respond(400, json={"error": {"message": "API key not valid"}})
    with pytest.raises(EmbeddingError, match="API key not valid"):
        await gemini().embed_query("q")

    respx.post(BATCH_URL).respond(json=embeddings([1, 0]))
    with pytest.raises(EmbeddingError, match="2-dimensional"):
        await gemini().embed_query("q")


@respx.mock
async def test_openai_compatible_embeddings_keep_input_order() -> None:
    route = respx.post("https://emb.test/v1/embeddings").respond(
        json={"data": [{"index": 1, "embedding": [0, 2, 0]}, {"index": 0, "embedding": [2, 0, 0]}]}
    )
    embedder = OpenAIEmbedder(base_url="https://emb.test/v1", api_key="k", model="m", dimensions=3)

    assert await embedder.embed_documents(["a", "b"]) == [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
    assert sent(route) == {"model": "m", "input": ["a", "b"], "dimensions": 3}
    assert route.calls.last.request.headers["authorization"] == "Bearer k"


def test_create_embedder_needs_a_key() -> None:
    with pytest.raises(EmbeddingConfigError, match="GEMINI_API_KEY"):
        create_embedder(Settings())
    assert isinstance(
        create_embedder(Settings(gemini_api_key="g")),  # pyright: ignore[reportArgumentType]
        GeminiEmbedder,
    )
    with pytest.raises(EmbeddingConfigError, match="EMBEDDING_BASE_URL"):
        create_embedder(Settings(embedding_provider="openai"))


def test_normalize_and_the_fake_embedder() -> None:
    assert normalize([3, 4]) == [0.6, 0.8]
    assert normalize([0, 0]) == [0, 0]
    fake = FakeEmbedder(dimensions=64)
    a, b, c = (fake.vector(t) for t in ("annual leave days", "Annual leaves", "PAN card"))
    assert math.isclose(sum(x * x for x in a), 1.0)

    def cosine(x: list[float], y: list[float]) -> float:
        return sum(p * q for p, q in zip(x, y, strict=True))

    assert cosine(a, b) > cosine(a, c)
