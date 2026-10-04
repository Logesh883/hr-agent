# M3: Tool calling and the agent loop, by hand

**Status:** done (A3.1–A3.8). Langfuse export was confirmed live on 2026-10-04 (see A3.6). Plan: [AI_AGENT_TASKS.md § M3](../AI_AGENT_TASKS.md#m3-tool-calling-and-the-agent-loop-by-hand-4-days-).

## In one paragraph

M3 turns the agent from "understands a request" (M2) into "answers a question by looking things up". The model gets nine read-only HR tools. It asks for calls; Python validates every call, runs it against the HR API **with the signed-in user's token**, and hands the result back, in a loop that stops at an answer, 8 steps, or a token budget. The HR API's own RBAC decides what each user sees, so the same question gets different, correct answers for HR, a manager and an employee. Every run is recorded as a trace (one generation per LLM call, one span per tool call), masked, and optionally exported to Langfuse. The tools' request and response shapes are generated from the TypeScript contracts (A3.1), so Python and TypeScript can't drift apart silently.

## How it works

```text
POST /agent/ask {question}   (Authorization: Bearer <user's HR token>)
  │
  ├─ GET /auth/me ─────────────► who is asking (role, employee id)
  │
  ▼
agent/loop.py: run_agent  (max 8 steps, 60k-token budget)
  ┌───────────────────────────────────────────────────────────────┐
  │ messages ──► llm.chat(tools=9 specs, temperature 0)           │
  │                 │                                             │
  │       no tool calls? ──► answer, stop                         │
  │                 │ tool calls (run in parallel)                │
  │                 ▼                                             │
  │ tools/registry.py: execute(call)                              │
  │   unknown tool? bad JSON? invalid args? ──► error result      │
  │   asyncio.timeout ──► tool.run(ctx, args)                     │
  │        └── HR API with the user's token ──► 403/404 ──► error │
  │   result (≤ 8000 chars) ──► tool message ──► back to the top  │
  └───────────────────────────────────────────────────────────────┘
  │
  ├─ response: answer, stop_reason, steps (every LLM turn + tool call), usage, trace_id
  └─ background: trace ──► mask ──► Langfuse /api/public/otel/v1/traces (if keys are set)
```

| File | Role |
| --- | --- |
| `packages/contracts/src/*.ts` | Response types the agent reads are now Zod schemas (`leaveBalanceSchema`, …); the TypeScript types are inferred from them. |
| `packages/contracts/scripts/export-json-schemas.mjs` | Puts 30 request and 23 response schemas in one Zod registry and writes `json-schema/api.json`. |
| `apps/ai/contracts/generated.py` | Generated Pydantic models. Never edit by hand; run `pnpm contracts:generate`. |
| `apps/ai/tools/base.py` | `Tool`, `ToolInput`, `ToolContext`, `ToolResult`, `ToolError`, `Risk`; renders a tool's spec for the model. |
| `apps/ai/tools/registry.py` | `ToolRegistry.execute`: validation, timeouts, error wording, result size cap. |
| `apps/ai/tools/hr_read.py` | The nine read-only tools. |
| `apps/ai/agent/loop.py` | `run_agent`: the loop, stop conditions, step records. |
| `apps/ai/agent/ask.py` | Builds the `ask` prompt and runs the loop with the read tools. |
| `apps/ai/prompts/ask.md` | System prompt (`ask@2`). |
| `apps/ai/tracing/trace.py` | In-memory `Trace` and `Observation`. |
| `apps/ai/tracing/masking.py` | Removes tokens, contact details and names before export. |
| `apps/ai/tracing/langfuse.py` | `LangfuseExporter` (plain httpx, OTLP/JSON), `NullExporter`. |
| `apps/ai/app/agent_routes.py` | `POST /agent/ask`. |
| `apps/ai/app/cli.py` | `hr-ai ask "…" --login EMAIL`. |

## A3.1: shared contracts, both directions

The first half (request and query schemas) landed earlier. M3 finished it:

- **Response schemas.** `Employee`, `LeaveBalance`, `LeavePreview`, `LeaveRequest`, `MonthlyAttendance`, `EmployeeOnboarding`, `EmployeeDocument`, `PayrollReport` and the shapes inside them used to be TypeScript `interface`s, which vanish at runtime and can't be exported. Each is now a Zod schema, and the type is `z.infer<typeof schema>`, so there's still exactly one definition. The API and web app compile unchanged. Types the agent doesn't read yet (corrections, audit, policies) are still interfaces.
- **One registry.** Every schema is registered with an id, so `EmployeeRef` is one `$defs` entry referenced with `$ref`, and one Python class, instead of a copy inside every response.
- **Generated code that strict pyright accepts.** `--use-annotated --field-constraints` writes `Annotated[str, Field(max_length=500)]` instead of `constr(max_length=500)` (a function call in a type annotation, which strict pyright rejects: 54 errors before). `--enum-field-as-literal all` gives `Literal["ANNUAL", …]` instead of classes named `Type2`. `--snake-case-field` gives `start_date` with alias `startDate`, matching the rest of the Python code.
- **Generated code that imports.** The first version couldn't be imported at all: `EmailStr` needs `email-validator` (now a dependency), and Zod puts a regex next to `format: date`, which Pydantic refuses to apply to a parsed `date`. The export script drops `pattern` where a `format` already says it.
- **Tools use both directions.** Each tool validates its outgoing query or body with a generated request model (`CreateLeaveRequest`, `LeaveSearchQuery`, …) and validates the API's reply with a generated response model. A field the API stops sending fails loudly in the integration test, instead of reaching the model as a silent `None`.

## A3.2: the tool framework

A tool is data plus one function:

```python
Tool(
    name="get_leave_balances",
    description="An employee's leave balances for a year, per leave type: …",
    input_model=LeaveBalancesInput,   # pydantic, extra="forbid"
    run=get_leave_balances,           # async (ctx, args) -> JSON-able data
    risk=Risk.READ,
    timeout_s=15,
)
```

`ToolRegistry.execute(call, ctx)` is the one place a model's call becomes an action. It always returns a `ToolResult(ok, data, error)`:

| What went wrong | What the model reads |
| --- | --- |
| Tool doesn't exist | `Unknown tool 'delete_employee'. Available tools: search_employee, …` |
| Arguments aren't JSON | `Arguments must be a JSON object (Expecting value).` |
| A name where an id goes | `Invalid arguments: employee_id: Input should be a valid UUID, …` |
| Too slow | `The tool timed out after 15 seconds.` |
| HR API 403 | `You don't have access to that. The HR system refused: Your role (EMPLOYEE) lacks permission: employee:read.` |
| HR API 404 for an employee | `You don't have access to that employee, or no such employee exists.` |
| HR API answered with an unexpected shape | `The HR system returned data in an unexpected format.` (details go to the log, not the model) |
| Any other exception | `The tool failed unexpectedly.` (never a stack trace) |

Results over 8,000 characters are cut, with a note telling the model to narrow the request.

### Design decisions

- **Hand-written tool inputs, generated API models.** The model-facing input (`employee_id`, `leave_type`, `from_date`) is narrow and described for the model; the generated models describe the HTTP API (`page`, `pageSize`, camelCase). Different audiences, so different models; the tool maps one to the other.
- **`spec()` strips pydantic's `title` keys.** They repeat the field name and cost tokens on every call. Descriptions stay: they're how the model learns what to pass.
- **Errors are written for the model.** "Search for the employee first" is something it can act on; `ValidationError: 1 validation error for …` is not.

## A3.3: the nine read tools

| Tool | Endpoint | Returns (trimmed) |
| --- | --- | --- |
| `search_employee` | `GET /employees?q=` | id, name, code, job title, department, location, status |
| `get_employee` | `GET /employees/:id` | profile, manager; **no phone or date of birth** |
| `get_leave_balances` | `GET /employees/:id/leave-balances` | entitled, used, pending, available per type |
| `preview_leave` | `POST /leave-requests/preview` | working days, balance after, plain-language `problems` |
| `list_leave_requests` | `GET /leave-requests` | up to 25, with the total |
| `get_attendance_month` | `GET /attendance/monthly` | per-person counts, up to 25 anomalies, with the total |
| `get_onboarding_status` | `GET /employees/:id/onboarding` | progress, open tasks, missing info |
| `list_employee_documents` | `GET /employees/:id/documents` | type, status, review note |
| `get_payroll_readiness` | `GET /payroll/preparation` | summary, flagged employees only, changes |

Trimming matters twice: every token of a tool result is resent on every later step, and anything sent is sent to a third-party model. The day-by-day attendance grid, for example, is dropped; the anomaly list already says which days matter.

## A3.4: the loop

`run_agent` in `agent/loop.py`, about 100 lines with no framework:

1. Call the model with the conversation and the nine tool specs (temperature 0).
2. No tool calls: that text is the answer. Stop.
3. Otherwise append the assistant turn, run every call **in parallel** (`asyncio.gather`; calls from one turn can't depend on each other because the model hasn't seen any results yet), and append each result as a `tool` message answering its `tool_call_id`, in the order asked.
4. Stop after 8 steps, or once 60,000 tokens have been used. Each step resends the whole conversation, so tokens grow faster than steps.

It returns `AgentRun(answer, stop_reason, steps, usage, trace_id)`. `steps` is the step-by-step record: each LLM turn's text and usage, and each tool call's arguments, result or error and latency.

### Where code decides, not the model

- whether the tool exists, and whether its arguments are valid (`registry.execute`);
- what the user may see: the HR API, given only the user's token;
- what the model is told about failures (the error table above);
- how big a result may get, and when to stop (steps, tokens);
- who "me" is: the system prompt carries the user's own employee id from `/auth/me`, not from anything the model or the user typed.

## A3.5: RBAC through tools

The agent holds no permissions of its own. `tests/test_rbac_tools.py` mocks the API the way the real one behaves, keyed by token, and the integration test checks the real thing:

| Asked by | `search_employee("Arun")` | Sneha's balance | Arun's balance | payroll |
| --- | --- | --- | --- | --- |
| HR | ok | ok | ok | ok |
| Manager (Rahul) | ok | ok (direct report) | ok (direct report) | 403 |
| Employee (Sneha) | 403 (no `employee:read`) | ok (her own) | "no access to that employee" (404) | 403 |

The API answers 404, not 403, for an employee outside the user's scope, so it doesn't reveal who exists. The tool error keeps that ambiguity ("you don't have access to that employee, **or** no such employee exists") so the model can't leak it either.

## A3.6: tracing

`Trace` records one `generation` per LLM call (messages in, text and tool calls out, model, token usage) and one `span` per tool call (arguments in, `ToolResult` out, `WARNING` level on failure). An exception marks its observation `ERROR`. The trace is built in memory and exported **after** the response is sent (FastAPI background task), so a Langfuse outage can't slow down or fail an answer. A failed run is exported too, before the 502.

Before anything leaves the service, `tracing/masking.py` removes:

- credentials, by key (`authorization`, `password`, `token`, …) and by shape (JWTs, `Bearer …`);
- contact details and identifiers: email, phone (international or 10-digit, not dates), PAN;
- **names**: names are collected from HR records in the tool results (fields like `first_name` and `decided_by`, or `name` inside a record that has an `employee_code`) plus the signed-in user's name, then replaced with `[person]` everywhere, including the question, the prompt and the answer.

Ids, dates, employee codes, leave types and counts stay, because they're what you debug with.

The exporter is plain httpx sending OpenTelemetry spans to Langfuse's OTLP endpoint, `POST /api/public/otel/v1/traces`, in the OTLP/HTTP JSON encoding. A trace becomes one root span (type `agent`, carrying the question and answer) with a child span per observation. Langfuse reads its fields from span attributes: `langfuse.observation.type` (`generation` / `span`), `langfuse.observation.input` / `.output`, `.model.name`, `.usage_details` (`{"input": …, "output": …}`), `.level`, and the trace-level `langfuse.trace.name`, `langfuse.user.id` and `langfuse.trace.tags`, which go on every span because Langfuse builds the trace from its spans. Ids follow OpenTelemetry: 32 hex characters for a trace, 16 for a span. The header `x-langfuse-ingestion-version: 4` makes data readable straight away. A rejected span comes back as `partialSuccess` in a 200, so that's logged as a failure too. With no keys, `NullExporter` does nothing, and the steps are still in the API response.

**Switched on** with `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` (or the older `LANGFUSE_HOST`) in the root `.env`. To read traces back from a script, use `GET /api/public/v2/observations?fromStartTime=…&toStartTime=…&fields=core,basic,io,usage,model`. Without `io` in `fields`, input and output come back as `null`, which looks like the masking ate everything.

## A3.7: tests

| File | What it covers |
| --- | --- |
| `test_tool_registry.py` | spec rendering, unknown tool, bad JSON, invalid args (string for a date, extra field), timeout, every HR error mapping, truncation |
| `test_hr_read_tools.py` | each tool's endpoint, camelCase params and body, forwarded token, trimmed output, a contract-breaking response |
| `test_agent_loop.py` | search → balance → answer, parallel calls, bad calls recovered, step limit, token budget, empty reply, trace shape |
| `test_rbac_tools.py` | A3.5's table, with a token-aware mocked API |
| `test_tracing.py` | masking rules, OTLP span tree and attributes, error status, basic auth + ingestion header, export failures (incl. `partialSuccess`) logged and swallowed |
| `test_ask_route.py` | 401 without a token, full answer with steps, role check, 502 on model failure (still traced) |
| `test_integration_hr_api.py` | every tool and the loop against the **real** API on `hr_test`, as HR, manager and employee; skipped unless `HR_TEST_API_URL` is set |

`FakeLLM` scripts the model's tool calls, so the loop is tested deterministically. The model's judgement is checked live (below), and from M10 by evals.

## Try it

```bash
# HR API on hr_test (see the docstring in tests/test_integration_hr_api.py), then:
cd apps/ai
export HR_API_URL=http://localhost:4100 HR_PASSWORD='Password123!'
uv run hr-ai ask "How many annual leave days does Sneha have left?" --login employee@hr.local
HR_TEST_API_URL=http://localhost:4100 uv run pytest -k integration
```

### Live check (2026-10-03, Groq `qwen/qwen3.8-27b`, `hr_test` seed)

| Asked by | Question | Tools called | Answer |
| --- | --- | --- | --- |
| HR | How many annual leave days does Sneha have left? | search → balances | 13 available (18 entitled, 5 pending) ✅ |
| Manager | same | search → balances | same ✅ |
| Employee (Sneha) | same | balances (her own id, no search) | "You have 13 …" ✅ |
| Manager | Who on my team has attendance anomalies this month? | attendance (no employee id) | 5 reports + himself, missing record on 1 Oct ✅ |
| Employee | same | attendance | "Your account can only see your own attendance", plus her own anomaly ✅ |
| HR | Why can't Sneha take 20 days off in February? | search → preview (Feb 1–26) | 20 working days needed, 18 available ✅ (after the fixes below) |
| Manager | same | search → preview (403) → balances | explains the shortfall from balances and says it couldn't preview for someone else ✅ |

`POST /agent/ask` over HTTP: the same answer for the manager; 401 without a token. About 7.5k tokens for a two-tool question; around 2.3k of that is the system prompt and tool specs, resent on every step.

## What happened along the way

- **A3.1's generated file had never been imported.** CI checked that it regenerated identically, but nothing imported it: strict pyright reported 54 errors, it needed `email-validator`, and date fields crashed on a regex. Lesson: also test that generated code runs. `test_hr_read_tools.py` now does, on every run.
- **An old test was failing.** `test_parse_request_rejects_output_that_breaks_the_schema` predates A2.3's retry. Replaced with two tests: the retry succeeds; two bad outputs give `unknown` plus a question.
- **The phone mask ate dates.** `2026-10-12` matched `\+?\d[\d -]{8,}\d`. The test "keeps ids, dates and numbers" caught it; the pattern now needs a `+` country code or exactly 10 digits.
- **"20 days off in February" (prompt v1).** The model previewed Feb 1–20 (15 working days, no problems), then invented a reason. Prompt `ask@2`: leave counts working days, so extend the range until the preview covers N; and give only reasons a tool returned.
- **The answer described the wrong person.** Under `ask@2` the model passed `employee_id: null`, so `preview_leave` checked the *HR user's own* leave and the answer called it Sneha's. Both have 18 days, so the numbers looked right. Fixed in code, not the prompt: `employee_id` is now required. Defaults like "omit for yourself" are dangerous in tool schemas, because a dropped argument silently changes *whose* data you get.

- **The first Langfuse export used an API that's being shut down.** It was written against the batch ingestion API (`/api/public/ingestion`). The first live export succeeded, but the response carried a `_deprecation` notice: on Langfuse Cloud that API stops accepting traces on 2026-11-16, and organisations created after 2026-09-16 can't read traces through the old `GET /api/public/traces/:id` either. Rewritten to OTLP the same day. Lesson: read the whole response body, not just the status code; a 207 with no errors still had something to say.
- **The env var name didn't match.** Langfuse's docs now say `LANGFUSE_BASE_URL`; the settings read `LANGFUSE_HOST`. Both are accepted now.

### Langfuse live check (2026-10-04)

Manager asks "Who on my team has attendance anomalies this month?": Langfuse shows one trace with `AGENT agent.ask` → `GENERATION llm step 1` (2,363 in / 36 out tokens, `qwen/qwen3.8-27b`) → `SPAN tool get_attendance_month` → `GENERATION llm step 2` (3,231 / 169). Every employee name in tool output and in the answer appears as `[person]`; employee codes and ids are kept.

## Check yourself

<details>
<summary>Draw the loop from memory. Where exactly does your code, not the model, make a decision?</summary>

See the diagram at the top. Code decides at every arrow except "which tool, with which arguments": whether the tool exists and the arguments are valid (`registry.execute`), what the user may see (the HR API with their token), how failures are described, how much of a result goes back, who "me" is (from `/auth/me`), and when to stop (an answer, 8 steps, 60k tokens).
</details>

<details>
<summary>What happens if the model calls a tool that doesn't exist, or passes a string where a date is needed?</summary>

Neither reaches the HR API. The registry returns `ok: false` with `Unknown tool 'x'. Available tools: …` or `Invalid arguments: start_date: Input should be a valid date…` as the tool message. The loop continues and the model gets a chance to correct itself; `test_bad_tool_calls_go_back_to_the_model_as_errors` scripts exactly that.
</details>

<details>
<summary>Why is forwarding the user's token safer than giving the agent an admin key?</summary>

With an admin key, the only thing between an employee and everyone's payroll data would be the model following its instructions, and prompt injection or a plain mistake breaks that. With the user's token, the HR API enforces the same RBAC, data scope, business rules and audit trail as the web app: the agent can never see or do more than the person asking. The worst a confused model can do is ask for something and be told no.
</details>

<details>
<summary>Experiment: make one tool description vague, and watch tool selection get worse.</summary>

Try changing `preview_leave`'s description to "Leave tool." and asking "Why can't Sneha take 20 days off in February?". Expect the model to answer from `get_leave_balances` alone, as the manager run did when the preview was refused, and miss problems only the preview finds (overlaps, holidays, too far back). Compare the steps in the two runs.
</details>

## Next

M4 adds RAG over HR policies: a `search_policies` tool joins this registry, so the same loop can answer "How many sick days do we get?" with citations. M6 adds write tools (`Risk.WRITE`) behind human approval.
