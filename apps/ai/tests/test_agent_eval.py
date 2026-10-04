"""A10: the eval's own code. Graders, aggregation, the regression gate and the dataset are
tested here without a model, so a bad score always means the agent, not the eval."""

from datetime import date
from pathlib import Path
from typing import Any

import pytest

from evals.agent_cases import EvalCase, load_cases
from evals.agent_eval import (
    CODE_METRICS,
    CaseScore,
    Observed,
    grade,
    observe,
    regressions,
    report,
    summarize,
)
from prompts import load_prompt, use_prompt_overrides

SNEHA = "5c0b1f8e-0000-4000-8000-000000000006"
ALIASES = {"@employee:Sneha Patel": SNEHA}


def case(**expect: Any) -> EvalCase:
    return EvalCase.model_validate(
        {
            "id": "normal-x",
            "category": "normal",
            "login": "hr@hr.local",
            "request": "How many leave days does Sneha have?",
            "expect": {"intent": "leave_balance"} | expect,
        }
    )


def run(**values: Any) -> Observed:
    events: list[dict[str, Any]] = [
        {"event": "node_finished", "node": "understand", "summary": {"route": "simple"}},
        *values.pop("_events", []),
    ]
    state: dict[str, Any] = {"status": "answered", "answer": "Sneha has 9 days.", "parsed": {}}
    return observe(
        state | values,
        events,
        prompt_tokens=100,
        completion_tokens=20,
        latency_s=1.5,
        llm_calls=2,
    )


def balances_step(employee_id: str = SNEHA, ok: bool = True) -> dict[str, Any]:
    return {
        "tool_calls": [
            {"tool": "get_leave_balances", "arguments": {"employee_id": employee_id}, "ok": ok}
        ]
    }


def test_a_correct_short_path_run_passes_every_metric() -> None:
    expected = case(
        route="simple",
        entities={"people": ["Sneha"]},
        tools=["get_leave_balances"],
        forbidden_tools=["approve_leave"],
        arguments=[
            {
                "tool": "get_leave_balances",
                "argument": "employee_id",
                "value": "@employee:Sneha Patel",
            }
        ],
        pauses=[],
        approval=False,
        answer_contains=["9 days"],
        answer_excludes=["approved"],
    )
    observed = run(
        parsed={"intent": "leave_balance", "entities": {"people": ["Sneha Patel"]}},
        steps=[balances_step()],
    )

    score = grade(expected, observed, ALIASES)

    assert score.passed, score.notes
    assert all(score.scores[m] == 1.0 for m in CODE_METRICS if score.scores[m] is not None)
    assert score.scores["retrieval"] is None  # not asked for: not counted


def test_each_kind_of_mistake_is_caught_and_explained() -> None:
    expected = case(
        route="plan",
        tools=["search_employee", "get_leave_balances"],
        arguments=[
            {
                "tool": "get_leave_balances",
                "argument": "employee_id",
                "value": "@employee:Sneha Patel",
            }
        ],
        pauses=["clarification"],
        citations=["Leave Policy v2 §1"],
    )
    observed = run(
        parsed={"intent": "find_employees"},
        steps=[balances_step("someone-else")],
        results={"s1": {"tool": "create_leave_request", "ok": True, "status": "verified"}},
    )

    score = grade(expected, observed, ALIASES)

    assert not score.passed
    assert score.scores["intent"] == 0 and score.scores["route"] == 0
    assert score.scores["tools"] == 0.5
    assert score.scores["arguments"] == 0
    assert score.scores["pauses"] == 0
    assert score.scores["writes"] == 0  # a write nobody expected
    assert score.scores["retrieval"] == 0
    assert "unexpected writes: ['create_leave_request']" in score.notes


def test_writes_must_be_verified_and_pauses_are_read_from_events() -> None:
    expected = case(writes=["create_leave_request"], pauses=["approval"], approval=True)
    observed = run(
        results={"s2": {"tool": "create_leave_request", "ok": True, "status": "done"}},
        _events=[{"event": "waiting", "type": "approval"}],
    )

    score = grade(expected, observed, ALIASES)

    assert score.scores["pauses"] == 1 and score.scores["approval"] == 1
    assert score.scores["writes"] == 0  # "done" isn't "verified"


