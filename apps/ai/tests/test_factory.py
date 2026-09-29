import pytest
from pydantic import SecretStr

from app.settings import Settings
from llm.factory import LLMConfigError, create_llm_client


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {"llm_api_key": SecretStr("k"), "llm_model": "some-model"}
    return Settings.model_validate(values | overrides)


@pytest.mark.parametrize(
    ("provider", "host"),
    [("groq", "api.groq.com"), ("openrouter", "openrouter.ai"), ("gemini", "googleapis.com")],
)
async def test_named_providers_fill_in_the_base_url(provider: str, host: str) -> None:
    llm = create_llm_client(settings(llm_provider=provider))

    assert llm.provider == provider
    assert llm.model == "some-model"
    assert host in str(llm._http.base_url)  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType, reportUnknownArgumentType]
    await llm.aclose()


def test_custom_provider_needs_a_base_url() -> None:
    with pytest.raises(LLMConfigError, match="LLM_BASE_URL"):
        create_llm_client(settings(llm_provider="custom"))


def test_missing_key_and_model_are_named() -> None:
    with pytest.raises(LLMConfigError, match=r"GROQ_API_KEY \(or LLM_API_KEY\), LLM_MODEL"):
        create_llm_client(settings(llm_api_key=None, llm_model=""))


def test_provider_key_wins_over_llm_api_key() -> None:
    llm = create_llm_client(
        settings(llm_provider="openrouter", openrouter_api_key=SecretStr("or-key"))
    )

    assert llm._headers == {"Authorization": "Bearer or-key"}  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType]


def test_falls_back_to_llm_api_key() -> None:
    llm = create_llm_client(settings(llm_provider="groq"))

    assert llm._headers == {"Authorization": "Bearer k"}  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType]
