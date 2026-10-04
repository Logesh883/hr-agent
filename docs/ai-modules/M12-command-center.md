# M12: Command Center integration

**Status:** done (A12.1–A12.3), together with web Phases 3 and 4. Five of the six portfolio demo scenarios ran end to end through the runs API on `hr_test` on 2026-10-04 (Groq `qwen/qwen3.8-27b`). The sixth, conflicting documents, needs document AI (M9, deferred).

Plan: [AI_AGENT_TASKS.md § M12](../AI_AGENT_TASKS.md#m12-command-center-integration-3-days-alongside-web-phase-4). Web side: [HR_WEB_APP_TASKS.md Phases 3–4](../HR_WEB_APP_TASKS.md#phase-3--tool-api-contract-with-the-ai-agent-).

## In one paragraph

M12 puts the agent in front of people. The runs API's request, view, question and event shapes became a **contract** in `@hr/contracts`, shared by the web app (TypeScript) and the AI service (generated Pydantic, checked by a test). The browser calls the AI service **directly with the user's HR API token**; the AI service checks it with `GET /auth/me` and acts with it. The web app gained a **Command Center** (ask, follow the plan and evidence live, answer questions, approve or reject), an **approval inbox**, and an **audit log**. Underneath, every AI write now goes through the HR API's **Tool API** (`POST /tools/:name`), so the audit log records which tool made each change, and the **risk policy** moved into the contracts, so the agent and the API read the same file.

## How it works

```text
browser (Next.js, session token)
  ├─ POST /agent/runs {request}           ─► AI service ─► GET /auth/me (who is this?)
  ├─ GET  /agent/runs/:id                    run view: question, progress (intent, entities,
  │                                          plan + risk per step, passages, verification)
  ├─ GET  /agent/runs/:id/events  (SSE via fetch; EventSource can't send the token)
  ├─ POST /agent/runs/:id/resume {answer}    text, an option, or {decision, arguments?, comment?}
  └─ GET  /agent/runs?status=waiting         the inbox
AI service ─(same token, X-Agent-Run-Id, Idempotency-Key)─► POST /tools/:name ─► same services as REST
                                                              audit: AI + run id + tool name
```

| File | Role |
| --- | --- |
| `packages/contracts/src/agent.ts` | Run request, view, questions, progress, events (A12.1) |
| `packages/contracts/src/tools.ts` | Tool catalog (14 tools: input/output schema, permission) and `RISK_POLICY` |
| `apps/api/src/tools/` | `GET /tools`, `POST /tools/:name` |
| `apps/ai/tools/hr_write.py` | Write tools now call `/tools/*`; reads stay on REST |
| `apps/ai/agent/risk.py` | Loads `json-schema/risk.json` (was `agent/risk.yaml`) |
| `apps/ai/graphs/persistence.py` | `summarize_state`: what the Command Center shows |
| `apps/web/src/lib/ai.ts`, `agent-queries.ts` | AI client, SSE reader, run hooks |
| `apps/web/src/components/agent/` | Run page, approval card, question panel, timeline |
| `apps/web/src/app/(app)/assistant`, `approvals`, `audit` | The pages |
| `apps/ai/evals/demo_scenarios.py` | A12.3: the demo scenarios, scripted |

## Design decisions

- **The browser talks to the AI service directly**, with the token it already uses for the HR API. A Next.js proxy would hide the token from the browser, but the token is already there (the web app calls the HR API from the browser), so a proxy would add a hop without adding safety. The AI service trusts nothing about the caller except what `GET /auth/me` says.
- **SSE over fetch, not `EventSource`.** `EventSource` can't set `Authorization`. The reader resumes after the last event id when a run continues after an answer, so nothing is shown twice.
- **The contract describes the wire format the AI service already spoke** (snake_case). Renaming everything to camelCase would have churned the CLI, tests and eval harness for no user-visible gain. The request models in `run_routes.py` stay hand-written (the generated ones wrap strings in `RootModel`s); `tests/test_run_contract.py` proves they accept and produce the contract.
- **Run-owner approvals** (decided with the user). The person who asked approves the agent's risky step in their own run. Approvals, runs and tool calls stay in the AI service's `ai` schema instead of new Prisma tables (T4.2). A cross-user HR approval queue would have meant redesigning M6.
- **Agent writes go through the Tool API** (decided with the user). Every AI mutation is then a typed tool call, the audit log can say *which* tool, and the gateway is exercised rather than decorative. Reads stay on REST: the README only asks it of mutations, and previews and read-backs are plain reads.
- **One risk policy.** `RISK_POLICY` in TypeScript, exported to JSON. The agent enforces it; the Tool API's catalog displays it.

## Try it

```bash
pnpm dev                                    # web :3000, API :4000, AI :8000
# open http://localhost:3000/assistant, sign in as hr@hr.local

# the demo scenarios, on hr_test (see the docstring in evals/demo_scenarios.py for the stack)
HR_PASSWORD=... uv run python -m evals.demo_scenarios --api http://localhost:4100 --ai http://localhost:8100
```

## A12.3: the demo scenarios, live (2026-10-04)

| Scenario | What happened | Result |
| --- | --- | --- |
| Onboard Priya | asked last name and email, held "Create employee Priya Rao" (medium) for approval, created EMP-0092 under Rahul, started onboarding; audit: `create_employee`, `start_onboarding` as AI | pass |
| Leave approval | found Rohan's pending request, held the approval (high), approved; verified | pass |
| Sensitive change (RBAC) | as a manager: refused before planning (`employee:update` missing), nothing written | pass |
| Sensitive change (human in the loop) | as HR: held the department move (medium), rejected with a reason; nothing written, Arun still in Engineering | pass |
| Tool failure | injected 500, then a dropped response: retried under one Idempotency-Key, one request created, verified | pass (after the fix below) |
| Conflicting documents | needs M9 | not run |
| Evaluation dashboard | `--eval` runs the fast eval subset; not run today (Groq quota was already rate-limiting, 429s with 10–40 s backoffs) | not run |

The browser run (Command Center, approval card, reject with reason, audit log page) was checked by hand on the dev stack.

## What happened along the way

- **A lost response looked like an overlap.** In the tool-failure demo the second attempt's answer was dropped *after* the API created the leave. The retry's preview then saw that leave as an overlap, and the agent told Sneha her request wasn't submitted when it was. The unit test had always mocked the preview as clean. Fix: if the preview's only problem is `OVERLAP` and the step has an idempotency key, send it anyway under the same key. If it was ours, the API replays the first answer; if not, the API refuses the overlap and nothing is created. `test_a_lost_response_isnt_mistaken_for_an_overlap_on_retry` fails without the fix.
- **Choice buttons couldn't answer a choice.** The matcher took a name, code or id, not the option text the UI shows. It now also accepts the option exactly as offered.
- **The model's data fences leaked into the evidence panel.** Policy passages carry `<data source=…>` fencing for the model (A8.2); the run view now strips it for people.
- **`update_onboarding_task` offered `IN_PROGRESS`**, which the contract doesn't allow. Switching the tool to the generated `UpdateOnboardingTaskTool` model exposed it.
- **Two stale integration assertions**: since A8.1 the agent refuses a role's missing tools itself, before the HR API is asked, so the message changed.

## Check yourself

<details><summary>Why does the AI service call <code>GET /auth/me</code> instead of decoding the JWT itself?</summary>

It would need the HR API's signing secret, and it would miss what only the API knows: a login turned off, a role changed, a password reset that ended older sessions. Asking the API makes it the single authority on who the caller is.
</details>

<details><summary>Approving runs "exactly these arguments". What stops the agent changing them afterwards?</summary>

The approval stores the arguments and their hash; `execute_step` runs the stored arguments and refuses a write that needs approval without a matching stored approval (M6). The model never produces the resume either: only the user's request with their token does.
</details>

<details><summary>Why keep reads on REST when writes moved to the Tool API?</summary>

The point of the gateway is a typed, audited surface for changes. Reads don't change anything or get audited; moving them would churn previews, read-back verification and every test mock for no safety gain.
</details>

## Next

M11 (observability: trace context into the HR API, run metrics, user feedback from the Command Center) and M13 (deployment). Note for M13: the AI service now reads `packages/contracts/json-schema/risk.json` at runtime, so its image needs that file.
