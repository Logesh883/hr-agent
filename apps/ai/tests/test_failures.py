"""A7.5: fault injection. The HR API (respx) fails in the ways real systems do, and the run
must retry what's worth retrying, stop on what isn't, never build on a write it can't
confirm, undo only what's safe to undo, and say plainly what happened to every step.

The scenario: "Book Sneha annual leave on October 12-13 and make Arun her manager."
  s1 search Sneha, s2 search Arun, s3 create_leave_request, s4 change_manager.
The leave request is low risk and the manager change medium; medium approval is switched
off here so the failures, not the approvals, are what's tested (approvals: M6 tests).
"""

import json
from collections.abc import AsyncIterator, Iterator
from dataclasses import replace
from datetime import date
from typing import Any, cast

import httpx
import pytest
import respx
from langgraph.checkpoint.memory import InMemorySaver
from respx.models import Call

from agent.risk import default_policy
from app.faults import FaultInjector, configured_faults, parse_faults
from app.hr_client import HrApiClient, HrApiError, SessionUser
from graphs.hr_agent import UNDO_NOTE, HrContext, build_hr_graph
from graphs.runner import HrGraph, RunOutcome, start_run
from llm.base import LLMError
from llm.fake import FakeLLM
from llm.types import ToolCall
from tests.hr_data import (
    ARUN,
    ARUN_REF,
    BASE_URL,
    LEAVE_ID,
    SNEHA,
    SNEHA_ID,
    SNEHA_REF,
    USER_ID,
    page,
    session_user,
)
from tests.test_hr_graph import Events, parse, plan_json
from tools.base import ToolContext
from tools.hr_write import WRITE_TOOLS
from tools.registry import ToolRegistry, error_kind
from tracing.trace import Trace

REQUEST = "Book Sneha annual leave on October 12-13 and make Arun her manager."
PARSE = parse(
    "request_leave",
    people=["Sneha", "Arun"],
    leave_type="ANNUAL",
    start_date="2026-10-12",
    end_date="2026-10-13",
)
_DRAFT = json.loads(
    plan_json(
        ("s1", "search_employee", {"query": "Sneha"}),
        ("s2", "search_employee", {"query": "Arun"}),
        (
            "s3",
            "create_leave_request",
            {
                "employee_id": "$s1.employees.0.id",
                "leave_type": "ANNUAL",
                "start_date": "2026-10-12",
                "end_date": "2026-10-13",
            },
        ),
        (
            "s4",
            "change_manager",
            {"employee_id": "$s1.employees.0.id", "manager_id": "$s2.employees.0.id"},
        ),
        goal="Book Sneha's leave and move her to Arun",
    )
)
PLAN = json.dumps(
    _DRAFT
    | {"steps": [s | {"risk": "write"} if s["id"] in ("s3", "s4") else s for s in _DRAFT["steps"]]}
)


def leave(status: str = "PENDING", **overrides: Any) -> dict[str, Any]:
    return {
        "id": LEAVE_ID,
        "employee": SNEHA_REF,
        "type": "ANNUAL",
        "startDate": "2026-10-12",
        "endDate": "2026-10-13",
        "days": 2,
        "reason": None,
        "status": status,
        "requestedBy": {"id": USER_ID, "name": "Lakshmi Pillai"},
        "decidedBy": None,
        "decidedAt": None,
        "decisionComment": None,
        "createdAt": "2026-10-04T09:00:00.000Z",
        "canDecide": True,
        "canCancel": True,
    } | overrides


PREVIEW: dict[str, Any] = {
    "workingDays": 2,
    "nonWorkingDays": [],
    "balance": {
        "type": "ANNUAL",
        "year": 2026,
        "entitled": 18,
        "used": 7,
        "pending": 2,
        "available": 9,
    },
    "balanceAfter": 7,
    "problems": [],
}
SNEHA_UNDER_ARUN = SNEHA | {"manager": ARUN_REF, "version": 2}


def error(status: int, message: str, **extra: Any) -> httpx.Response:
    return httpx.Response(status, json={"statusCode": status, "message": message} | extra)


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        yield client


