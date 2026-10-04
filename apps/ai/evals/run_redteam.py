"""CLI entry point: `uv run python -m evals.run_redteam`.

Runs every red-team case (evals/redteam.jsonl) through the real HR agent graph, with the
configured model, against the HR API at HR_API_URL, signed in as each case's user, and
writes docs/evaluation/redteam.md. Exits 1 if any case wasn't blocked or refused.

Point it at hr_test: the eval answers approvals with "reject", but a failing case could
still change data.

    cd apps/ai && HR_API_URL=http://localhost:4100 HR_PASSWORD='Password123!' \\
        uv run python -m evals.run_redteam --model openai/gpt-oss-120b
"""

import argparse
import asyncio
import os
import sys
from datetime import date
from pathlib import Path

import httpx
from langgraph.checkpoint.memory import InMemorySaver

from app.agent_routes import run_budget
from app.hr_client import HrApiClient, SessionUser
from app.settings import WORKSPACE_ROOT, get_settings
from evals.redteam import (
    CaseResult,
    PoisonedRetriever,
    RedTeamCase,
    dump,
    load_cases,
    results_table,
    run_case,
)
from graphs.hr_agent import HrContext, build_hr_graph
from graphs.runner import HrGraph
from llm.base import LLMClient
from llm.factory import create_llm_client
from rag.retrieval import PolicyRetriever
from rag.service import close_policy_retriever, create_policy_retriever
from tools.base import ToolContext
from tracing.trace import Trace

DEFAULT_OUTPUT = WORKSPACE_ROOT / "docs" / "evaluation" / "redteam.md"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the red-team cases; all must be blocked.")
    parser.add_argument("--dataset", type=Path, default=Path(__file__).with_name("redteam.jsonl"))
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--model", help="override LLM_MODEL")
    parser.add_argument("--only", nargs="*", help="case ids to run")
    args = parser.parse_args(argv)
    return asyncio.run(_main(args))


async def _main(args: argparse.Namespace) -> int:
    settings = get_settings()
    if args.model:
        settings = settings.model_copy(update={"llm_model": args.model})
    password = os.environ.get("HR_PASSWORD")
    if not password:
        print("Set HR_PASSWORD (the seeded users' password).", file=sys.stderr)
        return 2
    cases = [c for c in load_cases(args.dataset) if not args.only or c.id in args.only]
    llm = create_llm_client(settings)
    policies = create_policy_retriever(settings, llm=llm)
    graph = build_hr_graph(InMemorySaver())
    results: list[CaseResult] = []
    try:
        async with httpx.AsyncClient(
            base_url=settings.hr_api_url, timeout=settings.hr_api_timeout
        ) as http:
            sessions: dict[str, tuple[str, SessionUser]] = {}
            for case in cases:
                if case.login not in sessions:
                    login = await HrApiClient(http).login(case.login, password)
                    sessions[case.login] = (login.access_token, login.user)
                token, user = sessions[case.login]
                retriever = (
                    PoisonedRetriever(policies).as_retriever() if case.poison_policies else policies
                )
                try:
                    result = await _run_one(graph, case, http, token, user, llm, retriever)
                except Exception as error:  # one broken case shouldn't hide the others
                    result = CaseResult(
                        case=case, passed=False, outcome="error", reasons=[repr(error)[:200]]
                    )
                results.append(result)
                mark = "pass" if result.passed else "FAIL " + "; ".join(result.reasons)
                print(f"{case.id:32} {mark:6} {result.outcome}", file=sys.stderr)
    finally:
        await llm.aclose()
        await close_policy_retriever(policies)
    args.output.write_text(results_table(results, model=llm.model, run_date=date.today()))
    print(dump([r for r in results if not r.passed]) if not all(r.passed for r in results) else "")
    passed = sum(r.passed for r in results)
    print(f"{passed}/{len(results)} blocked or refused → {args.output}", file=sys.stderr)
    return 0 if passed == len(results) else 1


async def _run_one(
    graph: HrGraph,
    case: RedTeamCase,
    http: httpx.AsyncClient,
    token: str,
    user: SessionUser,
    llm: LLMClient,
    policies: PolicyRetriever | None,
) -> CaseResult:
    tools = ToolContext(
        hr=HrApiClient(http, token), user=user, today=date.today(), policies=policies
    )
    budget = run_budget(get_settings())

    def context() -> HrContext:
        trace = Trace(name="redteam", known_names={user.name})
        return HrContext(llm=llm, tools=tools, trace=trace, budget=budget)

    return await run_case(graph, case, context, f"redteam-{case.id}")


if __name__ == "__main__":
    sys.exit(main())
