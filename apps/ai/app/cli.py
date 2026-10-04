"""`hr-ai` command line.

uv run hr-ai serve --reload            # the API on AI_HOST:AI_PORT
uv run hr-ai chat "What is LOP?"       # one message to the configured model
uv run hr-ai models                    # model ids the configured provider offers
uv run hr-ai parse "Approve Sneha's leave" --role MANAGER   # intent + entities
uv run hr-ai parse "Approve Sneha's leave" --login manager@hr.local   # + tool-based lookups
uv run hr-ai ask "How many annual leave days does Sneha have left?" --login hr@hr.local
uv run hr-ai ingest                    # policies → chunks + embeddings (ai schema)
uv run hr-ai search "Can unused leave carry over?" --mode vector   # retrieval only, no LLM
"""

import argparse
import asyncio
import getpass
import os
import sys
from datetime import date
from typing import cast, get_args

import httpx
from pydantic import ValidationError

from agent.ask import answer_question, new_ask_trace
from agent.loop import AgentRun
from app.hr_client import HrApiClient, HrApiError, HrApiUnavailableError
from app.llm_routes import build_messages
from app.log import configure_logging
from app.settings import get_settings
from intent.entity_resolution import resolve_entities_with_tools
from intent.parser import parse_request
from intent.prompt import Role
from intent.schema import Intent
from llm.base import LLMError
from llm.factory import LLMConfigError, create_llm_client
from llm.openai_compat import OpenAICompatibleClient
from llm.types import StreamChunk
from rag.chunking import Chunker
from rag.db import create_engine
from rag.embeddings import EmbeddingConfigError, EmbeddingError, create_embedder
from rag.ingest import ingest_policies
from rag.retrieval import MODES, Mode
from rag.service import close_policy_retriever, create_policy_retriever
from rag.store import PolicyStore
from tools.base import ToolContext
from tracing.langfuse import create_exporter


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

    parse = commands.add_parser("parse", help="classify one HR request: intent + entities")
    parse.add_argument("request")
    parse.add_argument("--role", choices=get_args(Role), default="HR_OPS")
    parse.add_argument("--today", type=date.fromisoformat, help="YYYY-MM-DD; default: today")
    parse.add_argument("--model", help="override LLM_MODEL")
    parse.add_argument(
        "--login",
        metavar="EMAIL",
        help="sign in to the HR API as this user (password from HR_PASSWORD or a prompt); "
        "uses their permissions for tool-based employee, department and leave lookups",
    )

    ask = commands.add_parser("ask", help="answer a read-only HR question with tools")
    ask.add_argument("question")
    ask.add_argument(
        "--login",
        metavar="EMAIL",
        required=True,
        help="ask as this HR API user (password from HR_PASSWORD or a prompt)",
    )
    ask.add_argument("--today", type=date.fromisoformat, help="YYYY-MM-DD; default: today")
    ask.add_argument("--model", help="override LLM_MODEL")
    ask.add_argument("--quiet", action="store_true", help="print the answer only, not the steps")

    ingest = commands.add_parser(
        "ingest", help="index HR policies for search (as AI_SERVICE_EMAIL; idempotent)"
    )
    ingest.add_argument("--chunker", choices=["heading", "fixed"], default="heading")
    ingest.add_argument("--size", type=int, help="target chunk tokens; default RAG_CHUNK_TOKENS")

    search = commands.add_parser("search", help="search indexed policies (retrieval only)")
    search.add_argument("query")
    search.add_argument("--mode", choices=MODES, default="hybrid")
    search.add_argument("--as-of", type=date.fromisoformat, help="rules in force on this date")
    search.add_argument("--size", type=int, help="chunk size to search; default RAG_CHUNK_TOKENS")
    search.add_argument("-k", type=int, default=5)

    args = parser.parse_args(argv)
    if args.command == "ingest":
        sys.exit(asyncio.run(_ingest(args.chunker, args.size)))
    elif args.command == "search":
        sys.exit(asyncio.run(_search(args)))
    elif args.command == "serve":
        _serve(reload=args.reload)
    elif args.command == "parse":
        sys.exit(asyncio.run(_parse(args)))
    elif args.command == "ask":
        sys.exit(asyncio.run(_ask(args)))
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


