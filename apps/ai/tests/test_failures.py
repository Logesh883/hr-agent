"""A7.5: fault injection. The HR API (respx) fails in the ways real systems do, and the run
must retry what's worth retrying, stop on what isn't, never build on a write it can't
confirm, undo only what's safe to undo, and say plainly what happened to every step.

Two single-intent scenarios (a plan may only make the changes its request asks for, A8.2):

- Leave: "Book Sneha annual leave 2026-10-12 to 2026-10-13 and 2026-11-02 to 2026-11-03."
  s1 search Sneha, s2 and s3 create_leave_request. Low risk, and safe to undo: a failure
  of s3 cancels s2.
- Manager: "Make Arun Sneha's manager and change her location to Pune."
  s1 search Sneha, s2 search Arun, s3 change_manager, s4 update_employee. Not undoable:
  a failure of s4 leaves s3 in place and says so.

Medium approval is switched off so the failures, not the approvals, are what's tested
(approvals: M6 tests). Retries run without waiting.
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

SECOND_LEAVE_ID = "5c0b1f8e-0000-4000-8000-0000000000a2"


def with_write_risk(plan: str, *write_steps: str) -> str:
    draft = json.loads(plan)
    steps = [s | {"risk": "write"} if s["id"] in write_steps else s for s in draft["steps"]]
    return json.dumps(draft | {"steps": steps})


def leave_args(start: str, end: str) -> dict[str, Any]:
    return {
        "employee_id": "$s1.employees.0.id",
        "leave_type": "ANNUAL",
        "start_date": start,
        "end_date": end,
    }


LEAVE_REQUEST = "Book Sneha annual leave 2026-10-12 to 2026-10-13 and 2026-11-02 to 2026-11-03."
LEAVE_PARSE = parse(
    "request_leave",
    people=["Sneha"],
    leave_type="ANNUAL",
    start_date="2026-10-12",
    end_date="2026-10-13",
)
LEAVE_PLAN = with_write_risk(
    plan_json(
        ("s1", "search_employee", {"query": "Sneha"}),
        ("s2", "create_leave_request", leave_args("2026-10-12", "2026-10-13")),
        ("s3", "create_leave_request", leave_args("2026-11-02", "2026-11-03")),
        goal="Book Sneha's two leaves",
    ),
    "s2",
    "s3",
)

MANAGER_REQUEST = "Make Arun Sneha's manager and change her location to Pune."
MANAGER_PARSE = parse("update_employee", people=["Sneha", "Arun"], manager="Arun", location="Pune")
MANAGER_PLAN = with_write_risk(
    plan_json(
        ("s1", "search_employee", {"query": "Sneha"}),
        ("s2", "search_employee", {"query": "Arun"}),
        (
            "s3",
            "change_manager",
            {"employee_id": "$s1.employees.0.id", "manager_id": "$s2.employees.0.id"},
        ),
        ("s4", "update_employee", {"employee_id": "$s1.employees.0.id", "location": "Pune"}),
        goal="Move Sneha to Arun and to Pune",
    ),
    "s3",
    "s4",
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


SECOND_LEAVE = leave(id=SECOND_LEAVE_ID, startDate="2026-11-02", endDate="2026-11-03")
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
STALE = "Employee was changed by someone else. Reload and try again."


def error(status: int, message: str, **extra: Any) -> httpx.Response:
    return httpx.Response(status, json={"statusCode": status, "message": message} | extra)


class SnehaRecord:
    """Sneha's employee record as the HR API keeps it: PATCH applies the change and bumps
    the version, GET returns what's stored. Tests make it misbehave."""

    def __init__(self) -> None:
        self.record: dict[str, Any] = dict(SNEHA)
        # Answers to give instead of applying a PATCH, in order (then normal again).
        self.refusals: list[httpx.Response] = []
        # Set before a refusal: someone else saved meanwhile.
        self.saved_by_someone_else = False
        self.manager_sticks = True
        self.refuse_location: httpx.Response | None = None

    def get(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=self.record)

    def patch(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if "location" in body and self.refuse_location is not None:
            return self.refuse_location
        if self.refusals:
            if self.saved_by_someone_else:
                self.record["version"] = 5
            return self.refusals.pop(0)
        if body.get("version") != self.record["version"]:
            return error(409, STALE)
        if "managerId" in body and self.manager_sticks:
            self.record["manager"] = ARUN_REF
        if "location" in body:
            self.record["location"] = body["location"]
        self.record["version"] += 1
        return httpx.Response(200, json=self.record)


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        yield client


@pytest.fixture
def sneha() -> SnehaRecord:
    return SnehaRecord()


@pytest.fixture
def hr_api(sneha: SnehaRecord) -> Iterator[respx.MockRouter]:
    """Everything works; each test breaks one thing."""
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as api:
        api.get("/employees", params={"q": "Sneha"}).respond(json=page(SNEHA))
        api.get("/employees", params={"q": "Arun"}).respond(json=page(ARUN))
        api.post("/leave-requests/preview").respond(json=PREVIEW)
        api.post("/leave-requests", json__startDate="2026-10-12", name="create_first").respond(
            201, json=leave()
        )
        api.post("/leave-requests", json__startDate="2026-11-02", name="create_second").respond(
            201, json=SECOND_LEAVE
        )
        api.get(f"/leave-requests/{LEAVE_ID}", name="read_first").respond(json=leave())
        api.get(f"/leave-requests/{SECOND_LEAVE_ID}").respond(json=SECOND_LEAVE)
        api.post(f"/leave-requests/{LEAVE_ID}/cancel", name="cancel").respond(
            201, json=leave("CANCELLED")
        )
        api.get(f"/employees/{SNEHA_ID}").mock(side_effect=sneha.get)
        api.patch(f"/employees/{SNEHA_ID}").mock(side_effect=sneha.patch)
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
    graph: HrGraph,
    http: httpx.AsyncClient,
    events: Events | None = None,
    answer: Any = "Done.",
    *,
    scenario: str = "leave",
) -> tuple[RunOutcome, FakeLLM]:
    request, parsed, plan = (
        (LEAVE_REQUEST, LEAVE_PARSE, LEAVE_PLAN)
        if scenario == "leave"
        else (MANAGER_REQUEST, MANAGER_PARSE, MANAGER_PLAN)
    )
    llm = FakeLLM([parsed, plan, answer])
    outcome = await start_run(graph, scenario, request, context(http, llm), events or Events())
    assert outcome.status == "completed", outcome.question
    return outcome, llm


