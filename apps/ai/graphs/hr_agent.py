# LangGraph's annotations are partly generic-unknown; see graphs/react.py.
# pyright: reportUnknownMemberType=false, reportMissingTypeStubs=false
"""A5.2 and A5.3: the HR agent as a graph (README §3).

    START ─► understand ─┬─ clarify ──(interrupt: ask the user)──► understand
                         ├─ decline ──────────────────────────────────────────► END
                         ├─ answer_simple (the A5.1 loop) ─────────────────────► END
                         └─ retrieve_policy ─► plan ─► validate_plan ─┬─(problems, retry)─► plan
                                                                      ├─(still invalid)─► respond
                                                                      └─ execute_step ⟲
          (one plan step per pass; may interrupt to ask "which Rahul?") ─► verify ─► respond ─► END

- **understand** parses the request (M2 parser) and *code* routes it: missing required
  information → clarify; not an HR request → decline; one-person read questions → the short
  path; anything that needs several lookups, several people, or a change → plan.
- **clarify** pauses the graph with `interrupt()`. The checkpointer saves the state; the
  caller later resumes the same thread with the user's answer, and understand runs again
  with it.
- **plan** asks the LLM for the whole list of tool calls up front; **validate_plan** checks it
  in code (graphs/plan.py) and sends problems back for one retry.
- **execute_step** runs the next step only, so each result is checkpointed as it lands: an
  interrupt or a crash mid-plan never re-runs finished steps (it matters once steps write,
  in M6). It refuses to run a plan that changed after validation.
- **verify** checks every step ran and found something; **respond** writes the answer from
  the results and policy evidence, citing it.

State is plain JSON. The LLM, the HR client (with the user's token), the retriever and the
trace are the run's context: never checkpointed, supplied again on every resume.
"""

import json
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Annotated, Any, Literal, Protocol, Required, TypedDict, cast

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.config import get_stream_writer
from langgraph.errors import GraphInterrupt
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.runtime import Runtime
from langgraph.types import interrupt
from pydantic import ValidationError

from agent.ask import ASK_REGISTRY, READ_REGISTRY, build_ask_messages
from graphs.plan import (
    Plan,
    UnresolvedReference,
    check_plan,
    plan_hash,
    references,
    resolve_references,
)
from graphs.react import REACT_GRAPH, AgentContext, add_usage, append
from intent.parser import parse_request
from intent.prompt import Role
from intent.schema import Intent, ParsedRequest
from llm.base import LLMClient
from llm.types import Message, ToolCall
from prompts import load_prompt
from rag.retrieval import hit_payload
from tools.base import ToolContext, ToolResult
from tools.registry import ToolRegistry, result_content
from tracing.trace import Trace

Route = Literal["clarify", "decline", "simple", "plan"]
Status = Literal["answered", "failed"]

MAX_CLARIFICATIONS = 2
MAX_PLAN_ATTEMPTS = 2
POLICY_TOP_K = 4
# Characters of one step's result shown to the respond prompt.
RESULT_CHARS = 3000

# Intents that change data: they always take the planned path (and, until M6, stop at the
# checks). Intents whose answer may depend on policy get policy evidence retrieved first.
WRITE_INTENTS = frozenset(
    {
        Intent.ONBOARD_EMPLOYEE,
        Intent.UPDATE_EMPLOYEE,
        Intent.REQUEST_LEAVE,
        Intent.APPROVE_LEAVE,
        Intent.ATTENDANCE_CORRECTION,
    }
)
POLICY_INTENTS = WRITE_INTENTS | {Intent.POLICY_QUESTION, Intent.LEAVE_BALANCE}

# What to ask when the parser found a required field missing (REQUIRED_FIELDS).
FIELD_QUESTIONS = {
    "people": "Who is this about?",
    "job_title": "What is {person}'s job title?",
    "joining_date": "When does {person} join?",
    "location": "Which office or city will {person} work from?",
    "department": "Which department is {person} joining?",
    "leave_type": "Which type of leave: annual, sick, casual or unpaid?",
    "start_date": "Which date (or first date) is this for?",
}

DECLINE_ANSWER = (
    "I can help with HR operations: employees, leave, attendance, onboarding, documents, "
    "payroll readiness and HR policies. Could you rephrase your request in those terms?"
)