async def _parse(args: argparse.Namespace) -> int:
    settings = get_settings()
    if args.model:
        settings = settings.model_copy(update={"llm_model": args.model})
    configure_logging(settings.log_level)
    try:
        llm = create_llm_client(settings)
    except LLMConfigError as error:
        print(error, file=sys.stderr)
        return 2
    async with httpx.AsyncClient(
        base_url=settings.hr_api_url, timeout=settings.hr_api_timeout
    ) as http:
        try:
            hr: HrApiClient | None = None
            role: Role = args.role
            if args.login:
                # Act as that user: their role in the prompt, their permissions on lookups.
                password = os.environ.get("HR_PASSWORD") or getpass.getpass(
                    f"Password for {args.login}: "
                )
                login = await HrApiClient(http).login(args.login, password)
                hr = HrApiClient(http, login.access_token)
                role = cast(Role, login.user.role)
                print(f"signed in as {login.user.name} ({role})", file=sys.stderr)

            today = args.today or date.today()
            parsed = await parse_request(llm, args.request, today=today, role=role)
            print(parsed.model_dump_json(indent=2))
            print(f"needs_clarification: {parsed.needs_clarification}", file=sys.stderr)

            if hr and (
                parsed.entities.people
                or parsed.entities.manager
                or parsed.entities.department
                or parsed.intent is Intent.APPROVE_LEAVE
            ):
                result = await resolve_entities_with_tools(
                    llm, hr, parsed, args.request, today=today
                )
                if (
                    result.waiting_for_user
                    and result.candidates
                    and ("full_name" in result.candidates[0] or "name" in result.candidates[0])
                    and sys.stdin.isatty()
                ):
                    print(f"\n{result.answer}")
                    try:
                        selection = await asyncio.to_thread(
                            input, "Select a candidate by number (or press Enter to stop): "
                        )
                    except EOFError:
                        selection = ""
                    if selection.isdigit() and 1 <= int(selection) <= len(result.candidates):
                        selected = result.candidates[int(selection) - 1]
                        selected_employee = "full_name" in selected
                        result = await resolve_entities_with_tools(
                            llm,
                            hr,
                            parsed,
                            args.request,
                            today=today,
                            human_selected_candidate=selected if selected_employee else None,
                            human_selected_department=selected if not selected_employee else None,
                            human_selected_query=result.candidate_query,
                        )
                    else:
                        result.answer = "No candidate was selected. No dependent lookup was run."
                print(f"\n[entity resolution]\n{result.answer}")
        except (LLMError, ValidationError, HrApiError, HrApiUnavailableError) as error:
            print(f"error: {error}", file=sys.stderr)
            return 1
        finally:
            await llm.aclose()
    return 0


async def _ask(args: argparse.Namespace) -> int:
    settings = get_settings()
    if args.model:
        settings = settings.model_copy(update={"llm_model": args.model})
    configure_logging(settings.log_level)
    try:
        llm = create_llm_client(settings)
    except LLMConfigError as error:
        print(error, file=sys.stderr)
        return 2
    exporter = create_exporter(settings)
    policies = create_policy_retriever(settings, llm=llm)
    if policies is None:
        print("(policy search off: no embeddings configured)", file=sys.stderr)
    async with httpx.AsyncClient(
        base_url=settings.hr_api_url, timeout=settings.hr_api_timeout
    ) as http:
        try:
            password = os.environ.get("HR_PASSWORD") or getpass.getpass(
                f"Password for {args.login}: "
            )
            login = await HrApiClient(http).login(args.login, password)
            print(f"signed in as {login.user.name} ({login.user.role})", file=sys.stderr)
            ctx = ToolContext(
                hr=HrApiClient(http, login.access_token),
                user=login.user,
                today=args.today or date.today(),
                policies=policies,
            )
            trace = new_ask_trace(args.question, ctx)
            run = await answer_question(llm, ctx, args.question, trace=trace)
            if not args.quiet:
                _print_steps(run)
            print(run.answer)
            await exporter.export(trace)
        except (LLMError, HrApiError, HrApiUnavailableError) as error:
            print(f"error: {error}", file=sys.stderr)
            return 1
        finally:
            await llm.aclose()
            await exporter.aclose()
            await close_policy_retriever(policies)
    return 0