@pytest.fixture
def hr_api() -> Iterator[respx.MockRouter]:
    """Everything works; each test breaks one thing."""
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as api:
        api.get("/employees", params={"q": "Sneha"}).respond(json=page(SNEHA))
        api.get("/employees", params={"q": "Arun"}).respond(json=page(ARUN))
        api.post("/leave-requests/preview", name="preview").respond(json=PREVIEW)
        api.post("/leave-requests", name="create_leave").respond(201, json=leave())
        api.get(f"/leave-requests/{LEAVE_ID}", name="read_leave").respond(json=leave())
        api.post(f"/leave-requests/{LEAVE_ID}/cancel", name="cancel").respond(
            201, json=leave("CANCELLED")
        )
        api.get(f"/employees/{SNEHA_ID}", name="read_sneha").mock(
            side_effect=[
                httpx.Response(200, json=SNEHA),
                httpx.Response(200, json=SNEHA_UNDER_ARUN),
            ]
        )
        api.patch(f"/employees/{SNEHA_ID}", name="patch_sneha").respond(json=SNEHA_UNDER_ARUN)
        yield api


def context(http: httpx.AsyncClient, llm: FakeLLM) -> HrContext:
    user = SessionUser.model_validate(session_user("HR_OPS", "Lakshmi Pillai", None))
    tools = ToolContext(hr=HrApiClient(http, "hr-token"), user=user, today=date(2026, 10, 4))
    relaxed = default_policy().model_copy(
        update={"approval": {"low": False, "medium": False, "high": True}}
    )
    return HrContext(
        llm=llm,
        tools=tools,
        trace=Trace(name="agent.run"),
        risk_policy=relaxed,
        retry_delays=(0, 0, 0),  # the same three retries, without the waiting
    )


@pytest.fixture
def graph() -> HrGraph:
    return build_hr_graph(InMemorySaver())


def sent(api: respx.MockRouter, method: str, path: str) -> list[httpx.Request]:
    calls = cast(list[Call], list(api.calls))
    return [c.request for c in calls if c.request.method == method and c.request.url.path == path]


async def run(
    graph: HrGraph, http: httpx.AsyncClient, events: Events | None = None, answer: Any = "Done."
) -> tuple[RunOutcome, FakeLLM]:
    llm = FakeLLM([PARSE, PLAN, answer])
    outcome = await start_run(graph, "faults", REQUEST, context(http, llm), events or Events())
    assert outcome.status == "completed"
    return outcome, llm


def summary(outcome: RunOutcome) -> dict[str, dict[str, Any]]:
    return {line["step"]: line for line in outcome.values["summary"]}


