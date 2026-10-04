"""Read-only question answering: the ask prompt, the read tools and the agent loop."""

from agent.loop import AgentRun, run_agent
from llm.base import LLMClient
from llm.types import Message, PromptRef
from prompts import load_prompt
from tools.base import ToolContext
from tools.hr_read import READ_TOOLS
from tools.policy import POLICY_TOOLS
from tools.registry import ToolRegistry
from tracing.trace import Trace

READ_REGISTRY = ToolRegistry(READ_TOOLS)
# With policy search configured (M4), the agent can also answer questions about the rules.
ASK_REGISTRY = ToolRegistry([*READ_TOOLS, *POLICY_TOOLS])


def build_ask_messages(question: str, ctx: ToolContext) -> tuple[list[Message], PromptRef]:
    """The system prompt knows who is asking; the question stays the user message, as data."""
    prompt = load_prompt("ask")
    system = prompt.render(
        today=ctx.today.isoformat(),
        weekday=ctx.today.strftime("%A"),
        user_name=ctx.user.name,
        role=ctx.user.role,
        employee_id=ctx.user.employee_id or "none (this account has no employee record)",
    )
    return [Message.system(system), Message.user(question)], prompt.ref


def new_ask_trace(question: str, ctx: ToolContext) -> Trace:
    return Trace(
        name="agent.ask",
        user_id=ctx.user.id,
        input={"question": question},
        metadata={"role": ctx.user.role},
        tags=["ask", "read-only"],
        known_names={ctx.user.name},
    )


async def answer_question(
    llm: LLMClient, ctx: ToolContext, question: str, *, trace: Trace | None = None
) -> AgentRun:
    messages, prompt = build_ask_messages(question, ctx)
    trace = trace or new_ask_trace(question, ctx)
    trace.metadata["prompt"] = str(prompt)
    registry = ASK_REGISTRY if ctx.policies else READ_REGISTRY
    return await run_agent(llm, registry, ctx, messages, trace=trace, prompt=prompt)
