"""CLI entry point: `uv run python -m evals.run_agent_eval` (A10.2-A10.4).

Runs the end-to-end cases (evals/cases.jsonl) through the real HR agent graph with a
hosted model, against the HR API at HR_API_URL (point it at hr_test), grades every run
(evals/agent_eval.py), and writes:

- evals/results/<label>.json per configuration (model x prompt variant),
- docs/evaluation/agent-eval.md comparing them,
- with --langfuse: a Langfuse dataset, one dataset run per configuration, scores per trace.

    cd apps/ai && export HR_API_URL=http://localhost:4100 \\
        AI_DATABASE_URL=postgresql://hr:hr@localhost:5433/hr_test HR_PASSWORD='Password123!'
    uv run python -m evals.run_agent_eval --models openai/gpt-oss-120b llama-3.3-70b-versatile
    uv run python -m evals.run_agent_eval --prompt-variants current plan-v4 --fast
    uv run python -m evals.run_agent_eval --fast --baseline evals/baseline.json  # CI gate

Writes on hr_test are limited by the dataset's rules: leave requests the runs create are
cancelled afterwards, and every approval is rejected unless a case scripts otherwise.
"""

import argparse
import asyncio
import json
import os
import sys
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import httpx
from langgraph.checkpoint.memory import InMemorySaver

from agent.budget import RunBudget
from app.faults import FaultInjector, parse_faults
from app.hr_client import HrApiClient, SessionUser
from app.settings import WORKSPACE_ROOT, Settings, get_settings
from evals.agent_cases import EvalCase, load_cases
from evals.agent_eval import (
    CaseScore,
    Observed,
    dicts,
    dumps,
    grade,
    mapping,
    observe,
    regressions,
    report,
    summarize,
)
from graphs.hr_agent import HrContext, build_hr_graph, result_content_text
from graphs.runner import HrGraph, RunOutcome, resume_run, start_run
from llm.base import LLMClient, LLMError
from llm.factory import create_llm_client
from llm.types import Message
from prompts import load_prompt, use_prompt_overrides
from rag.retrieval import PolicyRetriever
from rag.service import close_policy_retriever, create_policy_retriever
from tools.base import ToolContext
from tracing.langfuse import LangfuseApi, TraceExporter, create_exporter, create_langfuse_api
from tracing.trace import Trace

HERE = Path(__file__).parent
DEFAULT_REPORT = WORKSPACE_ROOT / "docs" / "evaluation" / "agent-eval.md"
VARIANTS_DIR = HERE / "prompt_variants"
MAX_PAUSES = 6
DONT_KNOW = "I don't know."


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="End-to-end agent eval on hr_test.")
    parser.add_argument("--dataset", type=Path, default=HERE / "cases.jsonl")
    parser.add_argument("--fast", action="store_true", help="only the cases marked fast (CI)")
    parser.add_argument("--only", nargs="*", help="case ids")
    parser.add_argument(
        "--models",
        nargs="*",
        help="model ids, optionally with a provider: gemini:gemini-2.5-flash (default: LLM_MODEL)",
    )
    parser.add_argument(
        "--prompt-variants",
        nargs="*",
        default=["current"],
        help="'current' or a directory name under evals/prompt_variants",
    )
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--judge", metavar="MODEL", help="grade groundedness with this model")
    parser.add_argument("--results-dir", type=Path, default=HERE / "results")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--baseline", type=Path, help="fail if worse than this results file")
    parser.add_argument("--threshold", type=float, default=0.05)
    parser.add_argument("--write-baseline", type=Path, help="save the first result as baseline")
    parser.add_argument("--langfuse", action="store_true", help="also record to Langfuse")
    parser.add_argument(
        "--report-from",
        nargs="+",
        type=Path,
        help="only build the report from saved results files (no runs)",
    )
    args = parser.parse_args(argv)
    if args.report_from:
        rows = [json.loads(p.read_text()) for p in args.report_from]
        args.report.write_text(report(rows, run_date=date.today(), dataset=args.dataset.name))
        print(f"report → {args.report}", file=sys.stderr)
        return 0
    return asyncio.run(_main(args))


