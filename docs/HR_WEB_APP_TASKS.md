# HR Web App — Task Plan

Task breakdown for [HR_WEB_APP_README.md](HR_WEB_APP_README.md). Phases follow that file's roadmap (§11). Each phase ends with a working, demoable app.

**Stack:** Next.js (TypeScript) · NestJS (TypeScript) · PostgreSQL + Prisma · pnpm workspaces monorepo

Legend: `[x]` done · `[ ]` to do · **Exit:** what must be true before moving to the next phase

---

## Phase 0 — Workspace Setup

- [x] T0.1 Create monorepo root (`pnpm-workspace.yaml`, root `package.json`, `.gitignore`, `.editorconfig`)
- [x] T0.2 Scaffold `apps/web` (Next.js + TypeScript + Tailwind, App Router)
- [x] T0.3 Scaffold `apps/api` (NestJS + TypeScript) with `GET /health`
- [x] T0.4 Create empty `packages/db`, `packages/contracts`, `packages/ui`, `packages/config`
- [x] T0.5 `docker-compose.yml` with PostgreSQL 16 + pgvector (host port **5433**; 5432 is used by another local project)
- [x] T0.6 Root scripts: `pnpm dev` runs web + api together
- [ ] T0.7 `git init`, first commit, push to GitHub

**Exit:** `pnpm dev` starts the web app on :3000 and the API on :4000; `/health` returns `ok`.

## Phase 1 — Foundation (Monorepo, Auth, DB, Employee CRUD, RBAC) ✅

### 1.1 Shared config
- [x] T1.1 Shared `tsconfig` base and Prettier config in `packages/config` (linting stays per app: `eslint-config-next` in web, oxlint in api)
- [x] T1.2 Env handling: one root `.env` (`.env.example` documents it); zod-validated env in the API; web loads it via `scripts/next-with-env.mjs`

### 1.2 Database
- [x] T1.3 Prisma 7 in `packages/db` (`prisma.config.ts`, `@prisma/adapter-pg`), connected to docker Postgres
- [x] T1.4 Schema: `User` (role enum), `Employee`, `Department`, `AuditLog`, `Counter` (employee codes)
- [x] T1.5 First migration + idempotent seed: 4 departments, 20 employees, one login per role

### 1.3 Auth & RBAC
- [x] T1.6 Auth.js v5 credentials login in web; the API is the identity provider and its token lives in the encrypted session
- [x] T1.7 API issues and verifies its own JWT (global guard, user re-loaded per request); `@CurrentUser()`, `@Public()`
- [x] T1.8 Roles `ADMIN`, `HR_OPS`, `MANAGER`, `EMPLOYEE`; permission map in `packages/contracts`
- [x] T1.9 Global `PermissionsGuard` + `@RequirePermission()`
- [x] T1.10 RBAC matrix tests: 12 endpoints × 4 roles, plus anonymous and forged-token cases

### 1.4 Employee management
- [x] T1.11 Contracts: zod schemas for employee/department/audit DTOs, shared by API validation and web forms
- [x] T1.12 API: `GET/POST /employees`, `GET/PATCH /employees/:id`, `POST /employees/:id/archive`, `/reactivate`
- [x] T1.13 API: multi-term search + filters (department, manager, status, location) + pagination
- [x] T1.14 Optimistic locking (`version` column; stale writes return 409)
- [x] T1.15 Audit: every mutation writes `AuditLog` in the same transaction, recording only changed fields (`GET /audit-logs`)
- [x] T1.16 Departments API (`/departments`: list, get, create, update/archive)

Business rules enforced by the API: unique email/department code, active department required, no self-management or reporting cycles, can't archive someone with active reports or who manages a department, archived employees are read-only.

### 1.5 Web UI shell
- [x] T1.17 shadcn/ui (Radix, Nova), app layout (sidebar, header, user menu, dark mode)
- [x] T1.18 TanStack Query provider + typed API client; expired token signs the user out
- [x] T1.19 Employees list (table, debounced search, filters in the URL, pagination)
- [x] T1.20 Employee detail (with change history), create, and edit forms (react-hook-form + contract schemas)
- [x] T1.21 Departments page with create/edit dialogs
- [x] T1.22 Nav items and actions hidden by permission; direct URLs show "No access" from the API's 403

