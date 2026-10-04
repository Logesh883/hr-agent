# M7: Verification, recovery and failure handling

**Status:** done (A7.1–A7.5). The "tool failure" demo ran live on `hr_test` on 2026-10-04 (Groq `openai/gpt-oss-120b`), with failures injected between the agent and the real HR API:
- `create_employee` got a 500, then a dropped answer (the API did create the employee). Each time it was retried with the same key.
- The third try got the stored 201 back: **one** employee (EMP-0060), one `employee.created` audit entry (`AI`, run id), one idempotency row.
- The read-back confirmed every field.
- `start_onboarding` got a 403 and the run stopped there, without a retry. The answer says the employee exists and onboarding still has to be started by hand.

Plan: [AI_AGENT_TASKS.md § M7](../AI_AGENT_TASKS.md#m7-verification-recovery-and-failure-handling-3-days-).

## In one paragraph

M6 let the agent write. M7 makes "it worked" a checked fact, and "it failed" an honest, contained outcome.

After every successful write, the graph **re-reads** the record and compares it against declared **expectations**: the employee exists with those fields; the leave request is pending with those dates; an approval moved the days from pending to used. A mismatch stops every later write.

Every failure gets a **kind**. Transient ones (5xx, timeout, unreachable, "same key still in progress") are retried up to three times with backoff and jitter. That's safe because each write carries its step's idempotency key. A stale version is re-read and retried once. Everything else stops the run: a 403, a 404, a business rule's 422 (relayed word for word), or a real duplicate.

When a run stops partway, a **compensate** node undoes only what's both ours and harmless to undo: a leave request this run created that's still pending. Everything else stays in place and is named in a per-step **completion summary**. If the LLM is down at the very end, the summary is turned into the answer by code.

## How it works

```text
execute_step (one plan step)
   ├─ write? key = run:plan-hash:step
   ├─ expectation.before (e.g. the leave balance before an approval)
   ├─ run_with_retries
   │     attempt 1 ─ ok ───────────────────────────────────────────────┐
   │        └─ transient (server/unavailable/timeout/busy)?            │
   │              wait 0.5s·U(1,1.5) → attempt 2 → 1s → 3 → 2s → 4     │
   │        └─ anything else: final at once                            │
   ├─ failed write ─► stopped (kind "failed") ─────────────────────────┼──┐
   └─ ok write ─► expectation.check (re-read through the HR API) ◄─────┘  │
                    mismatch ─► status "mismatch", stopped ───────────────┤
                    match    ─► status "verified" ─► route_next           │
route_next ─ stopped by failure/mismatch ─► compensate ◄──────────────────┘
compensate: COMPENSATIONS[tool] for done/verified/mismatch steps, key + ":undo"
             (only create_leave_request: cancel if still PENDING)
   ─► verify: problems (failed, mismatch) · findings (empty, skipped, undone)
              + completion_summary: every step's status and detail,
                writes that stayed: "not undone automatically: a person should decide"
   ─► respond (respond@4) ── LLMError? ─► plain_summary(state), from code
```

| File | Role |
| --- | --- |
| `apps/ai/agent/expectations.py` | Post-conditions per write tool (`EXPECTATIONS`), and the one safe undo (`COMPENSATIONS`). |
| `apps/ai/tools/base.py` | `ErrorKind`, `TRANSIENT`, `ToolResult.error_kind` / `status_code` / `transient`. |
| `apps/ai/tools/registry.py` | Every failure path gets a kind; `error_kind(HrApiError)` maps statuses. |
| `apps/ai/tools/hr_write.py` | Stale version: re-read and retry once, with its own key (`…:r1`). |
| `apps/ai/graphs/hr_agent.py` | `run_with_retries`, read-back in `execute_step`, `compensate`, `verify`, `completion_summary`, `plain_summary`. |
| `apps/ai/app/faults.py` | Development-only fault injector for the live demo (`--faults`, `HR_FAULTS`). |
| `apps/ai/prompts/respond.md` | `respond@4`: when a run stopped partway, say what stays and what was undone. |

## A7.1–A7.2: expectations and the read-back

| Write tool | What must be true afterwards (re-read) |
| --- | --- |
| `create_employee`, `update_employee`, `change_manager`, `change_department` | `GET /employees/:id` has every field that was sent (email compared lowercased; department/manager by id) |
| `start_onboarding` | onboarding is started and the checklist has tasks |
| `create_leave_request` | the request is `PENDING` with that type and those dates |
| `approve_leave` | `APPROVED`, and the balance moved: `used` +days, `pending` −days (snapshot taken before) |
| `reject_leave` | `REJECTED` |

The check runs **inside** `execute_step`, right after the write, not at the end. That's what "stops further writes" needs: the next step is routed only after the result says `verified`. A mismatch becomes `stopped_kind: "mismatch"` and a **problem** in `verify` (not a finding). A `verified` event goes to the run's timeline either way.

## A7.3: errors mapped to actions

| HR API response | `error_kind` | What the agent does |
| --- | --- | --- |
| 400, 422 without problems | `invalid` | stop; the plan's arguments were wrong |
| 422 with `problems` | `rule` | stop; the problems go to the answer word for word |
| 401 | `auth` | stop; "sign in again" |
| 403 / 404 | `forbidden` / `not_found` | stop and explain, no retry |
| 409 "changed by someone else" | `conflict` | the tool re-reads the version and retries once with key `…:r1`; a second 409 is final |
| 409 "Idempotency-Key is still in progress" | `busy` | transient: our own earlier attempt is still running, so retry |
| a 201/200 replayed for a matching key | — | done: this *is* "409 duplicate, treat as done if the key matches" |
| 409 any other duplicate (email used, overlap) | `conflict` | stop: someone else's record, never "done" |
| 5xx, timeout, unreachable | `server` / `timeout` / `unavailable` | up to 3 retries, 0.5 s, 1 s, 2 s, ×U(1, 1.5) jitter |

Two details matter:
- **The retry key.** The stale-version retry needs its own key. The first attempt's 409 is stored under the first key as a final 4xx answer, so reusing it would just replay the 409.
- **Model messages.** `error_kind` and `status_code` stay out of the messages sent to the model (`result_content`), so the M3/M5 tool-loop transcripts didn't change shape.

## A7.4: partial completion and compensation

`completion_summary` lists every plan step: `verified`, `done`, `failed`, `mismatch`, `compensated`, `rejected`, `skipped` or `not run`, with a detail. When the run stopped because of a failure, each write that stayed in place gets the detail *"not undone automatically: a person should decide"*.

**Only one compensation exists:** cancelling a leave request *this run* created that is *still pending*. The cancel carries key `…:sN:undo`. If a manager already approved it in the meantime, it's left alone and reported ("not undone: left as is: it's approved now"). Creating an employee, changing a manager or approving leave is never reversed automatically.

The `respond` node gets the summary. If the LLM call fails, `plain_summary` writes the answer from the summary in code. The work was done, and losing the report of it would be worse than a plain answer.

## A7.5: fault injection

### In CI: `tests/test_failures.py` (27 tests, FakeLLM + respx)

The scenario: book Sneha's leave (low risk), then move her to Arun (medium; approval switched off so failures are what's tested). Retries run with zero delays.

