"""Plan checks and reference resolution (graphs/plan.py): code deciding what may run."""

import pytest

from agent.ask import READ_REGISTRY
from graphs.plan import (
    Plan,
    PlanStep,
    UnresolvedReference,
    check_plan,
    plan_hash,
    resolve_references,
)
from tests.hr_data import ARUN_ID, SNEHA_ID


def plan(*steps: PlanStep) -> Plan:
    return Plan(goal="test", steps=list(steps))


def step(id_: str, tool: str, risk: str = "read", **arguments: object) -> PlanStep:
    return PlanStep(id=id_, tool=tool, arguments=arguments, reason="r", risk=risk)  # pyright: ignore[reportArgumentType]


def test_a_valid_plan_with_a_reference_has_no_problems() -> None:
    ok = plan(
        step("s1", "search_employee", query="Sneha"),
        step("s2", "get_leave_balances", employee_id="$s1.employees.0.id", year=2026),
    )

    assert check_plan(ok, READ_REGISTRY) == []


@pytest.mark.parametrize(
    ("bad", "problem"),
    [
        (step("s1", "delete_employee"), "s1 (delete_employee): no such tool"),
        (step("s1", "search_employee", name="Sneha"), "unknown argument 'name'"),
        (step("s1", "search_employee"), "missing required argument 'query'"),
        (step("s1", "get_leave_balances", employee_id="Sneha"), "'employee_id': employee_id"),
        (
            step("s1", "get_leave_balances", employee_id="$s2.employees.0.id"),
            "isn't an earlier step",
        ),
        (
            step("s1", "search_employee", risk="write", query="x"),
            "marked write, but the tool is read",
        ),
    ],
)
def test_check_plan_reports_each_problem_for_the_planner(bad: PlanStep, problem: str) -> None:
    problems = check_plan(plan(bad), READ_REGISTRY)

    assert any(problem in p for p in problems), problems


def test_empty_and_oversized_plans_are_rejected() -> None:
    assert check_plan(plan(), READ_REGISTRY) == ["The plan has no steps."]
    long = plan(*(step(f"s{i}", "search_employee", query="x") for i in range(1, 10)))
    assert "at most 8" in check_plan(long, READ_REGISTRY)[0]


def search_result(*people: dict[str, str]) -> dict[str, object]:
    return {"ok": True, "data": {"total": len(people), "employees": list(people)}}


SNEHA = {"id": SNEHA_ID, "name": "Sneha Patel", "employee_code": "EMP006"}
ARUN = {"id": ARUN_ID, "name": "Arun Kumar", "employee_code": "EMP005"}


def test_references_resolve_through_a_single_match() -> None:
    resolved = resolve_references(
        {"employee_id": "$s1.employees.0.id", "year": 2026}, {"s1": search_result(SNEHA)}
    )

    assert resolved == {"employee_id": SNEHA_ID, "year": 2026}


def test_several_matches_are_a_question_not_a_guess() -> None:
    results = {"s1": search_result(SNEHA, ARUN)}

    with pytest.raises(UnresolvedReference) as raised:
        resolve_references({"employee_id": "$s1.employees.0.id"}, results)

    assert raised.value.candidates == [SNEHA, ARUN]
    assert raised.value.reference == "$s1.employees.0.id"
    # Once the user picks, the same reference resolves to their choice.
    chosen = resolve_references(
        {"employee_id": "$s1.employees.0.id"}, results, {"$s1.employees.0.id": 1}
    )
    assert chosen == {"employee_id": ARUN_ID}


@pytest.mark.parametrize(
    ("results", "message"),
    [
        ({"s1": search_result()}, "found nothing"),
        ({"s1": {"ok": False, "error": "403"}}, "has no result"),
        ({"s1": {"ok": True, "data": {"employees": [SNEHA]}}}, "has no 'ids'"),
    ],
)
def test_unresolvable_references_say_why(results: dict[str, object], message: str) -> None:
    reference = "$s1.ids.0" if message == "has no 'ids'" else "$s1.employees.0.id"

    with pytest.raises(UnresolvedReference, match=message):
        resolve_references({"employee_id": reference}, results)  # pyright: ignore[reportArgumentType]


def test_plan_hash_changes_with_any_edit() -> None:
    original = plan(step("s1", "search_employee", query="Sneha")).model_dump(mode="json")
    edited = plan(step("s1", "search_employee", query="Arun")).model_dump(mode="json")

    assert plan_hash(original) == plan_hash(dict(original))
    assert plan_hash(original) != plan_hash(edited)