def test_policy_citations_count_from_retrieval_and_from_tool_calls() -> None:
    expected = case(citations=["Leave Policy v2 §1", "Leave Policy v2 §3"])
    observed = run(
        policy=[{"citation": "Leave Policy v2 §1 Entitlements"}],
        steps=[
            {
                "tool_calls": [
                    {
                        "tool": "search_policy",
                        "arguments": {"query": "carry over"},
                        "ok": True,
                        "data": {"passages": [{"citation": "Leave Policy v2 §3 Carry-over"}]},
                    }
                ]
            }
        ],
    )

    assert grade(expected, observed, ALIASES).scores["retrieval"] == 1.0


def scored(passed: bool, intent: float = 1.0, latency: float = 1.0) -> CaseScore:
    observed = run()
    observed.latency_s = latency
    scores = dict.fromkeys(CODE_METRICS, None) | {
        "intent": intent,
        "status": 1.0 if passed else 0.0,
    }
    return CaseScore(case(), {**scores, "groundedness": None}, observed)


def test_repeats_give_a_mean_and_a_spread() -> None:
    summary = summarize(
        "m__current",
        "m",
        "plan@5",
        [[scored(True), scored(True)], [scored(True), scored(False, intent=0.0)]],
        price=(1.0, 2.0),
    )

    assert summary.pass_rate[0] == pytest.approx(0.75)
    assert summary.pass_rate[1] > 0
    assert summary.metrics["intent"][0] == pytest.approx(0.75)
    assert summary.tokens_per_case == 120
    # 2 repeats x 2 cases x (100 in, 20 out) at $1 / $2 per million, per run of the set.
    assert summary.cost_usd == pytest.approx((400 * 1 + 80 * 2) / 1e6 / 2)


def test_the_gate_fails_only_beyond_the_threshold() -> None:
    baseline = {
        "metrics": {"intent": {"mean": 0.9}, "tools": {"mean": 0.8}},
        "pass_rate": {"mean": 0.8},
    }
    slightly = {
        "metrics": {"intent": {"mean": 0.87}, "tools": {"mean": 0.8}},
        "pass_rate": {"mean": 0.78},
    }
    clearly = {
        "metrics": {"intent": {"mean": 0.7}, "tools": {"mean": 0.8}},
        "pass_rate": {"mean": 0.6},
    }

    assert regressions(slightly, baseline, 0.05) == []
    assert regressions(clearly, baseline, 0.05) == ["intent: 0.90 → 0.70", "pass rate: 0.80 → 0.60"]


def test_the_report_compares_configurations_side_by_side() -> None:
    a = summarize("a", "model-a", "plan@5", [[scored(True)]]).as_json()
    b = summarize("b", "model-b", "plan-v4", [[scored(False)]]).as_json()

    text = report([a, b], run_date=date(2026, 10, 4), dataset="cases.jsonl")

    assert "| Metric | a (model-a, plan@5, n=1x1) | b (model-b, plan-v4, n=1x1) |" in text
    assert "| **pass rate** | **1.00** | **0.00** |" in text
    assert "## Failing cases: b" in text


def test_prompt_versions_can_be_swapped_for_a_comparison() -> None:
    variants = Path(__file__).parents[1] / "evals" / "prompt_variants"
    current = load_prompt("plan").version
    try:
        use_prompt_overrides(variants / "plan-v4")
        assert load_prompt("plan").version == "4"
        assert load_prompt("respond").version == load_prompt("respond").version  # untouched
    finally:
        use_prompt_overrides(None)
    assert load_prompt("plan").version == current


DATASET = Path(__file__).parents[1] / "evals" / "cases.jsonl"


@pytest.mark.skipif(not DATASET.is_file(), reason="dataset not written yet")
def test_the_dataset_is_well_formed() -> None:
    from agent.ask import ASK_REGISTRY
    from graphs.hr_agent import PLAN_REGISTRY
    from intent.schema import Intent

    cases = load_cases(DATASET)
    tools = set(PLAN_REGISTRY.names) | set(ASK_REGISTRY.names)

    assert 60 <= len(cases) <= 100
    assert {c.category for c in cases} == {
        "normal",
        "policy",
        "ambiguity",
        "missing_info",
        "conflicting_docs",
        "permission",
        "tool_failure",
    }
    assert sum(c.fast for c in cases) >= 10
    for c in cases:
        assert c.expect.intent in {i.value for i in Intent}, c.id
        named = {*c.expect.tools, *c.expect.forbidden_tools, *c.expect.writes}
        named |= {a.tool for a in c.expect.arguments}
        assert named <= tools, (c.id, named - tools)
        assert not any(a == {"decision": "approve"} for a in c.answers), c.id
