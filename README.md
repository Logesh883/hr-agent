# AI HR Operations Employee

Portfolio project: an agentic AI employee for HR back-office operations. The system converts natural-language HR requests into validated, auditable workflows using policy RAG, typed tools, verification, and human approval.

The project is split into two scopes that share one monorepo and one database:

| Scope | README | Owns |
| --- | --- | --- |
| 1. HR Full-Stack Web App | [docs/HR_WEB_APP_README.md](docs/HR_WEB_APP_README.md) | Next.js admin UI, NestJS HR API, typed tool endpoints, RBAC, approvals, audit, data model, deployment |
| 2. AI Agent Build | [docs/AI_AGENT_README.md](docs/AI_AGENT_README.md) | FastAPI + LangGraph agent, planning, policy RAG, document AI, verification, evaluation, AI observability |

```text
HR admin ──► Next.js web app ──► NestJS HR API ──► PostgreSQL + pgvector
                  │                    ▲
                  ▼                    │ typed tool calls (RBAC, approvals, audit)
           FastAPI + LangGraph AI agent ┘
```

> **Core principle:** the AI does not merely answer questions. It understands intent, plans work, retrieves applicable policy, calls approved tools, verifies the resulting state, and records what happened. Permissions and business rules stay in the HR API, outside the LLM.

## Local Development

Requires Node 22+, pnpm 10, Docker, and [uv](https://docs.astral.sh/uv/) for the AI service (`uv python install 3.12`).

```bash
pnpm install
cp .env.example .env    # then set JWT_SECRET and AUTH_SECRET: openssl rand -base64 32
pnpm db:up              # PostgreSQL 16 + pgvector on localhost:5433
pnpm db:migrate         # apply Prisma migrations
pnpm db:seed            # demo company: people, leave, documents, onboarding, attendance, policies
pnpm dev                # web on http://localhost:3000, api on http://localhost:4000, ai on http://localhost:8000
```

Demo logins (password `Password123!`), also shown as one-click buttons on the sign-in page:

| Email | Role | Can |
| --- | --- | --- |
| `admin@hr.local` | Admin | Everything |
| `hr@hr.local` | HR Operations (Lakshmi) | Everything: employees, onboarding, leave, attendance, documents, payroll prep, policies |
| `manager@hr.local` | Manager (Rahul, Engineering) | Read the directory; approve the team's leave; see and propose corrections to the team's attendance; the team's onboarding |
| `employee@hr.local` | Employee (Sneha) | Request leave, own attendance, onboarding and documents, read policies |

The seed is a demo company with realistic loose ends to work through: leave awaiting approval, documents to verify (including a bank letter whose name doesn't match), new hires mid-onboarding with overdue tasks, attendance anomalies and a pending correction, and payroll blockers. Uploaded files go to `storage/` (git-ignored). Re-running `pnpm db:seed` resets the demo records.

New employees don't get a login automatically: HR opens the employee, uses **App access → Give app access**, and hands over the one-time temporary password. The employee signs in with their work email and must choose their own password first.

Other commands: `pnpm test:ai` (AI service tests), `pnpm test` (API unit + e2e; e2e runs against a separate `hr_test` database and `storage-test/` folder, migrated and seeded automatically, so it never touches your dev data), `pnpm typecheck`, `pnpm lint`, `pnpm db:studio`, `pnpm db:reset`.

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js admin UI (Auth.js, TanStack Query, shadcn/ui) |
| `apps/api` | NestJS HR API (JWT auth, RBAC + data scope, business rules, audit, file storage) |
| `apps/ai` | FastAPI AI agent service (Python 3.12, uv); calls the HR API with the signed-in user's token |
| `packages/contracts` | Zod schemas, DTO types, roles and permissions shared by web and api |
| `packages/db` | Prisma schema, migrations, seed |
| `packages/config` | Shared tsconfig and Prettier config |

Task plan and progress for the web app: [docs/HR_WEB_APP_TASKS.md](docs/HR_WEB_APP_TASKS.md).
Learning and build plan for the AI agent: [docs/AI_AGENT_TASKS.md](docs/AI_AGENT_TASKS.md).

Target cost: ₹0/month within free-tier limits. Source specification: [docs/AI_HR_Operations_Employee_Project_Specification.pdf](docs/AI_HR_Operations_Employee_Project_Specification.pdf).
