"""Run labelled intent/entity examples against any configured LLM provider."""

from collections.abc import Iterable
from datetime import date
from pathlib import Path
from typing import Any, TypedDict, cast

from pydantic import BaseModel, ConfigDict

from intent.parser import parse_request
from intent.prompt import Role
from intent.schema import Entities, Intent
from llm.base import LLMClient


class EvalCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    request: str
    role: Role
    intent: Intent
    entities: dict[str, Any]


class EvalRow(TypedDict):
    id: str
    expected_intent: str
    predicted_intent: str
    intent_correct: bool
    expected_entities: list[tuple[str, str]]
    predicted_entities: list[tuple[str, str]]


class EvalReport(TypedDict):
    cases: int
    intent_accuracy: float
    entity_precision: float
    entity_recall: float
    entity_true_positive: int
    entity_false_positive: int
    entity_false_negative: int
    rows: list[EvalRow]


def load_cases(path: Path) -> list[EvalCase]:
    cases = [
        EvalCase.model_validate_json(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if not cases:
        raise ValueError(f"Evaluation dataset is empty: {path}")
    ids = [case.id for case in cases]
    if len(ids) != len(set(ids)):
        raise ValueError(f"Evaluation case ids must be unique: {path}")
    for case in cases:
        # Catch misspelled entity field names before spending model calls.
        Entities.model_validate(case.entities)
    return cases


async def run_intent_eval(
    llm: LLMClient, cases: Iterable[EvalCase], *, today: date
) -> EvalReport:
    """Run cases sequentially and report intent accuracy and micro entity P/R."""
    rows: list[EvalRow] = []
    true_positive = false_positive = false_negative = 0
    correct_intents = 0
    total = 0

    for case in cases:
        predicted = await parse_request(llm, case.request, today=today, role=case.role)
        expected_entities = _entity_items(Entities.model_validate(case.entities))
        actual_entities = _entity_items(predicted.entities)
        tp = len(expected_entities & actual_entities)
        fp = len(actual_entities - expected_entities)
        fn = len(expected_entities - actual_entities)
        true_positive += tp
        false_positive += fp
        false_negative += fn
        correct = predicted.intent is case.intent
        correct_intents += int(correct)
        total += 1
        rows.append(
            {
                "id": case.id,
                "expected_intent": case.intent.value,
                "predicted_intent": predicted.intent.value,
                "intent_correct": correct,
                "expected_entities": sorted(expected_entities),
                "predicted_entities": sorted(actual_entities),
            }
        )

    return {
        "cases": total,
        "intent_accuracy": correct_intents / total,
        "entity_precision": _ratio(true_positive, true_positive + false_positive),
        "entity_recall": _ratio(true_positive, true_positive + false_negative),
        "entity_true_positive": true_positive,
        "entity_false_positive": false_positive,
        "entity_false_negative": false_negative,
        "rows": rows,
    }


def _entity_items(entities: Entities) -> set[tuple[str, str]]:
    values = cast(dict[str, object], entities.model_dump(mode="json", exclude_none=True))
    items: set[tuple[str, str]] = set()
    for field, value in values.items():
        if isinstance(value, list):
            items.update(
                (field, str(item).casefold()) for item in cast(list[object], value)
            )
        elif value not in (None, ""):
            items.add((field, str(value).casefold()))
    return items


def _ratio(numerator: int, denominator: int) -> float:
    return numerator / denominator if denominator else 0.0
