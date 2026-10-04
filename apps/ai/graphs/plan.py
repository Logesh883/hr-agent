"""Plans: what the planner proposes, and the code that checks and runs it (A5.2).

A plan is a list of tool calls written *before* any of them runs. Later steps use earlier
results through references: `"$s1.employees.0.id"` means "the `id` of the first employee
in step s1's result". The planner can't see results while planning, so this is how it
says "the id I'll get from the search".

Code, not the model, decides whether a plan may run (`check_plan`):
- every tool exists, and its risk is what the *tool* declares (the model's own `risk`
  label is checked against it, never trusted); M5 runs read tools only;
- arguments use the tool's own field names, required fields are present, and every
  literal value passes the tool's validation;
- references point at an earlier step.

And at run time (`resolve_references`), a reference through a list only resolves when the
list has exactly one item: "the first of three Rahuls" is a guess, so it stops and asks.
The validated plan is fingerprinted (`plan_hash`); the executor refuses to run a plan that
changed after validation.
"""

import hashlib
import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from tools.base import Risk, ToolInput
from tools.registry import ToolRegistry, validation_summary

MAX_PLAN_STEPS = 8
_REFERENCE = re.compile(r"^\$(s\d+)((?:\.[A-Za-z0-9_]+)*)$")


class PlanStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^s\d+$", description="s1, s2, … in order")
    tool: str
    arguments: dict[str, Any] = {}
    reason: str = Field(description="Why this step is needed, in a few words")
    risk: Literal["read", "write"] = "read"


class Plan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    goal: str = Field(description="What the plan achieves, in one sentence")
    steps: list[PlanStep]


class UnresolvedReference(Exception):
    """A `$sN.path` reference that can't be resolved. When it's ambiguous (several matches
    where one was needed), `candidates` holds them and `reference` the reference text, so
    the user can be asked which; their choice comes back through `choices`."""

    def __init__(
        self, message: str, *, candidates: list[Any] | None = None, reference: str | None = None
    ) -> None:
        super().__init__(message)
        self.candidates = candidates or []
        self.reference = reference


def plan_hash(plan: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()


def check_plan(plan: Plan, registry: ToolRegistry, *, allow_writes: bool = False) -> list[str]:
    """Everything wrong with the plan, as messages the planner can act on. Empty: valid."""
    problems: list[str] = []
    if not plan.steps:
        problems.append("The plan has no steps.")
    if len(plan.steps) > MAX_PLAN_STEPS:
        problems.append(f"The plan has {len(plan.steps)} steps; at most {MAX_PLAN_STEPS}.")
    seen: set[str] = set()
    for step in plan.steps:
        where = f"{step.id} ({step.tool})"
        if step.id in seen:
            problems.append(f"{step.id}: duplicate step id.")
        tool = registry.get(step.tool)
        if tool is None:
            problems.append(f"{where}: no such tool. Available: {', '.join(registry.names)}.")
            seen.add(step.id)
            continue
        if tool.risk is Risk.WRITE and not allow_writes:
            problems.append(f"{where}: changes data, and this agent can only read for now.")
        if step.risk != tool.risk.value:
            problems.append(f"{where}: marked {step.risk}, but the tool is {tool.risk.value}.")
        problems.extend(f"{where}: {p}" for p in _check_arguments(step, tool.input_model, seen))
        seen.add(step.id)
    return problems


def _check_arguments(step: PlanStep, model: type[ToolInput], earlier: set[str]) -> list[str]:
    problems: list[str] = []
    fields = model.model_fields
    for name in step.arguments.keys() - fields.keys():
        problems.append(f"unknown argument '{name}'; it takes {', '.join(fields) or 'none'}.")
    for name, field in fields.items():
        if field.is_required() and name not in step.arguments:
            problems.append(f"missing required argument '{name}'.")
    blank = model.model_construct()
    for name, value in step.arguments.items():
        if name not in fields:
            continue
        reference = _reference(value)
        if reference is not None:
            if reference[0] not in earlier:
                problems.append(f"'{name}' refers to {reference[0]}, which isn't an earlier step.")
            continue
        try:
            # Validates one field with the tool's own rules, without the others.
            model.__pydantic_validator__.validate_assignment(blank, name, value)
        except ValidationError as error:
            problems.append(f"'{name}': {validation_summary(error)}")
    return problems


def _reference(value: Any) -> tuple[str, list[str]] | None:
    if not isinstance(value, str):
        return None
    match = _REFERENCE.match(value)
    if match is None:
        return None
    return match.group(1), [part for part in match.group(2).split(".") if part]


def references(step: dict[str, Any]) -> set[str]:
    """Step ids a step's arguments refer to."""
    found: set[str] = set()
    for value in step.get("arguments", {}).values():
        reference = _reference(value)
        if reference:
            found.add(reference[0])
    return found


def resolve_references(
    arguments: dict[str, Any], results: dict[str, Any], choices: dict[str, int] | None = None
) -> dict[str, Any]:
    """Arguments with every `$sN.path` replaced by the value from step sN's result data.
    `choices` maps a reference to the list position the user picked when it was ambiguous."""
    resolved: dict[str, Any] = {}
    for name, value in arguments.items():
        reference = _reference(value)
        resolved[name] = (
            value if reference is None else _lookup(value, *reference, results, choices or {})
        )
    return resolved


def _lookup(
    text: str, step_id: str, path: list[str], results: dict[str, Any], choices: dict[str, int]
) -> Any:
    result = results.get(step_id)
    if not result or not result.get("ok"):
        raise UnresolvedReference(f"{text}: step {step_id} has no result.")
    node: Any = result.get("data")
    for part in path:
        if isinstance(node, list):
            items: list[Any] = node  # pyright: ignore[reportUnknownVariableType]
            if not part.isdigit():
                raise UnresolvedReference(f"{text}: '{part}' isn't a list position.")
            if not items:
                raise UnresolvedReference(f"{text}: step {step_id} found nothing.")
            if len(items) == 1:
                node = items[0]
            elif 0 <= choices.get(text, -1) < len(items):
                node = items[choices[text]]
            else:
                # Picking item 0 of several would be a guess about *who*; ask instead.
                raise UnresolvedReference(
                    f"{text}: step {step_id} found {len(items)} matches.",
                    candidates=items,
                    reference=text,
                )
        elif isinstance(node, dict):
            mapping: dict[str, Any] = node  # pyright: ignore[reportUnknownVariableType]
            if part not in mapping:
                raise UnresolvedReference(f"{text}: step {step_id}'s result has no '{part}'.")
            node = mapping[part]
        else:
            raise UnresolvedReference(f"{text}: can't look up '{part}' in a {type(node).__name__}.")
    return node
