"""A10.2-A10.3: grading end-to-end runs, and the report.

Every metric but groundedness is decided by code from the run's final state and events:

| Metric | Per case (1 = right) |
| --- | --- |
| intent | parsed intent == expected |
| route | the first route `understand` chose == expected |
| entities | share of expected entities the parse got |
| tools | share of expected tools used (planned and run, or called on the short path) |
| no_forbidden_tools | none of the forbidden tools used |
| arguments | share of expected key arguments sent with the expected value |
| pauses | the run paused exactly as expected (clarification / value / which / approval) |
| approval | asked for approval exactly when expected |
| writes | expected writes verified, and no other write succeeded |
| status | final status (answered / failed) as expected |
| retrieval | share of expected policy citations retrieved |
| answer | share of answer checks met (facts present, forbidden text absent) |
| completed | the run finished (didn't crash or stay paused) |
| groundedness | LLM judge, 1-5 rubric, scaled to 0-1 (only with --judge) |

A metric is None for a case it doesn't apply to, and averages skip None. A case *passes*
when every applicable code-graded metric is 1.
"""

import json
import statistics
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from typing import Any, cast

from evals.agent_cases import EvalCase
from tools.hr_write import WRITE_TOOLS

WRITE_TOOL_NAMES = frozenset(t.name for t in WRITE_TOOLS)
CODE_METRICS = (
    "intent",
    "route",
    "entities",
    "tools",
    "no_forbidden_tools",
    "arguments",
    "pauses",
    "approval",
    "writes",
    "status",
    "retrieval",
    "answer",
    "completed",
)
METRICS = (*CODE_METRICS, "groundedness")


@dataclass
class ToolUse:
    tool: str
    arguments: dict[str, Any]
    ok: bool
    status: str | None = None  # plan steps: done, verified, failed, …


@dataclass
class Observed:
    """What a run did, gathered from its final state and its event stream."""

    values: dict[str, Any]
    first_route: str | None
    pauses: list[str]
    tools: list[ToolUse]
    citations: list[str]
    prompt_tokens: int
    completion_tokens: int
    latency_s: float
    llm_calls: int
    error: str | None = None
    finished: bool = True

    @property
    def answer(self) -> str:
        return str(self.values.get("answer") or "")


@dataclass
class CaseScore:
    case: EvalCase
    scores: dict[str, float | None]
    observed: Observed
    notes: list[str] = field(default_factory=list[str])
    judge: dict[str, Any] | None = None

    @property
    def passed(self) -> bool:
        return all(self.scores.get(m) in (None, 1.0) for m in CODE_METRICS)


def observe(
    values: dict[str, Any],
    events: list[dict[str, Any]],
    *,
    prompt_tokens: int,
    completion_tokens: int,
    latency_s: float,
    llm_calls: int,
    error: str | None = None,
    finished: bool = True,
) -> Observed:
    first_route = next(
        (
            e.get("summary", {}).get("route")
            for e in events
            if e.get("event") == "node_finished" and e.get("node") == "understand"
        ),
        None,
    )
    # The graph's "which one?" pause is sent as type "choice".
    pauses = [
        {"choice": "which"}.get(str(e.get("type")), str(e.get("type")))
        for e in events
        if e.get("event") == "waiting"
    ]
    tools: list[ToolUse] = []
    for record in mapping(values.get("results")).values():
        record = mapping(record)
        if record.get("tool"):
            tools.append(
                ToolUse(
                    str(record["tool"]),
                    mapping(record.get("arguments")),
                    bool(record.get("ok")),
                    record.get("status"),
                )
            )
    citations = [str(p.get("citation", "")) for p in dicts(values.get("policy"))]
    for step in dicts(values.get("steps")):
        for call in dicts(step.get("tool_calls")):
            tools.append(
                ToolUse(str(call["tool"]), mapping(call.get("arguments")), bool(call["ok"]))
            )
            data = mapping(call.get("data"))
            if call["tool"] == "search_policy":
                citations += [str(p.get("citation", "")) for p in dicts(data.get("passages"))]
    return Observed(
        values=values,
        first_route=first_route,
        pauses=pauses,
        tools=tools,
        citations=citations,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        latency_s=latency_s,
        llm_calls=llm_calls,
        error=error,
        finished=finished,
    )