**Exit:** met. Verified by 75 API tests (unit, RBAC matrix, database lifecycle) and a 23-check browser run as HR, Manager, and Employee.

## Phase 2 — Core HR (Leave, Attendance, Onboarding, Documents) ✅

Built as vertical slices (API + tests + UI), in the order leave → documents → onboarding → attendance → payroll/policies. Shared foundation: **data scope** (HR/admin see everyone; managers see themselves and direct reports for leave, attendance and onboarding; everyone else sees themselves; documents are never team-visible).

### 2.1 Onboarding
- [x] T2.1 Schema: `OnboardingTemplateTask` (company-wide + department-specific, due relative to joining) and `OnboardingTask`
- [x] T2.2 API: start onboarding, update task (HR, or the manager/new-hire assignee), progress summary; document tasks complete only when the document is verified
- [x] T2.3 UI: onboarding tab per employee (progress, checklist, skip with note), onboarding list, missing-info warnings

### 2.2 Leave
- [x] T2.4 Schema: `LeaveRequest`, `Holiday`; balances are **computed** from policy entitlements (prorated by joining month) minus approved and pending days, so they can't drift
- [x] T2.5 Deterministic validation as pure functions: working days (weekends + holidays), overlaps, balance, backdating, span, year boundary; every failure explained in words
- [x] T2.6 API: preview (dry run), create, list (mine / approvals / all), approve/reject (manager for direct reports, HR for anyone, never your own), cancel, balances; per-employee advisory lock against overdrawing
- [x] T2.7 UI: my leave with balances, request dialog with live preview, approvals queue, team/all, who's out, holidays
- [x] T2.8 Unit tests for leave rules

### 2.3 Attendance
- [x] T2.9 Schema: `AttendanceRecord` (times stored as instants, shown in IST) and `AttendanceCorrection`; eight weeks of seeded data with deliberate anomalies
- [x] T2.10 API: daily and monthly views with per-employee day detail; anomalies: missing record, absent without leave, late check-in, missing check-out, short day
- [x] T2.11 Cross-check with approved leave (leave days, and check-ins on leave days)
- [x] T2.12 Corrections: proposed → approved (applied) or rejected; the record never changes before approval; proposer ≠ approver; no reviewing your own attendance
- [x] T2.13 UI: daily table, monthly summary, anomalies list, corrections queue, month calendar on the employee page

### 2.4 Documents
- [x] T2.14 Storage abstraction with a local-disk driver; the S3/Supabase driver moves to deployment (T5.4)
- [x] T2.15 Schema: `Document` (with an `extraction` column reserved for the AI OCR pipeline)
- [x] T2.16 API: upload through the API (10 MB, PDF/JPEG/PNG checked by file signature), authenticated download, verify/flag with note, review queue. Uploads go through the API rather than signed URLs so every read is access-checked
- [x] T2.17 UI: documents tab with required-documents checklist, upload, HR review queue (pending / flagged / all)

### 2.5 Payroll preparation (report only)
- [x] T2.18 Report per month: working, worked, paid/unpaid leave, unexplained days, loss of pay, payable days; joiners, exits and payroll-relevant edits from the audit log
- [x] T2.19 Flags: missing/unverified/flagged bank details and PAN, unresolved attendance, pending leave, pending corrections
- [x] T2.20 UI: report page with "needs attention" filter + CSV export

### 2.6 Policies
- [x] T2.21 Schema: `PolicyDocument` with version, category, effectiveFrom; seeded Markdown policies whose numbers match the enforced rules (RAG sources for the AI scope)
- [x] T2.22 API + UI: publish new versions (PDF/DOCX/Markdown/text), version history with in force / upcoming / superseded by effective date

**Exit:** met. Every HR area in README §2 works through the admin UI without AI. Verified by 29 unit tests, 265 API end-to-end tests (including an RBAC matrix over every endpoint and role), and a 59-check browser run across HR, manager and employee journeys.

## Added after Phase 2

