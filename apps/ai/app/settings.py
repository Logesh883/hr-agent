from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


def _find_workspace_root(start: Path) -> Path | None:
    """Walks up to the monorepo root, the folder holding pnpm-workspace.yaml."""
    for directory in (start, *start.parents):
        if (directory / "pnpm-workspace.yaml").exists():
            return directory
    return None


# Monorepo root; falls back to the working directory outside the repo.
WORKSPACE_ROOT = _find_workspace_root(Path(__file__).resolve().parent) or Path.cwd()


class Settings(BaseSettings):
    """AI service configuration. Env vars live in the monorepo root .env; real env vars win."""

    model_config = SettingsConfigDict(
        env_file=WORKSPACE_ROOT / ".env",
        env_file_encoding="utf-8",
        # The root .env is shared with the web app and API, so ignore their variables.
        extra="ignore",
    )

    # "development" enables dev-only routes such as POST /llm/chat.
    ai_env: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"

    hr_api_url: str = "http://localhost:4000"
    ai_host: str = "127.0.0.1"
    ai_port: int = 8000
    web_origin: str = "http://localhost:3000"
    # Seconds to wait on the HR API before giving up.
    hr_api_timeout: float = 10.0
    # Development only (A7.5 demo): HR API failures to inject into agent runs, e.g.
    # "POST /tools/create_leave_request=500,drop". See app/faults.py. Ignored in production.
    hr_faults: str = ""

    # A8.4 budgets. Per start or resume of an agent run: tokens and seconds (checked between
    # steps; a hard stop at twice the seconds). Per user: requests a minute and runs at once.
    agent_run_max_tokens: int = 60_000
    agent_run_max_seconds: float = 120.0
    agent_requests_per_minute: int = 10
    agent_concurrent_runs: int = 2

    # Which hosted model answers. Every provider speaks the OpenAI chat completions API;
    # "groq", "openrouter" and "gemini" fill in LLM_BASE_URL, "custom" needs it set.
    llm_provider: Literal["groq", "openrouter", "gemini", "custom"] = "groq"
    llm_base_url: str = ""
    # Keep one key per provider so switching is just LLM_PROVIDER + LLM_MODEL. LLM_API_KEY is
    # the fallback (and the only option for "custom").
    groq_api_key: SecretStr | None = None
    openrouter_api_key: SecretStr | None = None
    gemini_api_key: SecretStr | None = None
    llm_api_key: SecretStr | None = None
    # The provider's model id. Free model lists change, so there is no default.
    llm_model: str = ""
    llm_timeout: float = 60.0
    llm_max_retries: int = 3

    # Langfuse Cloud tracing (https://cloud.langfuse.com → project → API keys). Leave the keys
    # empty to keep traces local; set both to export one masked trace per agent request.
    # LANGFUSE_BASE_URL is the name Langfuse's docs use; LANGFUSE_HOST is the older one.
    langfuse_base_url: str = Field(
        default="https://cloud.langfuse.com",
        validation_alias=AliasChoices("langfuse_base_url", "langfuse_host"),
    )
    langfuse_public_key: str = ""
    langfuse_secret_key: SecretStr | None = None

    # Postgres for the AI service's own `ai` schema (policy chunks and their vectors). Empty
    # means DATABASE_URL, the HR database: the AI service never touches its HR tables.
    database_url: str = "postgresql://hr:hr@localhost:5433/hr"
    ai_database_url: str = ""

    # Embeddings for policy RAG (M4), from a hosted API. "gemini" uses Gemini's native
    # embedContent API (task types: query vs document); "openai" is any OpenAI-compatible
    # /embeddings endpoint (EMBEDDING_BASE_URL + EMBEDDING_API_KEY).
    embedding_provider: Literal["gemini", "openai"] = "gemini"
    embedding_model: str = "gemini-embedding-001"
    # Must match the `vector(n)` column; changing it means a new migration and re-ingesting.
    embedding_dimensions: int = 768
    embedding_base_url: str = ""
    # Falls back to GEMINI_API_KEY for the gemini provider.
    embedding_api_key: SecretStr | None = None

    # Least-privilege HR API login used to fetch policies for ingestion (EMPLOYEE role:
    # `policy:read` and nothing that matters). Seeded as ai-ingest@hr.local.
    ai_service_email: str = "ai-ingest@hr.local"
    ai_service_password: SecretStr | None = None

    # Target chunk size in (approximate) tokens. Retrieval only searches chunks made with
    # the current size, so changing it means re-running `hr-ai ingest`.
    rag_chunk_tokens: int = 256
    # Rerank hybrid results with the LLM before answering (A4.3); costs one model call.
    rag_rerank: bool = False

    @property
    def ai_db_url(self) -> str:
        """SQLAlchemy URL for asyncpg; Prisma-only query parameters (`?schema=`) dropped."""
        url = (self.ai_database_url or self.database_url).split("?", 1)[0]
        for prefix in ("postgresql://", "postgres://"):
            if url.startswith(prefix):
                return "postgresql+asyncpg://" + url.removeprefix(prefix)
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()
