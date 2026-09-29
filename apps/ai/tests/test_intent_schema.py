import re
from datetime import date
from pathlib import Path
from typing import Any, get_args

import pytest
from pydantic import ValidationError

from app.settings import WORKSPACE_ROOT
from intent.schema import (
    INTENT_DESCRIPTIONS,
    REQUIRED_FIELDS,
    DocumentType,
    Entities,
    Intent,
    LeaveType,
    ModelParse,
    ParsedRequest,
)

CONTRACTS = WORKSPACE_ROOT / "packages/contracts/src"

# The spec's example, as a model would return it on 2026-09-29.
ONBOARD_PRIYA: dict[str, Any] = {
    "intent": "onboard_employee",
    "entities": {
        "people": ["Priya"],
        "job_title": "Software Engineer",
        "department": None,
        "manager": "Rahul",
        "location": "Bangalore",
        "leave_type": None,
        "document_type": None,
        "joining_date": "2026-10-12",
        "start_date": None,
        "end_date": None,
    },
    "confidence": 0.95,
    "clarifying_question": None,
}


def ts_string_array(file: Path, name: str) -> list[str]:
    """Reads `export const NAME = ['A', 'B'] as const;` from a TypeScript contracts file."""
    match = re.search(rf"export const {name} = \[(.*?)\] as const", file.read_text(), re.DOTALL)
    assert match, f"{name} not found in {file}"
    return re.findall(r"'([A-Z_]+)'", match.group(1))


def test_leave_and_document_types_match_the_api_contracts() -> None:
    assert list(get_args(LeaveType)) == ts_string_array(CONTRACTS / "leave.ts", "LEAVE_TYPES")
    assert list(get_args(DocumentType)) == ts_string_array(
        CONTRACTS / "document.ts", "DOCUMENT_TYPES"
    )


def test_every_intent_has_a_description_and_required_fields() -> None:
    assert set(INTENT_DESCRIPTIONS) == set(Intent)
    assert set(REQUIRED_FIELDS) == set(Intent)
    assert len(Intent) == 12


def test_output_schema_is_strict_mode_compatible() -> None:
    schema = ModelParse.output_schema()
    objects = [schema, *schema["$defs"].values()]

    for obj in (o for o in objects if o.get("type") == "object"):
        assert obj["additionalProperties"] is False, obj["title"]
        assert set(obj["required"]) == set(obj["properties"]), obj["title"]
    assert schema["$defs"]["Intent"]["enum"] == [i.value for i in Intent]
    assert "missing_fields" not in schema["properties"]  # code's job, not the model's


def test_parses_model_json_and_finds_nothing_missing() -> None:
    parsed = ParsedRequest.from_model(ModelParse.model_validate(ONBOARD_PRIYA))

    assert parsed.intent is Intent.ONBOARD_EMPLOYEE
    assert parsed.entities.joining_date == date(2026, 10, 12)
    assert parsed.entities.manager == "Rahul"
    assert parsed.missing_fields == []
    assert not parsed.needs_clarification


def test_code_decides_what_is_missing() -> None:
    raw = ONBOARD_PRIYA | {
        "entities": ONBOARD_PRIYA["entities"] | {"joining_date": None, "location": None}
    }

    parsed = ParsedRequest.from_model(ModelParse.model_validate(raw))

    assert parsed.missing_fields == ["joining_date", "location"]
    assert parsed.needs_clarification


def test_empty_people_counts_as_missing_only_where_required() -> None:
    approve = ParsedRequest.from_model(ModelParse(intent=Intent.APPROVE_LEAVE, confidence=0.9))
    balance = ParsedRequest.from_model(ModelParse(intent=Intent.LEAVE_BALANCE, confidence=0.9))

    assert approve.missing_fields == ["people"]
    assert balance.missing_fields == []  # "my balance": the requester


@pytest.mark.parametrize(
    ("intent", "confidence", "expected"),
    [
        (Intent.POLICY_QUESTION, 0.9, False),
        (Intent.POLICY_QUESTION, 0.4, True),
        (Intent.UNKNOWN, 1, True),
    ],
)
def test_needs_clarification(intent: Intent, confidence: float, expected: bool) -> None:
    parsed = ParsedRequest.from_model(ModelParse(intent=intent, confidence=confidence))

    assert parsed.needs_clarification is expected


def test_single_day_and_ranges_are_valid() -> None:
    Entities(start_date=date(2026, 10, 2), end_date=date(2026, 10, 2))
    Entities(start_date=date(2026, 10, 2), end_date=date(2026, 10, 5))
    Entities(start_date=date(2026, 10, 2))


@pytest.mark.parametrize(
    ("entities", "message"),
    [
        ({"start_date": "2026-10-05", "end_date": "2026-10-02"}, "is before start_date"),
        ({"end_date": "2026-10-02"}, "start_date is empty"),
        ({"leave_type": "EARNED"}, "leave_type"),
        ({"start_date": "next Friday"}, "start_date"),
        ({"employee_id": "e1"}, "Extra inputs are not permitted"),
    ],
)
def test_rejects_bad_entities_with_a_readable_reason(
    entities: dict[str, Any], message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        Entities.model_validate(entities)


@pytest.mark.parametrize(
    "change",
    [{"intent": "book_flight"}, {"confidence": 1.5}, {"missing_fields": ["people"]}],
)
def test_rejects_bad_model_output(change: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        ModelParse.model_validate(ONBOARD_PRIYA | change)
