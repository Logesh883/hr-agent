"""A5.5: the runs API, with an in-memory checkpointer and run store (no database)."""

import asyncio
import json
from collections.abc import AsyncIterator, Iterator, Sequence
from datetime import date
from typing import Any

import httpx
import pytest
import respx
from fastapi import FastAPI
from langgraph.checkpoint.memory import InMemorySaver

from app.main import create_app
from app.settings import Settings
from graphs.hr_agent import build_hr_graph
from graphs.persistence import MemoryRunStore
from graphs.service import RunService
from llm.base import LLMClient
from llm.fake import FakeLLM
from llm.types import LLMResponse, Message, ToolSpec
from tests.hr_data import ARUN, ARUN_ID, BASE_URL, SNEHA, SNEHA_ID, balances, page, session_user
from tests.test_hr_graph import COMPARE_PLAN, parse, plan_json
from tracing.trace import Trace

AUTH = {"Authorization": "Bearer hr-token"}
OTHER = {"Authorization": "Bearer other-token"}


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
def store() -> MemoryRunStore:
    return MemoryRunStore()


@pytest.fixture
def service(fake: FakeLLM, store: MemoryRunStore) -> RunService:
    return RunService(
        graph=build_hr_graph(InMemorySaver()),
        store=store,
        llm=fake,
        exporter=RecordingExporter(),
        hr_api_url=BASE_URL,
        today=lambda: date(2026, 10, 4),
    )


@pytest.fixture
def app(service: RunService) -> FastAPI:
    app = create_app(Settings(hr_api_url=BASE_URL))
    app.state.run_service = service
    return app


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://ai.test") as client:
        yield client


def who_is(request: httpx.Request) -> httpx.Response:
    """Two users: the hr-token belongs to Lakshmi, any other token to someone else."""
    if request.headers["authorization"] == "Bearer hr-token":
        return httpx.Response(200, json=session_user("HR_OPS", "Lakshmi Pillai", None))
    return httpx.Response(200, json=session_user("HR_OPS", "Someone Else", None) | {"id": "x"})


@pytest.fixture
def hr_api() -> Iterator[respx.MockRouter]:
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        router.route(host="ai.test").pass_through()
        router.get("/auth/me").mock(side_effect=who_is)
        router.get("/employees", params={"q": "Sneha"}).respond(json=page(SNEHA))
        router.get("/employees", params={"q": "Arun"}).respond(json=page(ARUN))
        router.get(f"/employees/{SNEHA_ID}/leave-balances").respond(json=balances(9))
        router.get(f"/employees/{ARUN_ID}/leave-balances").respond(json=balances(4))
        yield router


def sse(text: str) -> list[dict[str, Any]]:
    """Parses a server-sent event stream into [{"id", "event", "data"}]."""
    events: list[dict[str, Any]] = []
    for block in text.strip().split("\n\n"):
        fields = dict(
            line.split(": ", 1) for line in block.splitlines() if not line.startswith(":")
        )
        if fields:
            events.append({**fields, "data": json.loads(fields["data"])})
    return events


async def test_a_run_starts_in_the_background_finishes_and_streams_its_timeline(
    client: httpx.AsyncClient,
    service: RunService,
    store: MemoryRunStore,
    fake: FakeLLM,
    hr_api: respx.MockRouter,
) -> None:
    fake.queue(parse("leave_balance", people=["Sneha", "Arun"]), COMPARE_PLAN, "Sneha 9, Arun 4.")

    started = await client.post(
        "/agent/runs", json={"request": "Sneha vs Arun leave"}, headers=AUTH
    )
    assert started.status_code == 202
    run_id = started.json()["id"]
    assert started.json()["status"] == "running"
    await service.wait(run_id)

    run = (await client.get(f"/agent/runs/{run_id}", headers=AUTH)).json()
    assert run["status"] == "completed" and run["answer"] == "Sneha 9, Arun 4."
    assert run["workflow_type"] == "leave_balance"
    assert [s["status"] for s in run["progress"]["plan"]["steps"]] == ["done"] * 4
    assert len(run["trace_ids"]) == 1

    stream = await client.get(f"/agent/runs/{run_id}/events", headers=AUTH)
    assert stream.headers["content-type"].startswith("text/event-stream")
    events = sse(stream.text)
    kinds = [e["event"] for e in events]
    assert kinds[0] == "run_started" and kinds[-1] == "finished"
    assert kinds.count("tool_finished") == 4
    assert [int(e["id"]) for e in events] == sorted(int(e["id"]) for e in events)
    # Reconnecting with Last-Event-ID replays only what came after it.
    later = await client.get(
        f"/agent/runs/{run_id}/events", headers=AUTH | {"Last-Event-ID": events[-3]["id"]}
    )
    assert [e["event"] for e in sse(later.text)] == kinds[-2:]

    # A5.6 records: one agent_run per LLM call, one tool_call per tool call, masked.
    assert [a["name"] for a in store.agent_runs] == ["llm understand", "llm plan", "llm respond"]
    assert [t["tool_name"] for t in store.tool_calls] == [
        "search_employee",
        "search_employee",
        "get_leave_balances",
        "get_leave_balances",
    ]
    assert "Sneha" not in json.dumps(store.tool_calls, default=str)
    assert all(t["status"] == "ok" for t in store.tool_calls)


