from collections.abc import AsyncIterator

import httpx
import pytest

from app.main import create_app
from app.settings import Settings


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(Settings(web_origin="http://web.test"))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://ai.test") as client:
        yield client


async def test_health(client: httpx.AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_cors_allows_web_origin(client: httpx.AsyncClient) -> None:
    response = await client.get("/health", headers={"Origin": "http://web.test"})

    assert response.headers["access-control-allow-origin"] == "http://web.test"


async def test_cors_rejects_other_origins(client: httpx.AsyncClient) -> None:
    response = await client.get("/health", headers={"Origin": "http://evil.test"})

    assert "access-control-allow-origin" not in response.headers
