"""A10.1: the end-to-end eval case format (evals/cases.jsonl, one JSON object per line).

A case is one request, as one seeded user, with what a correct run looks like. Everything
under `expect` is checked by code (evals/agent_eval.py); only groundedness uses a judge.

Values that are ids in the HR system are written as aliases and resolved against hr_test
before the run: "@employee:Sneha Patel" → her employee id.
"""

from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Category = Literal[
    "normal",  # a plain request that should just work
    "policy",  # answered from policy documents, with citations
    "ambiguity",  # unclear or several matches: the agent should ask
    "missing_info",  # a required value is missing: the agent should ask, never guess
    "conflicting_docs",  # document status and review notes that disagree with the record
    "permission",  # the role can't do it: declined or refused, nothing written
    "tool_failure",  # the HR API fails (injected): retry, stop, report honestly
]
Login = Literal["hr@hr.local", "manager@hr.local", "employee@hr.local"]
Pause = Literal["clarification", "value", "which", "approval"]
Route = Literal["plan", "simple", "clarify", "decline"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ExpectedArgument(_Strict):
    tool: str
    argument: str
    # A literal ("ANNUAL", "2026-10-12") or an alias ("@employee:Sneha Patel").
    value: Any


class Expect(_Strict):
    intent: str
    # The route `understand` chose first (before any clarification).
    route: Route | None = None
    # A subset of the parsed entities: people (names, any order, case-insensitive), dates
    # as YYYY-MM-DD, leave_type, job_title, department, manager, location.
    entities: dict[str, Any] = Field(default_factory=dict)
    # Tools the run must use (planned and run, or called on the short path) …
    tools: list[str] = Field(default_factory=list)
    # … and tools it must not use.
    forbidden_tools: list[str] = Field(default_factory=list)
    arguments: list[ExpectedArgument] = Field(default_factory=list[ExpectedArgument])
    # The kinds of pause the run must make, in order (an empty list: no pause at all).
    pauses: list[Pause] | None = None
    # Whether an approval must be asked for (None: don't check).
    approval: bool | None = None
    # Write tools that must end `verified`. Every other write must not succeed.
    writes: list[str] = Field(default_factory=list)
    # Final run status.
    status: Literal["answered", "failed"] = "answered"
    # Policy citations that must be retrieved (prefix match, e.g. "Leave Policy v2 §1").
    citations: list[str] = Field(default_factory=list)
    # Facts the answer must state (case-insensitive substrings), and must not.
    answer_contains: list[str] = Field(default_factory=list)
    answer_excludes: list[str] = Field(default_factory=list)


class EvalCase(_Strict):
    id: str
    category: Category
    login: Login
    request: str
    # Replies to the run's pauses, in order. Once used up: approvals are rejected and any
    # other question gets "I don't know." Use {"decision": "approve"} to approve.
    answers: list[str | dict[str, Any]] = Field(default_factory=list[str | dict[str, Any]])
    # HR API failures to inject (app/faults.py spec), for tool_failure cases.
    faults: str | None = None
    # In the fast subset CI runs on every prompt or graph change.
    fast: bool = False
    expect: Expect
    note: str | None = None


def load_cases(path: Path) -> list[EvalCase]:
    cases = [
        EvalCase.model_validate_json(line) for line in path.read_text().splitlines() if line.strip()
    ]
    ids = [c.id for c in cases]
    duplicates = {i for i in ids if ids.count(i) > 1}
    if duplicates:
        raise ValueError(f"Duplicate case ids: {sorted(duplicates)}")
    return cases
