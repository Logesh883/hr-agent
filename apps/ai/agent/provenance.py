"""A6.5: never invent data. Every value a write step would send must come from somewhere.

A literal argument of a write step is *supported* when it is:
- in the user's own words (the request and their answers to questions),
- a value the parser read from those words (dates it worked out, a leave type),
- a value an earlier tool returned (only reachable through `$sN` references, which are
  always fine: code resolves them from real results),
- the signed-in user's own employee id ("me"),
- the tool's documented default (e.g. employment_type FULL_TIME), or
- free text the model writes as prose (a rejection reason, an email body), which the
  person approving reads in full.

Anything else (an email address nobody gave, a guessed last name, an id from nowhere) is
unsupported, and so is the planner's `"?"` marker ("I don't know this"). The graph then
asks the user for it instead of sending it.
"""

from datetime import date
from typing import Any, cast, get_args
from uuid import UUID

from pydantic import BaseModel

from graphs.plan import ASK_USER, is_reference

# Prose the model composes and the approver reads; not facts to trace.
FREE_TEXT_FIELDS = frozenset({"reason", "comment", "notes", "subject", "body"})

FIELD_LABELS = {
    "first_name": "first name",
    "last_name": "last name",
    "email": "work email address",
    "phone": "phone number",
    "job_title": "job title",
    "location": "office location",
    "joining_date": "joining date (YYYY-MM-DD)",
    "start_date": "start date (YYYY-MM-DD)",
    "end_date": "end date (YYYY-MM-DD)",
    "to": "recipient's email address",
}


def unsupported_arguments(
    arguments: dict[str, Any],
    model: type[BaseModel],
    *,
    user_text: str,
    parsed: dict[str, Any],
    own_employee_id: str | None,
) -> list[str]:
    """Names of the arguments whose values can't be traced to anything."""
    text = user_text.casefold()
    known = {_norm(value) for value in _leaves(parsed)}
    if own_employee_id:
        known.add(own_employee_id.casefold())
    unsupported: list[str] = []
    for name, value in arguments.items():
        if value is None or isinstance(value, bool) or is_reference(value):
            continue
        if value == ASK_USER:
            unsupported.append(name)
            continue
        if name in FREE_TEXT_FIELDS:
            continue
        field = model.model_fields.get(name)
        if field is not None and not field.is_required() and value == field.default:
            continue
        normalised = _norm(value)
        if normalised in known or (normalised and normalised in text):
            continue
        unsupported.append(name)
    return unsupported


def is_id_field(model: type[BaseModel], name: str) -> bool:
    """Ids come from lookups, never from a person: asking someone for a UUID is a planning
    mistake, sent back to the planner instead of to the user."""
    field = model.model_fields.get(name)
    if field is None:
        return False
    annotation = field.annotation
    return annotation is UUID or UUID in get_args(annotation)


def question_for(argument: str, arguments: dict[str, Any], tool: str) -> str:
    person = " ".join(
        str(arguments[part])
        for part in ("first_name", "last_name")
        if isinstance(arguments.get(part), str)
        and arguments[part] not in (ASK_USER, "")
        and not is_reference(arguments[part])
    )
    label = FIELD_LABELS.get(argument, argument.replace("_", " "))
    if person:
        return f"What is {person}'s {label}? I won't guess it."
    return f"What should the {label} be for {tool.replace('_', ' ')}? I won't guess it."


def _norm(value: Any) -> str:
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip().casefold()


def _leaves(value: Any) -> list[Any]:
    if isinstance(value, dict):
        return [leaf for v in cast(dict[str, Any], value).values() for leaf in _leaves(v)]
    if isinstance(value, list):
        return [leaf for v in cast(list[Any], value) for leaf in _leaves(v)]
    return [] if value is None else [value]
