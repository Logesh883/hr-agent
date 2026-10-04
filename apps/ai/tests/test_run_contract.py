"""A12.1: the runs API speaks exactly the `@hr/contracts` agent contract.

Drives Onboard Priya over HTTP (start, two value questions, an approval, approve) as the web
app's Command Center would, and checks every run view, the run list and every streamed
event against the Pydantic models generated from the Zod schemas.
"""

from collections.abc import AsyncIterator, Iterator
from datetime import date

import httpx
import pytest
import respx
from fastapi import FastAPI
from langgraph.checkpoint.memory import InMemorySaver

from app.main import create_app
from app.settings import Settings
from contracts import generated as api
from graphs.hr_agent import build_hr_graph
from graphs.persistence import MemoryRunStore
from graphs.service import RunService
from llm.fake import FakeLLM
from tests.hr_data import BASE_URL, session_user
from tests.test_onboard_priya import PARSE, PLAN, REQUEST, mock_hr_api
from tests.test_run_routes import AUTH, RecordingExporter, sse


@pytest.fixture
def fake() -> FakeLLM:
    return FakeLLM([PARSE, PLAN, "Priya Rao is created and onboarding has started."])


@pytest.fixture
def service(fake: FakeLLM) -> RunService:
    return RunService(
        graph=build_hr_graph(InMemorySaver()),
        store=MemoryRunStore(),
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


@pytest.fixture
def hr_api() -> Iterator[respx.MockRouter]:
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as router:
        router.route(host="ai.test").pass_through()
        router.get("/auth/me").respond(json=session_user("HR_OPS", "Lakshmi Pillai", None))
        mock_hr_api(router)
        yield router


async def view(client: httpx.AsyncClient, run_id: str) -> api.RunView:
    response = await client.get(f"/agent/runs/{run_id}", headers=AUTH)
    assert response.status_code == 200
    return api.RunView.model_validate(response.json())


async def answer(
    client: httpx.AsyncClient, service: RunService, run_id: str, body: api.ResumeRun
) -> api.RunView:
    response = await client.post(
        f"/agent/runs/{run_id}/resume",
        json=body.model_dump(mode="json", exclude_none=True),
        headers=AUTH,
    )
    assert response.status_code == 202, response.text
    api.RunView.model_validate(response.json())
    await service.wait(run_id)
    return await view(client, run_id)


async def test_a_run_from_start_to_approval_matches_the_contract(
    client: httpx.AsyncClient, service: RunService, hr_api: respx.MockRouter
) -> None:
    start = api.StartRun(request=REQUEST)
    started = await client.post("/agent/runs", json=start.model_dump(), headers=AUTH)
    assert started.status_code == 202
    run_id = str(api.RunView.model_validate(started.json()).id)
    await service.wait(run_id)

    asked = await view(client, run_id)
    assert asked.status == "waiting" and asked.question is not None
    assert isinstance(asked.question.root, api.RunQuestion2)  # a value question
    asked = await answer(client, service, run_id, api.ResumeRun(answer=api.Answer("Rao")))
    asked = await answer(
        client, service, run_id, api.ResumeRun(answer=api.Answer("priya.rao@acme.example"))
    )

    assert asked.question is not None
    approval = asked.question.root
    assert isinstance(approval, api.RunQuestion4)  # an approval question
    assert approval.tool == "create_employee" and approval.risk == "medium"
    assert approval.after is not None and approval.after["manager"] == "Rahul Sharma"
    assert asked.progress is not None and asked.progress.plan is not None

    # The inbox: the user's waiting runs.
    inbox = await client.get("/agent/runs", params={"status": "waiting"}, headers=AUTH)
    assert [str(r.id) for r in api.RunList.model_validate(inbox.json()).items] == [run_id]

    decision = api.ApprovalDecision(decision="approve", comment=api.Comment("Looks right"))
    done = await answer(client, service, run_id, api.ResumeRun(answer=decision))

    assert done.status == "completed" and done.answer
    assert done.progress is not None
    assert done.progress.approvals is not None
    assert [(a.step, a.decision) for a in done.progress.approvals] == [("s4", "approved")]
    assert done.progress.plan is not None
    created = next(s for s in done.progress.plan.steps if s.tool == "create_employee")
    assert created.status == "verified" and created.result and "Priya" in created.result

    stream = await client.get(f"/agent/runs/{run_id}/events", headers=AUTH)
    events = [api.RunEvent.model_validate(e["data"]) for e in sse(stream.text)]
    kinds = [e.root.event for e in events]
    assert kinds[0] == "run_started" and kinds[-1] == "finished"
    assert {"waiting", "run_resumed", "tool_started", "approval_decided", "verified"} <= set(kinds)