def summary(outcome: RunOutcome) -> dict[str, dict[str, Any]]:
    return {line["step"]: line for line in outcome.values["summary"]}


def statuses(outcome: RunOutcome) -> dict[str, str]:
    return {step: line["status"] for step, line in summary(outcome).items()}


# ---- leave: everything works ---------------------------------------------------------------


async def test_everything_works_and_every_write_is_checked(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    events = Events()
    outcome, _ = await run(graph, http, events)

    assert statuses(outcome) == {"s1": "done", "s2": "verified", "s3": "verified"}
    assert [e["step"] for e in events.items if e["event"] == "verified"] == ["s2", "s3"]
    assert outcome.values["verification"]["problems"] == []
    assert not hr_api["cancel"].called


# ---- transient failures: retried --------------------------------------------------------


async def test_a_500_is_retried_with_the_same_idempotency_key(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    hr_api["create_first"].mock(
        side_effect=[
            error(500, "Internal server error"),
            error(503, "Service unavailable"),
            httpx.Response(201, json=leave()),
        ]
    )
    events = Events()

    outcome, _ = await run(graph, http, events)

    attempts = sent(hr_api, "POST", "/leave-requests")
    assert len(attempts) == 4  # three tries at the first leave, then the second
    keys = {r.headers["idempotency-key"] for r in attempts[:3]}
    assert len(keys) == 1  # one key for every try: it can't be booked twice
    assert [e["error"] for e in events.items if e["event"] == "tool_retry"] == [
        "The HR system refused the request (500): Internal server error.",
        "The HR system refused the request (503): Service unavailable.",
    ]
    assert statuses(outcome) == {"s1": "done", "s2": "verified", "s3": "verified"}


async def test_a_lost_response_is_retried_and_the_api_replays_the_first_answer(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    # The request reached the API, the answer didn't come back; the retry finds the first
    # attempt still running (409 busy), then gets its stored 201: one leave request.
    hr_api["create_first"].mock(
        side_effect=[
            httpx.ReadTimeout("timed out"),
            error(409, "A request with this Idempotency-Key is still in progress. Retry shortly."),
            httpx.Response(201, json=leave(), headers={"Idempotent-Replayed": "true"}),
        ]
    )

    outcome, _ = await run(graph, http)

    assert hr_api["create_first"].call_count == 3
    assert outcome.values["results"]["s2"]["status"] == "verified"


async def test_retries_give_up_after_three_and_nothing_after_runs(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    hr_api["create_first"].respond(500, json={"statusCode": 500, "message": "Database down"})

    outcome, llm = await run(graph, http)

    assert hr_api["create_first"].call_count == 4  # first try + 3 retries
    assert outcome.values["stopped_kind"] == "failed"
    assert outcome.values["results"]["s2"]["error_kind"] == "server"
    assert not hr_api["create_second"].called
    assert statuses(outcome) == {"s1": "done", "s2": "failed", "s3": "not run"}
    respond_prompt = llm.calls[-1].messages[1].content or ""
    assert "s3 create_leave_request: not run" in respond_prompt


# ---- final failures: not retried --------------------------------------------------------


async def test_a_422_is_not_retried_and_its_problems_are_relayed_word_for_word(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    hr_api["create_first"].mock(
        return_value=error(
            422,
            "Leave request breaks the rules",
            problems=[
                {"code": "OVERLAP", "message": "Overlaps with leave already booked on 2026-10-12"}
            ],
        )
    )

    outcome, llm = await run(graph, http)

    assert hr_api["create_first"].call_count == 1
    result = outcome.values["results"]["s2"]
    assert result["error_kind"] == "rule"
    assert "Overlaps with leave already booked on 2026-10-12" in result["error"]
    assert "Overlaps with leave already booked on 2026-10-12" in (
        llm.calls[-1].messages[1].content or ""
    )
    assert not hr_api["create_second"].called


async def test_a_403_stops_and_the_leave_this_run_created_is_cancelled(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    hr_api["create_second"].mock(
        return_value=error(403, "Missing permission leave:request", code="FORBIDDEN")
    )
    events = Events()

    outcome, _ = await run(graph, http, events)

    assert hr_api["create_second"].call_count == 1  # not retried
    results = outcome.values["results"]
    assert results["s3"]["error_kind"] == "forbidden"
    # The first leave request was ours and still pending: safe to cancel, so it is.
    (cancel,) = sent(hr_api, "POST", f"/leave-requests/{LEAVE_ID}/cancel")
    assert cancel.headers["idempotency-key"].endswith(":s2:undo")
    assert statuses(outcome) == {"s1": "done", "s2": "compensated", "s3": "failed"}
    assert summary(outcome)["s2"]["detail"] == "cancelled the leave request this run created"
    assert "compensated" in events.kinds()


async def test_a_duplicate_that_isnt_ours_is_not_treated_as_done(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    # "409 duplicate: treat as done *if the key matches*." A matching key is replayed by
    # the API as the first answer (above); a real duplicate is someone else's record.
    hr_api["create_first"].mock(return_value=error(409, "Overlaps an existing leave request"))

    outcome, _ = await run(graph, http)

    assert hr_api["create_first"].call_count == 1
    assert outcome.values["results"]["s2"]["status"] == "failed"
    assert outcome.values["stopped_kind"] == "failed"


# ---- verification -----------------------------------------------------------------------


async def test_a_write_that_doesnt_check_out_stops_every_later_write(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    # 201, but reading it back shows other dates: the run can't build on that.
    hr_api["read_first"].respond(json=leave(endDate="2026-10-16", days=5))

    outcome, _ = await run(graph, http)

    s2 = outcome.values["results"]["s2"]
    assert s2["verification"] == {
        "ok": False,
        "mismatches": ["end_date is '2026-10-16', expected '2026-10-13'"],
    }
    assert outcome.values["stopped_kind"] == "mismatch"
    assert not hr_api["create_second"].called
    # Still pending and ours, so the wrong request is cancelled rather than left behind.
    assert hr_api["cancel"].called
    assert statuses(outcome) == {"s1": "done", "s2": "compensated", "s3": "not run"}


async def test_what_cant_be_undone_safely_is_left_and_said(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    hr_api["create_second"].mock(return_value=error(403, "Missing permission leave:request"))
    # A manager approved the first leave in the meantime: it's no longer ours to cancel.
    hr_api["read_first"].mock(
        side_effect=[
            httpx.Response(200, json=leave()),  # the read-back right after creating it
            httpx.Response(200, json=leave("APPROVED")),  # by the time we'd undo it
        ]
    )

    outcome, _ = await run(graph, http)

    assert not hr_api["cancel"].called
    s2 = outcome.values["results"]["s2"]
    assert s2["status"] == "verified"
    assert s2["compensation"] == "not undone: left as is: it's approved now"


# ---- manager: version conflicts and changes that can't be undone ---------------------------


async def test_the_manager_scenario_works_and_both_changes_are_checked(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter, sneha: SnehaRecord
) -> None:
    outcome, _ = await run(graph, http, scenario="manager")

    assert statuses(outcome) == {"s1": "done", "s2": "done", "s3": "verified", "s4": "verified"}
    assert sneha.record["manager"] == ARUN_REF and sneha.record["location"] == "Pune"


async def test_a_stale_version_is_re_read_and_retried_once(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter, sneha: SnehaRecord
) -> None:
    sneha.refusals = [error(409, STALE)]
    sneha.saved_by_someone_else = True

    outcome, _ = await run(graph, http, scenario="manager")

    first, second, _location = sent(hr_api, "PATCH", f"/employees/{SNEHA_ID}")
    assert json.loads(first.content)["version"] == 1
    assert json.loads(second.content)["version"] == 5
    assert second.headers["idempotency-key"] == first.headers["idempotency-key"] + ":r1"
    assert outcome.values["results"]["s3"]["status"] == "verified"


async def test_a_second_stale_version_is_reported_not_retried_forever(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter, sneha: SnehaRecord
) -> None:
    sneha.refusals = [error(409, STALE), error(409, STALE)]

    outcome, _ = await run(graph, http, scenario="manager")

    assert len(sent(hr_api, "PATCH", f"/employees/{SNEHA_ID}")) == 2  # s4 never sent
    assert outcome.values["results"]["s3"]["error_kind"] == "conflict"
    assert statuses(outcome)["s4"] == "not run"


async def test_a_manager_change_that_didnt_stick_is_a_problem(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter, sneha: SnehaRecord
) -> None:
    sneha.manager_sticks = False

    outcome, _ = await run(graph, http, scenario="manager")

    s3 = outcome.values["results"]["s3"]
    assert s3["status"] == "mismatch"
    assert s3["verification"]["mismatches"][0].startswith("manager_id is ")
    (problem,) = outcome.values["verification"]["problems"]
    assert problem.startswith("s3 (change_manager) ran but didn't check out")
    assert len(sent(hr_api, "PATCH", f"/employees/{SNEHA_ID}")) == 1  # the location wasn't
    assert sneha.record["location"] == SNEHA["location"]


async def test_writes_left_in_place_after_a_failure_are_called_out(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter, sneha: SnehaRecord
) -> None:
    sneha.refuse_location = error(403, "Missing permission employee:update")

    outcome, _ = await run(graph, http, scenario="manager")

    lines = summary(outcome)
    # A manager change has no safe automatic undo: it stays, and the summary says so.
    assert lines["s3"]["status"] == "verified" and lines["s3"]["detail"] == UNDO_NOTE
    assert lines["s4"]["status"] == "failed"
    assert sneha.record["manager"] == ARUN_REF


# ---- the model fails, the run doesn't -----------------------------------------------------


async def test_when_the_llm_is_down_at_the_end_the_result_is_still_reported(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    hr_api["create_second"].mock(return_value=error(403, "Missing permission leave:request"))

    outcome, _ = await run(graph, http, answer=LLMError("provider unavailable"))

    answer = outcome.values["answer"]
    assert answer.startswith("The assistant couldn't write a full answer")
    assert (
        "- s2 create leave request: compensated "
        "(cancelled the leave request this run created)" in answer
    )
    assert "- s3 create leave request: failed" in answer


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
