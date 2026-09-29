"""Builds the intent-parsing prompt (prompts/intent.md) for one request."""

import calendar
from datetime import date, timedelta
from typing import Any, Literal

from intent.schema import INTENT_DESCRIPTIONS, ModelParse
from llm.types import Message, PromptRef
from prompts import load_prompt

# Mirrors ROLES in packages/contracts/src/permissions.ts.
Role = Literal["ADMIN", "HR_OPS", "MANAGER", "EMPLOYEE"]
ROLE_LABELS: dict[Role, str] = {
    "ADMIN": "Admin",
    "HR_OPS": "HR Operations",
    "MANAGER": "Manager (sees their own team)",
    "EMPLOYEE": "Employee (sees only their own records)",
}

CALENDAR_DAYS = 14

# Strict structured output: the provider constrains decoding to this schema.
RESPONSE_FORMAT: dict[str, Any] = {
    "type": "json_schema",
    "json_schema": {"name": "model_parse", "strict": True, "schema": ModelParse.output_schema()},
}


def build_intent_messages(
    request: str, *, today: date, role: Role
) -> tuple[list[Message], PromptRef]:
    """System prompt with today's date, a calendar and the requester's role; the request as
    the user message, unchanged, so it stays data rather than part of our instructions."""
    prompt = load_prompt("intent")
    system = prompt.render(
        today=today.isoformat(),
        weekday=today.strftime("%A"),
        role=ROLE_LABELS[role],
        calendar=calendar_block(today),
        intents=intents_block(),
    )
    return [Message.system(system), Message.user(request)], prompt.ref


def calendar_block(today: date) -> str:
    """The next two weeks with weekdays, plus last, this and next month's ranges.

    Models are unreliable at working out which weekday a date falls on; a lookup table
    turns "next Friday" into reading instead of arithmetic.
    """
    days = [today + timedelta(days=offset) for offset in range(1, CALENDAR_DAYS + 1)]
    lines = [f"- {day:%a} {day.isoformat()}" for day in days]
    this_start, this_end = month_range(today)
    last_start, last_end = month_range(this_start - timedelta(days=1))
    next_start, next_end = month_range(this_end + timedelta(days=1))
    lines.append(f"- Last month: {last_start.isoformat()} to {last_end.isoformat()}")
    lines.append(f"- This month: {this_start.isoformat()} to {this_end.isoformat()}")
    lines.append(f"- Next month: {next_start.isoformat()} to {next_end.isoformat()}")
    return "\n".join(lines)


def month_range(day: date) -> tuple[date, date]:
    last = calendar.monthrange(day.year, day.month)[1]
    return day.replace(day=1), day.replace(day=last)


def intents_block() -> str:
    return "\n".join(f"- {intent.value}: {text}" for intent, text in INTENT_DESCRIPTIONS.items())
