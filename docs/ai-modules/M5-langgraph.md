# M5: LangGraph: stateful agent workflows

**Status:** done (A5.1–A5.6), verified live on 2026-10-04 with Groq `openai/gpt-oss-120b`: a multi-step plan, a clarification answered in the terminal and over HTTP, a run killed mid-answer and resumed from Postgres, and the event stream. Plan: [AI_AGENT_TASKS.md § M5](../AI_AGENT_TASKS.md#m5-langgraph-stateful-agent-workflows-5-days-).

## In one paragraph

M5 turns the agent from one loop into a **workflow with explicit state**. First the M3 loop is rebuilt in LangGraph and shown to behave identically (A5.1). Then the HR agent graph (A5.2):
1. **understand** the request;
2. **route** it, in code: ask a question, decline, answer a simple question with the M3 loop, or **plan**;
3. for planned requests, **retrieve policy** evidence, have the LLM **plan** every tool call up front, and **validate** the plan in code;
4. **execute** it one step at a time, **verify**, and **respond** with citations.

When information is missing, or a name matches several people, the graph **pauses** with `interrupt()` and resumes the same thread with the user's answer (A5.3). Every step is checkpointed to Postgres (A5.4), so runs survive restarts. Runs are started, followed (server-sent events) and resumed over HTTP (A5.5), and every run, LLM call and tool call is recorded in the `ai` schema (A5.6).

## How it works

```text
POST /agent/runs {request}  (Bearer: user's HR token)   ──► 202 {id, status: running}
  │  background task (token in memory only)
  ▼
 START ─► understand ─┬─ clarify ─(interrupt)─► … POST /resume {answer} ─► understand
          (M2 parse,  ├─ decline ───────────────────────────────────────────────► END
           code picks ├─ answer_simple (A5.1 graph: call_model ⇄ run_tools) ────► END
           the route) └─ retrieve_policy ─► plan ─► validate_plan ─┬─(problems, once)─► plan
                                                                    ├─(still bad)───► respond
                                                                    └─► execute_step ⟲ ─► verify ─► respond ─► END
                                                                         (one step per pass;
                                                                          "which Rahul?" interrupt)
  │ after every node: checkpoint ─► ai.checkpoints (LangGraph's AsyncPostgresSaver)
  │ timeline events ─► ai.workflow_event ─► GET /agent/runs/:id/events (SSE)
  │ LLM + tool calls ─► ai.agent_run / ai.tool_call (masked)   trace ─► Langfuse
  ▼
GET /agent/runs/:id ─► status, question or answer, plan progress (from the checkpoint)
```

| File | Role |
| --- | --- |
| `apps/ai/graphs/react.py` | A5.1: the M3 loop as a graph; `run_react_graph` is a drop-in for `run_agent`. |
| `apps/ai/graphs/hr_agent.py` | A5.2/A5.3: state, context, nodes, routing, `build_hr_graph`. |
| `apps/ai/graphs/plan.py` | `Plan`, `check_plan`, `$sN.path` references, `plan_hash`. |
| `apps/ai/graphs/runner.py` | `start_run` / `resume_run`: drive a thread and turn its stream into timeline events. |
| `apps/ai/graphs/persistence.py` | `open_checkpointer` (Postgres), `PostgresRunStore` / `MemoryRunStore`, trace → records. |
| `apps/ai/graphs/records.py` | `workflow_run`, `agent_run`, `tool_call`, `workflow_event` tables. |
| `apps/ai/graphs/service.py` | `RunService`: background runs, status lifecycle, ownership, recording. |
| `apps/ai/app/run_routes.py` | The runs API and the SSE stream. |
| `apps/ai/tracing/llm.py` | `TracedLLM`: every node's LLM call becomes a trace generation. |
| `apps/ai/prompts/plan.md`, `respond.md` | `plan@2`, `respond@2`. |
| `apps/ai/migrations/versions/…_agent_runs.py` | The A5.6 tables. |

## A5.1: the loop as a graph, and what the framework does

`graphs/react.py` has three nodes (`call_model`, `run_tools`, `stop_early`) and two routing functions; that's the whole loop. `test_react_graph.py` runs **the same FakeLLM scripts** through the hand-written `run_agent` and the graph, for six cases (normal, parallel calls, bad calls, step limit, token budget, empty reply), and requires identical `AgentRun`s apart from timings.

What the framework now does for you:
- **The loop becomes data.** The `for` loop and its `return`s turn into edges; the two routing functions are the only decisions, and the graph can be drawn from them.
- **State merges by declaration.** Each node returns only the keys it changed. `Annotated[list, append]` and the usage-summing reducer say how updates merge, instead of mutating local variables.
- **Checkpoints after every node, for free.** Compile with a checkpointer and the state is saved after each node; `aget_state_history` shows `input → call_model → run_tools → call_model`. The hand-written loop keeps its state in variables that die with the process.
- **Streaming.** `astream(stream_mode=["updates", "custom"])` yields after each node, and `get_stream_writer()` carries our own `tool_started`/`tool_finished` events.

What it doesn't do: validation, tool execution, error wording and tracing are still our code (`tools.registry`, `agent.loop.run_tool`). The framework moves state between them.

**State vs context.** State is plain JSON (messages as `Message.model_dump(mode="json")`), so any checkpointer can store it and nothing needs unpickling. The LLM client, the HR client **holding the user's token**, the retriever and the trace are passed as the run's `context` (`Runtime[HrContext]`), which LangGraph never checkpoints. A test checks the token isn't in the checkpoint. The flip side: resuming a run needs the user's token again, and that's correct, because whoever resumes must be allowed to act.

## A5.2: the HR agent graph

**understand → route (code).** The M2 parser gives the intent, entities and missing fields; `choose_route` decides:

| Situation | Route |
| --- | --- |
| clearly not HR (intent `unknown`, no question) | decline, without asking |
| required field missing, unclear intent, confidence < 0.6 | clarify (at most 2 rounds) |
| the model's *optional* question on a request that **changes** data | clarify |
| the model's optional question on a **read-only** request | ignored: just answer |
| a write intent, or several people | plan |
| anything else | the short path (the A5.1 loop) |

The read-only rule came from a live run (see "What happened along the way").

**plan.** The LLM writes the whole list of tool calls before any runs: `{"goal", "steps": [{"id": "s1", "tool", "arguments", "reason", "risk"}]}`. It can't see results while planning, so later steps use **references**: `"$s1.employees.0.id"` means the id of the first employee in s1's result.

**validate_plan (code, `check_plan`).** Every tool exists. The model's `risk` label must match what the *tool* declares, and M5 runs only `read` tools. Argument names are the tool's own and required ones are present. Each literal value passes the tool's own validation, field by field (`validate_assignment` on a blank model, because references can't be validated until run time). References point at earlier steps. Problems go back to the planner once (the A2.3 pattern); a second bad plan ends in an honest "couldn't plan that".

