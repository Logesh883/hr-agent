from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import SecretStr
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
    langfuse_host: str = "https://cloud.langfuse.com"
    langfuse_public_key: str = ""
    langfuse_secret_key: SecretStr | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