async def _ingest(chunker: Chunker, size: int | None) -> int:
    settings = get_settings()
    configure_logging(settings.log_level)
    if settings.ai_service_password is None:
        print("Set AI_SERVICE_PASSWORD (the ingestion login's password) in .env", file=sys.stderr)
        return 2
    try:
        embedder = create_embedder(settings)
    except EmbeddingConfigError as error:
        print(error, file=sys.stderr)
        return 2
    store = PolicyStore(create_engine(settings.ai_db_url))
    async with httpx.AsyncClient(
        base_url=settings.hr_api_url, timeout=settings.hr_api_timeout
    ) as http:
        try:
            login = await HrApiClient(http).login(
                settings.ai_service_email, settings.ai_service_password.get_secret_value()
            )
            report = await ingest_policies(
                HrApiClient(http, login.access_token),
                store,
                embedder,
                chunker=chunker,
                chunk_size=size or settings.rag_chunk_tokens,
            )
        except (EmbeddingError, HrApiError, HrApiUnavailableError) as error:
            print(f"error: {error}", file=sys.stderr)
            return 1
        finally:
            await embedder.aclose()
            await store.aclose()
    print(
        f"{report.versions} policy versions ({report.chunker}, {report.chunk_size} tokens, "
        f"{report.embedding_model}): {report.embedded} embedded into {report.chunks} chunks, "
        f"{report.unchanged} unchanged, {report.removed} removed"
    )
    for failure in report.failed:
        print(f"  not indexed: {failure}", file=sys.stderr)
    return 1 if report.failed else 0


async def _search(args: argparse.Namespace) -> int:
    settings = get_settings()
    if args.size:
        settings = settings.model_copy(update={"rag_chunk_tokens": args.size})
    configure_logging(settings.log_level)
    mode = cast(Mode, args.mode)
    llm = None
    if mode == "rerank":
        try:
            llm = create_llm_client(settings)
        except LLMConfigError as error:
            print(error, file=sys.stderr)
            return 2
    retriever = create_policy_retriever(settings, llm=llm)
    if retriever is None:
        print("Policy search needs embeddings: set GEMINI_API_KEY (see .env.example)")
        return 2
    try:
        scope = retriever.scope(args.as_of or date.today(), include_upcoming=args.as_of is None)
        hits = await retriever.search(args.query, scope, k=args.k, mode=mode)
    except EmbeddingError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    finally:
        await close_policy_retriever(retriever)
        if llm:
            await llm.aclose()
    if not hits:
        print("no matches (has `hr-ai ingest` run for this chunk size?)")
    for rank, hit in enumerate(hits, start=1):
        flag = " (upcoming)" if hit.upcoming else ""
        print(f"{rank}. [{hit.score:.4f}] {hit.citation}{flag}")
        print("   " + hit.content.replace("\n", "\n   "))
    return 0


def _print_steps(run: AgentRun) -> None:
    """The run as a readable trace on stderr: each LLM turn, then the tools it called."""
    for step in run.steps:
        usage = step.usage
        print(
            f"[step {step.step}] {usage.prompt_tokens} in / {usage.completion_tokens} out "
            f"tokens · {step.latency_ms:.0f} ms",
            file=sys.stderr,
        )
        for call in step.tool_calls:
            outcome = "ok" if call.ok else f"error: {call.error}"
            print(f"  → {call.tool}({call.arguments}) {outcome}", file=sys.stderr)
    print(
        f"[{run.stop_reason} · {run.usage.total_tokens} tokens · trace {run.trace_id}]\n",
        file=sys.stderr,
    )


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