@dataclass
class Session:
    token: str
    user: SessionUser


async def _main(args: argparse.Namespace) -> int:
    settings = get_settings()
    password = os.environ.get("HR_PASSWORD")
    if not password:
        print("Set HR_PASSWORD (the seeded users' password).", file=sys.stderr)
        return 2
    cases = [
        c
        for c in load_cases(args.dataset)
        if (not args.fast or c.fast) and (not args.only or c.id in args.only)
    ]
    models: list[str] = args.models or [settings.llm_model]
    prices = _prices()
    summaries: list[dict[str, Any]] = []
    langfuse = create_langfuse_api(settings) if args.langfuse else None
    exporter = create_exporter(settings) if args.langfuse else None
    judge = create_llm_client(_with_model(settings, args.judge)) if args.judge else None
    async with httpx.AsyncClient(
        base_url=settings.hr_api_url, timeout=settings.hr_api_timeout
    ) as http:
        sessions = {
            login: await _login(http, login, password) for login in {c.login for c in cases}
        }
        hr = sessions.get("hr@hr.local") or await _login(http, "hr@hr.local", password)
        aliases = await _aliases(http, hr, cases)
        for model in models:
            for variant in args.prompt_variants:
                label = f"{_slug(model)}__{variant}"
                use_prompt_overrides(None if variant == "current" else VARIANTS_DIR / variant)
                llm = create_llm_client(_with_model(settings, model))
                policies = create_policy_retriever(settings, llm=llm)
                runner = CaseRunner(
                    settings,
                    http,
                    sessions,
                    aliases,
                    llm,
                    policies,
                    judge,
                    langfuse,
                    exporter,
                    label,
                )
                try:
                    repeats = [await runner.run_all(cases, r) for r in range(args.repeats)]
                finally:
                    await llm.aclose()
                    await close_policy_retriever(policies)
                summary = summarize(
                    label, model, _prompt_label(variant), repeats, prices.get(model, (0.0, 0.0))
                )
                args.results_dir.mkdir(parents=True, exist_ok=True)
                (args.results_dir / f"{label}.json").write_text(dumps(summary))
                summaries.append(summary.as_json())
                print(
                    f"{label}: pass rate {summary.pass_rate[0]:.2f} over {len(cases)} cases",
                    file=sys.stderr,
                )
    use_prompt_overrides(None)
    for client in (judge, langfuse, exporter):
        if client is not None:
            await client.aclose()

    dataset = args.dataset.name + (" (fast subset)" if args.fast else "")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(report(summaries, run_date=date.today(), dataset=dataset))
    print(f"report → {args.report}", file=sys.stderr)
    if args.write_baseline:
        args.write_baseline.write_text(json.dumps(summaries[0], indent=2) + "\n")
    if args.baseline:
        found = regressions(summaries[0], json.loads(args.baseline.read_text()), args.threshold)
        if found:
            print("Regressions beyond the threshold:\n  " + "\n  ".join(found), file=sys.stderr)
            return 1
    return 0


