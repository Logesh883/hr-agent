import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app import agent_routes, llm_routes, run_routes
from app.log import configure_logging
from app.settings import Settings, get_settings
from llm.base import LLMClient
from rag.service import close_policy_retriever
from tracing.langfuse import TraceExporter, create_exporter

router = APIRouter()


class Health(BaseModel):
    status: str


@router.get("/health")
async def health() -> Health:
    return Health(status="ok")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
    yield
    llm: LLMClient | None = getattr(app.state, "llm", None)
    if llm:
        await llm.aclose()
    service = getattr(app.state, "run_service", None)
    if service is not None:
        await service.aclose()
        await app.state.run_service_stack.aclose()
    exporter: TraceExporter = app.state.trace_exporter
    await exporter.aclose()
    await close_policy_retriever(getattr(app.state, "policies", None))


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    app = FastAPI(title="HR AI service", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.llm = None
    app.state.trace_exporter = create_exporter(settings)
    app.state.run_service = None
    app.state.run_service_lock = asyncio.Lock()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.web_origin],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    app.include_router(agent_routes.router)
    app.include_router(run_routes.router)
    if settings.ai_env == "development":
        app.include_router(llm_routes.router)
    return app


app = create_app()
