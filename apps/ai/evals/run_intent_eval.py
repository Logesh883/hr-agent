"""CLI entry point: `uv run python -m evals.run_intent_eval`."""

import argparse
import asyncio
import sys
from datetime import date
from pathlib import Path

from app.settings import get_settings
from evals.intent_eval import EvalReport, load_cases, run_intent_eval
from llm.base import LLMError
from llm.factory import LLMConfigError, create_llm_client

PROVIDERS = ("groq", "openrouter", "gemini", "custom")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Measure intent accuracy and entity precision/recall on labelled requests."
    )
    parser.add_argument("--dataset", type=Path, default=Path(__file__).with_name("intents.jsonl"))
    parser.add_argument(
        "--today",
        type=date.fromisoformat,
        default=date(2026, 10, 3),
        help="date used to interpret relative phrases (default: 2026-10-03)",
    )
    parser.add_argument("--provider", choices=PROVIDERS, help="override LLM_PROVIDER")
    parser.add_argument("--model", help="override LLM_MODEL")
    args = parser.parse_args(argv)

    try:
        cases = load_cases(args.dataset)
        settings = get_settings()
        overrides = {
            key: value
            for key, value in (
                ("llm_provider", args.provider),
                ("llm_model", args.model),
            )
            if value is not None
        }
        llm = create_llm_client(settings.model_copy(update=overrides))
    except (OSError, ValueError, LLMConfigError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    try:
        report = asyncio.run(run_intent_eval(llm, cases, today=args.today))
        _print_report(report, provider=llm.provider, model=llm.model, today=args.today)
    except LLMError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    finally:
        asyncio.run(llm.aclose())
    return 0


def _print_report(report: EvalReport, *, provider: str, model: str, today: date) -> None:
    print(f"Provider: {provider} · model: {model} · today: {today.isoformat()}")
    print(f"Cases: {report['cases']}")
    print(f"Intent accuracy: {_percent(report['intent_accuracy'])}")
    print(
        "Entity precision/recall: "
        f"{_percent(report['entity_precision'])} / {_percent(report['entity_recall'])} "
        f"(TP {report['entity_true_positive']}, FP {report['entity_false_positive']}, "
        f"FN {report['entity_false_negative']})"
    )
    mismatches = [
        row
        for row in report["rows"]
        if not row["intent_correct"] or row["expected_entities"] != row["predicted_entities"]
    ]
    if mismatches:
        print("Mismatches:")
        for row in mismatches:
            print(
                f"- {row['id']}: intent {row['predicted_intent']} "
                f"(expected {row['expected_intent']}); entities predicted="
                f"{row['predicted_entities']} expected={row['expected_entities']}"
            )


def _percent(value: float) -> str:
    return f"{value * 100:.1f}%"


if __name__ == "__main__":
    raise SystemExit(main())