def merge[V](old: dict[str, V], new: dict[str, V]) -> dict[str, V]:
    return old | new


class HrState(TypedDict, total=False):
    request: Required[str]
    # {"question", "answer"} pairs from clarify interrupts, oldest first.
    clarifications: Annotated[list[dict[str, str]], append]
    parsed: dict[str, Any]
    route: Route
    # hit_payload dicts: passage text with citation.
    policy: list[dict[str, Any]]
    plan: dict[str, Any] | None
    plan_hash: str
    plan_problems: list[str]
    plan_attempts: int
    # Step id → {"tool", "arguments", "status": done | failed | skipped, "ok", "data", "error"}.
    results: Annotated[dict[str, dict[str, Any]], merge]
    # Answers to "which one?" questions: reference text → chosen list position.
    choices: Annotated[dict[str, int], merge]
    verification: dict[str, Any]
    # The short path's steps (AgentStep dumps) and token usage.
    steps: list[dict[str, Any]]
    usage: Annotated[dict[str, int], add_usage]
    answer: str
    status: Status


@dataclass(frozen=True)
class HrContext:
    """Per-run dependencies, supplied on every start and resume; never checkpointed."""

    llm: LLMClient
    tools: ToolContext
    trace: Trace
    max_clarifications: int = MAX_CLARIFICATIONS

    @property
    def registry(self) -> ToolRegistry:
        return ASK_REGISTRY if self.tools.policies else READ_REGISTRY


class Node(Protocol):
    def __call__(
        self, state: HrState, runtime: Runtime[HrContext]
    ) -> Awaitable[dict[str, Any]]: ...


def traced(name: str, node: Node) -> Node:
    """Wraps a node: a `node_started` event for the timeline, and a span in the trace."""

    async def run(state: HrState, runtime: Runtime[HrContext]) -> dict[str, Any]:
        get_stream_writer()({"event": "node_started", "node": name})
        span = None
        try:
            with runtime.context.trace.observe(f"node {name}") as span:
                return await node(state, runtime)
        except GraphInterrupt:
            # A pause for the user, not a failure.
            if span is not None:
                span.level = "DEFAULT"
                span.status_message = "paused: waiting for the user"
            raise

    return run


# ---- understand / clarify / decline ------------------------------------------------------


def request_with_clarifications(state: HrState) -> str:
    lines = [state["request"]]
    for item in state.get("clarifications", []):
        lines.append(f"(Asked: {item['question']} Answer: {item['answer']})")
    return "\n".join(lines)


async def understand(state: HrState, runtime: Runtime[HrContext]) -> dict[str, Any]:
    ctx = runtime.context
    parsed = await parse_request(
        ctx.llm,
        request_with_clarifications(state),
        today=ctx.tools.today,
        role=cast(Role, ctx.tools.user.role),
    )
    return {"parsed": parsed.model_dump(mode="json"), "route": choose_route(state, parsed, ctx)}


def choose_route(state: HrState, parsed: ParsedRequest, ctx: HrContext) -> Route:
    """Code decides the path; the model only supplied the parse."""
    asked = len(state.get("clarifications", []))
    if parsed.intent is Intent.UNKNOWN and parsed.clarifying_question is None:
        return "decline"  # clearly not an HR request: asking again won't help
    if parsed.needs_clarification and asked < ctx.max_clarifications:
        return "clarify"
    if parsed.intent is Intent.UNKNOWN:
        return "decline"
    if parsed.intent in WRITE_INTENTS or len(parsed.entities.people) > 1:
        return "plan"
    return "simple"


def route_after_understand(state: HrState) -> str:
    route = state.get("route", "decline")
    return {"plan": "retrieve_policy", "simple": "answer_simple"}.get(route, route)


def clarification_question(parsed: ParsedRequest) -> str:
    if parsed.clarifying_question:
        return parsed.clarifying_question
    person = parsed.entities.people[0] if parsed.entities.people else "they"
    for name in parsed.missing_fields:
        if name in FIELD_QUESTIONS:
            return FIELD_QUESTIONS[name].format(person=person)
    return "Could you give me a bit more detail about what you need?"


