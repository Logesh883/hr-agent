from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app import llm_routes
from app.log import configure_logging
from app.settings import Settings, get_settings
from llm.base import LLMClient

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


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    app = FastAPI(title="HR AI service", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.llm = None
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.web_origin],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    if settings.ai_env == "development":
        app.include_router(llm_routes.router)
    return app


app = create_app()
