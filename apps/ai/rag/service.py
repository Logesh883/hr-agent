"""Builds the policy retriever from settings, shared by the API, the CLI and the evals."""

import logging

from app.settings import Settings
from llm.base import LLMClient
from rag.db import create_engine
from rag.embeddings import EmbeddingConfigError, create_embedder
from rag.retrieval import PolicyRetriever, RetrievalConfig
from rag.store import PolicyStore

logger = logging.getLogger("hr_ai.rag")


def create_policy_retriever(
    settings: Settings, *, llm: LLMClient | None = None
) -> PolicyRetriever | None:
    """None (and a log line) when embeddings aren't configured: the agent then runs without
    `search_policy` instead of failing every request."""
    try:
        embedder = create_embedder(settings)
    except EmbeddingConfigError as error:
        logger.warning("rag.disabled", extra={"fields": {"reason": str(error)}})
        return None
    return PolicyRetriever(
        PolicyStore(create_engine(settings.ai_db_url)),
        embedder,
        RetrievalConfig(
            chunker="heading",
            chunk_size=settings.rag_chunk_tokens,
            mode="rerank" if settings.rag_rerank else "hybrid",
        ),
        llm=llm,
    )


async def close_policy_retriever(retriever: PolicyRetriever | None) -> None:
    if retriever is not None:
        await retriever.embedder.aclose()
        await retriever.store.aclose()