async def clarify(state: HrState, runtime: Runtime[HrContext]) -> dict[str, Any]:
    question = clarification_question(ParsedRequest.model_validate(state.get("parsed", {})))
    # Pauses here. On resume the node runs again from the top and interrupt() returns the
    # user's answer, so everything before this line must be safe to repeat.
    answer = interrupt({"type": "clarification", "question": question})
    return {"clarifications": [{"question": question, "answer": str(answer)}]}


async def decline(state: HrState, runtime: Runtime[HrContext]) -> dict[str, Any]:
    return {"answer": DECLINE_ANSWER, "status": "answered"}


# ---- the short path ----------------------------------------------------------------------


async def answer_simple(state: HrState, runtime: Runtime[HrContext]) -> dict[str, Any]:
    ctx = runtime.context
    messages, prompt = build_ask_messages(request_with_clarifications(state), ctx.tools)
    result = await REACT_GRAPH.ainvoke(
        {"messages": [m.model_dump(mode="json") for m in messages]},
        context=AgentContext(
            llm=ctx.llm, registry=ctx.registry, tools=ctx.tools, trace=ctx.trace, prompt=prompt
        ),
    )
    return {
        "answer": result.get("answer", ""),
        "steps": result.get("steps", []),
        "usage": result.get("usage", {}),
        "status": "answered",
    }


# ---- the planned path --------------------------------------------------------------------


async def retrieve_policy(state: HrState, runtime: Runtime[HrContext]) -> dict[str, Any]:
    retriever = runtime.context.tools.policies
    intent = Intent(state.get("parsed", {}).get("intent", Intent.UNKNOWN))
    if retriever is None or intent not in POLICY_INTENTS:
        return {"policy": []}
    scope = retriever.scope(runtime.context.tools.today)
    hits = await retriever.search(state["request"], scope, k=POLICY_TOP_K)
    return {"policy": [hit_payload(hit) for hit in hits]}


async def plan(state: HrState, runtime: Runtime[HrContext]) -> dict[str, Any]:
    ctx = runtime.context
    prompt = load_prompt("plan")
    user = ctx.tools.user
    system = prompt.render(
        today=ctx.tools.today.isoformat(),
        weekday=ctx.tools.today.strftime("%A"),
        user_name=user.name,
        role=user.role,
        employee_id=user.employee_id or "none (this account has no employee record)",
        tools="\n".join(
            f"- {spec['function']['name']}: {spec['function']['description']} "
            f"Arguments: {json.dumps(spec['function']['parameters'])}"
            for spec in ctx.registry.specs()
        ),
    )
    parts = [
        f"Request: {request_with_clarifications(state)}",
        f"Parsed: {json.dumps(state.get('parsed', {}))}",
    ]
    if state.get("policy"):
        parts.append(
            "Policy passages already retrieved (no need to search them again): "
            + "; ".join(p["citation"] for p in state.get("policy", []))
        )
    if state.get("plan_problems"):
        parts.append(
            f"Your previous plan: {json.dumps(state.get('plan'))}\n"
            "It was rejected. Fix these problems and return the complete plan again:\n- "
            + "\n- ".join(state.get("plan_problems", []))
        )
    response = await ctx.llm.chat(
        [Message.system(system), Message.user("\n\n".join(parts))],
        response_format={"type": "json_object"},
        temperature=0,
        max_tokens=1500,
        prompt=prompt.ref,
    )
    attempts = state.get("plan_attempts", 0) + 1
    usage = response.usage.model_dump()
    try:
        proposed = Plan.model_validate_json(response.text or "")
    except ValidationError as error:
        return {
            "plan": None,
            "plan_problems": [f"The plan isn't valid JSON in the required shape: {error}"],
            "plan_attempts": attempts,
            "usage": usage,
        }
    return {
        "plan": proposed.model_dump(mode="json"),
        "plan_problems": [],
        "plan_attempts": attempts,
        "usage": usage,
    }


async def validate_plan(state: HrState, runtime: Runtime[HrContext]) -> dict[str, Any]:
    proposed = state.get("plan")
    if proposed is None:
        return {}  # plan already reported why
    problems = check_plan(Plan.model_validate(proposed), runtime.context.registry)
    if problems:
        return {"plan_problems": problems}
    return {"plan_problems": [], "plan_hash": plan_hash(proposed), "results": {}}


