"""The authenticated natural-language entry point for the HR agent."""

from datetime import date
from typing import Annotated, cast, get_args

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from agent.ask import answer_question, new_ask_trace
from agent.loop import AgentStep, StopReason
from app.hr_client import HrApiClient, HrApiError, HrApiUnavailableError, SessionUser
from app.llm_routes import get_llm
from app.settings import Settings
from intent.entity_resolution import resolve_entities_with_tools
from intent.parser import parse_request
from intent.prompt import Role
from intent.schema import Entities, EntityField, Intent
from llm.base import LLMClient, LLMError
from llm.types import Usage
from rag.chunking import Chunker
from rag.db import create_engine
from rag.embeddings import EmbeddingConfigError, EmbeddingError, create_embedder
from rag.ingest import ingest_policies
from rag.retrieval import PolicyRetriever
from rag.service import create_policy_retriever
from rag.store import PolicyStore
from tools.base import ToolContext
from tracing.langfuse import TraceExporter

router = APIRouter(prefix="/agent", tags=["agent"])


class ParseRequest(BaseModel):
    request: str = Field(min_length=1, max_length=4000)


class ParseResponse(BaseModel):
    intent: Intent
    entities: Entities
    resolved_employee_ids: dict[str, str]
    resolved_department_ids: dict[str, str]
    missing_fields: list[EntityField]
    confidence: float
    clarifying_question: str | None
    needs_clarification: bool
    resolution_answer: str | None = None
    waiting_for_user: bool = False
    candidates: list[dict[str, str]] = []


@router.post("/parse", response_model=ParseResponse)
async def parse_agent_request(
    body: ParseRequest,
    request: Request,
    llm: Annotated[LLMClient, Depends(get_llm)],
    authorization: Annotated[str | None, Header()] = None,
) -> ParseResponse:
    """Parse a request and resolve mentioned records as the authenticated HR API user."""
    token = bearer_token(authorization)
    settings: Settings = request.app.state.settings
    async with httpx.AsyncClient(
        base_url=settings.hr_api_url, timeout=settings.hr_api_timeout
    ) as http:
        hr = HrApiClient(http, token)
        user = await signed_in_user(hr)
        role = cast(Role, user.role)
        today = date.today()
        try:
            parsed = await parse_request(llm, body.request, today=today, role=role)
            resolution = None
            if (
                parsed.entities.people
                or parsed.entities.manager
                or parsed.entities.department
                or parsed.intent is Intent.APPROVE_LEAVE
            ):
                resolution = await resolve_entities_with_tools(
                    llm, hr, parsed, body.request, today=today
                )
        except LLMError as error:
            raise HTTPException(502, "The language model could not process this request") from error
        except HrApiError as error:
            raise _hr_http_error(error) from error
        except HrApiUnavailableError as error:
            raise HTTPException(503, "HR API is unavailable") from error

    return ParseResponse(
        intent=parsed.intent,
        entities=parsed.entities,
        resolved_employee_ids=resolution.resolved_employee_ids if resolution else {},
        resolved_department_ids=resolution.resolved_department_ids if resolution else {},
        missing_fields=parsed.missing_fields,
        confidence=parsed.confidence,
        clarifying_question=parsed.clarifying_question,
        needs_clarification=parsed.needs_clarification
        or bool(resolution and resolution.waiting_for_user),
        resolution_answer=resolution.answer if resolution else None,
        waiting_for_user=resolution.waiting_for_user if resolution else False,
        candidates=resolution.candidates if resolution else [],
    )


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)


class AskResponse(BaseModel):
    answer: str
    stop_reason: StopReason
    # Every LLM turn and tool call, in order: what the agent did to reach the answer.
    steps: list[AgentStep]
    usage: Usage
    trace_id: str


