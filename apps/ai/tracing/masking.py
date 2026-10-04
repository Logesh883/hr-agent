"""Removes credentials and personal data from trace payloads before they leave the service.

Traces go to a third-party service (Langfuse Cloud), so what they hold must be safe to share:

- credentials (tokens, passwords, API keys) by key name and by shape (JWTs, "Bearer …",
  provider keys like gsk_…/sk-…/AIza…);
- contact details and identifiers by key and by shape: emails, phone numbers, PAN, Aadhaar,
  bank account numbers and IFSC codes, and dates of birth (by key, or a date labelled
  "DOB"/"born"; other dates are kept);
- people's names: the names in a run are collected from HR records (tool results) and the
  signed-in user, then replaced wherever they appear, including inside the user's question,
  the prompts and the model's answer.

Ids, dates, leave types and counts are kept: they're what makes a trace useful for debugging.
"""

import re
from collections.abc import Iterable
from typing import Any, cast

# Compared after normalising: lowercase, no "_" or "-" (dateOfBirth == date_of_birth).
SECRET_KEYS = frozenset(
    {
        "authorization",
        "token",
        "accesstoken",
        "refreshtoken",
        "password",
        "apikey",
        "secret",
        "secretkey",
        "cookie",
    }
)
PII_KEYS = frozenset(
    {
        "email",
        "phone",
        "dateofbirth",
        "dob",
        "pan",
        "pannumber",
        "aadhaar",
        "aadhaarnumber",
        "bankaccount",
        "accountnumber",
        "ifsc",
    }
)
# Keys whose value is a person's name. `name` alone is too generic (tools have names too),
# so it only counts inside a person record, recognised by its employee_code.
NAME_KEYS = frozenset({"first_name", "last_name", "full_name", "employee", "decided_by"})

_PATTERNS = [
    (re.compile(r"\beyJ[\w-]+\.[\w-]+\.[\w-]+"), "[token]"),
    (re.compile(r"(?i)\bbearer\s+[\w.~+/=-]+"), "Bearer [token]"),
    (re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"), "[email]"),
    (re.compile(r"\b(?:gsk|sk|pk|rk)[-_][A-Za-z0-9_-]{16,}"), "[key]"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{30,}"), "[key]"),
    (re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b"), "[pan]"),
    (re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b"), "[ifsc]"),
    # A date that's labelled as a birth date; other dates (joining, leave) are kept.
    (
        re.compile(
            r"(?i)\b(dob|date of birth|birth ?date|born(?: on)?)(\W{0,3})"
            r"(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2} \w+ \d{4})"
        ),
        r"\1\2[date of birth]",
    ),
    # Aadhaar: 12 digits, often in groups of four.
    (re.compile(r"(?<![\w-])\d{4}[ -]?\d{4}[ -]?\d{4}(?![\w-])"), "[aadhaar]"),
    # International (+91 98450 11006) or a bare 10-digit number; not dates like 2026-10-12.
    (re.compile(r"(?<![\w-])(?:\+\d{1,3}(?:[ -]?\d){7,12}|\d{5}[ -]?\d{5})(?![\w-])"), "[phone]"),
    # Bank account numbers: 9 to 18 digits on their own (after phones and Aadhaar).
    (re.compile(r"(?<![\w-])\d{9,18}(?![\w-])"), "[account number]"),
]
MIN_NAME_LENGTH = 3


def collect_names(value: Any) -> set[str]:
    """Person names found in HR-record-shaped payloads (see NAME_KEYS)."""
    names: set[str] = set()
    if isinstance(value, dict):
        record = cast(dict[str, Any], value)
        for key, item in record.items():
            if isinstance(item, str) and (
                key in NAME_KEYS or (key == "name" and "employee_code" in record)
            ):
                names.add(item)
            else:
                names |= collect_names(item)
    elif isinstance(value, list):
        for item in cast(list[Any], value):
            names |= collect_names(item)
    return names


class Masker:
    def __init__(self, names: Iterable[str] = ()) -> None:
        # Mask each part of a name too: "Sneha Patel" also hides a later "Sneha".
        words = {
            part for name in names for part in (name, *name.split()) if len(part) >= MIN_NAME_LENGTH
        }
        self._names = (
            re.compile(
                r"\b(?:"
                + "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True))
                + r")\b",
                re.IGNORECASE,
            )
            if words
            else None
        )

    def mask(self, value: Any) -> Any:
        if isinstance(value, str):
            return self._mask_text(value)
        if isinstance(value, dict):
            return {
                key: self._mask_field(key, item)
                for key, item in cast(dict[str, Any], value).items()
            }
        if isinstance(value, list | tuple):
            return [self.mask(item) for item in cast(list[Any], value)]
        return value

    def _mask_field(self, key: str, value: Any) -> Any:
        lowered = key.lower().replace("_", "").replace("-", "")
        if value is None:
            return None
        if lowered in SECRET_KEYS:
            return "[redacted]"
        if lowered in PII_KEYS:
            return "[personal data]"
        return self.mask(value)

    def _mask_text(self, text: str) -> str:
        for pattern, replacement in _PATTERNS:
            text = pattern.sub(replacement, text)
        if self._names:
            text = self._names.sub("[person]", text)
        return text