def route_after_validate(state: HrState) -> str:
    if not state.get("plan_problems"):
        return "execute_step"
    if state.get("plan_attempts", 0) < MAX_PLAN_ATTEMPTS:
        return "plan"
    return "respond"


def next_step(state: HrState) -> dict[str, Any] | None:
    done = state.get("results", {})
    steps = (state.get("plan") or {}).get("steps", [])
    return next((step for step in steps if step["id"] not in done), None)


async def execute_step(state: HrState, runtime: Runtime[HrContext]) -> dict[str, Any]:
    ctx = runtime.context
    proposed = state.get("plan") or {}
    if plan_hash(proposed) != state.get("plan_hash"):
        raise RuntimeError("The plan changed after it was validated; refusing to run it.")
    step = next_step(state)
    if step is None:
        return {}
    results = state.get("results", {})
    record: dict[str, Any] = {"tool": step["tool"], "arguments": step["arguments"]}

    failed_inputs = [ref for ref in references(step) if not results.get(ref, {}).get("ok")]
    if failed_inputs:
        reason = f"skipped: needs {', '.join(sorted(failed_inputs))}, which didn't succeed"
        return {
            "results": {step["id"]: record | {"status": "skipped", "ok": False, "error": reason}}
        }

    choices = dict(state.get("choices", {}))
    try:
        arguments = resolve_references(step["arguments"], results, choices)
    except UnresolvedReference as error:
        if not error.candidates or error.reference is None:
            return {
                "results": {
                    step["id"]: record | {"status": "failed", "ok": False, "error": str(error)}
                }
            }
        index = ask_which(error)
        if index is None:
            message = f"{error} The answer didn't match exactly one of them."
            return {
                "results": {
                    step["id"]: record | {"status": "failed", "ok": False, "error": message}
                }
            }
        choices[error.reference] = index
        arguments = resolve_references(step["arguments"], results, choices)

    write = get_stream_writer()
    write({"event": "tool_started", "tool": step["tool"], "step": step["id"]})
    call = ToolCall(id=step["id"], name=step["tool"], arguments=json.dumps(arguments))
    with ctx.trace.observe(
        f"tool {step['tool']}", input=arguments, metadata={"step": step["id"]}
    ) as span:
        result = await ctx.registry.execute(call, ctx.tools)
        span.output = result.model_dump(exclude_none=True)
        if not result.ok:
            span.level = "WARNING"
            span.status_message = result.error
    write({"event": "tool_finished", "tool": step["tool"], "step": step["id"], "ok": result.ok})
    record |= {
        "arguments": arguments,
        "status": "done" if result.ok else "failed",
        "ok": result.ok,
        "data": result.data,
        "error": result.error,
    }
    return {"results": {step["id"]: record}, "choices": choices}


def ask_which(error: UnresolvedReference) -> int | None:
    """Interrupts with the candidates; the answer must match exactly one of them."""
    options = [_describe(candidate) for candidate in error.candidates]
    answer = (
        str(
            interrupt(
                {
                    "type": "choice",
                    "question": f"I found {len(options)} matches. Which one did you mean?",
                    "options": options,
                }
            )
        )
        .strip()
        .casefold()
    )
    matches = [i for i, c in enumerate(error.candidates) if answer and _matches(answer, c)]
    return matches[0] if len(matches) == 1 else None


def _matches(answer: str, candidate: Any) -> bool:
    """The answer is (part of) the candidate's name, or its exact code or id."""
    if not isinstance(candidate, dict):
        return answer == str(candidate).casefold()
    item = cast(dict[str, Any], candidate)
    name = str(item.get("name", "")).casefold()
    exact = {str(item.get(key, "")).casefold() for key in ("employee_code", "id")}
    return answer in name or answer in exact


def _describe(candidate: Any) -> str:
    if isinstance(candidate, dict):
        item = cast(dict[str, Any], candidate)
        details = ", ".join(
            str(item[k]) for k in ("employee_code", "job_title", "department") if item.get(k)
        )
        return (
            f"{item.get('name', item.get('id', '?'))} ({details})"
            if details
            else str(item.get("name"))
        )
    return str(candidate)


def route_after_step(state: HrState) -> str:
    return "execute_step" if next_step(state) else "verify"