class CaseRunner:
    def __init__(
        self,
        settings: Settings,
        http: httpx.AsyncClient,
        sessions: dict[str, Session],
        aliases: dict[str, str],
        llm: LLMClient,
        policies: PolicyRetriever | None,
        judge: LLMClient | None,
        langfuse: LangfuseApi | None,
        exporter: TraceExporter | None,
        label: str,
    ) -> None:
        self.settings = settings
        self.http = http
        self.sessions = sessions
        self.aliases = aliases
        self.llm = llm
        self.policies = policies
        self.judge = judge
        self.langfuse = langfuse
        self.exporter = exporter
        self.label = label
        self.graph: HrGraph = build_hr_graph(InMemorySaver())

    async def run_all(self, cases: list[EvalCase], repeat: int) -> list[CaseScore]:
        scores: list[CaseScore] = []
        for case in cases:
            score = await self.run_case(case, repeat)
            scores.append(score)
            mark = "pass" if score.passed else "FAIL " + "; ".join(score.notes)[:160]
            print(f"  [{repeat}] {case.id:40} {mark}", file=sys.stderr)
        return scores

    async def run_case(self, case: EvalCase, repeat: int) -> CaseScore:
        session = self.sessions[case.login]
        trace = Trace(name="eval", input={"request": case.request}, known_names={session.user.name})
        trace.metadata = {"case": case.id, "label": self.label, "repeat": repeat}
        events: list[dict[str, Any]] = []

        async def on_event(event: dict[str, Any]) -> None:
            events.append(event)

        transport = FaultInjector(parse_faults(case.faults)) if case.faults else None
        started = time.monotonic()
        error: str | None = None
        outcome: RunOutcome | None = None
        async with httpx.AsyncClient(
            base_url=self.settings.hr_api_url,
            timeout=self.settings.hr_api_timeout,
            transport=transport,
        ) as http:
            tools = ToolContext(
                hr=HrApiClient(http, session.token),
                user=session.user,
                today=date.today(),
                policies=self.policies,
            )
            context = self._context_factory(tools, trace)
            thread = f"eval-{self.label}-{case.id}-{repeat}-{uuid.uuid4().hex[:8]}"
            try:
                outcome = await start_run(self.graph, thread, case.request, context(), on_event)
                answers = list(case.answers)
                for _ in range(MAX_PAUSES):
                    if outcome.status != "waiting" or outcome.question is None:
                        break
                    reply = _reply(outcome.question, answers)
                    outcome = await resume_run(self.graph, thread, reply, context(), on_event)
            except Exception as exc:  # a crash is a result, not the end of the eval
                error = f"{type(exc).__name__}: {exc}"[:600]
        latency = time.monotonic() - started
        values = dict(outcome.values) if outcome else {}
        await self._cleanup(session, values)
        usage = trace.usage
        observed = observe(
            values,
            events,
            prompt_tokens=usage.prompt_tokens,
            completion_tokens=usage.completion_tokens,
            latency_s=latency,
            llm_calls=sum(o.kind == "generation" for o in trace.observations),
            error=error,
            finished=outcome is not None and outcome.status == "completed",
        )
        score = grade(case, observed, self.aliases)
        if self.judge is not None and observed.answer and values.get("status") == "answered":
            score.judge = await judge_groundedness(self.judge, case, observed)
            if score.judge.get("score"):
                score.scores["groundedness"] = (float(score.judge["score"]) - 1) / 4
        trace.finish({"answer": observed.answer, "scores": score.scores})
        await self._record(case, trace, score)
        return score

    def _context_factory(self, tools: ToolContext, trace: Trace) -> Callable[[], HrContext]:
        budget = RunBudget(
            max_tokens=self.settings.agent_run_max_tokens,
            max_seconds=self.settings.agent_run_max_seconds,
        )

        def context() -> HrContext:
            return HrContext(
                llm=self.llm,
                tools=tools,
                trace=trace,
                budget=budget,
                retry_delays=(0.2, 0.4, 0.8),
            )

        return context

    async def _cleanup(self, session: Session, values: dict[str, Any]) -> None:
        """Cancels leave requests the run created, so hr_test stays as seeded."""
        hr = HrApiClient(self.http, session.token)
        for record in map(mapping, mapping(values.get("results")).values()):
            data = mapping(record.get("data"))
            if record.get("tool") == "create_leave_request" and record.get("ok") and data.get("id"):
                if record.get("status") == "compensated":
                    continue
                try:
                    await hr.post(f"/leave-requests/{data['id']}/cancel")
                except Exception as exc:
                    print(f"    cleanup failed for {data['id']}: {exc!r}", file=sys.stderr)

    async def _record(self, case: EvalCase, trace: Trace, score: CaseScore) -> None:
        if self.exporter is not None:
            await self.exporter.export(trace)
        if self.langfuse is None:
            return
        await self.langfuse.dataset_item(
            "hr-agent-eval",
            case.id,
            {"request": case.request, "login": case.login},
            case.expect.model_dump(exclude_defaults=True),
            {"category": case.category, "fast": case.fast},
        )
        await self.langfuse.dataset_run_item(self.label, case.id, trace.id)
        for metric, value in score.scores.items():
            if value is not None:
                await self.langfuse.score(trace.id, metric, value)
        await self.langfuse.score(trace.id, "passed", float(score.passed))


