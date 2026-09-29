import pytest

from app.settings import Settings


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests never read the developer's .env or exported LLM keys."""
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    for name in (
        "LLM_PROVIDER",
        "LLM_BASE_URL",
        "LLM_API_KEY",
        "LLM_MODEL",
        "GROQ_API_KEY",
        "OPENROUTER_API_KEY",
        "GEMINI_API_KEY",
        "AI_ENV",
    ):
        monkeypatch.delenv(name, raising=False)