def grade(case: EvalCase, run: Observed, aliases: dict[str, str]) -> CaseScore:
    e = case.expect
    parsed: dict[str, Any] = run.values.get("parsed") or {}
    used = {t.tool for t in run.tools}
    notes: list[str] = []
    scores: dict[str, float | None] = dict.fromkeys(METRICS)

    scores["intent"] = float(parsed.get("intent") == e.intent)
    if e.route is not None:
        scores["route"] = float(run.first_route == e.route)
    if e.entities:
        hits = [
            k for k, v in e.entities.items() if _entity_matches(parsed.get("entities") or {}, k, v)
        ]
        scores["entities"] = len(hits) / len(e.entities)
        missed = sorted(set(e.entities) - set(hits))
        if missed:
            notes.append(f"entities missed: {missed}")
    if e.tools:
        scores["tools"] = len(set(e.tools) & used) / len(set(e.tools))
        if set(e.tools) - used:
            notes.append(f"tools not used: {sorted(set(e.tools) - used)}")
    if e.forbidden_tools:
        bad = sorted(set(e.forbidden_tools) & used)
        scores["no_forbidden_tools"] = float(not bad)
        if bad:
            notes.append(f"forbidden tools used: {bad}")
    if e.arguments:
        matched = 0
        for expected in e.arguments:
            want = _resolve(expected.value, aliases)
            if any(
                t.tool == expected.tool and _same(t.arguments.get(expected.argument), want)
                for t in run.tools
            ):
                matched += 1
            else:
                notes.append(f"argument {expected.tool}.{expected.argument} != {expected.value}")
        scores["arguments"] = matched / len(e.arguments)
    if e.pauses is not None:
        scores["pauses"] = float(run.pauses == e.pauses)
        if run.pauses != e.pauses:
            notes.append(f"pauses {run.pauses}, expected {e.pauses}")
    if e.approval is not None:
        scores["approval"] = float(("approval" in run.pauses) == e.approval)
    succeeded = [t for t in run.tools if t.tool in WRITE_TOOL_NAMES and t.ok]
    verified = {t.tool for t in succeeded if t.status == "verified"}
    unexpected = sorted({t.tool for t in succeeded} - set(e.writes))
    scores["writes"] = float(set(e.writes) <= verified and not unexpected)
    if unexpected:
        notes.append(f"unexpected writes: {unexpected}")
    status = run.values.get("status")
    scores["status"] = float(run.finished and status == e.status)
    if e.citations:
        found = [c for c in e.citations if any(got.startswith(c) for got in run.citations)]
        scores["retrieval"] = len(found) / len(e.citations)
    checks = [s.casefold() in run.answer.casefold() for s in e.answer_contains] + [
        s.casefold() not in run.answer.casefold() for s in e.answer_excludes
    ]
    if checks:
        scores["answer"] = sum(checks) / len(checks)
    scores["completed"] = float(run.finished and run.error is None)
    if run.error:
        notes.insert(0, f"error: {run.error}")  # first: it usually explains the rest
    return CaseScore(case, scores, run, notes)


def _entity_matches(parsed: dict[str, Any], key: str, want: Any) -> bool:
    got = parsed.get(key)
    if isinstance(want, list):
        names = {str(x).casefold() for x in cast(list[Any], got or [])}
        return all(
            any(str(w).casefold() in n or n in str(w).casefold() for n in names)
            for w in cast(list[Any], want)
        )
    return got is not None and str(got).casefold() == str(want).casefold()


