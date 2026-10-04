"""Removes credentials and personal data from trace payloads before they leave the service.

Traces go to a third-party service (Langfuse Cloud), so what they hold must be safe to share:

- credentials (tokens, passwords, API keys) by key name and by shape (JWTs, "Bearer …");
- contact details and identifiers (emails, phone numbers, PAN numbers) by key and by shape;
- people's names: the names in a run are collected from HR records (tool results) and the
  signed-in user, then replaced wherever they appear, including inside the user's question,
  the prompts and the model's answer.

Ids, dates, leave types and counts are kept: they're what makes a trace useful for debugging.
"""

import re
from collections.abc import Iterable
from typing import Any, cast

SECRET_KEYS = frozenset(
    {"authorization", "token", "access_token", "password", "api_key", "secret", "secret_key"}
)
PII_KEYS = frozenset({"email", "phone", "date_of_birth", "dob", "pan", "bank_account"})
# Keys whose value is a person's name. `name` alone is too generic (tools have names too),
# so it only counts inside a person record, recognised by its employee_code.
NAME_KEYS = frozenset({"first_name", "last_name", "full_name", "employee", "decided_by"})

_PATTERNS = [
    (re.compile(r"\beyJ[\w-]+\.[\w-]+\.[\w-]+"), "[token]"),
    (re.compile(r"(?i)\bbearer\s+[\w.~+/=-]+"), "Bearer [token]"),
    (re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"), "[email]"),
    (re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b"), "[pan]"),
    # International (+91 98450 11006) or a bare 10-digit number; not dates like 2026-10-12.
    (re.compile(r"(?<![\w-])(?:\+\d{1,3}(?:[ -]?\d){7,12}|\d{5}[ -]?\d{5})(?![\w-])"), "[phone]"),
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
        lowered = key.lower()
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
