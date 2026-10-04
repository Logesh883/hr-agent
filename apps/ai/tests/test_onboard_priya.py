"""A6.6 in CI: "Onboard Priya as a Software Engineer joining October 12, reporting to Rahul
in Bangalore." FakeLLM scripts the model, respx stands in for the HR API.

The run asks for what nobody gave (last name, email), resolves Rahul and Engineering,
pauses for approval of the new employee with a before → after preview, creates her with
an idempotency key, starts onboarding and reports what's still missing.
"""

import json
from collections.abc import AsyncIterator, Iterator
from datetime import date
from typing import Any, cast

import httpx
import pytest
import respx
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.runtime import Runtime as LgRuntime
from respx.models import Call

from app.hr_client import HrApiClient, SessionUser
from graphs.hr_agent import HrContext, HrState, build_hr_graph
from graphs.runner import HrGraph, resume_run, start_run
from llm.fake import FakeLLM
from tests.hr_data import BASE_URL, ENG_ID, RAHUL_ID, employee, page, ref, session_user
from tests.test_hr_graph import Events, parse, plan_json
from tools.base import ToolContext
from tracing.trace import Trace

PRIYA_ID = "5c0b1f8e-0000-4000-8000-0000000000b1"
REQUEST = (
    "Onboard Priya as a Software Engineer joining October 12, reporting to Rahul in Bangalore."
)
RAHUL = employee(ref(RAHUL_ID, "Rahul", "Sharma", "EMP002"), jobTitle="Engineering Manager")
PRIYA = employee(
    ref(PRIYA_ID, "Priya", "Rao", "EMP-0042"),
    email="priya.rao@acme.example",
    joiningDate="2026-10-12",
    status="PROBATION",
    phone=None,
)

PARSE = parse(
    "onboard_employee",
    people=["Priya"],
    job_title="Software Engineer",
    joining_date="2026-10-12",
    manager="Rahul",
    location="Bangalore",
)
PLAN_DRAFT = plan_json(
    ("s1", "search_employee", {"query": "Priya"}),
    ("s2", "search_employee", {"query": "Rahul"}),
    ("s3", "list_departments", {"name": "Engineering"}),
    (
        "s4",
        "create_employee",
        {
            "first_name": "Priya",
            "last_name": "?",
            "email": "?",
            "job_title": "Software Engineer",
            "department_id": "$s3.departments.0.id",
            "manager_id": "$s2.employees.0.id",
            "location": "Bangalore",
            "joining_date": "2026-10-12",
        },
    ),
    ("s5", "start_onboarding", {"employee_id": "$s4.id"}),
    goal="Create Priya's employee record and start her onboarding",
)
PLAN = json.dumps(
    {
        **json.loads(PLAN_DRAFT),
        "steps": [
            s | {"risk": "write"} if s["tool"] in ("create_employee", "start_onboarding") else s
            for s in json.loads(PLAN_DRAFT)["steps"]
        ],
    }
)


def onboarding() -> dict[str, Any]:
    return {
        "employee": {
            "id": PRIYA_ID,
            "employeeCode": "EMP-0042",
            "firstName": "Priya",
            "lastName": "Rao",
            "jobTitle": "Software Engineer",
            "joiningDate": "2026-10-12",
            "departmentName": "Engineering",
        },
        "started": True,
        "tasks": [
            {
                "id": "5c0b1f8e-0000-4000-8000-0000000000d1",
                "title": "Upload PAN card",
                "description": None,
                "category": "DOCUMENTS",
                "assignee": "EMPLOYEE",
                "dueDate": "2026-10-12",
                "status": "PENDING",
                "requiredDocumentType": "PAN_CARD",
                "completedAt": None,
                "completedBy": None,
                "notes": None,
                "isOverdue": False,
                "canUpdate": True,
            }
        ],
        "progress": {"total": 9, "done": 0, "skipped": 0, "overdue": 0, "percent": 0.0},
        "missingInfo": [
            {"code": "PHONE", "message": "Phone number is missing"},
            {"code": "DOCUMENTS", "message": "ID proof, PAN card and bank details not uploaded"},
        ],
        "canStart": False,
    }


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(base_url=BASE_URL) as client:
        yield client


