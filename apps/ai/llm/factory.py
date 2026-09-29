from pydantic import SecretStr

from app.settings import Settings
from llm.base import LLMClient
from llm.openai_compat import OpenAICompatibleClient

# OpenAI-compatible endpoints of the free-tier providers.
PROVIDER_BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
}


class LLMConfigError(Exception):
    """The LLM_* settings don't describe a usable provider."""


def create_llm_client(settings: Settings) -> LLMClient:
    """Builds the client named by LLM_PROVIDER. Nothing else picks a provider."""
    base_url = settings.llm_base_url or PROVIDER_BASE_URLS.get(settings.llm_provider, "")
    api_key = _api_key(settings)
    missing = [
        name
        for name, value in (
            ("LLM_BASE_URL", base_url),
            (_key_setting(settings), api_key),
            ("LLM_MODEL", settings.llm_model),
        )
        if not value
    ]
    if missing:
        raise LLMConfigError(
            f"Set {', '.join(missing)} in the root .env for LLM_PROVIDER={settings.llm_provider} "
            "(see .env.example)."
        )
    assert api_key is not None
    return OpenAICompatibleClient(
        provider=settings.llm_provider,
        base_url=base_url,
        model=settings.llm_model,
        api_key=api_key.get_secret_value(),
        timeout=settings.llm_timeout,
        max_retries=settings.llm_max_retries,
    )


def _api_key(settings: Settings) -> SecretStr | None:
    """The provider's own key (e.g. GROQ_API_KEY) if set, else LLM_API_KEY."""
    provider_keys = {
        "groq": settings.groq_api_key,
        "openrouter": settings.openrouter_api_key,
        "gemini": settings.gemini_api_key,
    }
    return provider_keys.get(settings.llm_provider) or settings.llm_api_key


def _key_setting(settings: Settings) -> str:
    if settings.llm_provider == "custom":
        return "LLM_API_KEY"
    return f"{settings.llm_provider.upper()}_API_KEY (or LLM_API_KEY)"
