"""A8.4: budgets. A run stops between steps when it's out of tokens, time or steps, and
says what it did; a user can't start more than their share of runs."""

import time
from dataclasses import replace

import httpx
import pytest
import respx

from agent.budget import RateLimited, RateLimiter, RunBudget
from graphs.runner import HrGraph, start_run
from graphs.service import RunService
from llm.fake import FakeLLM
from tests.test_hr_graph import COMPARE_PLAN, Events, context, graph, http, mock_people, parse
from tests.test_run_routes import AUTH, app, client, fake, hr_api, service, store

# Fixtures shared with the graph and runs-API tests.
__all__ = ["app", "client", "fake", "graph", "hr_api", "http", "service", "store"]

REQUEST = "Compare Sneha's and Arun's annual leave"


def script() -> FakeLLM:
    return FakeLLM(
        [parse("leave_balance", people=["Sneha", "Arun"]), COMPARE_PLAN, "Sneha 9, Arun 4."]
    )


@respx.mock
async def test_a_run_out_of_tokens_stops_before_the_next_step(
    http: httpx.AsyncClient, graph: HrGraph
) -> None:
    mock_people()
    events = Events()
    ctx = replace(context(http, script()), budget=RunBudget(max_tokens=1))

    outcome = await start_run(graph, "tokens", REQUEST, ctx, events)

    assert outcome.values["status"] == "failed" and outcome.values["stopped_kind"] == "budget"
    assert outcome.answer is not None
    assert outcome.answer.startswith("This request used its token budget (")
    assert "so I stopped here" in outcome.answer
    assert events.nodes() == ["understand"]  # understand ran; nothing after it
    assert "budget_exceeded" in events.kinds()
    assert not respx.calls


@respx.mock
async def test_a_run_out_of_time_stops_before_the_next_step(
    http: httpx.AsyncClient, graph: HrGraph
) -> None:
    mock_people()
    ctx = replace(context(http, script()), started=time.monotonic() - 1_000)

    outcome = await start_run(graph, "slow", REQUEST, ctx, Events())

    assert outcome.answer is not None
    assert outcome.answer.startswith("This request took longer than its time budget (120 s)")
    assert not respx.calls


@respx.mock
async def test_a_run_that_needs_too_many_steps_is_stopped_with_what_it_did(
    http: httpx.AsyncClient, graph: HrGraph
) -> None:
    mock_people()
    ctx = replace(context(http, script()), budget=RunBudget(max_node_passes=6))

    outcome = await start_run(graph, "loop", REQUEST, ctx, Events())

    assert outcome.answer is not None
    assert outcome.answer.startswith("This request needed more than 6 steps")
    # understand, retrieve_policy, plan, validate_plan, then two lookups: and no more.
    assert "- s2 search employee: done" in outcome.answer
    assert "- s3 get leave balances: not run" in outcome.answer
    assert outcome.values["status"] == "failed"


async def test_requests_per_minute_are_limited_per_user() -> None:
    now = [0.0]
    limiter = RateLimiter(per_minute=2, concurrent=5, clock=lambda: now[0])

    await limiter.acquire("u1", hold=False)
    await limiter.acquire("u1", hold=False)
    with pytest.raises(RateLimited, match="at most 2 a minute") as refused:
        await limiter.acquire("u1", hold=False)
    await limiter.acquire("u2", hold=False)  # someone else isn't affected

    assert refused.value.retry_after == 60
    now[0] = 60.0
    await limiter.acquire("u1", hold=False)  # a minute later: allowed again


async def test_runs_at_once_are_limited_until_one_finishes() -> None:
    limiter = RateLimiter(per_minute=100, concurrent=1)

    await limiter.acquire("u1")
    with pytest.raises(RateLimited, match="already have 1 requests running"):
        await limiter.acquire("u1")
    limiter.release("u1")
    await limiter.acquire("u1")


async def test_the_runs_api_answers_429_with_retry_after(
    client: httpx.AsyncClient, service: RunService, fake: FakeLLM, hr_api: respx.MockRouter
) -> None:
    service.limiter = RateLimiter(per_minute=1, concurrent=5)
    fake.queue(parse("unknown"), "x")

    first = await client.post("/agent/runs", json={"request": "hello"}, headers=AUTH)
    second = await client.post("/agent/runs", json={"request": "hello"}, headers=AUTH)

    assert first.status_code == 202
    assert second.status_code == 429
    assert second.headers["retry-after"] == "60"
    assert "at most 1 a minute" in second.json()["detail"]
    await service.wait(first.json()["id"])
