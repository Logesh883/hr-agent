# M2: Prompting and structured outputs

**Status:** in progress. Done: A2.1. Next: A2.2 (intent prompt). Plan: [AI_AGENT_TASKS.md § M2](../AI_AGENT_TASKS.md#m2-prompting-and-structured-outputs-understanding-requests-3-days).

## In one paragraph

M2 turns a free-text request ("Onboard Priya as a Software Engineer joining October 12, reporting to Rahul in Bangalore") into a validated Python object: **what** the user wants (the intent) and **what they mentioned** (the entities). Everything after this (tool calls in M3, workflows in M5) works from that object, not from raw text. The model only reads and classifies. Code decides what's missing, turns names into ids, and decides whether to act or ask.

## A2.1: the `ParsedRequest` schema

**File:** `apps/ai/intent/schema.py`. **Tests:** `apps/ai/tests/test_intent_schema.py`.

### The shape

```text
ModelParse                      ← what the model returns (its JSON schema is sent to the model)
├── intent: Intent              ← one of 12 values, e.g. "onboard_employee"
├── entities: Entities
│   ├── people: [str]           ← names as written; empty = the requester ("my leave")
│   ├── job_title, department, manager, location: str | null
│   ├── leave_type: ANNUAL | SICK | CASUAL | UNPAID | null        ← the API's own values
│   ├── document_type: OFFER_LETTER | ID_PROOF | … | null          ← the API's own values
│   └── joining_date, start_date, end_date: YYYY-MM-DD | null
├── confidence: 0..1
└── clarifying_question: str | null

ParsedRequest = ModelParse + missing_fields   ← added by code, never by the model
```

Example, for the spec's onboarding request:

```json
{
  "intent": "onboard_employee",
  "entities": {"people": ["Priya"], "job_title": "Software Engineer", "manager": "Rahul",
               "location": "Bangalore", "joining_date": "2026-10-12", "department": null, …},
  "confidence": 0.95,
  "clarifying_question": null
}
```

→ `ParsedRequest.from_model(...)` → `missing_fields: []`, `needs_clarification: False`.

### The 12 intents

| Intent | Meaning | Required before acting |
| --- | --- | --- |
| `onboard_employee` | Add a new hire and start their onboarding | people, job_title, joining_date, location |
| `update_employee` | Change job title, department, manager or location | people |
| `find_employees` | Search or list employees | – |
| `request_leave` | Apply for leave | leave_type, start_date |
| `approve_leave` | Act on someone's pending leave | people |
| `leave_balance` | Leave days left | – (empty people = the requester) |
| `attendance_review` | Attendance, anomalies, missing punches | – |
| `attendance_correction` | Fix one day's attendance | start_date |
| `document_status` | Submitted / verified / missing documents | – |
| `policy_question` | Answered by HR policy (RAG, M4) | – |
| `payroll_readiness` | Is payroll ready, what blocks it | – |
| `unknown` | Not HR operations, or too unclear | – |

`needs_clarification` is true when the intent is `unknown`, a required field is missing, or `confidence < 0.6`. Then the agent asks instead of acting.

### Design decisions

| Decision | Why | Rejected |
| --- | --- | --- |
| **`missing_fields` computed in code** (`REQUIRED_FIELDS` table), not returned by the model | "The LLM proposes; code decides." A model can claim nothing is missing; a table can't. It's also testable and the same every time. | Asking the model to list missing fields |
| **Two classes**: `ModelParse` (model output) and `ParsedRequest` (+ code's additions) | The schema sent to the model must not contain fields the model shouldn't fill. A test checks `missing_fields` isn't in it. | One class with the model told to leave a field alone |
| **Names, not ids**, in entities | The model can't know ids and would invent them (a plan pitfall). A2.4 resolves names against the HR API in code, and asks when "Rahul" matches two people. | `manager_id` in the schema |
| **Separate `joining_date` vs `start_date`/`end_date`** | Onboarding's date means something different from a leave range; separate fields make evaluation (A2.6) exact | One generic `dates` list |
| **Leave and document types use the API's enums** (`ANNUAL`, `PAN_CARD`, …) | Values pass straight into API calls; field descriptions map synonyms (earned/privilege leave → `ANNUAL`, loss of pay → `UNPAID`). A test reads `packages/contracts` and fails if the TypeScript enums change. | Free text ("earned leave") mapped later |
| **Added `document_type`** (not in the plan's entity list) | `document_status` requests often name one ("has Arjun's PAN card been verified?") | |
| **Strict-mode compatible schema**: `extra="forbid"` + every field required in the JSON schema | Strict structured-output modes require `additionalProperties: false` and all properties listed as required. Python defaults still keep tests short (`json_schema_serialization_defaults_required`). | Optional fields (rejected by strict mode) |
| **Validation messages written for the model** ("end_date 2026-10-02 is before start_date 2026-10-05") | A2.3 sends validation errors back to the model to fix its answer, so the message must say exactly what's wrong | Default pydantic messages only |
| **Field descriptions in the schema** | The model reads them. They're the first line of prompt engineering, e.g. "Never a manager: see manager". | Explaining fields only in the prompt |

### Tested

- Output schema is strict-compatible: every object has `additionalProperties: false`, and all properties are required.
- `LeaveType` / `DocumentType` equal `LEAVE_TYPES` / `DOCUMENT_TYPES` in `packages/contracts`.
- Every intent has a description and a `REQUIRED_FIELDS` entry.
- Missing fields and `needs_clarification`, including "empty `people` means the requester".
- Rejected: end before start, end without start, unknown leave type, un-normalised dates ("next Friday"), extra keys such as `employee_id`, unknown intents, confidence above 1, a model trying to set `missing_fields`.

### Live check (2026-09-29, Groq, strict `json_schema`, one-line instruction, no examples)

Both models accepted the strict schema (including `format: date` and the 0–1 bounds on confidence).

| Request | `openai/gpt-oss-120b` | `qwen/qwen3.8-27b` |
| --- | --- | --- |
| "Onboard Priya as a Software Engineer joining October 12, reporting to Rahul in Bangalore" | ✅ exactly right | ❌ put Rahul in `people`, invented `department: "Engineering"` and `document_type: "PAN_CARD"`, asked a needless question |
| "I need sick leave next Friday" | ✅ `request_leave`, SICK, 2026-10-02 | ❌ `leave_balance`, plus `document_type: "PAN_CARD"` again |
| "Approve the leave" | ✅ `approve_leave`, `missing: [people]`, asks "Which employee's leave…?" | ✅ intent, ❌ `PAN_CARD` again |

What this teaches, for A2.2 onward:

- **A valid schema doesn't mean a correct answer.** Qwen's output passed validation but was wrong. Strict mode guarantees shape, not meaning. That's why A2.6 builds an eval set.
- **Nullable enums can pull a weak model toward the first option** (`PAN_CARD` every time). Few-shot examples showing `null`, or listing `null` first, should help. Measure it.
- **"Next Friday" is ambiguous.** On Tuesday 2026-09-29 both models chose 2026-10-02 (this week's Friday); many people mean 2026-10-09. The prompt needs a stated rule, and the eval needs a case for it.
- The same instruction gives very different quality on two models, so always record both (the M2 "done when").

## Check yourself (answered as tasks finish)

<details>
<summary>Why resolve "Rahul" to an id in code instead of asking the model for an id?</summary>

The model has never seen your employee table, so any id it gives is invented. Even with the table in the prompt, it could pick the wrong Rahul silently. Code queries the HR API (`GET /employees?q=Rahul`) with the user's permissions, gets real ids, and when there are two matches it **asks** instead of guessing. The model's job is to notice that a person called Rahul was mentioned. (Answered in full after A2.4.)
</details>

<details>
<summary>What should happen when a request is missing the joining date?</summary>

`REQUIRED_FIELDS[onboard_employee]` includes `joining_date`, so `missing_fields = ["joining_date"]` and `needs_clarification` is true. The agent must not create the employee. It returns the clarifying question ("When does Priya join?") and waits. It must also never default to today: a wrong joining date affects payroll proration and leave entitlement.
</details>

## Next

A2.2: the intent prompt (`prompts/intent.md`) with few-shot examples from the spec, today's date and the user's role injected, and rules for "next Friday".
