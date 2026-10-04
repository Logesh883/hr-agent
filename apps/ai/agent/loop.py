"""The agent loop, by hand: no framework, so every decision point is visible.

    messages ──► LLM (with tool specs) ──► tool calls? ── no ──► answer
                     ▲                         │ yes
                     │                         ▼
                     └──── tool results ◄── code validates + executes each call

The model only proposes calls. Code decides everything else: whether a tool exists, whether
its arguments are valid, what the user may see (the HR API, with the user's token), and when
to stop (an answer, the step limit, or the token budget).
"""

import asyncio
import json
from collections.abc import Sequence
from typing import Any, Literal

from pydantic import BaseModel

from llm.base import LLMClient
from llm.types import Message, PromptRef, ToolCall, Usage
from tools.base import ToolContext, ToolResult
from tools.registry import ToolRegistry, result_content
from tracing.trace import Trace

MAX_STEPS = 8
# Prompt + completion tokens over the whole run. Every step resends the conversation, so
# a long run costs far more than its last message suggests.
TOKEN_BUDGET = 60_000

StopReason = Literal["answered", "max_steps", "token_budget"]

EMPTY_ANSWER = "I couldn't produce an answer."
BUDGET_ANSWER = (
    "I stopped before finishing because this question needed too much work. "
    "Try asking about one person or a shorter period."
)


def max_steps_answer(max_steps: int) -> str:
    return (
        f"I couldn't finish within {max_steps} steps. Try a narrower question, "
        "for example about one person or one month."
    )


class ToolCallStep(BaseModel):
    id: str
    tool: str
    # Parsed arguments when they were valid JSON, else the raw text the model produced.
    arguments: Any
    ok: bool
    error: str | None = None
    data: Any = None
    latency_ms: float


class AgentStep(BaseModel):
    """One LLM turn and the tool calls it asked for."""

    step: int
    text: str | None
    tool_calls: list[ToolCallStep] = []
    usage: Usage
    latency_ms: float


class AgentRun(BaseModel):
    answer: str
    stop_reason: StopReason
    steps: list[AgentStep]
    usage: Usage
    trace_id: str


async def run_agent(
    llm: LLMClient,
    registry: ToolRegistry,
    ctx: ToolContext,
    messages: Sequence[Message],
    *,
    trace: Trace,
    prompt: PromptRef | None = None,
    max_steps: int = MAX_STEPS,
    token_budget: int = TOKEN_BUDGET,
    max_tokens: int = 1024,
) -> AgentRun:
    conversation = list(messages)
    tools = registry.specs()
    steps: list[AgentStep] = []
    used = Usage()

    for number in range(1, max_steps + 1):
        with trace.observe(
            f"llm step {number}",
            kind="generation",
            input=[m.to_wire() for m in conversation],
            model_parameters={"temperature": 0, "max_tokens": max_tokens},
            metadata={"prompt": str(prompt) if prompt else None},
        ) as generation:
            # Temperature 0: the same question should take the same path through the tools.
            response = await llm.chat(
                conversation, tools=tools, temperature=0, max_tokens=max_tokens, prompt=prompt
            )
            generation.model = response.model
            generation.usage = response.usage
            generation.output = {
                "text": response.text,
                "tool_calls": [c.model_dump() for c in response.tool_calls],
                "finish_reason": response.finish_reason,
            }
        used.prompt_tokens += response.usage.prompt_tokens
        used.completion_tokens += response.usage.completion_tokens
        step = AgentStep(
            step=number,
            text=response.text,
            usage=response.usage,
            latency_ms=response.latency_ms,
        )
        steps.append(step)

        if not response.tool_calls:
            answer = (response.text or "").strip() or EMPTY_ANSWER
            return _finish(trace, answer, "answered", steps, used)

        conversation.append(
            Message(role="assistant", content=response.text, tool_calls=response.tool_calls)
        )
        # Calls from one turn don't depend on each other (the model hasn't seen any of their
        # results yet), so they run in parallel. Results go back in the order they were asked.
        results = await asyncio.gather(
            *(run_tool(registry, ctx, call, trace) for call in response.tool_calls)
        )
        for call, (result, latency_ms) in zip(response.tool_calls, results, strict=True):
            conversation.append(Message.tool(call.id, result_content(result)))
            step.tool_calls.append(
                ToolCallStep(
                    id=call.id,
                    tool=call.name,
                    arguments=parsed_arguments(call.arguments),
                    ok=result.ok,
                    error=result.error,
                    data=result.data,
                    latency_ms=latency_ms,
                )
            )

        if used.total_tokens >= token_budget:
            return _finish(trace, BUDGET_ANSWER, "token_budget", steps, used)

    return _finish(trace, max_steps_answer(max_steps), "max_steps", steps, used)


async def run_tool(
    registry: ToolRegistry, ctx: ToolContext, call: ToolCall, trace: Trace
) -> tuple[ToolResult, float]:
    with trace.observe(
        f"tool {call.name}", input=parsed_arguments(call.arguments), metadata={"call_id": call.id}
    ) as span:
        result = await registry.execute(call, ctx)
        span.output = result.model_dump(exclude_none=True)
        if not result.ok:
            span.level = "WARNING"
            span.status_message = result.error
    return result, span.latency_ms


def _finish(
    trace: Trace, answer: str, reason: StopReason, steps: list[AgentStep], used: Usage
) -> AgentRun:
    trace.finish({"answer": answer, "stop_reason": reason})
    trace.metadata["stop_reason"] = reason
    trace.metadata["steps"] = len(steps)
    return AgentRun(answer=answer, stop_reason=reason, steps=steps, usage=used, trace_id=trace.id)


def parsed_arguments(arguments: str) -> Any:
    try:
        return json.loads(arguments or "{}")
    except json.JSONDecodeError:
        return arguments