| Injected | Expected and asserted |
| --- | --- |
| nothing | both writes `verified`, two `verified` events, no cancel |
| 500, 503, then 201 | 3 POSTs, **one** key, two `tool_retry` events, both writes verified |
| timeout, 409 busy, then replayed 201 | 3 POSTs, verified |
| 500 ×4 | 4 POSTs, then stop; manager change `not run`, and the answer prompt says so |
| 422 with a problem | 1 POST; the problem text in the result and in the answer prompt |
| 403 on the manager change | 1 PATCH; the created leave is cancelled with `…:s3:undo` |
| stale 409, then OK | 2 PATCHes, versions 1 → 5, second key `…:r1`, verified |
| stale 409 twice | 2 PATCHes, then `conflict`, stop |
| duplicate 409 (not our key) | 1 POST, `failed`, not treated as done |
| leave read back with other dates | `mismatch`, the manager change never sent, leave cancelled |
| manager read back unchanged | `mismatch` problem in verify, leave cancelled |
| leave approved before the undo | no cancel; "not undone: … approved now" |
| manager change first, then the leave fails | the manager change is marked "not undone automatically" |
| LLM down at respond | code-written answer listing each step |

Also covered: the status → kind table, a hanging tool timing out as transient, and the fault injector itself.

### Live: the "tool failure" demo

`app/faults.py` sits between the agent and the real HR API. It fails matching requests a set number of times, then lets them through. `drop` is the interesting outcome: the request **is** handled and only the answer is lost. That's exactly the case idempotency keys exist for. It's ignored when `AI_ENV=production`.

```bash
cd apps/ai && export HR_API_URL=http://localhost:4100 AI_DATABASE_URL=postgresql://hr:hr@localhost:5433/hr_test
HR_PASSWORD='Password123!' uv run hr-ai run \
  "Onboard Ishita Bhatt (ishita.bhatt@acme.example) as a QA Engineer in Engineering joining November 2, reporting to Rahul in Bangalore." \
  --login hr@hr.local --faults "POST /employees=500,drop; POST /employees/*/onboarding=403"
#   ? Approve: Create employee Ishita Bhatt?   > approve
#   fault.injected → create_employee failed → tool_retry
#   fault.injected → create_employee failed → tool_retry   (the API did create her)
#   create_employee ok → verified                           (stored 201 replayed)
#   fault.injected → start_onboarding failed (403), no retry → compensate → verify
#   "Ishita Bhatt is now in the HR system as a QA Engineer, but her onboarding
#    checklist has not been started and must be set up manually."
```