def mapping(value: Any) -> dict[str, Any]:
    """A JSON object from the run's state, typed; anything else is empty."""
    return cast(dict[str, Any], value) if isinstance(value, dict) else {}


def dicts(value: Any) -> list[dict[str, Any]]:
    """A JSON list of objects from the run's state, typed."""
    items = cast(list[Any], value) if isinstance(value, list) else []
    return [mapping(item) for item in items if isinstance(item, dict)]


def _resolve(value: Any, aliases: dict[str, str]) -> Any:
    if isinstance(value, str) and value.startswith("@"):
        return aliases.get(value, value)
    return value


def _same(got: Any, want: Any) -> bool:
    if got is None:
        return False
    return str(got).casefold() == str(want).casefold()


# ---- aggregation ---------------------------------------------------------------------------


@dataclass
class Summary:
    label: str
    model: str
    prompts: str
    cases: int
    repeats: int
    # metric → (mean over repeats, stdev over repeats)
    metrics: dict[str, tuple[float, float]]
    pass_rate: tuple[float, float]
    by_category: dict[str, float]
    tokens_per_case: float
    latency_p50_s: float
    latency_p95_s: float
    cost_usd: float
    failures: list[dict[str, Any]]

    def as_json(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "model": self.model,
            "prompts": self.prompts,
            "cases": self.cases,
            "repeats": self.repeats,
            "metrics": {k: {"mean": m, "stdev": s} for k, (m, s) in self.metrics.items()},
            "pass_rate": {"mean": self.pass_rate[0], "stdev": self.pass_rate[1]},
            "by_category": self.by_category,
            "tokens_per_case": self.tokens_per_case,
            "latency_p50_s": self.latency_p50_s,
            "latency_p95_s": self.latency_p95_s,
            "cost_usd": self.cost_usd,
            "failures": self.failures,
        }


def summarize(
    label: str,
    model: str,
    prompts: str,
    repeats: list[list[CaseScore]],
    price: tuple[float, float] = (0.0, 0.0),
) -> Summary:
    """`repeats`: one list of case scores per repeat of the whole set."""
    per_repeat: dict[str, list[float]] = {m: [] for m in METRICS}
    pass_rates: list[float] = []
    for scores in repeats:
        for metric in METRICS:
            values = [s.scores[metric] for s in scores if s.scores[metric] is not None]
            if values:
                per_repeat[metric].append(statistics.fmean(v for v in values if v is not None))
        pass_rates.append(statistics.fmean(s.passed for s in scores) if scores else 0.0)
    everything = [s for scores in repeats for s in scores]
    categories: dict[str, list[bool]] = {}
    for s in everything:
        categories.setdefault(s.case.category, []).append(s.passed)
    latencies = sorted(s.observed.latency_s for s in everything) or [0.0]
    prompt_tokens = sum(s.observed.prompt_tokens for s in everything)
    completion_tokens = sum(s.observed.completion_tokens for s in everything)
    runs = max(len(everything), 1)
    return Summary(
        label=label,
        model=model,
        prompts=prompts,
        cases=len(repeats[0]) if repeats else 0,
        repeats=len(repeats),
        metrics={m: _mean_sd(v) for m, v in per_repeat.items() if v},
        pass_rate=_mean_sd(pass_rates),
        by_category={c: statistics.fmean(v) for c, v in sorted(categories.items())},
        tokens_per_case=(prompt_tokens + completion_tokens) / runs,
        latency_p50_s=_percentile(latencies, 0.5),
        latency_p95_s=_percentile(latencies, 0.95),
        cost_usd=(prompt_tokens * price[0] + completion_tokens * price[1])
        / 1e6
        / max(len(repeats), 1),
        failures=[
            {"id": s.case.id, "notes": s.notes}
            for s in (repeats[0] if repeats else [])
            if not s.passed
        ],
    )


def _mean_sd(values: list[float]) -> tuple[float, float]:
    if not values:
        return (0.0, 0.0)
    return (statistics.fmean(values), statistics.stdev(values) if len(values) > 1 else 0.0)