async def verify(state: HrState, runtime: Runtime[HrContext]) -> dict[str, Any]:
    """Read-only plans: every step ran and found something. (Writes get real checks in M7.)"""
    problems: list[str] = []
    for step in (state.get("plan") or {}).get("steps", []):
        result = state.get("results", {}).get(step["id"])
        if result is None:
            problems.append(f"{step['id']} ({step['tool']}) never ran.")
        elif not result.get("ok"):
            problems.append(
                f"{step['id']} ({step['tool']}) {result.get('status')}: {result.get('error')}"
            )
        elif _empty(result.get("data")):
            problems.append(f"{step['id']} ({step['tool']}) found nothing.")
    return {"verification": {"ok": not problems, "problems": problems}}


def _empty(data: Any) -> bool:
    if isinstance(data, dict):
        item = cast(dict[str, Any], data)
        return item.get("total") == 0 or (len(item) == 1 and _empty(next(iter(item.values()))))
    return data in (None, [], "")


async def respond(state: HrState, runtime: Runtime[HrContext]) -> dict[str, Any]:
    ctx = runtime.context
    prompt = load_prompt("respond")
    system = prompt.render(
        today=ctx.tools.today.isoformat(), user_name=ctx.tools.user.name, role=ctx.tools.user.role
    )
    parts = [f"Request: {request_with_clarifications(state)}"]
    proposed = state.get("plan")
    if state.get("plan_problems"):
        parts.append(
            "No plan could be made that passes the checks, so nothing was looked up. Problems: "
            + "; ".join(state.get("plan_problems", []))
        )
    elif proposed:
        parts.append(f"Plan goal: {proposed['goal']}")
        for step in proposed["steps"]:
            result = state.get("results", {}).get(step["id"], {})
            content = result_content_text(result)
            parts.append(f"{step['id']} {step['tool']} ({step['reason']}): {content}")
    for passage in state.get("policy", []):
        parts.append(f"Policy passage [{passage['citation']}]: {passage['text']}")
    problems = state.get("verification", {}).get("problems", [])
    if problems:
        parts.append("Checks that didn't pass: " + "; ".join(problems))
    response = await ctx.llm.chat(
        [Message.system(system), Message.user("\n\n".join(parts))],
        temperature=0,
        max_tokens=1024,
        prompt=prompt.ref,
    )
    answer = (response.text or "").strip() or "I couldn't produce an answer."
    failed = bool(state.get("plan_problems"))
    return {
        "answer": answer,
        "status": "failed" if failed else "answered",
        "usage": response.usage.model_dump(),
    }


def result_content_text(result: dict[str, Any]) -> str:
    if not result:
        return "not run"
    if result.get("status") == "skipped":
        return str(result.get("error"))
    text = result_content(
        ToolResult(ok=bool(result.get("ok")), data=result.get("data"), error=result.get("error"))
    )
    return text[:RESULT_CHARS]


# ---- the graph ---------------------------------------------------------------------------


def build_hr_graph(
    checkpointer: BaseCheckpointSaver[Any] | None = None,
) -> CompiledStateGraph[HrState, HrContext, HrState, HrState]:
    graph = StateGraph(HrState, context_schema=HrContext)
    nodes: dict[str, Node] = {
        "understand": understand,
        "clarify": clarify,
        "decline": decline,
        "answer_simple": answer_simple,
        "retrieve_policy": retrieve_policy,
        "plan": plan,
        "validate_plan": validate_plan,
        "execute_step": execute_step,
        "verify": verify,
        "respond": respond,
    }
    for name, node in nodes.items():
        graph.add_node(name, traced(name, node))
    graph.add_edge(START, "understand")
    graph.add_conditional_edges(
        "understand",
        route_after_understand,
        ["clarify", "decline", "answer_simple", "retrieve_policy"],
    )
    graph.add_edge("clarify", "understand")
    graph.add_edge("decline", END)
    graph.add_edge("answer_simple", END)
    graph.add_edge("retrieve_policy", "plan")
    graph.add_edge("plan", "validate_plan")
    graph.add_conditional_edges(
        "validate_plan", route_after_validate, ["plan", "execute_step", "respond"]
    )
    graph.add_conditional_edges("execute_step", route_after_step, ["execute_step", "verify"])
    graph.add_edge("verify", "respond")
    graph.add_edge("respond", END)
    return graph.compile(checkpointer=checkpointer)