**execute_step: one step per graph pass.** Each step's result is checkpointed as it lands, so an interrupt or a crash never re-runs a finished step. With reads that only saves time; with M6's writes it prevents doing something twice. Before each step:
- **Plan fingerprint.** The hash taken at validation must still match, so a plan can't change silently after it was checked (a listed pitfall).
- **References resolve in code, and never by guessing.** A path through a list resolves only if the list has exactly **one** item. Several matches → `interrupt` with the candidates ("which one?"), and the answer must match exactly one name, code or id. No match → the step is *skipped*, with the reason.

**verify.** For read-only plans: every step ran. A failed step is a **problem**; an empty result is a **finding**. For a new hire, "no Priya on record" is the good answer.

**respond.** The LLM writes the answer from the request, each step's result, the policy passages (cited) and the verification. It is told it didn't run the steps itself and must not add facts.

## A5.3: clarification

`clarify` calls `interrupt({"type": "clarification", "question": …})`. The graph stops, the checkpoint keeps everything, and `RunOutcome.status == "waiting"`. Resuming with `Command(resume=answer)` **re-runs the clarify node from the top**: `interrupt()` now returns the answer instead of pausing. That's why everything before it in the node must be safe to repeat. Then understand parses the request again, with `(Asked: … Answer: …)` appended.

## A5.4: Postgres checkpointer

