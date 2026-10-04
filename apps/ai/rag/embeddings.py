"""Text → vectors, from a hosted embeddings API (plain httpx, like the LLM client).

Retrieval embeds the question with the same model that embedded the chunks and compares
directions: cosine similarity. Every vector is L2-normalised here, so cosine similarity is
just a dot product and every provider's output looks the same to the database.
(`gemini-embedding-001` returns unnormalised vectors at any size below its full 3072.)

Queries and documents are embedded differently. Gemini's `gemini-embedding-001` takes a
task type (RETRIEVAL_QUERY vs RETRIEVAL_DOCUMENT, plus a document title); newer Gemini
models put the task in the text instead ("task: search result | query: …"). A question
and the passage that answers it are not paraphrases of each other, and asymmetric
embeddings are trained for exactly that gap.
"""

import asyncio
import logging
import math
import random
import re
from collections.abc import Sequence
from time import perf_counter
from typing import Any, Protocol

import httpx

from app.settings import Settings

logger = logging.getLogger("hr_ai.embeddings")

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
# Inputs per batch request.
GEMINI_BATCH = 100
OPENAI_BATCH = 64


class EmbeddingError(Exception):
    """The embeddings API failed after any retries."""


class EmbeddingConfigError(Exception):
    """The EMBEDDING_* settings don't describe a usable provider."""


class Embedder(Protocol):
    model: str
    dimensions: int

    async def embed_documents(
        self, texts: Sequence[str], *, titles: Sequence[str] | None = None
    ) -> list[list[float]]: ...

    async def embed_query(self, text: str) -> list[float]: ...

    async def aclose(self) -> None: ...


def normalize(vector: Sequence[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vector))
    return [x / norm for x in vector] if norm else list(vector)


class _HttpEmbedder:
    """Batching, retries with backoff, and one log line per API call."""

    provider = "custom"

    def __init__(
        self,
        *,
        model: str,
        dimensions: int,
        http: httpx.AsyncClient,
        max_retries: int = 4,
        backoff_base: float = 1.0,
    ) -> None:
        self.model = model
        self.dimensions = dimensions
        self._http = http
        self._max_retries = max_retries
        self._backoff_base = backoff_base

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _post(self, path: str, body: dict[str, Any], *, count: int) -> Any:
        start = perf_counter()
        for attempt in range(self._max_retries + 1):
            try:
                response = await self._http.post(path, json=body)
            except httpx.TransportError as error:
                if attempt == self._max_retries:
                    self._log(start, count, status="unreachable")
                    raise EmbeddingError(f"{self.model}: unreachable: {error!r}") from error
                await self._wait(attempt, None)
                continue
            if response.status_code in RETRY_STATUSES and attempt < self._max_retries:
                await self._wait(attempt, response)
                continue
            if response.is_error:
                self._log(start, count, status=str(response.status_code))
                raise EmbeddingError(
                    f"{self.model}: HTTP {response.status_code}: {response.text[:300]}"
                )
            self._log(start, count, status="ok")
            return response.json()
        raise AssertionError("unreachable")

    async def _wait(self, attempt: int, response: httpx.Response | None) -> None:
        delay = self._backoff_base * 2**attempt * random.uniform(1.0, 1.5)
        if response is not None:
            delay = _retry_after(response) or delay
        logger.info(
            "embedding.retry",
            extra={
                "fields": {
                    "model": self.model,
                    "attempt": attempt + 1,
                    "status": response.status_code if response is not None else None,
                    "delay_s": round(delay, 2),
                }
            },
        )
        await asyncio.sleep(delay)

    def _log(self, start: float, count: int, *, status: str) -> None:
        logger.info(
            "embedding.call",
            extra={
                "fields": {
                    "provider": self.provider,
                    "model": self.model,
                    "inputs": count,
                    "status": status,
                    "latency_ms": round((perf_counter() - start) * 1000, 1),
                }
            },
        )


def _retry_after(response: httpx.Response) -> float | None:
    """Seconds to wait from a Retry-After header, or Gemini's `RetryInfo.retryDelay` ("37s")."""
    header = response.headers.get("retry-after")
    if header:
        try:
            return min(float(header), 60.0)
        except ValueError:
            pass
    match = re.search(r'"retryDelay":\s*"(\d+(?:\.\d+)?)s"', response.text)
    return min(float(match.group(1)), 60.0) if match else None