@router.post("/ask", response_model=AskResponse)
async def ask(
    body: AskRequest,
    request: Request,
    background: BackgroundTasks,
    llm: Annotated[LLMClient, Depends(get_llm)],
    authorization: Annotated[str | None, Header()] = None,
) -> AskResponse:
    """Answer a read-only HR question with tools, as the authenticated HR API user."""
    token = bearer_token(authorization)
    settings: Settings = request.app.state.settings
    exporter: TraceExporter = request.app.state.trace_exporter
    async with httpx.AsyncClient(
        base_url=settings.hr_api_url, timeout=settings.hr_api_timeout
    ) as http:
        hr = HrApiClient(http, token)
        ctx = ToolContext(
            hr=hr,
            user=await signed_in_user(hr),
            today=date.today(),
            policies=get_policy_retriever(request, llm),
        )
        trace = new_ask_trace(body.question, ctx)
        try:
            run = await answer_question(llm, ctx, body.question, trace=trace)
        except LLMError as error:
            # Export the failed run too: a trace is most useful when something went wrong.
            trace.finish({"error": str(error)})
            await exporter.export(trace)
            raise HTTPException(502, "The language model could not process this request") from error

    # After the response is sent, so tracing never adds latency.
    background.add_task(exporter.export, trace)
    return AskResponse(
        answer=run.answer,
        stop_reason=run.stop_reason,
        steps=run.steps,
        usage=run.usage,
        trace_id=run.trace_id,
    )


class IngestPoliciesRequest(BaseModel):
    chunker: Chunker = "heading"
    # Default: RAG_CHUNK_TOKENS, the size search uses.
    chunk_size: int | None = Field(default=None, ge=16, le=2048)


class IngestPoliciesResponse(BaseModel):
    chunker: str
    chunk_size: int
    embedding_model: str
    versions: int
    embedded: int
    unchanged: int
    removed: int
    chunks: int
    failed: list[str]


@router.post("/policies/ingest", response_model=IngestPoliciesResponse)
async def ingest_policy_documents(
    body: IngestPoliciesRequest,
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> IngestPoliciesResponse:
    """Re-index the HR policies for search (A4.2), e.g. after publishing a new version.

    Only users who may publish policies (`policy:manage`: HR, admins) can trigger it. The
    documents themselves are fetched as the least-privilege service login, not as the
    caller: indexing must not depend on who pressed the button.
    """
    settings: Settings = request.app.state.settings
    async with httpx.AsyncClient(
        base_url=settings.hr_api_url, timeout=settings.hr_api_timeout
    ) as http:
        user = await signed_in_user(HrApiClient(http, bearer_token(authorization)))
        if "policy:manage" not in user.permissions:
            raise HTTPException(403, "Only HR can re-index policies")
        if settings.ai_service_password is None:
            raise HTTPException(503, "AI_SERVICE_PASSWORD is not configured")
        try:
            embedder = create_embedder(settings)
        except EmbeddingConfigError as error:
            raise HTTPException(503, str(error)) from error
        store = PolicyStore(create_engine(settings.ai_db_url))
        try:
            login = await HrApiClient(http).login(
                settings.ai_service_email, settings.ai_service_password.get_secret_value()
            )
            report = await ingest_policies(
                HrApiClient(http, login.access_token),
                store,
                embedder,
                chunker=body.chunker,
                chunk_size=body.chunk_size or settings.rag_chunk_tokens,
            )
        except EmbeddingError as error:
            raise HTTPException(502, "The embeddings provider failed") from error
        except HrApiError as error:
            raise _hr_http_error(error) from error
        except HrApiUnavailableError as error:
            raise HTTPException(503, "HR API is unavailable") from error
        finally:
            await embedder.aclose()
            await store.aclose()
    return IngestPoliciesResponse.model_validate(report.__dict__)


def get_policy_retriever(request: Request, llm: LLMClient) -> PolicyRetriever | None:
    """The app's shared retriever, built on first use; None without embedding settings."""
    state = request.app.state
    if not getattr(state, "policies_checked", False):
        state.policies = create_policy_retriever(state.settings, llm=llm)
        state.policies_checked = True
    return state.policies


async def signed_in_user(hr: HrApiClient) -> SessionUser:
    """Who the token belongs to; only the four agent roles may use the agent."""
    try:
        user = await hr.me()
    except HrApiError as error:
        raise _hr_http_error(error) from error
    except HrApiUnavailableError as error:
        raise HTTPException(503, "HR API is unavailable") from error
    if user.role not in get_args(Role):
        raise HTTPException(403, "This account does not have an agent role")
    return user


def bearer_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(401, "Authorization bearer token is required")
    scheme, separator, token = authorization.partition(" ")
    if scheme.casefold() != "bearer" or not separator or not token.strip():
        raise HTTPException(401, "Authorization must use a bearer token")
    return token.strip()


def _hr_http_error(error: HrApiError) -> HTTPException:
    status = error.status_code if 400 <= error.status_code < 500 else 502
    return HTTPException(status, error.message)
