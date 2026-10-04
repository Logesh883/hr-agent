"""CLI entry point: `uv run python -m evals.run_rag_eval`.

Ingests the policies once per chunk configuration (unchanged ones are skipped, so re-runs
only embed what's new), then runs every question through every retrieval mode and writes
the results table to docs/evaluation/rag-retrieval.md.

Needs the HR API (for ingestion; `--skip-ingest` to reuse what's indexed), embeddings
(GEMINI_API_KEY) and, for the `rerank` mode, the LLM.
"""

import argparse
import asyncio
import sys
from datetime import date
from pathlib import Path
from typing import cast

import httpx

from app.hr_client import HrApiClient, HrApiError, HrApiUnavailableError
from app.settings import WORKSPACE_ROOT, Settings, get_settings
from evals.rag_eval import (
    CachedQueryEmbedder,
    ModeResult,
    RagCase,
    evaluate,
    load_cases,
    results_table,
)
from llm.base import LLMClient, LLMError
from llm.factory import LLMConfigError, create_llm_client
from rag.chunking import Chunker
from rag.db import create_engine
from rag.embeddings import EmbeddingConfigError, EmbeddingError, create_embedder
from rag.ingest import ingest_policies
from rag.retrieval import MODES, Mode, PolicyRetriever, RetrievalConfig
from rag.store import PolicyStore

DEFAULT_OUTPUT = WORKSPACE_ROOT / "docs" / "evaluation" / "rag-retrieval.md"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Measure policy retrieval: recall@5 and MRR.")
    parser.add_argument(
        "--dataset", type=Path, default=Path(__file__).with_name("rag_questions.jsonl")
    )
    parser.add_argument(
        "--sizes",
        type=int,
        nargs="+",
        # The seeded policies' sections are all under ~125 tokens, and heading chunks never
        # span sections, so sizes above 128 produce identical chunks.
        default=[64, 128, 256],
        help="heading chunk sizes",
    )
    parser.add_argument(
        "--fixed-size", type=int, default=256, help="also test fixed-size chunks (0: skip)"
    )
    parser.add_argument("--modes", nargs="+", choices=MODES, default=list(MODES))
    parser.add_argument(
        "--today",
        type=date.fromisoformat,
        default=date(2026, 10, 4),
        help="date for 'current' questions (default 2026-10-04, when the eval was written)",
    )
    parser.add_argument("--skip-ingest", action="store_true", help="use what's already indexed")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)

    settings = get_settings()
    try:
        cases = load_cases(args.dataset)
        embedder = CachedQueryEmbedder(create_embedder(settings))
        llm = create_llm_client(settings) if "rerank" in args.modes else None
    except (OSError, ValueError, EmbeddingConfigError, LLMConfigError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    configs: list[tuple[Chunker, int]] = [("heading", size) for size in args.sizes]
    if args.fixed_size:
        configs.append(("fixed", args.fixed_size))

    try:
        results = asyncio.run(
            _run(
                settings,
                embedder,
                llm,
                cases,
                configs,
                cast(list[Mode], args.modes),
                today=args.today,
                ingest=not args.skip_ingest,
            )
        )
    except (EmbeddingError, LLMError, HrApiError, HrApiUnavailableError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    report = _report(results, cases, embedder.model, llm.model if llm else None, args.today)
    print(report)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(report, encoding="utf-8")
    print(f"\nwritten to {args.output}", file=sys.stderr)
    return 0


async def _run(
    settings: Settings,
    embedder: CachedQueryEmbedder,
    llm: LLMClient | None,
    cases: list[RagCase],
    configs: list[tuple[Chunker, int]],
    modes: list[Mode],
    *,
    today: date,
    ingest: bool,
) -> list[ModeResult]:
    store = PolicyStore(create_engine(settings.ai_db_url))
    results: list[ModeResult] = []
    try:
        async with httpx.AsyncClient(
            base_url=settings.hr_api_url, timeout=settings.hr_api_timeout
        ) as http:
            hr: HrApiClient | None = None
            if ingest:
                password = settings.ai_service_password
                if password is None:
                    raise HrApiError(401, "Set AI_SERVICE_PASSWORD for ingestion")
                login = await HrApiClient(http).login(
                    settings.ai_service_email, password.get_secret_value()
                )
                hr = HrApiClient(http, login.access_token)
            for chunker, size in configs:
                label = f"{chunker} {size}"
                if hr is not None:
                    report = await ingest_policies(
                        hr, store, embedder, chunker=chunker, chunk_size=size
                    )
                    print(
                        f"{label}: {report.embedded} embedded, {report.unchanged} unchanged",
                        file=sys.stderr,
                    )
                retriever = PolicyRetriever(
                    store, embedder, RetrievalConfig(chunker, size), llm=llm
                )
                for mode in modes:
                    result = await evaluate(retriever, cases, mode=mode, today=today, label=label)
                    print(
                        f"  {mode:8} recall@5 {result.recall:.2f}  MRR {result.mrr:.3f}",
                        file=sys.stderr,
                    )
                    results.append(result)
    finally:
        await store.aclose()
        await embedder.aclose()
        if llm:
            await llm.aclose()
    return results


def _report(
    results: list[ModeResult],
    cases: list[RagCase],
    embedding_model: str,
    llm_model: str | None,
    today: date,
) -> str:
    questions = {case.id: case.question for case in cases}
    misses = [
        f"- **{r.label}, {r.mode}**: "
        + ", ".join(
            f"`{case_id}` ({'rank ' + str(r.ranks[case_id]) if r.ranks[case_id] else 'not found'})"
            for case_id in r.misses
        )
        for r in results
        if r.misses
    ]
    rerank_model = f", rerank with `{llm_model}`" if llm_model else ""
    return "\n".join(
        [
            "# Policy retrieval eval (A4.5)",
            "",
            f"{len(cases)} questions from `apps/ai/evals/rag_questions.jsonl`, as of "
            f"{today.isoformat()}. Embeddings: `{embedding_model}`{rerank_model}. "
            "Generated by `uv run python -m evals.run_rag_eval`; don't edit by hand.",
            "",
            "A hit is a chunk from the expected policy version that contains the "
            "expected evidence phrase. Recall@5: share of questions with a hit in the top "
            "5. MRR: mean of 1/rank of the first hit in the top 10.",
            "",
            results_table(results),
            "",
            "## Misses (no hit in the top 5)",
            "",
            *(misses or ["None."]),
            "",
            "## Questions",
            "",
            *(f"- `{case_id}`: {question}" for case_id, question in questions.items()),
            "",
        ]
    )


if __name__ == "__main__":
    sys.exit(main())
