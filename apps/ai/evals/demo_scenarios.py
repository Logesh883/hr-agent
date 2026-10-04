"""A12.3: the portfolio demo scenarios (AI_AGENT_README §17), run end to end through the
runs API exactly as the web app's Command Center drives it: start a run with the user's
token, answer its questions, approve or reject what it holds, follow its events, then check
the HR records and the audit log.

Run it against the stack on `hr_test` (the API on 4100, an AI service pointed at it). For
the tool-failure scenario the AI service needs injected faults:

    cd apps/api && DATABASE_URL=postgresql://hr:hr@localhost:5433/hr_test \\
        STORAGE_DIR=../../storage-test API_PORT=4100 node dist/main
    cd apps/ai && HR_API_URL=http://localhost:4100 \\
        AI_DATABASE_URL=postgresql://hr:hr@localhost:5433/hr_test AI_PORT=8100 \\
        HR_FAULTS="POST /tools/create_leave_request=500,drop" uv run hr-ai serve
    HR_PASSWORD=... uv run python -m evals.demo_scenarios \\
        --api http://localhost:4100 --ai http://localhost:8100

Each scenario prints what happened and PASS / FAIL with the reasons. Writes stay in
hr_test; the leave the tool-failure scenario creates is cancelled afterwards.
"""

import argparse
import asyncio
import json
import os
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

import httpx

RUN_TIMEOUT_S = 240


@dataclass
class Run:
    id: str
    view: dict[str, Any]
    events: list[dict[str, Any]]
    asked: list[dict[str, Any]]

    @property
    def kinds(self) -> list[str]:
        return [e["event"] for e in self.events]


@dataclass
class Scenario:
    name: str
    shows: str
    login: str
    request: str
    # Answers to value questions, by argument name; "clarification" for a clarifying one.
    answers: dict[str, str] = field(default_factory=dict[str, str])
    # Approval decisions, in order.
    decisions: list[dict[str, Any]] = field(default_factory=list[dict[str, Any]])
    check: Callable[["Demo", Run], Awaitable[list[str]]] | None = None
    cleanup: Callable[["Demo", Run], Awaitable[None]] | None = None


class Demo:
    def __init__(self, api: httpx.AsyncClient, ai: httpx.AsyncClient, password: str) -> None:
        self.api = api
        self.ai = ai
        self.password = password
        self.tokens: dict[str, str] = {}

    async def token(self, login: str) -> str:
        if login not in self.tokens:
            res = await self.api.post(
                "/auth/login", json={"email": login, "password": self.password}
            )
            res.raise_for_status()
            self.tokens[login] = res.json()["accessToken"]
        return self.tokens[login]

    async def hr(self, login: str, path: str, **params: Any) -> Any:
        res = await self.api.get(
            path, params=params, headers={"Authorization": f"Bearer {await self.token(login)}"}
        )
        res.raise_for_status()
        return res.json()

    async def audit_for(self, run: Run) -> list[dict[str, Any]]:
        page = await self.hr("hr@hr.local", "/audit-logs", agentRunId=run.id, pageSize=100)
        return page["items"]

    async def play(self, scenario: Scenario) -> Run:
        auth = {"Authorization": f"Bearer {await self.token(scenario.login)}"}
        res = await self.ai.post("/agent/runs", json={"request": scenario.request}, headers=auth)
        res.raise_for_status()
        run_id = res.json()["id"]
        decisions = list(scenario.decisions)
        asked: list[dict[str, Any]] = []
        deadline = time.monotonic() + RUN_TIMEOUT_S
        while True:
            view = (await self.ai.get(f"/agent/runs/{run_id}", headers=auth)).json()
            if view["status"] == "running":
                if time.monotonic() > deadline:
                    raise TimeoutError(f"run {run_id} still running after {RUN_TIMEOUT_S}s")
                await asyncio.sleep(1)
                continue
            if view["status"] != "waiting":
                break
            question = view["question"]
            asked.append(question)
            say(f"  ? {question['question']}")
            answer: Any
            if question["type"] == "approval":
                if not decisions:
                    raise RuntimeError("asked for an approval the scenario didn't expect")
                answer = decisions.pop(0)
                say(f"    {question.get('summary')} [{question['risk']}] → {answer['decision']}")
            elif question["type"] == "value" and question["argument"] in scenario.answers:
                answer = scenario.answers[question["argument"]]
                say(f"    > {answer}")
            elif question["type"] == "clarification" and "clarification" in scenario.answers:
                answer = scenario.answers["clarification"]
                say(f"    > {answer}")
            else:
                raise RuntimeError(f"unexpected question: {json.dumps(question)}")
            res = await self.ai.post(
                f"/agent/runs/{run_id}/resume", json={"answer": answer}, headers=auth
            )
            res.raise_for_status()
        stream = await self.ai.get(f"/agent/runs/{run_id}/events", headers=auth)
        events = [
            json.loads(line.removeprefix("data: "))
            for line in stream.text.splitlines()
            if line.startswith("data: ")
        ]
        return Run(run_id, view, events, asked)


