# M6: Write tools, risk levels and human approval

**Status:** done (A6.1–A6.6). The headline scenario ran live on `hr_test` on 2026-10-04 (Groq `openai/gpt-oss-120b`):
- it asked for the two values nobody gave;
- it showed a before → after approval and created Priya Rao (EMP-0059), then started onboarding;
- both writes landed in the audit log as `AI` with the run id;
- replaying the approved step twice at once returned the same employee.

Plan: [AI_AGENT_TASKS.md § M6](../AI_AGENT_TASKS.md#m6-write-tools-risk-levels-and-human-approval-5-days-).

## In one paragraph

M6 lets the agent change data, safely. Eleven write tools wrap the HR API's write endpoints; each has a read-only **preview** that produces a before → after diff. A **risk policy** file, enforced in code, decides per tool and per field which writes need a person's **approval**.

Before anything runs, every value a write would send must trace back to the user's words, the parse, a lookup or a documented default ("**never invent data**"); otherwise the agent asks. The approval pauses the run with the exact change, and the person approves, rejects or edits it. Every write carries an **idempotency key** for its plan step, so retries and resumes can't act twice. The HR API marks the agent's changes as `AI` in its audit log, with the run id.

## How it works

```text
understand ─► retrieve_policy ─► plan (writes allowed; "?" for unknown values)
   ─► validate_plan (code)
        • tools, arguments, values (check_plan)
        • risk per write step, from agent/risk.yaml ─────────────────► state.risks
        • provenance of every literal in a write (agent/provenance.py)
             unsupported value ─► ask_value (interrupt) ─► state.overrides
             unsupported *id*  ─► back to plan ("get it from a lookup")
   ─► route_next ─┬─ missing values?           ─► ask_value
                  ├─ next step needs approval? ─► approve (preview ─► interrupt)
                  │                                approve / edit ─► state.approvals
                  │                                reject ─► stop all later steps
                  ├─ next step                 ─► execute_step
                  │       write: Idempotency-Key = run:plan-hash:step   X-Agent-Run-Id = run
                  │       unapproved write needing approval ─► refuses (RuntimeError)
                  └─ done / stopped            ─► verify ─► respond
HR API: AuditLog.actorType = AI, agentRunId = run   ·   IdempotencyKey(user, key) → response
```

| File | Role |
| --- | --- |
| `apps/api/src/common/agent-context.ts` | `X-Agent-Run-Id` → request-scoped context (AsyncLocalStorage). |
| `apps/api/src/common/idempotency.interceptor.ts` | `Idempotency-Key` on writes: store, replay, mismatch 422, in-progress 409. |
| `apps/api/src/audit/audit.service.ts` | Audit entries `AI` + `agentRunId` when the context has a run. |
| `packages/db/prisma/migrations/…_agent_audit_and_idempotency` | `AuditLog.agentRunId`, `IdempotencyKey`. |
| `apps/ai/tools/hr_write.py` | The write tools and `list_departments`. |
| `apps/ai/agent/risk.yaml`, `agent/risk.py` | The risk policy and its loader. |
| `apps/ai/agent/provenance.py` | "Never invent data": what counts as supported; the questions. |
| `apps/ai/graphs/hr_agent.py` | `ask_value`, `approve`, `route_next`, write execution. |
| `apps/ai/graphs/records.py` + migration | `ai.approval`, `ai.email_outbox`. |
| `apps/ai/prompts/plan.md`, `respond.md` | `plan@4`, `respond@3`. |

## A6.1: the HR API side

- **AI in the audit log.** Middleware reads `X-Agent-Run-Id` (a UUID) into an `AsyncLocalStorage` context; `AuditService.record` writes `actorType: AI` and `agentRunId`. The **actor stays the user**: the agent acts with their token, so `actorId` is who it acted for. The header is a label, not a credential (it grants nothing), so a malformed one is ignored rather than refused.
- **Idempotency-Key.** A global interceptor, active only when the header is present on a write. The first request with a key inserts a row under the primary key `(userId, key)` *before* the handler runs, so a simultaneous duplicate hits the unique constraint and gets 409 (still in progress) or, once finished, the stored response with `Idempotent-Replayed: true`. The same key with a different method, path or body gets 422: a key names one intended action. 2xx and 4xx outcomes are stored as final; a 5xx deletes the row so the retry can run. One subtlety: Nest applies the route's status code (201 for POST) *after* interceptors, so the interceptor reads it from the route's metadata, not from `res.statusCode`.
- `agent.e2e-spec.ts` covers: AI vs USER entries, replay, mismatch, two simultaneous requests (one employee), and a stored 4xx.

## A6.2: write tools

`create_employee`, `update_employee`, `change_manager`, `change_department`, `start_onboarding`, `update_onboarding_task`, `create_leave_request`, `approve_leave`, `reject_leave`, `propose_attendance_correction`, `send_email`, plus the read tool `list_departments` (with a `name` filter, so "Engineering" resolves to one id). Each one:
- validates its body against the generated contract model;
- sends `ctx.idempotency_key`; the HR client adds `X-Agent-Run-Id` from the run;
- has a `preview` that only reads and returns `{summary, before, after}` with names, not ids (the approver sees "Rahul Sharma", not a UUID).

Specific behaviours:
- **Optimistic locking from the tool's side.** The `update_employee`, `change_manager` and `change_department` tools read the record's `version`, then write with it. A concurrent change gives 409 and nothing is overwritten (M7 maps that 409 to "re-read and re-plan").
- **Leave is checked before it's sent.** `create_leave_request` always calls the preview endpoint first and refuses, with the rules' own messages, instead of sending a request that breaks them.
- **`send_email` never sends.** It queues to `ai.email_outbox`, keyed by the step's idempotency key, so a retried step doesn't queue twice.

## A6.3: risk policy

`agent/risk.yaml` gives low / medium / high per tool, optionally per field. The riskiest field present wins: `update_employee` is low, but setting `status` makes it medium. Low runs without asking; medium asks if `approval.medium: true` (configurable, README §11); high always asks, whatever the file says. Unlisted write tools are high.

The level is computed at validation **from the policy**. The model also writes a `risk` label in its plan, but that's only checked against the tool (`check_plan`) and never used to decide anything.

## A6.4: approval

The `approve` node runs right before a write that needs approval, once its references are resolved. That's why the preview can say "manager: Rahul Sharma, department: Engineering": in a plan written up front those were only `$s2…` references. It interrupts with the step, its risk and reason, `summary` / `before` / `after`, any rule problems, the arguments, the whole plan, and the policy citations.

The answer comes back through resume, either `{"decision": "approve" | "reject" | "edit", "arguments"?, "comment"?}` or plain text:
- **Approve** stores the arguments and their hash.
- **Edit** merges the person's changes, re-validates them, and stores the result; an invalid edit asks again with the error.
- **Reject** stops every later step. They're reported as "not run: stopped because s4 was rejected by Lakshmi Pillai: …".
- **Anything that isn't a clear yes is a no.**

Every decision is stored in `ai.approval` with what was shown.

**Where the decision lives, and what stops the model skipping it:**
1. The model can't produce a resume: only the API caller (the user, with their token) can.
2. Routing (`route_next`) sends a write that needs approval to `approve`.
3. `execute_step` independently refuses a write that needs approval without a stored approval, and runs **exactly** the approved arguments (their hash is checked), not a fresh resolution.

## A6.5: never invent data

`agent/provenance.py` checks every literal argument of every write step before anything runs. A value is supported if it is:
- in the user's words (the request plus their answers);
- something the parser read from them (e.g. "October 12" → 2026-10-12);
- the user's own id;
- the field's documented default (`employment_type: FULL_TIME`);
- free prose the approver reads in full (a rejection reason, an email body).

References are always fine, because code resolves them from real results.

The planner writes `"?"` for what it doesn't know, and so does anything unsupported. For each such value, `ask_value` interrupts with a question worded at that moment ("What is Priya **Rao**'s work email address? I won't guess it."), validates the answer with the tool's own field rules (an invalid email asks again), and stores it as an *override*, applied by code on top of the validated plan.

**Ids are never asked.** A `"?"` in an id field goes back to the planner: "get it from a lookup". That came from the first live run (below).

## A6.6: the headline scenario

"Onboard Priya as a Software Engineer joining October 12, reporting to Rahul in Bangalore."

| | CI (`tests/test_onboard_priya.py`, FakeLLM + respx) | Live on `hr_test` |
| --- | --- | --- |
| Values nobody gave | asks last name, then email ("Priya Rao's work email") | same: "Rao", "priya.rao@acme.example" |
| Resolve Rahul, Engineering | search, list_departments → references | search Priya (duplicate check), get Rahul, list_departments by his department |
| Approval | create_employee, medium, before → after with names | same, shown in the terminal as `field: — → value` |
| Writes | POST /employees (key `…:s4`, run id), POST …/onboarding (`…:s5`, low, no approval) | EMP-0059 created, 13 onboarding tasks |
| What's missing | from start_onboarding's missing info | phone, date of birth, offer letter, ID proof, PAN, bank details, citing [Employee Onboarding Policy v1 §1] |
| Audit | — | `employee.created` and `onboarding.started`: `AI`, run id, by hr@hr.local |

The CI file also covers reject (nothing written, later steps not run, reason in the answer), edit (the edited title is what's sent), "hmm, maybe" counting as a reject, the second lock (an unapproved write raises), and an id placeholder going back to the planner.

## Tests

| File | What it checks |
| --- | --- |
| `apps/api/test/agent.e2e-spec.ts` | AI audit + run id; idempotent replay, mismatch, simultaneous duplicates, stored 4xx |
| `test_write_safety.py` | risk levels incl. field escalation and "high always asks"; provenance; headers on writes; version-first updates; leave never sent when the preview has problems; previews are GET-only; outbox once; department filter |
| `test_onboard_priya.py` | the scenario: questions, approval payload, writes with keys, approving twice; reject; edit; unclear answer; second lock; id → replan |

## Try it

```bash
# HR API on hr_test (port 4100), AI pointed at it:
cd apps/api && pnpm build && DATABASE_URL=postgresql://hr:hr@localhost:5433/hr_test STORAGE_DIR=storage-test API_PORT=4100 node dist/main
cd apps/ai && export HR_API_URL=http://localhost:4100 AI_DATABASE_URL=postgresql://hr:hr@localhost:5433/hr_test
uv run alembic upgrade head && uv run hr-ai ingest
HR_PASSWORD='Password123!' uv run hr-ai run "Onboard Priya as a Software Engineer joining October 12, reporting to Rahul in Bangalore." --login hr@hr.local
#   ? What is Priya's last name? I won't guess it.            > Rao
#   ? What is Priya Rao's work email address? …              > priya.rao@acme.example
#   ? Approve: Create employee Priya Rao?   (before → after)  > approve
# Over HTTP: POST /agent/runs/:id/resume {"answer": {"decision": "approve"}}
```

## What happened along the way

- **The agent asked a person for a UUID.** The request names no department, so in the first live run the model listed all departments and wrote `"?"` for `department_id`. Provenance then asked "What is Priya Rao's department id?", and an answer like "Engineering" failed UUID validation. Fix in code: an unsupported **id** goes back to the planner, not the user. Fix in `plan@4`: if no department is named, use the manager's, chaining references (`list_departments(name="$s2.employees.0.department")` → `"$s3.departments.0.id"`). The second live run did exactly that.
- **Questions worded too early.** Questions were written at validation, before any answer, so the email question said "Priya's" after the user had said "Rao". They're now worded when asked, with earlier answers applied.
- **Idempotency status codes.** The interceptor first stored `res.statusCode`, which is still 200 when interceptors run; Nest sets 201 for POST afterwards. It now reads the route's own status.
- **Pre-existing e2e failures.** Three attendance/payroll e2e tests fail with or without this module's changes (verified by stashing them). They depend on today's date against the seed and are left for M7/M10, not hidden.

## Check yourself

<details>
<summary>Where does the approval decision live, and what stops the model skipping it?</summary>

In code and in the user's hands. The risk level comes from `risk.yaml` via `RiskPolicy.assess`, not from the model. Routing sends any write that needs approval to `approve`, which pauses. Only a resume from the API caller, with the user's token, can carry a decision. `execute_step` checks again and refuses to run an unapproved write, and runs exactly the approved arguments, verified by hash. The model can write `"risk": "read"` on a write step; `check_plan` rejects the mismatch, and the label isn't used anyway.
</details>

<details>
<summary>Why do idempotency keys matter specifically for LLM-driven retries?</summary>

An agent retries more than a person does, and at worse moments: provider timeouts, `429`s with backoff, a crash between "HR API created the employee" and "checkpoint saved", a resumed run re-entering a step, a user approving twice. Each could repeat a write the HR API already did. Unlike a person, the agent can't look at the screen and notice "oh, she already exists". The key is per plan step (`run:plan-hash:step`), stable across all of those, so the HR API returns its first answer instead of acting again. A changed plan gets new keys, because it's a different intended action.
</details>

<details>
<summary>Experiment: approve the same step twice, quickly. Prove there's only one new employee.</summary>

Done three ways:
1. **In the graph:** after the approval completes, a second `{"decision": "approve"}` finds nothing waiting, and the POST count stays 1.
2. **In the HR API e2e:** two simultaneous identical POSTs with one key give one employee.
3. **Live on `hr_test`:** the approved `create_employee` step was replayed twice concurrently with its key. Both calls returned EMP-0059 (the stored response), and `SELECT count(*)` stayed at 1.
</details>

## Next

M7 makes "it worked" a checked fact: declarative expectations per write tool (`create_employee` → the employee exists with those fields), a verify node that re-reads, mapping API errors (409 → re-read and re-plan), partial-completion summaries, and fault-injection tests.
