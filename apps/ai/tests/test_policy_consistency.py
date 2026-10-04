"""A4.6: the policy *text* must agree with the rules the code enforces.

The HR API enforces entitlements and the late cutoff from `@hr/contracts` (LEAVE_POLICY,
ATTENDANCE_RULES, exported to packages/contracts/json-schema/rules.json). The agent answers
"how many sick days do we get?" from the policy *documents*. If someone edits one and not
the other, the agent and the system disagree, and nothing else would notice.

Two layers, so a failure says where the drift is:
- retrieval: the passages found for each rule contain the enforced value (the policy text
  says what the code does);
- answer: the agent's answer, through `search_policy`, states that value and cites the
  policy (the model reads it correctly).

Live: needs indexed policies (`hr-ai ingest`), embeddings and the LLM. Run with
    cd apps/ai && RAG_LIVE_TESTS=1 uv run pytest tests/test_policy_consistency.py
"""

import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import date
from typing import Any

import httpx
import pytest

from agent.ask import answer_question
from app.hr_client import HrApiClient, SessionUser
from app.settings import WORKSPACE_ROOT, Settings
from llm.factory import create_llm_client
from rag.retrieval import PolicyRetriever
from rag.service import close_policy_retriever, create_policy_retriever
from tests.hr_data import session_user
from tools.base import ToolContext

RULES_PATH = WORKSPACE_ROOT / "packages" / "contracts" / "json-schema" / "rules.json"
LIVE = os.environ.get("RAG_LIVE_TESTS") == "1"


def rules() -> dict[str, Any]:
    return json.loads(RULES_PATH.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class Rule:
    name: str
    question: str
    # How the enforced value is written in the policy text and in answers.
    value: str
    policy: str


def rules_to_check() -> list[Rule]:
    leave = rules()["LEAVE_POLICY"]
    attendance = rules()["ATTENDANCE_RULES"]
    return [
        Rule(
            f"{kind.lower()}_days",
            f"How many days of {leave[kind]['label'].lower()} do employees get per year?",
            str(leave[kind]["daysPerYear"]),
            "Leave Policy",
        )
        for kind in ("ANNUAL", "SICK", "CASUAL")
    ] + [
        Rule(
            "late_cutoff",
            "After what time is a check-in recorded as late?",
            attendance["lateAfter"],
            "Attendance Policy",
        ),
        Rule(
            "full_day_hours",
            "How many hours between check-in and check-out count as a full day?",
            str(attendance["minHoursPresent"]),
            "Attendance Policy",
        ),
    ]


def test_rules_are_exported_from_the_contracts() -> None:
    """Always runs: the file the live checks compare against exists and has the rules."""
    exported = rules()

    assert set(exported["LEAVE_POLICY"]) == {"ANNUAL", "SICK", "CASUAL", "UNPAID"}
    assert exported["ATTENDANCE_RULES"]["lateAfter"].count(":") == 1


live = pytest.mark.skipif(not LIVE, reason="set RAG_LIVE_TESTS=1 (needs indexed policies + keys)")


def live_settings() -> Settings:
    # conftest hides the developer's .env from tests; live tests opt back in.
    return Settings(_env_file=WORKSPACE_ROOT / ".env")  # pyright: ignore[reportCallIssue]


@pytest.fixture
async def retriever() -> AsyncIterator[PolicyRetriever]:
    llm = create_llm_client(live_settings())
    retriever = create_policy_retriever(live_settings(), llm=llm)
    if retriever is None:
        pytest.fail("RAG_LIVE_TESTS needs embeddings: set GEMINI_API_KEY")
    yield retriever
    await close_policy_retriever(retriever)
    await llm.aclose()


@live
@pytest.mark.parametrize("rule", rules_to_check(), ids=lambda rule: rule.name)
async def test_policy_text_states_the_enforced_rule(retriever: PolicyRetriever, rule: Rule) -> None:
    hits = await retriever.search(rule.question, retriever.scope(date.today()), k=5)

    from_policy = [hit for hit in hits if hit.title == rule.policy and not hit.upcoming]
    assert from_policy, f"no {rule.policy} passage retrieved for {rule.question!r}"
    assert any(rule.value in hit.content for hit in from_policy), (
        f"{rule.policy} doesn't state {rule.value} (enforced by @hr/contracts) in "
        + " / ".join(hit.citation for hit in from_policy)
    )


@live
@pytest.mark.parametrize("rule", rules_to_check(), ids=lambda rule: rule.name)
async def test_the_agent_answers_with_the_enforced_rule_and_cites_it(
    retriever: PolicyRetriever, rule: Rule
) -> None:
    llm = create_llm_client(live_settings())
    async with httpx.AsyncClient(base_url="http://hr-api.unused") as http:
        user = SessionUser.model_validate(session_user("EMPLOYEE", "Test Employee", None))
        ctx = ToolContext(
            hr=HrApiClient(http, "unused"), user=user, today=date.today(), policies=retriever
        )
        try:
            run = await answer_question(llm, ctx, rule.question)
        finally:
            await llm.aclose()

    assert run.stop_reason == "answered"
    assert rule.value in run.answer, run.answer
    assert f"[{rule.policy} v" in run.answer, f"no citation in: {run.answer}"