def say(text: str) -> None:
    print(text, flush=True)


def progress(run: Run) -> dict[str, Any]:
    return run.view.get("progress") or {}


def steps(run: Run) -> dict[str, str]:
    plan: dict[str, Any] = progress(run).get("plan") or {}
    found: list[dict[str, Any]] = plan.get("steps", [])
    return {s["tool"]: s["status"] for s in found}


# ---- the scenarios -----------------------------------------------------------------------

PRIYA_EMAIL = f"priya.rao.{uuid4().hex[:6]}@acme.example"


async def check_onboarding(demo: Demo, run: Run) -> list[str]:
    problems: list[str] = []
    found = await demo.hr("hr@hr.local", "/employees", q=PRIYA_EMAIL)
    if found["total"] != 1:
        problems.append(f"expected one employee with {PRIYA_EMAIL}, found {found['total']}")
    else:
        priya = found["items"][0]
        if not priya.get("manager") or priya["manager"]["firstName"] != "Rahul":
            problems.append("Priya doesn't report to Rahul")
        onboarding = await demo.hr("hr@hr.local", f"/employees/{priya['id']}/onboarding")
        if not onboarding["started"]:
            problems.append("onboarding wasn't started")
    tools = {e["toolName"] for e in await demo.audit_for(run) if e["actorType"] == "AI"}
    if not {"create_employee", "start_onboarding"} <= tools:
        problems.append(f"audit has AI entries for {sorted(tools)}")
    if not any(q["type"] == "approval" for q in run.asked):
        problems.append("the new employee wasn't held for approval")
    if not progress(run).get("passages"):
        problems.append("no policy evidence")
    return problems


async def check_leave_approval(demo: Demo, run: Run) -> list[str]:
    problems: list[str] = []
    approval = next((q for q in run.asked if q["type"] == "approval"), None)
    if approval is None or approval["risk"] != "high":
        problems.append("approving leave wasn't held as a high-risk approval")
    leave = await demo.hr("hr@hr.local", "/leave-requests", q="", status="APPROVED", pageSize=100)
    rohan = [
        item
        for item in leave["items"]
        if item["employee"]["firstName"] == "Rohan" and item["startDate"] == "2026-10-09"
    ]
    if not rohan:
        problems.append("Rohan's leave on 9 October isn't approved")
    if "approve_leave" not in {e["toolName"] for e in await demo.audit_for(run)}:
        problems.append("no AI audit entry for approve_leave")
    return problems


async def check_refused(demo: Demo, run: Run) -> list[str]:
    problems: list[str] = []
    if await demo.audit_for(run):
        problems.append("a manager's request changed records")
    if any(q["type"] == "approval" for q in run.asked):
        problems.append("it got as far as an approval")
    return problems


async def check_rejected(demo: Demo, run: Run) -> list[str]:
    problems: list[str] = []
    if await demo.audit_for(run):
        problems.append("a rejected change was written")
    if steps(run).get("change_department") != "rejected":
        problems.append(f"change_department step is {steps(run).get('change_department')}")
    arun = (await demo.hr("hr@hr.local", "/employees", q="Arun Kumar"))["items"][0]
    if arun["department"]["name"] != "Engineering":
        problems.append("Arun moved anyway")
    return problems


async def check_tool_failure(demo: Demo, run: Run) -> list[str]:
    problems: list[str] = []
    if "tool_retry" not in run.kinds:
        problems.append("no retry happened (is HR_FAULTS set on the AI service?)")
    if steps(run).get("create_leave_request") != "verified":
        problems.append(f"create_leave_request is {steps(run).get('create_leave_request')}")
    mine = await demo.hr("employee@hr.local", "/leave-requests", view="mine", pageSize=100)
    on_day = [
        item
        for item in mine["items"]
        if item["startDate"] == "2026-11-20" and item["status"] == "PENDING"
    ]
    if len(on_day) != 1:
        problems.append(f"expected exactly one pending request on 20 Nov, found {len(on_day)}")
    return problems