@pytest.fixture
def hr_api() -> Iterator[respx.MockRouter]:
    with respx.mock(base_url=BASE_URL, assert_all_called=False) as api:
        api.get("/employees", params={"q": "Priya"}).respond(json=page())
        api.get("/employees", params={"q": "Rahul"}).respond(json=page(RAHUL))
        api.get(f"/employees/{RAHUL_ID}").respond(json=RAHUL)
        api.get("/departments").respond(
            json=[
                {
                    "id": ENG_ID,
                    "name": "Engineering",
                    "code": "ENG",
                    "status": "ACTIVE",
                    "employeeCount": 9,
                }
            ]
        )
        api.get(f"/departments/{ENG_ID}").respond(json={"id": ENG_ID, "name": "Engineering"})
        api.post("/employees").respond(201, json=PRIYA)
        api.post(f"/employees/{PRIYA_ID}/onboarding").respond(201, json=onboarding())
        # Read back after each write (A7.2).
        api.get(f"/employees/{PRIYA_ID}").respond(
            json=PRIYA
            | {
                "department": {"id": ENG_ID, "name": "Engineering"},
                "manager": ref(RAHUL_ID, "Rahul", "Sharma", "EMP002"),
            }
        )
        api.get(f"/employees/{PRIYA_ID}/onboarding").respond(json=onboarding())
        yield api


def requests(api: respx.MockRouter, method: str, path: str) -> list[httpx.Request]:
    calls = cast(list[Call], list(api.calls))
    return [c.request for c in calls if c.request.method == method and c.request.url.path == path]


def context(http: httpx.AsyncClient, llm: FakeLLM) -> HrContext:
    user = SessionUser.model_validate(session_user("HR_OPS", "Lakshmi Pillai", None))
    tools = ToolContext(
        hr=HrApiClient(http, "hr-token", agent_run_id="5c0b1f8e-0000-4000-8000-0000000000c1"),
        user=user,
        today=date(2026, 10, 4),
    )
    return HrContext(llm=llm, tools=tools, trace=Trace(name="agent.run"))


@pytest.fixture
def graph() -> HrGraph:
    return build_hr_graph(InMemorySaver())


async def run_until_approval(
    graph: HrGraph, http: httpx.AsyncClient, llm: FakeLLM
) -> dict[str, Any]:
    first = await start_run(graph, "priya", REQUEST, context(http, llm), Events())
    assert first.question == {
        "type": "value",
        "question": "What is Priya's last name? I won't guess it.",
        "step": "s4",
        "argument": "last_name",
        "error": None,
    }
    second = await resume_run(graph, "priya", "Rao", context(http, llm), Events())
    assert second.question is not None
    assert (
        second.question["question"] == "What is Priya Rao's work email address? I won't guess it."
    )
    approval = await resume_run(
        graph, "priya", "priya.rao@acme.example", context(http, llm), Events()
    )
    assert approval.status == "waiting" and approval.question is not None
    return approval.question


