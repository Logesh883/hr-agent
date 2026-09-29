# M1: LLM fundamentals

**Status:** done, verified live on Groq and OpenRouter. Plan: [AI_AGENT_TASKS.md § M1](../AI_AGENT_TASKS.md#m1-llm-fundamentals-3-days-).

## In one paragraph

M1 gave the AI service a way to talk to language models that doesn't depend on any one vendor. All code calls one interface, `LLMClient.chat()` / `.stream()`, with provider-neutral types (`Message`, `LLMResponse`). Behind it, `OpenAICompatibleClient` speaks the OpenAI chat-completions format that Groq, OpenRouter and Gemini all accept, so switching provider or model is an `.env` change. Every call is timed and written as one JSON log line (tokens, latency, prompt version, never message text). Calls are retried with backoff when the provider is rate-limited or down. Prompts live in versioned files. `FakeLLM` lets every later module test agent logic without calling a model.

**Changed from the original plan:** the plan also had a local Hugging Face model (`Qwen2.5-1.5B-Instruct` via `transformers`). You chose free hosted models only, and the Mac had about 2.8 GB of free disk, so the local client was removed. A local model remains optional as bonus B3.

## How it works

### One call, end to end

```text
your code
  │  llm.chat(messages, temperature=0.7, max_tokens=512, prompt=dev_chat@1)
  ▼
LLMClient.chat()                       llm/base.py
  │  start timer
  ▼
OpenAICompatibleClient._chat()         llm/openai_compat.py
  │  body = {model, messages, temperature, max_tokens, [tools], [response_format]}
  ▼
_send()  POST {base_url}/chat/completions   Authorization: Bearer <key>
  │   429 / 5xx / timeout ──► wait 0.5s·2ⁿ (or Retry-After) and retry, max 3 times
  │   other 4xx          ──► LLMError immediately (retrying won't help)
  ▼
parse JSON with pydantic "wire" models ──► LLMResponse(text, tool_calls, usage, model, finish_reason)
  ▼
LLMClient.chat()  sets latency_ms, logs one "llm.call" line, returns the response
```

Streaming (`stream()`) is the same, except the request has `"stream": true` and the reply arrives as **server-sent events**, one `data: {…}` line per piece of text:

```text
data: {"choices":[{"delta":{"content":"Loss"}}]}
data: {"choices":[{"delta":{"content":" of pay"}}]}
data: {"choices":[{"finish_reason":"stop"}]}
data: {"choices":[],"usage":{"prompt_tokens":151,"completion_tokens":95}}   ← because stream_options.include_usage
data: [DONE]
```

Each text piece becomes a `StreamChunk(text=…)`. The last one is `StreamChunk(done=True, usage, latency_ms, ttft_ms, finish_reason)`. `base.py` measures **time to first token** (TTFT) as the moment the first non-empty text arrives.

### Files

| File | Purpose |
| --- | --- |
| `llm/types.py` | `Message` (system/user/assistant/tool), `ToolCall`, `Usage`, `LLMResponse`, `StreamChunk`, `PromptRef`, `ToolSpec`. `Message.to_wire()` converts to the OpenAI JSON format. |
| `llm/base.py` | `LLMClient`: public `chat()`/`stream()` do timing and logging, subclasses implement `_chat()`/`_stream()`. Also `LLMError`. |
| `llm/openai_compat.py` | The one real client: request building, retries, SSE parsing, error-message extraction, `list_models()` |
| `llm/factory.py` | `create_llm_client(settings)`: the only place a provider is chosen |
| `llm/fake.py` | `FakeLLM`: scripted replies for tests; records every call it receives |
| `prompts/__init__.py` | `load_prompt(name)` → `Prompt(name, version, template)`, `render(**values)` |
| `prompts/dev_chat.md` | The first prompt: system prompt for the dev chat |
| `app/log.py` | `JsonFormatter` and `configure_logging()`: one JSON object per log line |
| `app/llm_routes.py` | Dev-only `POST /llm/chat`; `get_llm` dependency that creates the client on first use |
| `app/cli.py` | `hr-ai serve`, `hr-ai chat`, `hr-ai models` |
| `experiments/m1_llm_basics.py` | The M1 experiment (tokens, sampling, truncation, speed) |
| `tests/test_openai_compat.py`, `test_fake_llm.py`, `test_prompts.py`, `test_llm_routes.py`, `test_factory.py`, `conftest.py` | Tests; `conftest.py` stops tests from reading your real `.env` |

### Choosing a provider (`llm/factory.py`)

```text
LLM_PROVIDER=groq        → https://api.groq.com/openai/v1                      key: GROQ_API_KEY
LLM_PROVIDER=openrouter  → https://openrouter.ai/api/v1                        key: OPENROUTER_API_KEY
LLM_PROVIDER=gemini      → https://generativelanguage.googleapis.com/v1beta/openai   key: GEMINI_API_KEY
LLM_PROVIDER=custom      → LLM_BASE_URL                                        key: LLM_API_KEY
```

The provider's own key wins; `LLM_API_KEY` is the fallback. `LLM_MODEL` has no default because free model lists change; `uv run hr-ai models` lists the current ones. Missing settings raise `LLMConfigError`, which names exactly what to set. The server turns that into a 503 on `/llm/chat` only, so `/health` works without any LLM configured.

### Logging (`app/log.py`, `llm/base.py`)

Every call writes exactly one line, success or failure:

```json
{"ts": "2026-09-29T16:38:40.846+00:00", "level": "info", "logger": "hr_ai.llm", "event": "llm.call",
 "provider": "groq", "model": "openai/gpt-oss-120b", "prompt": "dev_chat@1", "temperature": 0.0,
 "latency_ms": 684.5, "status": "ok", "stream": true, "ttft_ms": 589.7,
 "prompt_tokens": 151, "completion_tokens": 95, "finish_reason": "stop"}
```

Retries add `llm.retry` lines (attempt, reason, delay). Message content is deliberately **not** logged: prompts will contain employee data, and logs get copied to many places. M3 adds Langfuse traces for looking at content during development.

### Prompts as files (`prompts/`)

```markdown
---
name: dev_chat
version: "1"
description: System prompt for the dev-only POST /llm/chat endpoint and `hr-ai chat`.
---
You are an assistant for the HR operations team of a mid-sized Indian company.
Today is {{ today }}.
…
```

- `load_prompt("dev_chat")` checks the front matter's `name` matches the file name and that there is a `version`.
- `render(today=…)` fills `{{ placeholders }}`. A missing value raises `PromptError` instead of silently sending `{{ today }}` to the model.
- The `PromptRef` (`dev_chat@1`) is passed to `chat(prompt=…)` and logged. **Bump `version` whenever you change the wording**, so a change in results can be traced to a prompt edit (M2 and M10 compare versions).

### Testing without a model (`llm/fake.py`)

```python
llm = FakeLLM(["first reply", LLMResponse(text=None, tool_calls=[…]), TimeoutError()])
await llm.chat([...])   # → "first reply"
await llm.chat([...])   # → the scripted tool call
await llm.chat([...])   # → raises TimeoutError
llm.calls[0].messages   # what the code under test actually sent
```

`FakeLLM` goes through the same `LLMClient` base, so logging and timing behave the same as for the real client. An empty script raises an error so a test can't silently make extra calls.

## Design decisions

| Decision | Why | Rejected |
| --- | --- | --- |
| **One interface, own types** (`LLMClient`, `Message`) | The plan's pitfall: one provider's SDK spread through the code makes switching painful. Only `llm/` knows about wire formats. | Calling the `openai` SDK directly from agent code |
| **Plain httpx, no SDK** | Every request, retry and streamed line is visible (good for learning), retries are under our control, and `respx` mocks it | `openai` SDK (hides retries and has its own); LiteLLM (large; hides exactly what M1 is meant to teach) |
| **OpenAI-compatible only** | Groq, OpenRouter, Gemini and Hugging Face all accept it, so one client covers every free option | A client per provider |
| **Retry only 429, 5xx and network errors** | Those are temporary. A 400 means the request itself is wrong, and retrying burns rate limit for nothing. | Retry everything |
| **Backoff with jitter; obey `Retry-After`** | Waits grow (0.5 s, 1 s, 2 s), jitter stops parallel callers retrying in lockstep, and the provider knows best when to come back | Fixed delay |
| **`ToolCall.arguments` stays raw JSON text** | Models sometimes produce invalid JSON. Keeping the raw text lets M3 validate it and show the model its mistake. | Parsing it here and crashing on bad JSON |
| **Log after handing over the last stream chunk** | Lets the CLI finish its output line before the log line prints; the `finally` still logs if the caller stops early | Logging before the last chunk (the log line got glued to the answer) |
| **Per-provider keys** (`GROQ_API_KEY`, `OPENROUTER_API_KEY`) | Keep several keys in `.env` and switch with `LLM_PROVIDER` alone; handy for M2/M10 model comparisons | One `LLM_API_KEY` you swap by hand |
| **Dev routes only when `AI_ENV=development`** | `/llm/chat` sends anything to the model with no guardrails; it must not exist in production | Always on |

## Try it

```bash
cd apps/ai
uv run hr-ai models                           # model ids your key can use
uv run hr-ai chat "What is loss of pay?"      # streams the answer, then stats and the log line
uv run hr-ai chat "What is loss of pay?" --temperature 0 --no-stream
uv run hr-ai chat "Hi" --system "Reply only in Tamil."
uv run hr-ai chat "Hi" --model qwen/qwen3.8-27b
LLM_PROVIDER=openrouter uv run hr-ai chat "Hi" --model google/gemma-4-26b-a4b-it:free
uv run python experiments/m1_llm_basics.py    # the M1 experiment (~14 calls)
uv run pytest                                 # 49 tests, no real model calls
```

Through the server (`pnpm dev:ai`):

```bash
curl -X POST localhost:8000/llm/chat -H 'content-type: application/json' \
  -d '{"message":"What is a payslip?","temperature":0}'
curl -N -X POST localhost:8000/llm/chat -H 'content-type: application/json' \
  -d '{"message":"Name three leave types.","stream":true}'
```

### Results recorded on 2026-09-29

`experiments/m1_llm_basics.py` on Groq:

| | `qwen/qwen3.8-27b` | `openai/gpt-oss-120b` |
| --- | --- | --- |
| Prompt tokens, question alone | 27 | 86 (built-in system header) |
| Tokens for the 48-word `dev_chat` prompt | 76 (1.58 tokens/word) | 67 (1.40 tokens/word) |
| 5 runs at temperature 0 | 1 distinct answer | 1 distinct answer |
| 5 runs at temperature 1 | 5 distinct; one invented the abbreviation "LWP" and "temporary suspension of salary" | 5 distinct; one **empty** |
| `max_tokens=8` | `'In Indian payroll, "loss of pay'`, `finish_reason: length` | `''`, `finish_reason: length` |
| Time to first token | about 100–400 ms | about 400–600 ms |

OpenRouter free models that answered: `nvidia/nemotron-3-super-120b-a12b:free` (TTFT 1.1 s), `google/gemma-4-26b-a4b-it:free` (1.3 s), `poolside/laguna-s-2.1:free` (0.9 s, but only 27 tokens/s). Free OpenRouter is noticeably slower than Groq.

## What happened along the way

| Problem | Cause | Fix / lesson |
| --- | --- | --- |
| Not enough disk for the local model | 2.8 GB free; Qwen 1.5B is about 3 GB plus torch | Dropped local models (your choice anyway); hosted only |
| `HTTP 400: messages must contain a single user message for text classification models` | `LLM_MODEL` was `meta-llama/llama-prompt-guard-2-86m`, a prompt-injection **classifier**, not a chat model | Pick chat models from `hr-ai models`. The experiment now prints a hint on 400. (Prompt Guard itself becomes useful in M8, guardrails.) |
| gpt-oss returned empty text | It's a **reasoning model**: it writes hidden reasoning first, and those tokens count against `max_tokens` | Give reasoning models more `max_tokens`. Matters for structured output in M2. |
| OpenRouter `429 Provider returned error` on every call | Free models share one upstream pool (`limit_source: upstream_provider_shared_pool`) that was busy | Retries handled it as designed. The real reason was in `error.metadata.raw`, which errors now include. Try another free model or wait. |
| `inkling-small:free` → 403 | That model is only offered inside partner apps | Not every listed model is usable from the API |
| `python-dotenv could not parse statement starting at line 31` | A line `//LLM_API_KEY_OPEN_ROUTER sk-or-…`: `//` isn't a comment in `.env` (use `#`), and there was no `=` | Use `OPENROUTER_API_KEY=sk-or-…` |
| An OpenRouter key was printed into the chat | A masking command expected `KEY=value`; the line had no `=`, so nothing was masked | Rotate the key. Lesson: check what a "redacting" command prints before trusting it. |
| Tests could see your real keys | `Settings()` read the root `.env` during tests | `tests/conftest.py` disables the env file and clears `LLM_*`, provider key and `AI_ENV` variables for every test |
| CLI log line glued to the answer | The log was written before the CLI printed its final newline; also stdout buffering when piped | Log after the final chunk; `print(flush=True)` |
| `asynccontextmanager` flagged as deprecated | New typeshed rule: annotate with `AsyncGenerator`, not `AsyncIterator` | Changed the annotation in `app/main.py` |

## Check yourself

<details>
<summary>Why can the same prompt give different answers, and how do you make it (mostly) repeatable?</summary>

At each step the model produces a probability for every possible next token, and **sampling** picks one. With temperature above 0, less likely tokens get picked sometimes, so runs differ (the experiment: 5 different answers at temperature 1). Temperature 0 always picks the most likely token (greedy decoding): 5 identical answers. It's still only *mostly* repeatable, because provider-side batching and floating-point differences between GPUs can flip near-ties, and providers update models. For more repeatability, use temperature 0, a pinned model version, a `seed` where the provider supports it, and short prompts that don't change. For the agent: temperature 0 for deciding what to do (intents, tool calls), higher only for wording.
</details>

<details>
<summary>What does a chat template add around your messages, and why does using the wrong one hurt quality?</summary>

A model only sees one stream of tokens. The chat template turns role-tagged messages into that stream with special marker tokens, for example (Qwen style):

```text
<|im_start|>system
You are an assistant…<|im_end|>
<|im_start|>user
What is loss of pay?<|im_end|>
<|im_start|>assistant
```

The model was fine-tuned on exactly this format, so the markers tell it who is speaking and when its turn starts. With the wrong template, it sees text shaped differently from its training data: it may continue your message instead of answering, ignore the system prompt, or never stop. Hosted APIs apply the right template for you, but you can see its cost: gpt-oss used **86 prompt tokens for a 12-word question**, because its template adds a built-in system header and role markers.
</details>

<details>
<summary>Experiment: same question 5 times at temperature 0 and at 1.</summary>

See "Results recorded" above. Temperature 0: identical every time on both models. Temperature 1: five different wordings, one factual slip (Qwen invented "LWP" and described loss of pay as a "temporary suspension of salary"), and one empty answer from gpt-oss (its hidden reasoning used up the 80-token budget). Higher temperature trades consistency and accuracy for variety, which an HR agent rarely wants.
</details>

<details>
<summary>Estimate monthly tokens for 100 agent requests a day at ~6 LLM calls each. Which free-tier limit do you hit first?</summary>

- Calls: 100 × 6 = **600 calls a day**, about 18,000 a month.
- Tokens per call: an agent call re-sends the system prompt, tool definitions and conversation so far. Assume about 2,500 input and 300 output, so about 2,800 tokens.
- Per day: 600 × 2,800 ≈ **1.7 M tokens**; per month ≈ **50 M tokens**. Input dominates, because each of the 6 calls re-sends everything before it.

Free tiers limit requests per minute, requests per day, and tokens per minute and per day, per model. The first limit you hit is usually **requests per day** (OpenRouter free models allow only a small daily request count unless the account has credits) or **tokens per minute** during bursts, since one agent request fires 6 calls within seconds. Check current numbers at console.groq.com/settings/limits and in OpenRouter's docs, as they change. Ways to stay under: shorter system prompts, fewer calls per request, a smaller model for simple steps, and caching.
</details>

## Next

M2 uses this layer for **prompting and structured outputs**: turning "Approve Sneha's leave for Friday" into a validated pydantic object (intent + fields), with the first labelled evaluation set. It will use `response_format` (already passed through by `chat()`), versioned prompts, `FakeLLM` for unit tests, and a comparison of two hosted models.