async def cancel_demo_leave(demo: Demo, run: Run) -> None:
    mine = await demo.hr("employee@hr.local", "/leave-requests", view="mine", pageSize=100)
    auth = {"Authorization": f"Bearer {await demo.token('employee@hr.local')}"}
    for item in mine["items"]:
        if item["startDate"] == "2026-11-20" and item["status"] == "PENDING":
            await demo.api.post(f"/leave-requests/{item['id']}/cancel", headers=auth)


SCENARIOS = [
    Scenario(
        name="onboard-priya",
        shows="Intent, planning, RAG, tools, multi-step execution, approval",
        login="hr@hr.local",
        request="Onboard Priya as a Software Engineer joining October 12, reporting to Rahul "
        "in Bangalore.",
        answers={"last_name": "Rao", "email": PRIYA_EMAIL},
        decisions=[{"decision": "approve"}],
        check=check_onboarding,
    ),
    Scenario(
        name="leave-approval",
        shows="Policy retrieval + deterministic validation + approval",
        login="hr@hr.local",
        request="Approve Rohan Gupta's casual leave request for 9 October.",
        decisions=[{"decision": "approve", "comment": "Approved in the demo"}],
        check=check_leave_approval,
    ),
    Scenario(
        name="sensitive-change-rbac",
        shows="RBAC: a manager can't move people between departments",
        login="manager@hr.local",
        request="Move Arun Kumar to the Product department.",
        check=check_refused,
    ),
    Scenario(
        name="sensitive-change-rejected",
        shows="Risk classification + human-in-the-loop: HR rejects the transfer",
        login="hr@hr.local",
        request="Move Arun Kumar to the Product department.",
        decisions=[{"decision": "reject", "comment": "Not approved by his manager yet"}],
        check=check_rejected,
    ),
    Scenario(
        name="tool-failure",
        shows="Recovery + retry + verification + auditability",
        login="employee@hr.local",
        request="Apply casual leave for me on 2026-11-20.",
        check=check_tool_failure,
        cleanup=cancel_demo_leave,
    ),
]

NOT_RUN = {
    "conflicting-documents": "needs document AI (M9), which is deferred",
    "evaluation-dashboard": "run `uv run python -m evals.run_agent_eval --fast` (pass --eval)",
}


async def main_async(args: argparse.Namespace) -> int:
    password = os.environ.get("HR_PASSWORD")
    if not password:
        say("Set HR_PASSWORD (the seeded users' password).")
        return 2
    wanted = [s for s in SCENARIOS if not args.only or s.name in args.only]
    failed = 0
    async with (
        httpx.AsyncClient(base_url=args.api, timeout=30) as api,
        httpx.AsyncClient(base_url=args.ai, timeout=60) as ai,
    ):
        demo = Demo(api, ai, password)
        for scenario in wanted:
            say(f"\n== {scenario.name}: {scenario.shows}")
            say(f"  {scenario.login}: “{scenario.request}”")
            try:
                run = await demo.play(scenario)
                problems = await scenario.check(demo, run) if scenario.check else []
            except Exception as error:  # reported; the next scenario still runs
                run, problems = None, [f"{type(error).__name__}: {error}"]
            if run is not None:
                say(f"  run {run.id}: {run.view['status']}; steps {steps(run)}")
                answer = (run.view.get("answer") or "").strip().replace("\n", " ")
                say(f"  answer: {answer[:300]}{'…' if len(answer) > 300 else ''}")
                if scenario.cleanup:
                    await scenario.cleanup(demo, run)
            say("  PASS" if not problems else "  FAIL: " + "; ".join(problems))
            failed += bool(problems)
    if not args.only:
        for name, why in NOT_RUN.items():
            say(f"\n== {name}: not run here: {why}")
    if args.eval:
        from evals.run_agent_eval import main as run_eval

        say("\n== evaluation-dashboard: the fast eval subset")
        failed += run_eval(["--fast"]) != 0
    say(f"\n{len(wanted) - failed} of {len(wanted)} scenarios passed" if not args.eval else "")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the portfolio demo scenarios end to end.")
    parser.add_argument("--api", default="http://localhost:4100", help="HR API (on hr_test)")
    parser.add_argument("--ai", default="http://localhost:8100", help="AI service")
    parser.add_argument("--only", nargs="*", help="scenario names")
    parser.add_argument("--eval", action="store_true", help="also run the fast eval subset")
    return asyncio.run(main_async(parser.parse_args(argv)))


if __name__ == "__main__":
    sys.exit(main())
