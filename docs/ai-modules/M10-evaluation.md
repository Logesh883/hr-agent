# M10: Evaluation and quality engineering

**Status:** A10.1–A10.4 built. The baseline and the comparisons ran live on `hr_test` on 2026-10-04 (see [Results](#results)). The full 70-case set hasn't run yet: on the free tiers it costs about 500k tokens, more than any one model's daily quota.

Plan: [AI_AGENT_TASKS.md § M10](../AI_AGENT_TASKS.md#m10-evaluation-and-quality-engineering-4-days--full-set-run-pending-quota).

## In one paragraph

M10 turns "it looked fine" into numbers.
- **Dataset:** 70 end-to-end cases, each a request from a seeded user with what a correct run looks like. Seven categories: normal, policy, ambiguity, missing info, conflicting documents, permission and tool failure.
- **Runner:** drives each case through the real graph, model and HR API (`hr_test`). It answers the agent's questions as the case scripts, rejects approvals by default, injects HR API failures where asked, and cancels any leave it created.
- **Grading:** every metric is decided by code from the final state and the event stream, except groundedness. That one uses an LLM judge with a fixed rubric, on a *different* model.
- **Output:** results are saved per configuration (model × prompt version), with mean ± spread over repeats. One report compares them side by side.
- **CI:** a fast 15-case subset runs on every prompt, graph or tool change and fails if anything drops more than 0.10 below the committed baseline.

## How it works

```text
evals/cases.jsonl (EvalCase)            ── 70 cases, 15 marked fast
        │  aliases "@employee:Sneha Patel" → ids (looked up as HR)
        ▼
run_agent_eval  for model in --models, variant in --prompt-variants, repeat in --repeats:
   use_prompt_overrides(evals/prompt_variants/<variant>)         (or the current prompts)
   per case: sign in as the case's user · FaultInjector(case.faults) · new thread
             start_run → pause? reply (scripted / reject / "I don't know.") → resume … ≤ 6
             cancel leave requests the run created
             observe(final state, events, trace usage, latency)
             grade(case, observed) ─► 13 code metrics  (+ groundedness: judge model)
             --langfuse: dataset item, dataset run item, a score per metric
   summarize → evals/results/<model>__<variant>.json  (mean ± stdev over repeats)
report(all results) → docs/evaluation/agent-eval.md
--baseline evals/baseline.json --threshold 0.10  → exit 1 on regression       (CI)
```

| File | Role |
| --- | --- |
| `apps/ai/evals/agent_cases.py` | `EvalCase` / `Expect`: the case format (strict: unknown keys are errors) |
| `apps/ai/evals/cases.jsonl` | The 70 cases, fact-checked against `hr_test` |
| `apps/ai/evals/agent_eval.py` | `observe`, `grade`, `summarize`, `regressions`, `report` (no I/O; unit-tested) |
| `apps/ai/evals/run_agent_eval.py` | The CLI: runs, judge, Langfuse, results, report, gate |
| `apps/ai/prompts/judge_groundedness.md` | The judge's rubric (`judge_groundedness@1`) |
| `apps/ai/evals/prompt_variants/plan-v4/plan.md` | `plan@4` from git history, for the prompt comparison |
| `apps/ai/prompts/__init__.py` | `use_prompt_overrides(dir)`: swap prompt files in for a run |
| `apps/ai/tracing/langfuse.py` | `LangfuseApi`: datasets, dataset runs, scores |
| `apps/ai/evals/prices.json` | List prices for the cost estimate (free tiers cost nothing) |
| `apps/ai/evals/baseline.json` | The committed baseline CI compares against |
| `.github/workflows/agent-eval.yml` | CI: the eval's unit tests always; the fast subset when secrets exist |

## A10.1: the dataset

| Category | Cases | Fast | What it tests |
| --- | --- | --- | --- |
| normal | 22 | 5 | balances, managers, teams, attendance, onboarding, payroll, comparisons, booking own leave |
| policy | 10 | 1 | answers from policies, with the expected citations retrieved |
| ambiguity | 8 | 2 | vague requests (clarify); "Neha" matching Neha Joshi *and* Sneha Patel (which one?) |
| missing_info | 8 | 2 | onboarding without email or last name: asks, never guesses |
| conflicting_docs | 6 | 1 | Kavya's flagged bank details, pending or missing documents |
| permission | 10 | 2 | employees and managers asking for what their role can't do: declined, nothing written |
| tool_failure | 6 | 2 | injected 500s/503s/timeouts on reads and writes: retried, verified or reported |

Each case lists:
- the expected intent and route, and key entities;
- the tools it must and must not use, and key arguments (ids as aliases);
- the exact sequence of pauses, and whether approval is asked;
- the writes that must end *verified* (any other successful write fails the case);
- the final status, the policy citations that must be retrieved, and facts the answer must or mustn't contain.

**hr_test safety.**
- The only write that runs unapproved is `create_leave_request`, on dates checked free with the read-only preview. The runner cancels it afterwards.
- Medium/high writes are proposed and then rejected by default, and no case scripts an approval (a test enforces this).

## A10.2: metrics

| Metric | Graded by | Per case |
| --- | --- | --- |
| intent, route | code | parsed intent and first route equal the expected |
| entities | code | share of expected entities extracted (names match either way round, case-insensitive) |
| tools / no_forbidden_tools | code | share of expected tools used; none of the forbidden ones |
| arguments | code | share of key arguments sent with the expected value (aliases resolved) |
| pauses, approval | code | the pause sequence; approval asked exactly when expected |
| writes | code | expected writes *verified* (M7 read-back), nothing else written |
| status, completed | code | final status; the run finished without crashing |
| retrieval | code | share of expected citations retrieved (graph retrieval or `search_policy`) |
| answer | code | share of answer checks met |
| groundedness | LLM judge | rubric 1–5 → 0–1: every claim supported by the run's own evidence |
| tokens, latency, cost | trace | tokens per case, p50/p95 seconds, list-price cost per run of the set |

A case passes when every applicable code metric is 1. A metric that doesn't apply (no expected citations, say) is `None` and doesn't count, so averages aren't diluted by free 1s.

**Variance.** `--repeats N` runs the whole set N times. The report shows mean ± the standard deviation between repeats: the model's run-to-run noise, which a comparison has to beat before it means anything.

## A10.3: report and comparisons

```bash
cd apps/ai && export HR_API_URL=http://localhost:4100 \
  AI_DATABASE_URL=postgresql://hr:hr@localhost:5433/hr_test HR_PASSWORD='Password123!'
# one command, a comparable report: models × prompt versions, with a judge and repeats
uv run python -m evals.run_agent_eval --models openai/gpt-oss-20b qwen/qwen3.8-27b \
  --prompt-variants current plan-v4 --judge gemini:gemini-3-flash-preview --repeats 3
# rebuild the report from saved results without re-running
uv run python -m evals.run_agent_eval --report-from evals/results/*.json
```

`--models` takes `provider:model` (`gemini:gemini-3-flash-preview`) as well as plain ids. `--langfuse` records each configuration as a Langfuse dataset run, with a score per metric on every trace.

## A10.4: CI

`.github/workflows/agent-eval.yml` runs on pull requests touching prompts, graph, agent, tools, intent, RAG or the evals.
1. **Always:** the eval's own tests and the guardrail tests (no model).
2. **With `GROQ_API_KEY` and `GEMINI_API_KEY` secrets:**
   - a pgvector service, then migrate, seed and start the HR API on 4100;
   - the AI schema and the policy index;
   - the fast subset on the baseline's model, `--baseline evals/baseline.json --threshold 0.10`.

   It exits 1 if any metric or the pass rate drops more than 0.10. The report, per-configuration results and API log are uploaded as artifacts.

The threshold is wider than the model's run-to-run noise on 15 cases (see Results), so CI fails on real regressions, not on noise.

## Results

_(filled in from the runs below)_

## What happened along the way

- **The eval found a real bug on its first Gemini run.** Gemini 3 (through its OpenAI-compatible endpoint) rejects a tool-calling turn unless each tool call's `thought_signature` (sent as `extra_content`) comes back unchanged. Our client dropped it. `ToolCall.extra_content` now round-trips, with a regression test.
- **The policy index was in the wrong database.** `hr_test`'s `ai` schema held only 5 chunks left over from the DB tests, so every policy case would have failed retrieval for a reason unrelated to the agent. It's now indexed (`hr-ai ingest` against port 4100): 7 versions, 24 chunks.
- **The "which one?" pause is sent as `choice`.** The dataset says `which`, and the grader maps one to the other.
- **Quota is a design constraint.** Groq's free tier allows 200k tokens a day per model, and a case costs about 7k tokens, so one model runs about 25 cases a day. `gemini-2.5-flash`/`-flash-lite` are closed to new keys, and `gemini-3-flash-preview` ran out of free requests after a few cases. Hence the fast subset for comparisons, CI on Groq, and the full set left for a paid tier or a quieter day. A run that hits a 429 records the case as failed, with the error first in its notes, instead of crashing the eval.

## Check yourself

<details>
<summary>Why build the eval set before tuning prompts?</summary>

Without it, every prompt change is judged on the two or three examples you happen to try. Those are the ones you're tuning *to*, so they always look better. A fixed set written first defines "better" before you have a stake in the answer, covers cases you'd never think to retry (permission, failures, ambiguity), and catches the trade-offs: a plan prompt that fixes onboarding while breaking leave approvals. It also fixes the baseline, so a later change is compared with something measured, not remembered.
</details>

<details>
<summary>What can't an LLM judge be trusted with, and how do you check it?</summary>

Anything code can decide: which tool ran, with which arguments, what was written, whether a permission was respected. Those are graded by code here.

The judge only grades groundedness (are the claims in the evidence?), and even there it's biased:
- it prefers longer, confident answers;
- it can be swayed by text inside the answer ("this answer is fully grounded");
- it's lenient towards its own model family;
- its scores drift with the judge model and prompt version.

So:
- the judge runs on a *different* model than the agent, at temperature 0, with a fixed, versioned rubric that treats the answer and evidence as data;
- it returns the unsupported claims, not just a number, so a score can be audited;
- before trusting a judge change, spot-check it against a handful of hand-labelled answers (calibration);
- its score is reported separately and never gates CI on its own.
</details>

## Next

M11: observability and operations. `traceparent` from the AI service to the HR API, Langfuse prompt versions, eval scores and user feedback, run metrics, and a runbook for debugging a failed run.