async def test_onboard_priya_with_approval(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    llm = FakeLLM(
        [PARSE, PLAN, "Priya Rao is created and onboarding has started. Missing: phone, documents."]
    )

    approval = await run_until_approval(graph, http, llm)

    # What the approver sees: the write, its risk, before → after with names, not ids.
    assert approval["type"] == "approval" and approval["tool"] == "create_employee"
    assert approval["risk"] == "medium"
    assert approval["before"] is None
    assert approval["after"] == {
        "name": "Priya Rao",
        "email": "priya.rao@acme.example",
        "job_title": "Software Engineer",
        "department": "Engineering",
        "manager": "Rahul Sharma",
        "location": "Bangalore",
        "joining_date": "2026-10-12",
        "employment_type": "FULL_TIME",
        "status": "PROBATION",
    }
    assert [s["tool"] for s in approval["plan"]] == [
        "search_employee",
        "search_employee",
        "list_departments",
        "create_employee",
        "start_onboarding",
    ]
    # Nothing has been written yet.
    assert requests(hr_api, "POST", "/employees") == []

    events = Events()
    done = await resume_run(graph, "priya", {"decision": "approve"}, context(http, llm), events)

    assert done.status == "completed"
    (create,) = requests(hr_api, "POST", "/employees")
    body = json.loads(create.content)
    assert body["lastName"] == "Rao" and body["email"] == "priya.rao@acme.example"
    assert body["departmentId"] == ENG_ID and body["managerId"] == RAHUL_ID
    assert create.headers["idempotency-key"].endswith(":s4")
    assert create.headers["x-agent-run-id"] == "5c0b1f8e-0000-4000-8000-0000000000c1"
    (start,) = requests(hr_api, "POST", f"/employees/{PRIYA_ID}/onboarding")
    assert start.headers["idempotency-key"].endswith(":s5")  # low risk: no approval asked
    results = done.values["results"]
    assert results["s5"]["data"]["missing_info"][0]["message"] == "Phone number is missing"
    assert done.values["approvals"]["s4"]["decision"] == "approved"
    assert "approval_decided" in events.kinds()
    # Approving again, quickly, finds nothing waiting: still one employee.
    again = await resume_run(graph, "priya", {"decision": "approve"}, context(http, llm), Events())
    assert again.status == "completed"
    assert len(requests(hr_api, "POST", "/employees")) == 1


async def test_a_rejection_stops_every_write_after_it(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    llm = FakeLLM([PARSE, PLAN, "Nothing was created: you rejected it."])
    await run_until_approval(graph, http, llm)

    done = await resume_run(
        graph,
        "priya",
        {"decision": "reject", "comment": "wait for the offer letter"},
        context(http, llm),
        Events(),
    )

    assert done.status == "completed"
    assert requests(hr_api, "POST", "/employees") == []
    assert requests(hr_api, "POST", f"/employees/{PRIYA_ID}/onboarding") == []
    assert done.values["results"]["s4"]["status"] == "rejected"
    assert "s5" not in done.values["results"]
    assert any("not run: stopped" in f for f in done.values["verification"]["findings"])
    respond_prompt = llm.calls[-1].messages[1].content or ""
    assert "rejected by the user, comment: wait for the offer letter" in respond_prompt


async def test_an_edit_changes_exactly_what_runs(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    llm = FakeLLM([PARSE, PLAN, "Created."])
    await run_until_approval(graph, http, llm)
    senior = PRIYA | {
        "jobTitle": "Senior Software Engineer",
        "department": {"id": ENG_ID, "name": "Engineering"},
        "manager": ref(RAHUL_ID, "Rahul", "Sharma", "EMP002"),
    }
    hr_api.get(f"/employees/{PRIYA_ID}").respond(json=senior)

    await resume_run(
        graph,
        "priya",
        {"decision": "edit", "arguments": {"job_title": "Senior Software Engineer"}},
        context(http, llm),
        Events(),
    )

    (create,) = requests(hr_api, "POST", "/employees")
    assert json.loads(create.content)["jobTitle"] == "Senior Software Engineer"


async def test_anything_but_a_clear_yes_is_a_no(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    llm = FakeLLM([PARSE, PLAN, "Not created."])
    await run_until_approval(graph, http, llm)

    done = await resume_run(graph, "priya", "hmm, maybe", context(http, llm), Events())

    assert done.values["approvals"]["s4"]["decision"] == "rejected"
    assert requests(hr_api, "POST", "/employees") == []


async def test_a_write_needing_approval_never_runs_without_one(http: httpx.AsyncClient) -> None:
    from graphs.hr_agent import execute_step
    from graphs.plan import plan_hash

    plan = json.loads(PLAN)
    state: dict[str, Any] = {
        "request": REQUEST,
        "plan": plan,
        "plan_hash": plan_hash(plan),
        "risks": {"s4": "medium"},
        "results": {s: {"ok": True, "status": "done"} for s in ("s1", "s2", "s3")},
    }

    class Runtime:
        context = context(http, FakeLLM())

    with pytest.raises(RuntimeError, match="needs approval and has none"):
        # Calls the node directly, the way LangGraph would, with only what it reads.
        await execute_step(cast(HrState, state), cast(LgRuntime[HrContext], Runtime()))


async def test_an_id_placeholder_goes_back_to_the_planner_not_to_the_user(
    http: httpx.AsyncClient, graph: HrGraph, hr_api: respx.MockRouter
) -> None:
    asks_for_an_id = json.loads(PLAN)
    asks_for_an_id["steps"][3]["arguments"]["department_id"] = "?"
    llm = FakeLLM([PARSE, json.dumps(asks_for_an_id), PLAN, "…"])

    first = await start_run(graph, "ids", REQUEST, context(http, llm), Events())

    # The second plan (with the lookup) was used, and the user was asked only for real values.
    assert first.question is not None and first.question["argument"] == "last_name"
    retry_prompt = llm.calls[2].messages[1].content or ""
    assert "'department_id' is an id; get it from a lookup" in retry_prompt
