from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI

from app.llm_routes import get_llm
from app.main import create_app
from app.settings import Settings
from llm.base import LLMError
from llm.fake import FakeLLM


def client_for(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://ai.test")


@pytest.fixture
def fake() -> FakeLLM:
    return FakeLLM()


@pytest.fixture
async def client(fake: FakeLLM) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(Settings(ai_env="development"))
    app.dependency_overrides[get_llm] = lambda: fake
    async with client_for(app) as client:
        yield client


async def test_chat_uses_dev_chat_prompt(client: httpx.AsyncClient, fake: FakeLLM) -> None:
    fake.queue("LOP means loss of pay.")

    response = await client.post("/llm/chat", json={"message": "What is LOP?", "temperature": 0})

    assert response.status_code == 200
    assert response.json()["text"] == "LOP means loss of pay."
    system, user = fake.calls[0].messages
    assert system.role == "system" and "Today is " in (system.content or "")
    assert user.content == "What is LOP?"
    assert fake.calls[0].temperature == 0


async def test_chat_accepts_a_custom_system_prompt(
    client: httpx.AsyncClient, fake: FakeLLM
) -> None:
    fake.queue("ok")

    await client.post("/llm/chat", json={"message": "hi", "system": "Reply in Tamil."})

    assert fake.calls[0].messages[0].content == "Reply in Tamil."


async def test_chat_streams_plain_text(client: httpx.AsyncClient, fake: FakeLLM) -> None:
    fake.queue("streamed reply here")

    response = await client.post("/llm/chat", json={"message": "hi", "stream": True})

    assert response.headers["content-type"].startswith("text/plain")
    assert response.text == "streamed reply here"


async def test_provider_failure_is_a_502(client: httpx.AsyncClient, fake: FakeLLM) -> None:
    fake.queue(LLMError("HTTP 429: Rate limit reached", status_code=429))

    response = await client.post("/llm/chat", json={"message": "hi"})

    assert response.status_code == 502
    assert "Rate limit" in response.json()["detail"]


async def test_missing_llm_settings_is_a_503() -> None:
    app = create_app(Settings(ai_env="development", llm_api_key=None, llm_model=""))
    async with client_for(app) as client:
        response = await client.post("/llm/chat", json={"message": "hi"})

    assert response.status_code == 503
    assert "GROQ_API_KEY" in response.json()["detail"]


async def test_chat_route_is_absent_outside_development() -> None:
    async with client_for(create_app(Settings(ai_env="production"))) as client:
        response = await client.post("/llm/chat", json={"message": "hi"})

    assert response.status_code == 404
