"""`hr-ai` command line.

uv run hr-ai serve --reload            # the API on AI_HOST:AI_PORT
uv run hr-ai chat "What is LOP?"       # one message to the configured model
uv run hr-ai models                    # model ids the configured provider offers
"""

import argparse
import asyncio
import sys

from app.llm_routes import build_messages
from app.log import configure_logging
from app.settings import get_settings
from llm.base import LLMError
from llm.factory import LLMConfigError, create_llm_client
from llm.openai_compat import OpenAICompatibleClient
from llm.types import StreamChunk


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="hr-ai")
    commands = parser.add_subparsers(dest="command", required=True)

    serve = commands.add_parser("serve", help="run the FastAPI service")
    serve.add_argument("--reload", action="store_true", help="restart on code changes")

    chat = commands.add_parser("chat", help="send one message to the configured model")
    chat.add_argument("message")
    chat.add_argument("--system", help="system prompt instead of prompts/dev_chat.md")
    chat.add_argument("--temperature", type=float, default=0.7)
    chat.add_argument("--max-tokens", type=int, default=512)
    chat.add_argument("--model", help="override LLM_MODEL")
    chat.add_argument("--no-stream", action="store_true", help="wait for the whole reply")

    models = commands.add_parser("models", help="list the provider's model ids")
    models.add_argument("filter", nargs="?", default="", help="only ids containing this text")

    args = parser.parse_args(argv)
    if args.command == "serve":
        _serve(reload=args.reload)
    elif args.command == "models":
        sys.exit(asyncio.run(_models(args.filter)))
    else:
        sys.exit(asyncio.run(_chat(args)))


def _serve(*, reload: bool) -> None:
    import uvicorn

    settings = get_settings()
    uvicorn.run("app.main:app", host=settings.ai_host, port=settings.ai_port, reload=reload)


async def _chat(args: argparse.Namespace) -> int:
    settings = get_settings()
    if args.model:
        settings = settings.model_copy(update={"llm_model": args.model})
    configure_logging(settings.log_level)
    try:
        llm = create_llm_client(settings)
    except LLMConfigError as error:
        print(error, file=sys.stderr)
        return 2

    messages, prompt = build_messages(args.message, args.system)
    temperature: float = args.temperature
    max_tokens: int = args.max_tokens
    try:
        if args.no_stream:
            response = await llm.chat(
                messages, temperature=temperature, max_tokens=max_tokens, prompt=prompt
            )
            print(response.text or "")
            usage = response.usage
            print(
                f"[{usage.prompt_tokens} in / {usage.completion_tokens} out tokens · "
                f"total {response.latency_ms:.0f} ms · finish: {response.finish_reason}]",
                file=sys.stderr,
            )
        else:
            async for chunk in llm.stream(
                messages, temperature=temperature, max_tokens=max_tokens, prompt=prompt
            ):
                print(chunk.text, end="", flush=True)
                if chunk.done:
                    print(flush=True)
                    _print_speed(chunk)
    except LLMError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    finally:
        await llm.aclose()
    return 0


async def _models(text: str) -> int:
    try:
        # Listing models needs a key but no model yet.
        llm = create_llm_client(get_settings().model_copy(update={"llm_model": "-"}))
    except LLMConfigError as error:
        print(error, file=sys.stderr)
        return 2
    assert isinstance(llm, OpenAICompatibleClient)
    try:
        for model in await llm.list_models():
            if text in model:
                print(model)
    except LLMError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    finally:
        await llm.aclose()
    return 0


def _print_speed(last: StreamChunk) -> None:
    """Time to first token and generation speed: the two numbers users actually feel."""
    if not (last.usage and last.latency_ms and last.ttft_ms is not None):
        return
    generating_s = max((last.latency_ms - last.ttft_ms) / 1000, 1e-6)
    print(
        f"[{last.usage.prompt_tokens} in / {last.usage.completion_tokens} out tokens · "
        f"first token {last.ttft_ms:.0f} ms · total {last.latency_ms:.0f} ms · "
        f"{last.usage.completion_tokens / generating_s:.0f} tokens/s]",
        file=sys.stderr,
    )
