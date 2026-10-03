"""Resolve names and departments through model-selected, read-only HR tools.

The model decides which lookup tool to call. Python validates the tool arguments, executes
the corresponding HR API request with the signed-in user's token, and returns the result to
the model. Ambiguous matches stop the loop so the model cannot guess which record to use.
"""

import json
from datetime import date
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.hr_client import Department, Employee, HrApiClient, HrApiError, HrApiUnavailableError
from intent.schema import Intent, ParsedRequest
from llm.base import LLMClient
from llm.types import Message, PromptRef, ToolCall, ToolSpec

MAX_TOOL_STEPS = 8
TOOL_PROMPT = PromptRef(name="entity-resolution", version="1")


class _ToolArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SearchArgs(_ToolArgs):
    query: str = Field(min_length=1)


class PendingLeaveArgs(_ToolArgs):
    employee_id: str | None


TOOLS: list[ToolSpec] = [
    {
        "type": "function",
        "function": {
            "name": "search_employees",
            "description": (
                "Resolve a named employee or manager. Search by the name as written. "
                "Use this before referring to any employee record or leave request."
            ),
            "parameters": SearchArgs.model_json_schema(),
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_departments",
            "description": (
                "Resolve a department mentioned by name or code. Use this before referring "
                "to a department record."
            ),
            "parameters": SearchArgs.model_json_schema(),
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_pending_leave_requests",
            "description": (
                "List pending leave requests this signed-in user may decide. For a named "
                "employee, first call search_employees and pass that unique result's id. "
                "The parsed request's leave type and dates are applied automatically."
            ),
            "parameters": PendingLeaveArgs.model_json_schema(),
        },
    },
]


class EntityResolutionResult(BaseModel):
    answer: str
    # When present, the agent paused for a human to choose and did not run dependent tools.
    waiting_for_user: bool = False
    candidates: list[dict[str, str]] = []
    candidate_query: str | None = None
    resolved_employee_ids: dict[str, str] = {}
    resolved_department_ids: dict[str, str] = {}


async def resolve_entities_with_tools(
    llm: LLMClient,
    hr: HrApiClient,
    parsed: ParsedRequest,
    request: str,
    *,
    today: date,
    human_selected_candidate: dict[str, str] | None = None,
    human_selected_department: dict[str, str] | None = None,
    human_selected_query: str | None = None,
) -> EntityResolutionResult:
    """Run a bounded tool-calling loop for employee, manager and department lookups."""
    messages = [
        Message.system(
            "Resolve the names and departments in the structured HR request using the tools. "
            "Never invent an id. Search every named person and manager, and search a stated "
            "department. If the employee search returns multiple candidates, do not select one; "
            "the application will ask HR to choose. For approve_leave, first resolve a named "
            "employee, then call list_pending_leave_requests with that employee's id. Do not "
            "claim an approval happened: these tools only look up records. Use the parsed dates "
            "for relative phrases such as 'today'. If several leave requests match, list them "
            "and ask HR which one; do not choose. If a required lookup returns no result, say so.\n"
            f"Today's date: {today.isoformat()}\n"
            f"Parsed request: {parsed.model_dump_json()}"
            + (
                "\nHR explicitly selected this employee from the search candidates: "
                f"{json.dumps(human_selected_candidate, ensure_ascii=False)}. Use this record's "
                "id for dependent tools; do not ask HR to choose the person again."
                if human_selected_candidate
                else ""
            )
            + (
                "\nHR explicitly selected this department from the search candidates: "
                f"{json.dumps(human_selected_department, ensure_ascii=False)}. Use this record's "
                "id; do not ask HR to choose the department again."
                if human_selected_department
                else ""
            )
        ),
        Message.user(request),
    ]
    employees: dict[str, list[Employee]] = {}
    departments: dict[str, list[Department]] = {}
    selected_aliases: dict[str, dict[str, str]] = {}
    if human_selected_candidate:
        selected_aliases = {
            value.casefold(): human_selected_candidate
            for value in (
                human_selected_query or "",
                human_selected_candidate.get("full_name", ""),
                human_selected_candidate.get("employee_code", ""),
            )
            if value
        }
    selected_department_aliases: dict[str, dict[str, str]] = {}
    if human_selected_department:
        selected_department_aliases = {
            value.casefold(): human_selected_department
            for value in (
                human_selected_query or "",
                human_selected_department.get("name", ""),
                human_selected_department.get("code", ""),
            )
            if value
        }
    tool_calls_made = 0
    available_tools = [
        tool
        for tool in TOOLS
        if tool["function"]["name"] != "list_pending_leave_requests"
        or parsed.intent is Intent.APPROVE_LEAVE
    ]

    for _ in range(MAX_TOOL_STEPS):
        response = await llm.chat(
            messages,
            tools=available_tools,
            temperature=0,
            max_tokens=1200,
            prompt=TOOL_PROMPT,
        )
        if not response.tool_calls:
            if not tool_calls_made:
                return EntityResolutionResult(
                    answer="I couldn't resolve the HR records because the model did not request a lookup."
                )
            return EntityResolutionResult(
                answer=response.text or "I couldn't resolve the requested HR records.",
                resolved_employee_ids={
                    query: matches[0].id for query, matches in employees.items() if len(matches) == 1
                }
                | (
                    {human_selected_query.casefold(): human_selected_candidate["id"]}
                    if human_selected_candidate and human_selected_query
                    else {}
                ),
                resolved_department_ids={
                    query: matches[0].id
                    for query, matches in departments.items()
                    if len(matches) == 1
                }
                | (
                    {human_selected_query.casefold(): human_selected_department["id"]}
                    if human_selected_department and human_selected_query
                    else {}
                ),
            )

        messages.append(
            Message(
                role="assistant",
                content=response.text,
                tool_calls=response.tool_calls,
            )
        )
        for call in response.tool_calls:
            tool_calls_made += 1
            try:
                output, candidates = await _run_tool(
                    call,
                    hr,
                    parsed,
                    employees,
                    departments,
                    selected_aliases,
                    selected_department_aliases,
                )
            except ValidationError as error:
                output = {"error": f"Invalid tool arguments: {_error_summary(error)}"}
                candidates = []
            except (HrApiError, HrApiUnavailableError) as error:
                output = {"error": str(error)}
                candidates = []
            messages.append(
                Message.tool(call.id, json.dumps(output, default=str, ensure_ascii=False))
            )
            if candidates:
                prompt = _ambiguity_question(call, candidates)
                return EntityResolutionResult(
                    answer=prompt,
                    waiting_for_user=True,
                    candidates=candidates,
                    candidate_query=(
                        _call_query(call)
                        if call.name in {"search_employees", "search_departments"}
                        else None
                    ),
                )

    return EntityResolutionResult(
        answer="I couldn't finish resolving the HR records. Please narrow the request and try again."
    )


