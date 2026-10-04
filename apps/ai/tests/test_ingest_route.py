"""POST /agent/policies/ingest: who may trigger it, and that it ingests as the service login."""

import json
from collections.abc import AsyncIterator, Iterator
from typing import Any, cast

import httpx
import pytest
import respx
from fastapi import FastAPI
from respx.models import Call

from app.main import create_app
from app.settings import Settings
from rag.embeddings import Embedder
from rag.fake import FakeEmbedder
from rag.ingest import IngestReport
from tests.hr_data import BASE_URL, session_user

AUTH = {"Authorization": "Bearer caller-token"}


def requests(router: respx.MockRouter) -> list[httpx.Request]:
    # CallList subclasses a bare `list`, so its items are untyped.
    return [call.request for call in cast(list[Call], list(router.calls))]


def fake_embedder(settings: Settings) -> Embedder:
    return FakeEmbedder()


def user(role: str, *permissions: str) -> dict[str, Any]:
    return session_user(role, "Someone", None) | {"permissions": list(permissions)}


@pytest.fixture
def app() -> FastAPI:
    return create_app(
        Settings(hr_api_url=BASE_URL, ai_service_password="svc-pass", gemini_api_key="g")  # pyright: ignore[reportArgumentType]
    )


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://ai.test") as client:
        yield client


@pytest.fixture
def hr_api() -> Iterator[respx.MockRouter]:
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        router.route(host="ai.test").pass_through()
        router.post("/auth/login").respond(
            json={
                "accessToken": "service-token",
                "expiresAt": "2026-10-04T18:00:00.000Z",
                "user": user("EMPLOYEE", "policy:read"),
            }
        )
        yield router


async def test_only_policy_managers_may_reindex(
    client: httpx.AsyncClient, hr_api: respx.MockRouter
) -> None:
    hr_api.get("/auth/me").respond(json=user("MANAGER", "policy:read"))

    response = await client.post("/agent/policies/ingest", json={}, headers=AUTH)

    assert response.status_code == 403
    assert [request.url.path for request in requests(hr_api)] == ["/auth/me"]


async def test_hr_reindexes_as_the_service_login(
    client: httpx.AsyncClient, hr_api: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    hr_api.get("/auth/me").respond(json=user("HR_OPS", "policy:read", "policy:manage"))
    seen: dict[str, Any] = {}

    async def fake_ingest(hr: Any, store: Any, embedder: Any, **options: Any) -> IngestReport:
        seen["token"] = hr._token  # pyright: ignore[reportPrivateUsage]
        seen.update(options)
        return IngestReport(options["chunker"], options["chunk_size"], embedder.model, versions=7)

    monkeypatch.setattr("app.agent_routes.create_embedder", fake_embedder)
    monkeypatch.setattr("app.agent_routes.ingest_policies", fake_ingest)

    response = await client.post("/agent/policies/ingest", json={"chunk_size": 128}, headers=AUTH)

    assert response.status_code == 200, response.text
    assert response.json()["versions"] == 7
    assert seen == {"token": "service-token", "chunker": "heading", "chunk_size": 128}
    (login,) = [r for r in requests(hr_api) if r.url.path == "/auth/login"]
    assert json.loads(login.content)["password"] == "svc-pass"


async def test_without_embeddings_configured_it_says_so(
    hr_api: respx.MockRouter,
) -> None:
    hr_api.get("/auth/me").respond(json=user("HR_OPS", "policy:manage"))
    app = create_app(Settings(hr_api_url=BASE_URL, ai_service_password="svc"))  # pyright: ignore[reportArgumentType]
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://ai.test") as client:
        response = await client.post("/agent/policies/ingest", json={}, headers=AUTH)

    assert response.status_code == 503
    assert "GEMINI_API_KEY" in response.json()["detail"]