def _percentile(sorted_values: list[float], q: float) -> float:
    index = min(len(sorted_values) - 1, round(q * (len(sorted_values) - 1)))
    return sorted_values[index]


# ---- regression gate (A10.4) -------------------------------------------------------------


def regressions(current: dict[str, Any], baseline: dict[str, Any], threshold: float) -> list[str]:
    """Metrics that dropped by more than `threshold` (absolute, 0-1) from the baseline."""
    found: list[str] = []
    for metric, base in baseline.get("metrics", {}).items():
        now = current.get("metrics", {}).get(metric)
        if now is not None and base["mean"] - now["mean"] > threshold:
            found.append(f"{metric}: {base['mean']:.2f} → {now['mean']:.2f}")
    base_pass, now_pass = baseline["pass_rate"]["mean"], current["pass_rate"]["mean"]
    if base_pass - now_pass > threshold:
        found.append(f"pass rate: {base_pass:.2f} → {now_pass:.2f}")
    return found


# ---- report (A10.3) ----------------------------------------------------------------------


def report(summaries: Iterable[dict[str, Any]], *, run_date: date, dataset: str) -> str:
    rows = list(summaries)
    head = "| Metric | " + " | ".join(_column(r) for r in rows) + " |"
    lines = [
        "# Agent evaluation (A10)",
        "",
        f"Generated {run_date.isoformat()} by `uv run python -m evals.run_agent_eval` on "
        f"`hr_test`; dataset `{dataset}`. Means over repeats, ± the standard deviation "
        "between repeats (variance from the model, not the code).",
        "",
        head,
        "| --- |" + " --- |" * len(rows),
    ]

    def cell(row: dict[str, Any], metric: str) -> str:
        value = row["metrics"].get(metric)
        if value is None:
            return "-"
        sd = f" ± {value['stdev']:.2f}" if row["repeats"] > 1 else ""
        return f"{value['mean']:.2f}{sd}"

    lines.append(
        "| **pass rate** | "
        + " | ".join(
            f"**{r['pass_rate']['mean']:.2f}**"
            + (f" ± {r['pass_rate']['stdev']:.2f}" if r["repeats"] > 1 else "")
            for r in rows
        )
        + " |"
    )
    for metric in METRICS:
        lines.append(f"| {metric} | " + " | ".join(cell(r, metric) for r in rows) + " |")
    lines.append(
        "| tokens / case | " + " | ".join(f"{r['tokens_per_case']:,.0f}" for r in rows) + " |"
    )
    lines.append(
        "| latency p50 / p95 (s) | "
        + " | ".join(f"{r['latency_p50_s']:.1f} / {r['latency_p95_s']:.1f}" for r in rows)
        + " |"
    )
    lines.append(
        "| cost / run of the set (USD, list price) | "
        + " | ".join(f"{r['cost_usd']:.4f}" for r in rows)
        + " |"
    )
    categories = sorted({c for r in rows for c in r["by_category"]})
    lines += ["", "## Pass rate by category", "", head, "| --- |" + " --- |" * len(rows)]
    for c in categories:
        lines.append(
            f"| {c} | "
            + " | ".join(
                f"{r['by_category'][c]:.2f}" if c in r["by_category"] else "-" for r in rows
            )
            + " |"
        )
    for r in rows:
        if r["failures"]:
            lines += ["", f"## Failing cases: {_column(r)}", ""]
            lines += [f"- `{f['id']}`: {'; '.join(f['notes']) or 'see run'}" for f in r["failures"]]
    return "\n".join(lines) + "\n"


def _column(row: dict[str, Any]) -> str:
    return f"{row['label']} ({row['model']}, {row['prompts']}, n={row['cases']}x{row['repeats']})"


def dumps(summary: Summary) -> str:
    return json.dumps(summary.as_json(), indent=2) + "\n"
