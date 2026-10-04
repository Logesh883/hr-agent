from collections.abc import AsyncIterator, Iterator
from typing import cast

import httpx
import pytest
import respx
from fastapi import FastAPI
from respx.models import Call

from app.llm_routes import get_llm
from app.main import create_app
from app.settings import Settings
from llm.base import LLMError
from llm.fake import FakeLLM
from tests.hr_data import (
    BASE_URL,
    SNEHA,
    SNEHA_ID,
    balances,
    calls,
    page,
    session_user,
    tool_call,
)
from tracing.trace import Trace

QUESTION = {"question": "How many annual leave days does Sneha have left?"}
AUTH = {"Authorization": "Bearer hr-token"}


class RecordingExporter:
    def __init__(self) -> None:
        self.traces: list[Trace] = []

    async def export(self, trace: Trace) -> None:
        self.traces.append(trace)

    async def aclose(self) -> None:
        return None


@pytest.fixture
def fake() -> FakeLLM:
    return FakeLLM()


@pytest.fixture
def exporter() -> RecordingExporter:
    return RecordingExporter()


@pytest.fixture
def app(fake: FakeLLM, exporter: RecordingExporter) -> FastAPI:
    app = create_app(Settings(hr_api_url=BASE_URL))
    app.dependency_overrides[get_llm] = lambda: fake
    app.state.trace_exporter = exporter
    return app


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://ai.test") as client:
        yield client


@pytest.fixture
def hr_api() -> Iterator[respx.MockRouter]:
    # Let requests to the AI app itself (ASGI transport) through; mock only the HR API.
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        router.route(host="ai.test").pass_through()
        router.get("/auth/me").respond(json=session_user("HR_OPS", "Lakshmi Pillai", None))
        router.get("/employees").respond(json=page(SNEHA))
        router.get(f"/employees/{SNEHA_ID}/leave-balances").respond(json=balances(9))
        yield router


async def test_requires_a_bearer_token(client: httpx.AsyncClient) -> None:
    response = await client.post("/agent/ask", json=QUESTION)

    assert response.status_code == 401


async def test_answers_with_steps_and_exports_one_trace(
    client: httpx.AsyncClient,
    fake: FakeLLM,
    exporter: RecordingExporter,
    hr_api: respx.MockRouter,
) -> None:
    fake.queue(
        calls(tool_call("search_employee", '{"query": "Sneha"}')),
        calls(tool_call("get_leave_balances", f'{{"employee_id": "{SNEHA_ID}"}}', "call_2")),
        "Sneha Patel has 9 annual leave days left.",
    )

    response = await client.post("/agent/ask", json=QUESTION, headers=AUTH)

    assert response.status_code == 200
    body = response.json()
    assert body["answer"] == "Sneha Patel has 9 annual leave days left."
    assert body["stop_reason"] == "answered"
    assert [c["tool"] for s in body["steps"] for c in s["tool_calls"]] == [
        "search_employee",
        "get_leave_balances",
    ]
    assert body["usage"]["prompt_tokens"] > 0
    (trace,) = exporter.traces
    assert trace.id == body["trace_id"]
    assert trace.name == "agent.ask" and trace.metadata["role"] == "HR_OPS"
    # The user's token went to the HR API on every call.
    hr_requests = [c.request for c in cast(list[Call], hr_api.calls)]
    hr_requests = [r for r in hr_requests if r.url.host == "hr.test"]
    assert {r.headers["authorization"] for r in hr_requests} == {"Bearer hr-token"}


async def test_rejects_accounts_without_an_agent_role(
    client: httpx.AsyncClient, hr_api: respx.MockRouter
) -> None:
    hr_api.get("/auth/me").respond(json=session_user("AUDITOR", "Someone", None))

    response = await client.post("/agent/ask", json=QUESTION, headers=AUTH)

    assert response.status_code == 403


async def test_model_failure_is_a_502_and_still_traced(
    client: httpx.AsyncClient,
    fake: FakeLLM,
    exporter: RecordingExporter,
    hr_api: respx.MockRouter,
) -> None:
    fake.queue(LLMError("rate limited", status_code=429))

    response = await client.post("/agent/ask", json=QUESTION, headers=AUTH)

    assert response.status_code == 502
    (trace,) = exporter.traces
    assert trace.output == {"error": "rate limited"}
    assert trace.observations[0].level == "ERROR"