- [x] Role-aware user guide (`/guide`), generated from the permission map and shared rule constants
- [x] App access: HR/admin give employees a login (work email + one-time temporary password), change role, reset password, turn access off; forced password change at first sign-in enforced by the API; password changes/resets end older sessions; archiving turns the login off; login email follows the work email; only admins manage admin logins; nobody manages their own access
- [x] E2E tests use their own `hr_test` database and storage folder (migrate + seed before each run) instead of the dev database

## Phase 3 — Tool API (Contract with the AI Agent) ✅

- [x] T3.1 Tool schemas (input/output) in `packages/contracts/src/tools.ts`: 14 tools. Of README §4's 13, `upload_document` stays the multipart `POST /employees/:id/documents`, `send_email` is the AI service's outbox stub, and `generate_document` waits for document AI (M9); `reject_leave`, `cancel_leave`, `start_onboarding` and `update_onboarding_task` are added because the agent needs them
- [x] T3.2 Exported as JSON Schema (`json-schema/api.json`) and Pydantic models for the agent (`pnpm contracts:generate`); `GET /tools` serves each tool's input/output JSON Schema
- [x] T3.3 `GET /tools` (catalog: schemas, permission, risk, whether the caller may use it) and `POST /tools/:toolName`, each tool mapped to the same service method as its REST endpoint. The agent's write tools now call these, so every AI mutation goes through a typed tool endpoint; reads stay on REST
- [x] T3.4 On behalf of a user: the agent forwards the signed-in user's token, so their role and data scope apply (no service account)
- [x] T3.5 `Idempotency-Key` (A6.1's interceptor) applies to `/tools/*` like any write
- [x] T3.6 Audit: `actorType = AI` + `agentRunId` (A6.1), and now `toolName` on every change made through the Tool API
- [x] T3.7 Contract tests (`apps/api/test/tools.e2e-spec.ts`): catalog, valid input runs and matches the output schema, invalid input → 400 with issues, wrong role → 403, unknown tool → 404, locking, idempotency, audit; plus a live agent-side test (`apps/ai/tests/test_integration_hr_api.py`)

**Exit:** met. Every tool can be called over HTTP with a schema-checked request; RBAC, idempotency and audit apply.

## Phase 4 — Approvals, Audit & Command Center UI

- [ ] T4.1 Risk classification config (low / medium / high per tool + field)
- [ ] T4.2 Schema: `Approval`, `WorkflowRun`, `ToolCall` (shared with AI scope)
- [ ] T4.3 Approval flow: tool call held as `PENDING_APPROVAL` → approve/reject → execute
- [ ] T4.4 Approval inbox UI (approve / reject with reason)
- [ ] T4.5 Audit log UI: filter by actor, entity, date; before/after diff
- [ ] T4.6 Command Center page: request input, plan preview, evidence panel, approval cards, execution timeline, verification result (built against mocked AI responses until the agent exists)
- [ ] T4.7 Live updates for timeline (SSE or polling)

**Exit:** a mocked AI run can be shown end to end in the Command Center, and sensitive calls stop for approval.

## Phase 5 — Quality & Deployment

- [ ] T5.1 OpenTelemetry in api (traces + metrics)
- [ ] T5.2 Playwright E2E: login, employee CRUD, leave approval, onboarding
- [ ] T5.3 GitHub Actions: lint, typecheck, unit, API, E2E on PR
- [ ] T5.4 Supabase project (Postgres + pgvector + storage); run migrations
- [ ] T5.5 Deploy api to Render; deploy web to Cloudflare Pages
- [ ] T5.6 Upstash Redis + BullMQ for background jobs (only where needed)
- [ ] T5.7 Seed public demo data; demo login accounts per role
- [ ] T5.8 Update README with live demo link and local setup steps

**Exit:** public demo is live within free-tier limits; CI is green.

---

## MVP Cut

If time is short, ship in this order: **T0 → T1 → T2.1–T2.8 (onboarding + leave) → T2.14–T2.17 (documents) → T3 (5–8 safe tools) → T4.1–T4.6 → T5.4–T5.5**. Attendance, payroll report and policy UI come after the MVP.