What the database showed after the run:
- `Employee`: one row.
- `AuditLog`: one `employee.created`, `actorType = AI`, `agentRunId` = the run.
- `IdempotencyKey`: one row, `…:s4`, 201.
- `ai.tool_call`: all seven calls, with three `create_employee` attempts (500, unavailable, ok) and the 403. Every attempt stays auditable.

## Design decisions

- **Verify right after each write, not only at the end.** The point is to stop *before* building on a state that isn't there. An end-of-run check could only report the damage.
- **Retry in the graph, not in the HR client.** The graph knows the step, its key and the run's timeline (`tool_retry` events, one trace span per attempt). A client-level retry would be invisible and would retry reads and writes alike, with no idea whether a key protects them.
- **Kinds, not status codes, in state.** The graph routes on "what to do" (transient, rule, forbidden); the status stays for the record. A dropped connection and a 503 are the same decision.
- **Compensation is an allow-list of one.** An automatic undo is itself a write, made without approval, after something already went wrong. Cancelling our own pending leave request is invisible to everyone else and fully reversible. Archiving a just-created employee is not: payroll, logins and audit may already have reacted. So it's reported, not undone.
- **Fault injection as a transport, not mocks, for the demo.** The real agent, LLM, HR API, database and audit log are all in play. Only the network misbehaves, in a scripted way.

## What happened along the way

- **The first live demo hit a real duplicate.** Meera Iyer already exists in the seed (EMP-0001). The `drop` fault let the POST through, the API refused it (409, email in use) and stored that 4xx under the key, and the retry replayed the 409. The run stopped and said so: a duplicate that isn't ours is never "done". Correct, but not the demo intended, so the demo uses a fresh name.
- **Two intents in one request loop on clarification.** "Book Sneha's leave *and* change her manager" parses as `request_leave`, and the model keeps asking whether to also change the manager. The parser is single-intent by design (M2). This is noted for the M10 eval set, and the demo uses onboarding: one intent, two writes.
- **The first answer didn't say what stayed.** It reported the 403 but not that the new employee remains. `respond@4` adds a rule: when a run stops partway, end with the state things are in, from the per-step summary.
- **Tool messages changed shape.** Adding `error_kind` to `ToolResult` leaked into the model's tool messages and broke the M3/M5 transcript tests. It's excluded from `result_content`: the model doesn't need it.
- **Read-backs need mocks too.** The M6 Priya tests started failing on unmocked `GET /employees/:id` and `…/onboarding`, the new read-backs. They now mock them, and the edit test returns the edited title on read-back.

## Check yourself

<details>
<summary>When should the agent retry, ask the user, or stop?</summary>

- **Retry** when the failure says nothing about the request itself: 5xx, timeout, unreachable, or our own key still in progress. The same request may well succeed, and the idempotency key makes repeating it safe. Cap it (3) and back off with jitter, so a struggling API isn't hammered in lockstep.
- **Re-read and retry once** on a stale version. The intent is still valid; only the precondition moved. A second conflict means real contention, which a person should look at.
- **Ask the user** when a value is missing or unsupported (M6 provenance), or a reference is ambiguous ("which Rahul?"). That's information only they have, and it's caught *before* any write.
- **Stop** on anything that's an answer, not an accident. A 403/404 means permissions or existence, and retrying won't change them. A 422 is a business rule: relay it, don't argue. A duplicate that isn't ours, or a read-back mismatch, means the world isn't what the plan assumed, so every later write would build on a false premise.
</details>

<details>
<summary>Why not automatically undo everything when a later step fails?</summary>

- **An undo is a new write.** It's made without approval, by a run that has just shown something is off.
- **Many writes have effects outside the record.** A created employee may already have a login, notifications or payroll inclusion. An approved leave has moved a balance and been seen by the employee. Reversing the row doesn't reverse those.
- **The earlier write is often still wanted.** The employee should exist even if onboarding failed to start; the person just needs to finish the job.
- **A blind undo can destroy someone else's work.** If a manager acted on the record in between, "undoing" overwrites them.

So the rule is: undo only what is ours, untouched and harmless to reverse (a pending leave request this run created), and report everything else plainly for a person to decide.
</details>

## Next

M8 adds guardrails: a tool allow-list per role (employees aren't even offered approval tools), indirect-injection defences for policy and document text, PII masking in traces and logs, budgets (steps, tokens, rate limits), and a red-team eval set that must pass 100%.
