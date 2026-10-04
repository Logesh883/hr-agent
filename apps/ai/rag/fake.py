"""`FakeEmbedder`: deterministic vectors for tests, no API.

A hashed bag of words: each word (lowercased, crudely stemmed) adds 1 to one of the
dimensions. Texts sharing words point in similar directions, so retrieval tests behave like
real (if lexical-only) search, and the same text always gets the same vector.
"""

import hashlib
import re
from collections.abc import Sequence

from rag.embeddings import normalize

_STOP = frozenset(
    "a an and are as at be by can do does for from how i in is it my of on or the to we what"
    " when who".split()
)


def _stem(word: str) -> str:
    for suffix in ("ing", "es", "s"):
        if word.endswith(suffix) and len(word) > len(suffix) + 2:
            return word[: -len(suffix)]
    return word


class FakeEmbedder:
    model = "fake-embedding"

    def __init__(self, dimensions: int = 768) -> None:
        self.dimensions = dimensions
        self.calls: list[list[str]] = []

    def vector(self, text: str) -> list[float]:
        values = [0.0] * self.dimensions
        for word in re.findall(r"[a-z0-9]+", text.lower()):
            if word in _STOP:
                continue
            digest = hashlib.sha256(_stem(word).encode()).digest()
            values[int.from_bytes(digest[:4], "big") % self.dimensions] += 1.0
        if not any(values):
            values[0] = 1.0
        return normalize(values)

    async def embed_documents(
        self, texts: Sequence[str], *, titles: Sequence[str] | None = None
    ) -> list[list[float]]:
        self.calls.append(list(texts))
        return [self.vector(text) for text in texts]

    async def embed_query(self, text: str) -> list[float]:
        self.calls.append([text])
        return self.vector(text)

    async def aclose(self) -> None:
        return None
