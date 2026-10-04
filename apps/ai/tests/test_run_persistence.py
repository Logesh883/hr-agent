"""A5.4 and A5.6 against real Postgres: checkpoints and run records survive a "restart".

Skipped unless AI_TEST_DATABASE_URL is set (see tests/test_rag_store.py); migrates and
writes to that database's `ai` schema only.
"""

import argparse
import os
from collections.abc import AsyncIterator, Iterator
from datetime import date
from pathlib import Path

import httpx
import pytest
import respx
from alembic import command
from alembic.config import Config
from sqlalchemy import text

from app.hr_client import HrApiClient, SessionUser
from app.settings import Settings
from graphs.hr_agent import HrContext, build_hr_graph
from graphs.persistence import PostgresRunStore, RunRecord, open_checkpointer
from graphs.runner import resume_run, start_run
from llm.fake import FakeLLM
from rag.db import create_engine
from tests.hr_data import ARUN, BASE_URL, page, session_user
from tests.test_hr_graph import Events, parse, plan_json
from tools.base import ToolContext
from tracing.trace import Trace

DATABASE_URL = os.environ.get("AI_TEST_DATABASE_URL", "")

pytestmark = pytest.mark.skipif(
    not DATABASE_URL, reason="set AI_TEST_DATABASE_URL to run against Postgres"
)


@pytest.fixture(scope="module")
def url() -> Iterator[str]:
    url = Settings(database_url=DATABASE_URL).ai_db_url
    if "test" not in url.rsplit("/", 1)[-1]:
        pytest.fail(f"Refusing to write to a non-test database: {url}")
    config = Config(Path(__file__).parents[1] / "alembic.ini")
    config.cmd_opts = argparse.Namespace(x=[f"url={url}"])
    command.upgrade(config, "head")
    yield url


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        yield client


def context(http: httpx.AsyncClient, llm: FakeLLM) -> HrContext:
    user = SessionUser.model_validate(session_user("HR_OPS", "Lakshmi Pillai", None))
    tools = ToolContext(hr=HrApiClient(http, "hr-token"), user=user, today=date(2026, 10, 4))
    return HrContext(llm=llm, tools=tools, trace=Trace(name="agent.run"))


@respx.mock
async def test_a_paused_run_resumes_in_a_new_process(url: str, http: httpx.AsyncClient) -> None:
    respx.get(f"{BASE_URL}/employees", params={"q": "Arun"}).respond(json=page(ARUN))
    thread = f"test-{os.urandom(4).hex()}"
    first = FakeLLM([parse("onboard_employee", people=["Priya"], job_title="Engineer")])

    # Process 1: runs until the clarification, then "exits" (pool closed, objects gone).
    async with open_checkpointer(url) as saver:
        waiting = await start_run(
            build_hr_graph(saver), thread, "Onboard Priya", context(http, first), Events()
        )
    assert waiting.status == "waiting"

    # Process 2: a new pool, a new compiled graph; only the database is shared.
    second = FakeLLM(
        [
            parse(
                "onboard_employee",
                people=["Priya"],
                job_title="Engineer",
                joining_date="2026-10-12",
                location="Pune",
            ),
            plan_json(("s1", "search_employee", {"query": "Arun"})),
            "Checked.",
        ]
    )
    async with open_checkpointer(url) as saver:
        graph = build_hr_graph(saver)
        done = await resume_run(graph, thread, "12 Oct, Pune", context(http, second), Events())
        history = [
            s async for s in graph.aget_state_history({"configurable": {"thread_id": thread}})
        ]

    assert done.status == "completed" and done.answer == "Checked."
    assert done.values["clarifications"][0]["answer"] == "12 Oct, Pune"
    assert len(history) > 5  # a checkpoint per step, in Postgres
    engine = create_engine(url)
    async with engine.connect() as conn:
        tables = set(
            await conn.scalars(text("SELECT tablename FROM pg_tables WHERE schemaname = 'ai'"))
        )
    await engine.dispose()
    assert {"checkpoints", "checkpoint_writes", "workflow_run"} <= tables


async def test_run_store_round_trip(url: str) -> None:
    store = PostgresRunStore(create_engine(url))
    try:
        run = RunRecord.new(user_id="u1", user_role="HR_OPS", request="Sneha vs Arun")
        await store.create(run)
        first = await store.add_event(run.id, {"event": "run_started", "at": date(2026, 10, 4)})
        await store.add_event(run.id, {"event": "finished", "answer": "ok"})
        await store.update(run.id, status="waiting", question={"type": "clarification"})

        trace = Trace(name="agent.run", known_names={"Lakshmi Pillai"})
        with trace.observe("llm plan", kind="generation", metadata={"prompt": "plan@1"}) as g:
            g.model = "m"
        with trace.observe("tool search_employee", input={"query": "Sneha"}) as span:
            person = {"id": "e6", "name": "Sneha Patel", "employee_code": "EMP006"}
            span.output = {"ok": True, "data": {"employees": [person]}}
        await store.record_trace(run.id, trace)

        loaded = await store.get(run.id)
        assert loaded is not None and loaded.status == "waiting"
        assert loaded.question == {"type": "clarification"}
        events = await store.events(run.id, after=first)
        assert [e["event"] for _, e in events] == ["finished"]
        assert await store.mark_interrupted() >= 0
        async with store.engine.connect() as conn:
            tool = (
                await conn.execute(
                    text(
                        "SELECT tool_name, output::text FROM ai.tool_call"
                        " WHERE workflow_run_id = :r"
                    ),
                    {"r": run.id},
                )
            ).one()
            prompt = await conn.scalar(
                text("SELECT prompt_version FROM ai.agent_run WHERE workflow_run_id = :r"),
                {"r": run.id},
            )
        assert tool.tool_name == "search_employee" and "Sneha" not in tool.output
        assert prompt == "plan@1"
    finally:
        await store.aclose()
