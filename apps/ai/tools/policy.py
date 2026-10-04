"""`search_policy` (A4.4): retrieval over the HR policy documents, with citations.

Policies are readable by every role (`policy:read`), so searching the index needs no
per-user check; everything else the agent reads still goes through the HR API as the user.
"""

from datetime import date
from typing import Any

from pydantic import Field

from rag.retrieval import hit_payload
from tools.base import Tool, ToolContext, ToolError, ToolInput

TOP_K = 5


class SearchPolicyInput(ToolInput):
    query: str = Field(
        min_length=2,
        max_length=300,
        description="What to look up: the question, or its key terms "
        "('annual leave carry over', 'late check-in cutoff').",
    )
    as_of: date | None = Field(
        default=None,
        description="Only for questions about the past ('in 2025', 'last year'): a date in "
        "that period, YYYY-MM-DD, to get the rules in force then. Omit for current rules.",
    )


async def search_policy(ctx: ToolContext, args: SearchPolicyInput) -> dict[str, Any]:
    if ctx.policies is None:
        raise ToolError("Policy search isn't available right now.")
    retriever = ctx.policies
    as_of = args.as_of or ctx.today
    # Current questions also see policies that start soon; a past date sees only what was
    # in force then.
    scope = retriever.scope(as_of, include_upcoming=args.as_of is None)
    hits = await retriever.search(args.query, scope, k=TOP_K)
    result: dict[str, Any] = {
        "as_of": as_of.isoformat(),
        "passages": [hit_payload(h) for h in hits],
    }
    if not hits:
        result["note"] = "No policy text matched. The policies may not cover this."
    return result


POLICY_TOOLS: list[Tool[Any]] = [
    Tool(
        name="search_policy",
        description="Search the company's HR policy documents (leave, attendance, onboarding, "
        "conduct, security, hybrid work) for rules and entitlements. Returns passages with a "
        "citation (policy, version, section). Use it for 'what is the rule / am I allowed / "
        "how many days' questions; use the other tools for a specific person's data.",
        input_model=SearchPolicyInput,
        run=search_policy,
        timeout_s=30.0,
    ),
]