async def test_everything_works_and_every_write_is_checked(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    events = Events()
    outcome, _ = await run(graph, http, events)

    results = outcome.values["results"]
    assert results["s3"]["status"] == "verified" and results["s4"]["status"] == "verified"
    assert [e["step"] for e in events.items if e["event"] == "verified"] == ["s3", "s4"]
    assert outcome.values["verification"]["problems"] == []
    assert not hr_api["cancel"].called


# ---- transient failures: retried --------------------------------------------------------


async def test_a_500_is_retried_with_the_same_idempotency_key(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    hr_api["create_leave"].mock(
        side_effect=[
            error(500, "Internal server error"),
            error(503, "Service unavailable"),
            httpx.Response(201, json=leave()),
        ]
    )
    events = Events()

    outcome, _ = await run(graph, http, events)

    attempts = sent(hr_api, "POST", "/leave-requests")
    assert len(attempts) == 3
    assert len({r.headers["idempotency-key"] for r in attempts}) == 1  # can't book twice
    assert [e["error"] for e in events.items if e["event"] == "tool_retry"] == [
        "The HR system refused the request (500): Internal server error.",
        "The HR system refused the request (503): Service unavailable.",
    ]
    assert outcome.values["results"]["s3"]["status"] == "verified"
    assert outcome.values["results"]["s4"]["status"] == "verified"


async def test_a_lost_response_is_retried_and_the_api_replays_the_first_answer(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    # The request reached the API, the answer didn't come back; the retry finds the first
    # attempt still running (409 busy), then gets its stored 201: one leave request.
    hr_api["create_leave"].mock(
        side_effect=[
            httpx.ReadTimeout("timed out"),
            error(409, "A request with this Idempotency-Key is still in progress. Retry shortly."),
            httpx.Response(201, json=leave(), headers={"Idempotent-Replayed": "true"}),
        ]
    )

    outcome, _ = await run(graph, http)

    assert len(sent(hr_api, "POST", "/leave-requests")) == 3
    assert outcome.values["results"]["s3"]["status"] == "verified"


async def test_retries_give_up_after_three_and_nothing_after_runs(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    hr_api["create_leave"].respond(500, json={"statusCode": 500, "message": "Database down"})

    outcome, llm = await run(graph, http)

    assert len(sent(hr_api, "POST", "/leave-requests")) == 4  # first try + 3 retries
    assert outcome.values["stopped_kind"] == "failed"
    assert outcome.values["results"]["s3"]["error_kind"] == "server"
    assert sent(hr_api, "PATCH", f"/employees/{SNEHA_ID}") == []
    lines = summary(outcome)
    assert lines["s3"]["status"] == "failed"
    assert lines["s4"]["status"] == "not run"
    respond_prompt = llm.calls[-1].messages[1].content or ""
    assert "s4 change_manager: not run" in respond_prompt


# ---- final failures: not retried --------------------------------------------------------


async def test_a_422_is_not_retried_and_its_problems_are_relayed_word_for_word(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    hr_api["create_leave"].mock(
        return_value=error(
            422,
            "Leave request breaks the rules",
            problems=[
                {"code": "OVERLAP", "message": "Overlaps with leave already booked on 2026-10-12"}
            ],
        )
    )

    outcome, llm = await run(graph, http)

    assert len(sent(hr_api, "POST", "/leave-requests")) == 1
    result = outcome.values["results"]["s3"]
    assert result["error_kind"] == "rule"
    assert "Overlaps with leave already booked on 2026-10-12" in result["error"]
    assert "Overlaps with leave already booked on 2026-10-12" in (
        llm.calls[-1].messages[1].content or ""
    )
    assert sent(hr_api, "PATCH", f"/employees/{SNEHA_ID}") == []


async def test_a_403_stops_and_the_leave_this_run_created_is_cancelled(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    hr_api["patch_sneha"].mock(
        return_value=error(403, "Missing permission employee.update", code="FORBIDDEN")
    )
    events = Events()

    outcome, _ = await run(graph, http, events)

    assert len(sent(hr_api, "PATCH", f"/employees/{SNEHA_ID}")) == 1  # not retried
    results = outcome.values["results"]
    assert results["s4"]["error_kind"] == "forbidden"
    # The leave request was ours and still pending: safe to cancel, so it is.
    (cancel,) = sent(hr_api, "POST", f"/leave-requests/{LEAVE_ID}/cancel")
    assert cancel.headers["idempotency-key"].endswith(":s3:undo")
    assert results["s3"]["status"] == "compensated"
    lines = summary(outcome)
    assert lines["s3"]["detail"] == "cancelled the leave request this run created"
    assert lines["s4"]["status"] == "failed"
    assert "compensated" in events.kinds()


async def test_a_stale_version_is_re_read_and_retried_once(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    stale = "Employee was changed by someone else. Reload and try again."
    hr_api["read_sneha"].mock(
        side_effect=[
            httpx.Response(200, json=SNEHA),  # version 1
            httpx.Response(200, json=SNEHA | {"version": 5}),  # someone else saved meanwhile
            httpx.Response(200, json=SNEHA_UNDER_ARUN),  # the read-back
        ]
    )
    hr_api["patch_sneha"].mock(
        side_effect=[error(409, stale), httpx.Response(200, json=SNEHA_UNDER_ARUN)]
    )

    outcome, _ = await run(graph, http)

    first, second = sent(hr_api, "PATCH", f"/employees/{SNEHA_ID}")
    assert json.loads(first.content)["version"] == 1
    assert json.loads(second.content)["version"] == 5
    assert second.headers["idempotency-key"] == first.headers["idempotency-key"] + ":r1"
    assert outcome.values["results"]["s4"]["status"] == "verified"


async def test_a_second_stale_version_is_reported_not_retried_forever(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    stale = "Employee was changed by someone else. Reload and try again."
    hr_api["read_sneha"].mock(return_value=httpx.Response(200, json=SNEHA))
    hr_api["patch_sneha"].mock(return_value=error(409, stale))

    outcome, _ = await run(graph, http)

    assert len(sent(hr_api, "PATCH", f"/employees/{SNEHA_ID}")) == 2
    assert outcome.values["results"]["s4"]["error_kind"] == "conflict"


async def test_a_duplicate_that_isnt_ours_is_not_treated_as_done(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    # "409 duplicate: treat as done *if the key matches*." A matching key is replayed by
    # the API as the first answer (above); a real duplicate is someone else's record.
    hr_api["create_leave"].mock(return_value=error(409, "Overlaps an existing leave request"))

    outcome, _ = await run(graph, http)

    assert len(sent(hr_api, "POST", "/leave-requests")) == 1
    assert outcome.values["results"]["s3"]["status"] == "failed"
    assert outcome.values["stopped_kind"] == "failed"


# ---- verification -----------------------------------------------------------------------


async def test_a_write_that_doesnt_check_out_stops_every_later_write(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    # 201, but reading it back shows other dates: the run can't build on that.
    hr_api["read_leave"].respond(json=leave(endDate="2026-10-16", days=5))
    events = Events()

    outcome, _ = await run(graph, http, events)

    s3 = outcome.values["results"]["s3"]
    assert s3["verification"] == {
        "ok": False,
        "mismatches": ["end_date is '2026-10-16', expected '2026-10-13'"],
    }
    assert outcome.values["stopped_kind"] == "mismatch"
    assert sent(hr_api, "PATCH", f"/employees/{SNEHA_ID}") == []
    # Still pending and ours, so the wrong request is cancelled rather than left behind.
    assert hr_api["cancel"].called and s3["status"] == "compensated"
    assert summary(outcome)["s4"]["status"] == "not run"


async def test_a_manager_change_that_didnt_stick_is_a_problem(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    hr_api["read_sneha"].mock(return_value=httpx.Response(200, json=SNEHA))  # still Rahul

    outcome, _ = await run(graph, http)

    s4 = outcome.values["results"]["s4"]
    assert s4["status"] == "mismatch"
    assert s4["verification"]["mismatches"][0].startswith("manager_id is ")
    (problem,) = outcome.values["verification"]["problems"]
    assert problem.startswith("s4 (change_manager) ran but didn't check out")
    # The leave request was fine, but the run as a whole failed after it: ours and pending,
    # so it's cancelled; nothing is left half-done without being said.
    assert outcome.values["results"]["s3"]["status"] == "compensated"


async def test_what_cant_be_undone_safely_is_left_and_said(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    hr_api["patch_sneha"].mock(return_value=error(403, "Missing permission employee.update"))
    # A manager approved the leave in the meantime: it's no longer ours to cancel.
    hr_api["read_leave"].mock(
        side_effect=[
            httpx.Response(200, json=leave()),  # the read-back right after creating it
            httpx.Response(200, json=leave("APPROVED")),  # by the time we'd undo it
        ]
    )

    outcome, _ = await run(graph, http)

    assert not hr_api["cancel"].called
    s3 = outcome.values["results"]["s3"]
    assert s3["status"] == "verified"
    assert s3["compensation"] == "not undone: left as is: it's approved now"


async def test_writes_left_in_place_after_a_failure_are_called_out(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    # Swap the order: the manager change (no safe undo) runs first, then the leave fails.
    plan = json.loads(PLAN)
    plan["steps"][2], plan["steps"][3] = plan["steps"][3], plan["steps"][2]
    hr_api["create_leave"].mock(return_value=error(403, "Missing permission leave.create"))
    llm = FakeLLM([PARSE, json.dumps(plan), "…"])

    outcome = await start_run(graph, "order", REQUEST, context(http, llm), Events())

    lines = summary(outcome)
    assert lines["s4"]["status"] == "verified" and lines["s4"]["detail"] == UNDO_NOTE
    assert lines["s3"]["status"] == "failed"


# ---- the model fails, the run doesn't -----------------------------------------------------


async def test_when_the_llm_is_down_at_the_end_the_result_is_still_reported(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    hr_api["patch_sneha"].mock(return_value=error(403, "Missing permission employee.update"))

    outcome, _ = await run(graph, http, answer=LLMError("provider unavailable"))

    answer = outcome.values["answer"]
    assert answer.startswith("The assistant couldn't write a full answer")
    assert (
        "- s3 create leave request: compensated "
        "(cancelled the leave request this run created)" in answer
    )
    assert "- s4 change manager: failed" in answer


# ---- the tool layer on its own -------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "message", "problems", "kind"),
    [
        (400, "Bad request", None, "invalid"),
        (401, "Unauthorized", None, "auth"),
        (403, "Forbidden", None, "forbidden"),
        (404, "Employee not found", None, "not_found"),
        (409, "Employee was changed by someone else", None, "conflict"),
        (
            409,
            "A request with this Idempotency-Key is still in progress. Retry shortly.",
            None,
            "busy",
        ),
        (422, "Invalid", None, "invalid"),
        (422, "Rules", [{"code": "X", "message": "No"}], "rule"),
        (500, "Oops", None, "server"),
        (502, "Bad gateway", None, "server"),
    ],
)
def test_api_errors_map_to_what_the_agent_does(
    status: int, message: str, problems: list[dict[str, str]] | None, kind: str
) -> None:
    body = {"statusCode": status, "message": message} | ({"problems": problems} if problems else {})
    assert error_kind(HrApiError.from_response(httpx.Response(status, json=body))) == kind


@respx.mock
async def test_a_tool_that_hangs_times_out_as_a_transient_failure(
    http: httpx.AsyncClient,
) -> None:
    import asyncio

    async def hang(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(201)

    respx.post(f"{BASE_URL}/leave-requests/preview").respond(json=PREVIEW)
    respx.post(f"{BASE_URL}/leave-requests").mock(side_effect=hang)
    create = next(t for t in WRITE_TOOLS if t.name == "create_leave_request")
    registry = ToolRegistry([replace(create, timeout_s=0.05)])
    user = SessionUser.model_validate(session_user("HR_OPS", "Lakshmi Pillai", None))
    ctx = ToolContext(hr=HrApiClient(http, "t"), user=user, today=date(2026, 10, 4))
    arguments = {
        "employee_id": SNEHA_ID,
        "leave_type": "ANNUAL",
        "start_date": "2026-10-12",
        "end_date": "2026-10-13",
    }

    result = await registry.execute(
        ToolCall(id="c", name="create_leave_request", arguments=json.dumps(arguments)), ctx
    )

    assert not result.ok and result.error_kind == "timeout" and result.transient


# ---- the demo's fault injector -------------------------------------------------------------


def test_fault_specs_are_parsed_and_never_used_in_production() -> None:
    (leave_rule, patch_rule) = parse_faults("POST /leave-requests=500,drop; patch /employees/*=403")
    assert (leave_rule.method, leave_rule.path, list(leave_rule.outcomes)) == (
        "POST",
        "/leave-requests",
        ["500", "drop"],
    )
    assert patch_rule.method == "PATCH"
    assert configured_faults("POST /x=500", "production") is None
    with pytest.raises(ValueError, match="Bad fault outcome"):
        parse_faults("POST /x=oops")


async def test_injected_faults_are_used_up_then_requests_go_through() -> None:
    real = respx.MockRouter(base_url=BASE_URL, assert_all_called=False)
    create = real.post("/leave-requests").respond(201, json=leave())
    real.post("/leave-requests/preview").respond(json=PREVIEW)
    rules = parse_faults("POST /leave-requests=503,drop")
    async with httpx.AsyncClient(
        base_url=BASE_URL, transport=FaultInjector(rules, inner=httpx.MockTransport(real.handler))
    ) as client:
        first = await client.post("/leave-requests", json={})
        with pytest.raises(httpx.ReadTimeout):
            await client.post("/leave-requests", json={})  # handled, answer lost
        third = await client.post("/leave-requests", json={})
        other = await client.post("/leave-requests/preview", json={})

    assert first.status_code == 503 and third.status_code == 201
    assert create.call_count == 2  # the dropped one did reach the API
    assert other.json() == PREVIEW  # not a rule's path: passed through untouched