async def test_a_question_pauses_the_run_until_the_user_answers(
    client: httpx.AsyncClient, service: RunService, fake: FakeLLM, hr_api: respx.MockRouter
) -> None:
    fake.queue(
        parse("onboard_employee", people=["Priya"], job_title="Engineer", location="Pune"),
        parse(
            "onboard_employee",
            people=["Priya"],
            job_title="Engineer",
            location="Pune",
            joining_date="2026-10-12",
        ),
        plan_json(("s1", "search_employee", {"query": "Sneha"})),
        "Checked; creating Priya's record comes later.",
    )
    run_id = (
        await client.post("/agent/runs", json={"request": "Onboard Priya"}, headers=AUTH)
    ).json()["id"]
    await service.wait(run_id)

    waiting = (await client.get(f"/agent/runs/{run_id}", headers=AUTH)).json()
    assert waiting["status"] == "waiting"
    assert waiting["question"] == {"type": "clarification", "question": "When does Priya join?"}
    # The stream ends at the question instead of hanging.
    assert (
        sse((await client.get(f"/agent/runs/{run_id}/events", headers=AUTH)).text)[-1]["event"]
        == "waiting"
    )

    no_answer = await client.post(f"/agent/runs/{run_id}/resume", json={}, headers=AUTH)
    assert no_answer.status_code == 409

    resumed = await client.post(
        f"/agent/runs/{run_id}/resume", json={"answer": "12 October"}, headers=AUTH
    )
    assert resumed.status_code == 202
    await service.wait(run_id)

    done = (await client.get(f"/agent/runs/{run_id}", headers=AUTH)).json()
    assert done["status"] == "completed"
    assert done["progress"]["clarifications"] == [
        {"question": "When does Priya join?", "answer": "12 October"}
    ]
    assert len(done["trace_ids"]) == 2  # one trace per segment: start, resume


async def test_runs_are_private_to_whoever_started_them(
    client: httpx.AsyncClient, service: RunService, fake: FakeLLM, hr_api: respx.MockRouter
) -> None:
    fake.queue(parse("unknown", confidence=0.9))
    run_id = (await client.post("/agent/runs", json={"request": "poem"}, headers=AUTH)).json()["id"]
    await service.wait(run_id)

    for response in (
        await client.get(f"/agent/runs/{run_id}", headers=OTHER),
        await client.get(f"/agent/runs/{run_id}/events", headers=OTHER),
        await client.post(f"/agent/runs/{run_id}/resume", json={}, headers=OTHER),
    ):
        assert response.status_code == 404
    assert (await client.post("/agent/runs", json={"request": "x"})).status_code == 401


class HangsAtRespond(LLMClient):
    """The third call (respond) never returns, like a server stopped mid-call."""

    provider = "fake"
    model = "fake-model"

    def __init__(self, inner: FakeLLM) -> None:
        self.inner = inner

    async def _chat(
        self,
        messages: list[Message],
        *,
        tools: list[ToolSpec] | None,
        response_format: dict[str, Any] | None,
        temperature: float,
        max_tokens: int,
    ) -> LLMResponse:
        if len(self.inner.calls) == 2:
            await asyncio.Event().wait()
        return await self.inner.chat(
            messages, tools=tools, response_format=response_format, max_tokens=max_tokens
        )

    def _stream(self, messages: Sequence[Message], **kwargs: Any) -> Any:
        raise NotImplementedError

    async def chat(self, messages: Sequence[Message], **kwargs: Any) -> LLMResponse:
        kwargs.pop("prompt", None)
        return await self._chat(
            list(messages),
            tools=kwargs.get("tools"),
            response_format=kwargs.get("response_format"),
            temperature=0,
            max_tokens=kwargs.get("max_tokens", 1024),
        )


async def test_an_interrupted_run_resumes_from_its_checkpoint(
    client: httpx.AsyncClient,
    service: RunService,
    store: MemoryRunStore,
    hr_api: respx.MockRouter,
) -> None:
    script = FakeLLM([parse("leave_balance", people=["Sneha", "Arun"]), COMPARE_PLAN])
    service.llm = HangsAtRespond(script)
    run_id = (
        await client.post("/agent/runs", json={"request": "Sneha vs Arun"}, headers=AUTH)
    ).json()["id"]
    # Polls the store: the test only sees the run from outside, like an API client.
    while not any(e.get("node") == "respond" for _, e in await store.events(run_id)):  # noqa: ASYNC110
        await asyncio.sleep(0.01)
    await service.aclose()  # shutdown cancels the run mid-respond
    # Every tool call made before the kill is already on record.
    assert len(store.tool_calls) == 4
    lookups = len([c for c in hr_api.calls if "/employees" in str(c.request.url)])  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType, reportUnknownVariableType]
    assert (await store.get(run_id)).status == "running"  # pyright: ignore[reportOptionalMemberAccess]

    # "Restart": the new process marks it interrupted; the user continues it.
    assert await store.mark_interrupted() == 1
    service.llm = FakeLLM(["Sneha 9, Arun 4."])
    with_answer = await client.post(
        f"/agent/runs/{run_id}/resume", json={"answer": "x"}, headers=AUTH
    )
    assert with_answer.status_code == 409
    resumed = await client.post(f"/agent/runs/{run_id}/resume", json={}, headers=AUTH)
    assert resumed.status_code == 202
    await service.wait(run_id)

    done = (await client.get(f"/agent/runs/{run_id}", headers=AUTH)).json()
    assert done["status"] == "completed" and done["answer"] == "Sneha 9, Arun 4."
    after = len([c for c in hr_api.calls if "/employees" in str(c.request.url)])  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType, reportUnknownVariableType]
    assert after == lookups  # finished steps weren't run again
