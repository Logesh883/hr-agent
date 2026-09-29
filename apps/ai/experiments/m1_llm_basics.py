"""M1 experiment: see tokens, sampling and latency on the configured hosted model.

    uv run python experiments/m1_llm_basics.py [--runs 5]

Makes about 2 * runs + 4 calls, so it stays inside free-tier rate limits.
"""

import argparse
import asyncio
import sys
from datetime import date

from app.log import configure_logging
from app.settings import get_settings
from llm.base import LLMClient, LLMError
from llm.factory import LLMConfigError, create_llm_client
from llm.types import Message, StreamChunk
from prompts import load_prompt

QUESTION = "In one sentence, what is 'loss of pay' in Indian payroll?"


def heading(title: str) -> None:
    print(f"\n=== {title} ===")


async def token_cost(llm: LLMClient) -> None:
    heading("1. What the system prompt costs")
    system = load_prompt("dev_chat").render(today=date.today().isoformat())
    bare = await llm.chat([Message.user(QUESTION)], max_tokens=1)
    full = await llm.chat([Message.system(system), Message.user(QUESTION)], max_tokens=1)
    extra = full.usage.prompt_tokens - bare.usage.prompt_tokens
    words = len(system.split())
    print(f"question alone: {bare.usage.prompt_tokens} prompt tokens")
    print(f"with dev_chat:  {full.usage.prompt_tokens} prompt tokens")
    print(f"system prompt ≈ {extra} tokens for {words} words ({extra / words:.2f} tokens/word)")
    print("Every agent call re-sends the system prompt and history, so this is paid per call.")


async def sampling(llm: LLMClient, runs: int) -> None:
    heading(f"2. Same question {runs} times at temperature 0 and 1")
    for temperature in (0.0, 1.0):
        answers = [
            (await llm.chat([Message.user(QUESTION)], temperature=temperature, max_tokens=80)).text
            or ""
            for _ in range(runs)
        ]
        distinct = len(set(answers))
        print(f"\ntemperature {temperature}: {distinct} distinct answer(s) out of {runs}")
        for answer in dict.fromkeys(answers):
            print(f"  - {answer.strip()[:140]}")


async def truncation(llm: LLMClient) -> None:
    heading("3. max_tokens cuts the reply off")
    response = await llm.chat([Message.user(QUESTION)], max_tokens=8)
    print(f"text: {response.text!r}")
    print(f'finish_reason: {response.finish_reason}  ("length" = hit max_tokens, not done)')
    if not response.text and response.usage.completion_tokens:
        print(
            f"No visible text but {response.usage.completion_tokens} tokens generated: a reasoning "
            "model spends max_tokens on hidden thinking first, so give it more room."
        )


async def speed(llm: LLMClient) -> None:
    heading("4. Streaming: time to first token and tokens/s")
    last = StreamChunk(done=True)
    async for chunk in llm.stream(
        [Message.user("List five common HR documents, one per line.")], max_tokens=150
    ):
        last = chunk
    if last.usage and last.latency_ms and last.ttft_ms is not None:
        generating_s = max((last.latency_ms - last.ttft_ms) / 1000, 1e-6)
        print(f"first token after {last.ttft_ms:.0f} ms")
        print(f"total {last.latency_ms:.0f} ms for {last.usage.completion_tokens} tokens")
        print(f"≈ {last.usage.completion_tokens / generating_s:.0f} tokens/s while generating")
    else:
        print("The provider sent no usage in the stream, so tokens/s can't be measured.")


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=5)
    args = parser.parse_args()

    settings = get_settings()
    configure_logging(settings.log_level)
    try:
        llm = create_llm_client(settings)
    except LLMConfigError as error:
        print(error, file=sys.stderr)
        return 2
    print(f"provider={llm.provider} model={llm.model}")
    try:
        await token_cost(llm)
        await sampling(llm, args.runs)
        await truncation(llm)
        await speed(llm)
    except LLMError as error:
        print(f"\nerror: {error}", file=sys.stderr)
        if error.status_code == 400:
            print(
                "A 400 usually means LLM_MODEL isn't a chat model (e.g. a safety classifier "
                "or speech model). List chat-capable ids with: uv run hr-ai models",
                file=sys.stderr,
            )
        return 1
    finally:
        await llm.aclose()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
