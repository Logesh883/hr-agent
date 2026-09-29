from functools import lru_cache
from pathlib import Path

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

    hr_api_url: str = "http://localhost:4000"
    ai_host: str = "127.0.0.1"
    ai_port: int = 8000
    web_origin: str = "http://localhost:3000"
    # Seconds to wait on the HR API before giving up.
    hr_api_timeout: float = 10.0


@lru_cache
def get_settings() -> Settings:
    return Settings()
