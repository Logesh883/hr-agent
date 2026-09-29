# M0: Python service foundations

**Status:** done (commit `8d395a5`). Plan: [AI_AGENT_TASKS.md § M0](../AI_AGENT_TASKS.md#m0-python-service-foundations-1-day-).

## In one paragraph

M0 created `apps/ai`, the Python service that will become the AI agent. It's a FastAPI app on port 8000 that reads the same root `.env` as the web app and API, answers `GET /health`, and has a typed client for the NestJS HR API. That client always sends the **signed-in user's token**, so when the agent later acts, the HR API applies the same permissions, business rules and audit as if the user had clicked in the web app. The model never gets more access than the person using it.

```text
Web app (3000) ──(user's token)──► AI service (8000) ──(same token)──► HR API (4000) ──► Postgres
```

## How it works

### Files

| File | Purpose |
| --- | --- |
| `apps/ai/pyproject.toml` | Project definition: Python 3.12, dependencies, ruff/pyright/pytest settings, the `hr-ai` command |
| `apps/ai/uv.lock` | Exact versions of every package, so every machine installs the same thing |
| `apps/ai/.python-version` | Tells uv to use Python 3.12 |
| `apps/ai/app/settings.py` | Configuration from the root `.env` |
| `apps/ai/app/main.py` | The FastAPI app: `create_app()`, CORS, `/health` |
| `apps/ai/app/hr_client.py` | Typed HR API client and its error types |
| `apps/ai/package.json` | pnpm wrappers so `pnpm dev`, `pnpm lint`, `pnpm typecheck` include the AI service |
| `apps/ai/tests/test_health.py`, `test_hr_client.py` | Tests |

### Settings (`app/settings.py`)

`Settings` is a `pydantic-settings` class. Each field maps to an env var with the same name in upper case (`hr_api_url` ↔ `HR_API_URL`), converted to the declared type, with a default when unset.

- It walks up from its own folder until it finds `pnpm-workspace.yaml`, and reads `.env` from there. This mirrors how the NestJS API finds the same file.
- `extra="ignore"`: the shared `.env` also holds `DATABASE_URL`, `JWT_SECRET` and so on, which the AI service doesn't need.
- Real environment variables beat `.env`, so `LLM_MODEL=x uv run …` overrides one run without editing the file.
- `get_settings()` is cached, so the file is read once per process.

### The app (`app/main.py`)

`create_app(settings)` builds the FastAPI app. It's a function, not only a module-level object, so tests can build an app with their own settings (for example a different CORS origin). `app = create_app()` at the bottom is what uvicorn serves.

CORS: browsers block a page on `localhost:3000` from reading responses from `localhost:8000` unless the server allows it. `CORSMiddleware` allows exactly `WEB_ORIGIN` and no one else.

### The HR API client (`app/hr_client.py`)

```text
HrApiClient(http, token)
   │ request("POST", "/leave-requests", json=…)
   ├─ adds  Authorization: Bearer <token>
   ├─ network failure       → HrApiUnavailableError   ("nobody answered")
   ├─ 4xx / 5xx response    → HrApiError              ("the API said no, and why")
   └─ 2xx                   → decoded JSON (None for an empty body)
```

- **One shared `httpx.AsyncClient`, many `HrApiClient`s.** The httpx client holds a connection pool and should live as long as the app. `HrApiClient` is a cheap wrapper created per request, because each request comes from a different user with a different token. The token is attached per request, never to the shared client, so one user's token can't leak into another's call.
- **Errors keep the API's structure.** The HR API's error body (`ApiError` in `packages/contracts/src/common.ts`) has `statusCode`, `message`, and optionally:
  - `issues` (400): which request fields were invalid, e.g. `{path: "email", message: "Invalid email address"}`
  - `problems` (422): which business rules were broken, e.g. `{code: "INSUFFICIENT_BALANCE", …}`
  - `code`: a machine-readable reason, e.g. `PASSWORD_CHANGE_REQUIRED`

  `HrApiError` keeps all of them. The agent will need them: in M7 it reads `problems` to explain a refusal in plain words or change its plan.
- **Defensive parsing.** NestJS's own errors sometimes send `message` as a list (joined with `; `), and a proxy may send HTML instead of JSON (falls back to the HTTP reason phrase). Neither crashes the client.
- **camelCase ↔ snake_case.** `ApiModel` uses pydantic's `to_camel` alias generator, so JSON `employeeId` becomes Python `employee_id`.
- **Typed responses.** `login()` and `me()` return `LoginResponse` / `SessionUser` models, validated on arrival. The agent's tools (M3) will be added as more typed methods like these.

## Design decisions

| Decision | Why | Rejected |
| --- | --- | --- |
| Python **3.12** pinned with uv | ML/AI libraries lag the newest Python (the Mac has 3.14); uv installs 3.12 just for this project | System Python 3.14: packages like torch and some tokenizers ship wheels late |
| **Flat layout** (`app/`, `llm/`, `prompts/` at the top of `apps/ai`) | The plan adds many packages (`tools/`, `rag/`, `graphs/`…); flat keeps imports short (`from llm.types import …`) | uv's default `src/hr_ai/` single package |
| Installable package (hatchling) | Makes `uv run hr-ai …` work and lets tests import without path hacks | `package = false` (what M0 started with; changed in M1 when the CLI arrived) |
| **httpx** for HTTP | Async, typed, and `respx` can mock it in tests | `requests` (blocking) and `aiohttp` (no `respx`) |
| Tests use `httpx.ASGITransport`, not FastAPI's `TestClient` | `TestClient` is deprecated with httpx in the installed Starlette, and its types show up as unknown under strict pyright | |
| **Strict** pyright | Catches `None` bugs and wrong types before running; the agent code will be complex | Basic mode |

## Try it

```bash
pnpm dev:ai                                   # or: cd apps/ai && uv run hr-ai serve --reload
curl localhost:8000/health                    # {"status":"ok"}
cd apps/ai && uv run pytest tests/test_health.py tests/test_hr_client.py
```

Talking to the real HR API from Python (with the API running):

```python
import asyncio, httpx
from app.hr_client import HrApiClient, HrApiError

async def main():
    async with httpx.AsyncClient(base_url="http://localhost:4000") as http:
        login = await HrApiClient(http).login("employee@hr.local", "Password123!")
        me = await HrApiClient(http, login.access_token).me()
        print(me.name, me.role)                        # Sneha Patel EMPLOYEE
        try:
            await HrApiClient(http, "bad-token").me()
        except HrApiError as e:
            print(e.status_code, e.message)            # 401 Invalid or expired token

asyncio.run(main())
```

## What happened along the way

- **`TestClient` deprecation.** The first health tests used FastAPI's `TestClient`, which printed a Starlette deprecation warning and failed strict pyright. Switching to `httpx.AsyncClient(transport=httpx.ASGITransport(app=app))` fixed both, and it's the same client the real code uses.
- **Port from `.env`.** Plain `uvicorn app.main:app` can't read `AI_PORT` from `.env`, so the dev command goes through Python (`hr-ai serve`), which reads settings first and then starts uvicorn.

## Check yourself

<details>
<summary>When should a FastAPI handler be <code>async def</code> vs <code>def</code>?</summary>

Use `async def` when the handler waits on I/O through an **async** library (httpx, an async DB driver, the LLM client). While it waits, the event loop serves other requests. Use plain `def` when it calls **blocking** code (e.g. `requests`, a CPU-heavy function): FastAPI runs `def` handlers in a thread pool so they don't freeze the event loop. The trap is calling blocking code inside `async def`: every other request stalls until it finishes.
</details>

<details>
<summary>Why pin Python 3.12 instead of using the newest version?</summary>

The AI ecosystem (torch, tokenizers, some embedding libraries) publishes pre-built wheels for new Python versions months late. On the newest Python, `pip install` either fails or compiles from source. Pinning 3.12 per project, with uv, keeps installs fast and reproducible while the system Python stays new.
</details>

## Next

M1 adds the model layer (`llm/`): a provider-neutral client, prompts as files, logging, and the `hr-ai` CLI. See [M1 notes](M1-llm-fundamentals.md).