class GeminiEmbedder(_HttpEmbedder):
    """Gemini's native `batchEmbedContents` API, which (unlike its OpenAI-compatible endpoint)
    takes task types and document titles."""

    provider = "gemini"

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "gemini-embedding-001",
        dimensions: int = 768,
        base_url: str = GEMINI_BASE_URL,
        timeout: float = 30.0,
        http: httpx.AsyncClient | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(
            model=model,
            dimensions=dimensions,
            http=http
            or httpx.AsyncClient(
                base_url=base_url, timeout=timeout, headers={"x-goog-api-key": api_key}
            ),
            **kwargs,
        )
        # gemini-embedding-001 has task types; later models take the task as a text prefix.
        self._task_types = self.model.removeprefix("models/") == "gemini-embedding-001"

    async def embed_documents(
        self, texts: Sequence[str], *, titles: Sequence[str] | None = None
    ) -> list[list[float]]:
        requests = [
            self._request(text, "RETRIEVAL_DOCUMENT", title=titles[i] if titles else None)
            for i, text in enumerate(texts)
        ]
        return await self._embed(requests)

    async def embed_query(self, text: str) -> list[float]:
        (vector,) = await self._embed([self._request(text, "RETRIEVAL_QUERY")])
        return vector

    def _request(self, text: str, task: str, *, title: str | None = None) -> dict[str, Any]:
        request: dict[str, Any] = {
            "model": f"models/{self.model.removeprefix('models/')}",
            "outputDimensionality": self.dimensions,
        }
        if self._task_types:
            request["taskType"] = task
            if title:
                request["title"] = title
        elif task == "RETRIEVAL_QUERY":
            text = f"task: search result | query: {text}"
        else:
            text = f"title: {title or 'none'} | text: {text}"
        request["content"] = {"parts": [{"text": text}]}
        return request

    async def _embed(self, requests: list[dict[str, Any]]) -> list[list[float]]:
        vectors: list[list[float]] = []
        name = self.model.removeprefix("models/")
        for i in range(0, len(requests), GEMINI_BATCH):
            batch = requests[i : i + GEMINI_BATCH]
            data = await self._post(
                f"/models/{name}:batchEmbedContents", {"requests": batch}, count=len(batch)
            )
            vectors.extend(normalize(item["values"]) for item in data["embeddings"])
        _check_dimensions(vectors, self.dimensions, self.model)
        return vectors


class OpenAIEmbedder(_HttpEmbedder):
    """Any OpenAI-compatible `/embeddings` endpoint. No task types: queries and documents are
    embedded the same way."""

    provider = "openai"

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        dimensions: int,
        timeout: float = 30.0,
        http: httpx.AsyncClient | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(
            model=model,
            dimensions=dimensions,
            http=http
            or httpx.AsyncClient(
                base_url=base_url,
                timeout=timeout,
                headers={"Authorization": f"Bearer {api_key}"},
            ),
            **kwargs,
        )

    async def embed_documents(
        self, texts: Sequence[str], *, titles: Sequence[str] | None = None
    ) -> list[list[float]]:
        return await self._embed(list(texts))

    async def embed_query(self, text: str) -> list[float]:
        (vector,) = await self._embed([text])
        return vector

    async def _embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for i in range(0, len(texts), OPENAI_BATCH):
            batch = texts[i : i + OPENAI_BATCH]
            data = await self._post(
                "embeddings",
                {"model": self.model, "input": batch, "dimensions": self.dimensions},
                count=len(batch),
            )
            items = sorted(data["data"], key=lambda item: item["index"])
            vectors.extend(normalize(item["embedding"]) for item in items)
        _check_dimensions(vectors, self.dimensions, self.model)
        return vectors


def _check_dimensions(vectors: list[list[float]], dimensions: int, model: str) -> None:
    if vectors and len(vectors[0]) != dimensions:
        raise EmbeddingError(
            f"{model} returned {len(vectors[0])}-dimensional vectors; "
            f"EMBEDDING_DIMENSIONS and the database expect {dimensions}."
        )


def create_embedder(settings: Settings) -> Embedder:
    if settings.embedding_provider == "gemini":
        key = settings.embedding_api_key or settings.gemini_api_key
        if not key:
            raise EmbeddingConfigError(
                "Set GEMINI_API_KEY (or EMBEDDING_API_KEY) in the root .env for policy search "
                "(free key: https://aistudio.google.com/apikey)."
            )
        return GeminiEmbedder(
            api_key=key.get_secret_value(),
            model=settings.embedding_model,
            dimensions=settings.embedding_dimensions,
            base_url=settings.embedding_base_url or GEMINI_BASE_URL,
        )
    if not (settings.embedding_base_url and settings.embedding_api_key):
        raise EmbeddingConfigError(
            "Set EMBEDDING_BASE_URL and EMBEDDING_API_KEY for EMBEDDING_PROVIDER=openai."
        )
    return OpenAIEmbedder(
        base_url=settings.embedding_base_url,
        api_key=settings.embedding_api_key.get_secret_value(),
        model=settings.embedding_model,
        dimensions=settings.embedding_dimensions,
    )