async def _run_tool(
    call: ToolCall,
    hr: HrApiClient,
    parsed: ParsedRequest,
    employees: dict[str, list[Employee]],
    departments: dict[str, list[Department]],
    selected_aliases: dict[str, dict[str, str]],
    selected_department_aliases: dict[str, dict[str, str]],
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    try:
        raw = json.loads(call.arguments)
    except json.JSONDecodeError:
        return {"error": "Arguments must be valid JSON."}, []

    if call.name == "search_employees":
        args = SearchArgs.model_validate(raw)
        found = await hr.search_employees(args.query)
        matches = _prefer_exact_employee_matches(args.query, found)
        selected = selected_aliases.get(args.query.strip().casefold())
        if selected:
            matches = [employee for employee in matches if employee.id == selected["id"]]
        employees[args.query.casefold()] = matches
        records = [_employee_record(employee) for employee in matches]
        return {"employees": records}, records if len(records) > 1 else []

    if call.name == "search_departments":
        args = SearchArgs.model_validate(raw)
        found = [
            department
            for department in await hr.list_departments()
            if department.status == "ACTIVE"
        ]
        matches = _match_departments(args.query, found)
        selected = selected_department_aliases.get(args.query.strip().casefold())
        if selected:
            matches = [department for department in matches if department.id == selected["id"]]
        departments[args.query.casefold()] = matches
        records = [_department_record(department) for department in matches]
        return {"departments": records}, records if len(records) > 1 else []

    if call.name == "list_pending_leave_requests":
        args = PendingLeaveArgs.model_validate(raw)
        if parsed.entities.people and not args.employee_id:
            return {"error": "Resolve the named employee first and use their returned id."}, []
        if args.employee_id and args.employee_id not in {
            employee.id for result in employees.values() for employee in result
        } | {candidate["id"] for candidate in selected_aliases.values()}:
            return {"error": "Search for this employee first; use an id returned by that tool."}, []
        overlapping = None
        if parsed.entities.start_date:
            overlapping = (
                parsed.entities.start_date,
                parsed.entities.end_date or parsed.entities.start_date,
            )
        requests = await hr.pending_leave_to_decide(
            employee_id=args.employee_id,
            leave_type=parsed.entities.leave_type,
            overlapping=overlapping,
        )
        return {
            "pending_requests": [
                {
                    "id": item.id,
                    "employee": item.employee.full_name,
                    "type": item.type,
                    "start_date": item.start_date.isoformat(),
                    "end_date": item.end_date.isoformat(),
                    "days": item.days,
                }
                for item in requests
            ]
        }, []

    return {"error": f"Unknown tool: {call.name}"}, []


def _prefer_exact_employee_matches(query: str, employees: list[Employee]) -> list[Employee]:
    wanted = query.strip().casefold()
    exact = [
        employee
        for employee in employees
        if wanted
        in {
            employee.first_name.casefold(),
            employee.last_name.casefold(),
            employee.full_name.casefold(),
        }
    ]
    return exact or employees


def _match_departments(query: str, departments: list[Department]) -> list[Department]:
    wanted = query.strip().casefold()
    exact = [
        department
        for department in departments
        if wanted in {department.name.casefold(), department.code.casefold()}
    ]
    if exact:
        return exact
    return [
        department
        for department in departments
        if wanted in department.name.casefold() or wanted in department.code.casefold()
    ]


def _employee_record(employee: Employee) -> dict[str, str]:
    return {
        "id": employee.id,
        "full_name": employee.full_name,
        "employee_code": employee.employee_code,
        "job_title": employee.job_title,
        "location": employee.location,
    }


def _call_query(call: ToolCall) -> str | None:
    try:
        return SearchArgs.model_validate_json(call.arguments).query
    except ValueError:
        return None


def _department_record(department: Department) -> dict[str, str]:
    return {"id": department.id, "name": department.name, "code": department.code}


def _ambiguity_question(call: ToolCall, candidates: list[dict[str, str]]) -> str:
    if call.name == "search_departments":
        lines = [
            f"{index}. {item['name']} ({item['code']})"
            for index, item in enumerate(candidates, 1)
        ]
        return f"I found multiple matching departments:\n{chr(10).join(lines)}\nWhich one?"
    lines = [
        f"{index}. {item['full_name']} ({item['employee_code']}, {item['job_title']}, {item['location']})"
        for index, item in enumerate(candidates, 1)
    ]
    return f"I found multiple people matching that name:\n{chr(10).join(lines)}\nWhich one?"


def _error_summary(error: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
        for item in error.errors(include_input=False)
    )