`AsyncPostgresSaver` on a psycopg pool whose connections use `options=-csearch_path=ai`, so its four tables (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`) are created in the AI service's schema. Its own `setup()` creates and migrates them (idempotent, at startup), and `migrations/env.py` keeps Alembic away from tables starting with `checkpoint`.

**What it stores, and when:** after every super-step (node), the thread's full state values, which nodes run next, pending writes, and any interrupt. One thread per run (`thread_id` = run id).

`test_run_persistence.py` runs process 1 until the clarification and closes its pool, then process 2 opens a **new pool and a new compiled graph** and resumes. Only the database is shared.

## A5.5: the runs API

| Call | Does |
| --- | --- |
| `POST /agent/runs {request}` | 202 and the run; it continues in a background task |
| `GET /agent/runs/:id` | status (running / waiting / completed / failed / interrupted), the question or answer, and progress from the checkpoint (route, clarifications, policy citations, each plan step's status, verification) |
| `GET /agent/runs/:id/events` | Server-sent events: replays the stored timeline (from `Last-Event-ID`), then follows it until the run finishes or waits |
| `POST /agent/runs/:id/resume {answer?}` | answer the question; or, with no answer, continue an *interrupted* run |

Runs are private: another user gets 404 for all four. When the service starts, runs still marked `running` belonged to a process that's gone and become `interrupted`, which can be resumed. Events are read from the database (polling every 0.5 s, with a keep-alive comment), so a stream works the same after a restart or on another worker.

Events: `run_started`, `node_started`, `node_finished {summary}`, `tool_started`, `tool_finished {ok}`, `waiting {question, options?}`, `run_resumed`, `finished {status, answer}`, `failed`. This is the Command Center timeline of M12.

**CLI:** `uv run hr-ai run "…" --login EMAIL` prints the same timeline, asks questions in the terminal, and `--resume RUN_ID` continues a stopped run.

## A5.6: records

- `workflow_run` holds who asked what, the status, the question or answer, and its trace ids.
- `agent_run` holds one row per LLM call: node, model, prompt version, tokens, latency.
- `tool_call` holds one row per tool call: input, output, status, latency, **masked** like the trace.
- `workflow_event` holds the timeline.

The records come from the run's trace, so the database, Langfuse and the API agree. They're written **as each node finishes**, so a killed process loses at most the node it was in (see below). `TracedLLM` makes the graph's own LLM calls (understand, plan, respond) generations in the trace; in M3 only the loop's calls were.

## Tests

| File | What it checks |
| --- | --- |
| `test_react_graph.py` | graph == hand-written loop on six scripts; checkpoint after every node; token not in checkpoint; event stream order |
| `test_plan.py` | each plan problem; references through one / several / no matches; the user's choice; plan hash |
| `test_hr_graph.py` | multi-step plan run; clarification pause and resume; "which one?" without re-running the search; plan retry; unfixable plan; short path; decline; crash → resume from checkpoint; empty result as finding; which questions get asked |
| `test_run_routes.py` | API: background run, timeline, `Last-Event-ID`, records masked, question → resume (409 without answer), privacy, shutdown mid-run → interrupted → resume without repeating steps |
| `test_run_persistence.py` | **real Postgres**: resume in a new process, run store round trip (opt-in, `AI_TEST_DATABASE_URL`) |

## Try it

```bash
pnpm db:migrate:ai
cd apps/ai
export HR_PASSWORD='Password123!'
uv run hr-ai run "Compare Sneha's and Arun's annual leave balances" --login hr@hr.local
uv run hr-ai run "Onboard Priya as a Software Engineer reporting to Rahul" --login hr@hr.local
#   ? When does Priya join, and at which location?   ← type "12 October 2026, Bangalore"
# Ctrl-C a run halfway, then:
uv run hr-ai run --resume <run id> --login hr@hr.local
# Over HTTP (pnpm dev:ai): POST /agent/runs, then curl -N …/agent/runs/<id>/events
```

### Live check (2026-10-04, Groq `openai/gpt-oss-120b`)

| Request | What happened |
| --- | --- |
| HR: "Compare Sneha's and Arun's annual leave balances" | plan of 4 steps (2 searches, 2 balances with references) → validated → run one per pass → verified → answer with both balances and a [Leave Policy v2 §1] citation; numbers match the tool output |
| HR: "Onboard Priya as a Software Engineer reporting to Rahul" | paused: "When does Priya join, and at which location?" → "12 October 2026, in Bangalore" → re-parsed → plan: no existing Priya (finding), Rahul exists (Engineering Manager, Bangalore) → answer says what was checked and that creating the record comes later |
| HR: "Compare Sneha's and Arun's attendance this month", process `kill -9`'d during respond | DB showed `running`; `--resume` marked it interrupted, ran **only respond**, completed |
| Manager over HTTP: "Who on my team has attendance anomalies this month, and what does the policy say about missing records?" | 202 → SSE timeline → short path (attendance + search_policy) → six anomalies on 1 Oct plus the loss-of-pay rule cited [Attendance Policy v1 §4]; a run left waiting before the restart was still `waiting` after it |

## What happened along the way

- **The checkpointer won't store what can't be serialised, and shouldn't store secrets.** Graph state was designed as plain JSON from the start, with live objects in `context`. That also kept the HR token out of the database.
- **LangGraph's typing under strict pyright.** `add_node` and `compile` are reported "partially unknown" because of LangGraph's own generic annotations. The graph modules turn off only `reportUnknownMemberType` (and missing stubs), with a comment. Nodes are typed through a `Protocol` with named parameters, because LangGraph matches the `runtime` *keyword*, which a `Callable[[...]]` alias loses.
- **Groq's free daily token limit.** The M4 rerank eval spent the 200k-token daily budget of `qwen/qwen3.8-27b`, and the next run failed after waiting out three retries. Live M5 checks used `openai/gpt-oss-120b`, which has its own budget. Free tiers make "how many tokens does this cost?" a practical question, not an academic one.
- **"Not found" isn't a failure.** The first live onboarding run counted "no Priya on record" as a failed check, and a planned onboarding-status lookup by her (non-existent) id as an error. The answer then said the details "couldn't be confirmed". Now an empty result is a finding, dependent steps are skipped with the reason, and `plan@2` / `respond@2` say that for a new hire "nobody found" is the good answer.
- **The model asks too many questions.** For "Who on my team has anomalies, *and* what does the policy say?", the parser added "Would you also like the policy details?", and after the answer asked again. The graph used to obey any model question. Now code decides: a model question counts only for requests that change data (`should_ask`).
- **Records written at the end were lost to `kill -9`.** The first restart test resumed perfectly, but `tool_call` had no rows for the killed segment: records were written when a segment finished, and a killed process never gets there. Now they're written after each node.
- **Simulating a crash honestly.** Raising `CancelledError` inside a node isn't a crash: LangGraph wraps it as a node error and the run is recorded as failed. The test instead hangs the LLM call and cancels the task from outside, the way shutdown does.

## Check yourself

<details>
<summary>What's the difference between graph state and the message history?</summary>

The message history is one field the A5.1 loop keeps: the conversation sent to the model. Graph state is everything the *workflow* knows: the parse, the route, clarifications, policy evidence, the plan and its fingerprint, each step's result, the user's choices and the verification. In the HR graph, most nodes never see a message list. They read structured fields and write structured fields, and the LLM gets a prompt built from them. State is what's checkpointed, inspected by `GET /agent/runs/:id`, and reasoned about by code (routing, validation). A message history can only be re-read by a model.
</details>

<details>
<summary>What exactly does the checkpointer store, and when?</summary>

After every super-step (each node, here): the state values, which nodes are next, the writes of the step (`checkpoint_writes`), interrupts and their payloads, plus metadata (source, step number). Large values go to `checkpoint_blobs`. It does **not** store the context: the LLM client, the HR client with the user's token, the retriever, the trace. A checkpoint is written before an interrupt returns, which is why a run can wait for days. It's written after each `execute_step`, which is why a resumed run continues from the next step.
</details>

<details>
<summary>Why plan before executing when writes are involved?</summary>

So the whole intended change can be checked, shown and approved *before* anything happens:
- code validates every step (tool, risk, arguments);
- M6 will show the plan with a before → after diff for approval;
- the fingerprint guarantees what runs is what was checked.

In a ReAct loop, each action is decided after seeing the last result, so there's never a complete thing to approve, and a write can happen before anyone sees the next one. Planning also makes partial failure explicit (M7): you know which steps ran and which didn't.
</details>

<details>
<summary>Experiment: stop the server in the middle of a run, restart it, and resume the run.</summary>

Done live (third row of the live check): `kill -9` during respond. After restart the run was `interrupted`; `hr-ai run --resume` (or `POST /resume` without an answer) ran only `respond`. The four lookups weren't repeated, and the answer matched.
</details>

## Next

M6 adds write tools behind risk levels and human approval. The plan → validate → execute pipeline is where they go: `check_plan(allow_writes=True)`, an approval node that `interrupt`s with the plan and a before/after diff, and `execute_step`'s one-step-per-pass checkpointing so a resumed run never repeats a write.