def _reply(question: dict[str, Any], answers: list[str | dict[str, Any]]) -> str | dict[str, Any]:
    if answers:
        return answers.pop(0)
    if question.get("type") == "approval":
        return {"decision": "reject", "comment": "eval: rejected by default"}
    return DONT_KNOW


async def judge_groundedness(judge: LLMClient, case: EvalCase, run: Observed) -> dict[str, Any]:
    """A10.2: LLM-as-judge with a fixed rubric, at temperature 0, on a different model."""
    evidence: list[str] = []
    for step_id, record in mapping(run.values.get("results")).items():
        record = mapping(record)
        evidence.append(f"{step_id} {record.get('tool')}: {result_content_text(record)}")
    for passage in dicts(run.values.get("policy")):
        evidence.append(f"Policy [{passage['citation']}]: {passage['text']}")
    for step in dicts(run.values.get("steps")):
        for call in dicts(step.get("tool_calls")):
            evidence.append(
                f"{call['tool']}: {json.dumps(call.get('data') or call.get('error'))[:3000]}"
            )
    prompt = load_prompt("judge_groundedness")
    user = (
        f"Request: {case.request}\n\nEvidence:\n"
        + ("\n".join(evidence) or "(no tool results)")
        + f"\n\nAnswer:\n{run.answer}"
    )
    try:
        response = await judge.chat(
            [Message.system(prompt.template), Message.user(user)],
            response_format={"type": "json_object"},
            temperature=0,
            max_tokens=400,
            prompt=prompt.ref,
        )
        verdict: dict[str, Any] = json.loads(response.text or "{}")
    except (LLMError, ValueError) as error:
        return {"error": str(error)[:200]}
    score = verdict.get("score")
    return (
        verdict
        if isinstance(score, int) and 1 <= score <= 5
        else {"error": f"bad verdict {verdict}"}
    )


async def _login(http: httpx.AsyncClient, login: str, password: str) -> Session:
    response = await HrApiClient(http).login(login, password)
    return Session(response.access_token, response.user)


async def _aliases(http: httpx.AsyncClient, hr: Session, cases: list[EvalCase]) -> dict[str, str]:
    """ "@employee:Sneha Patel" → her id, looked up as HR."""
    wanted = {
        arg.value
        for case in cases
        for arg in case.expect.arguments
        if isinstance(arg.value, str) and arg.value.startswith("@employee:")
    }
    client = HrApiClient(http, hr.token)
    aliases: dict[str, str] = {}
    for alias in sorted(wanted):
        name = alias.removeprefix("@employee:")
        page = await client.get("/employees", params={"q": name.split()[0]})
        match = [
            e
            for e in page["items"]
            if f"{e['firstName']} {e['lastName']}".casefold() == name.casefold()
        ]
        if len(match) == 1:
            aliases[alias] = match[0]["id"]
        else:
            print(f"warning: alias {alias} matched {len(match)} employees", file=sys.stderr)
    return aliases


def _prices() -> dict[str, tuple[float, float]]:
    path = HERE / "prices.json"
    raw: dict[str, list[float]] = json.loads(path.read_text()) if path.is_file() else {}
    return {k: (v[0], v[1]) for k, v in raw.items() if not k.startswith("_")}


def _with_model(settings: Settings, spec: str) -> Settings:
    """ "gemini:gemini-2.5-flash" switches provider too; a bare id keeps LLM_PROVIDER."""
    prefix, _, rest = spec.partition(":")
    provider, model = (prefix, rest) if prefix in PROVIDERS and rest else ("", spec)
    update: dict[str, Any] = {"llm_model": model}
    if provider:
        update["llm_provider"] = provider
    return settings.model_copy(update=update)


PROVIDERS = ("groq", "openrouter", "gemini", "custom")


def _prompt_label(variant: str) -> str:
    if variant == "current":
        return "plan@" + load_prompt("plan").version
    return variant


def _slug(model: str) -> str:
    return model.replace("/", "_").replace(":", "_")


if __name__ == "__main__":
    sys.exit(main())
