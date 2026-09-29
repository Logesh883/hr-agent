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

## Phase 2 — Core HR (Leave, Attendance, Onboarding, Documents)

### 2.1 Onboarding
- [ ] T2.1 Schema: `OnboardingTask`; checklist templates per department
- [ ] T2.2 API: start onboarding (creates tasks), update task status, progress summary
- [ ] T2.3 UI: onboarding board per employee, progress bar, missing-info warnings

### 2.2 Leave
- [ ] T2.4 Schema: `LeaveRequest`, `LeaveBalance`, leave types
- [ ] T2.5 Deterministic validation: date ranges, overlaps, balance, weekends/holidays
- [ ] T2.6 API: create, list, approve/reject (manager/HR only), balances
- [ ] T2.7 UI: leave requests list, request form, approval queue, balance view
- [ ] T2.8 Unit tests for leave validation rules

### 2.3 Attendance
- [ ] T2.9 Schema: `AttendanceRecord`; seed a month of data with gaps/anomalies
- [ ] T2.10 API: daily/monthly views, missing-attendance and anomaly queries
- [ ] T2.11 Cross-check with approved leave
- [ ] T2.12 Correction proposals (`proposed` → `approved` → `applied`); historical edits need approval
- [ ] T2.13 UI: calendar/table views, anomaly list, correction review

### 2.4 Documents
- [ ] T2.14 Supabase Storage (or local MinIO in docker) client in api
- [ ] T2.15 Schema: `Document`; upload, list, verification status
- [ ] T2.16 API: upload (signed URL), mark verified/flagged, per-employee inventory
- [ ] T2.17 UI: document tab on employee page, upload, verify/flag actions

### 2.5 Payroll preparation (report only)
- [ ] T2.18 Report: employee changes, attendance, leave for a period
- [ ] T2.19 Flags: missing bank details, inconsistent data
- [ ] T2.20 UI: reviewable report page + CSV export

### 2.6 Policies
- [ ] T2.21 Schema: `PolicyDocument` with version, category, effectiveFrom
- [ ] T2.22 API + UI: upload new policy version, list versions

**Exit:** every HR area in README §2 is usable through the admin UI without any AI.

## Phase 3 — Tool API (Contract with the AI Agent)

- [ ] T3.1 Define all 13 tool schemas (input/output) in `packages/contracts`
- [ ] T3.2 Export contracts as JSON Schema / OpenAPI for the Python agent
- [ ] T3.3 `POST /tools/:toolName` endpoints mapped to existing services
- [ ] T3.4 Service-to-service auth: agent acts *on behalf of* a user (user's RBAC applies)
- [ ] T3.5 Idempotency keys (`Idempotency-Key` header + stored results)
- [ ] T3.6 `actorType = AI` recorded in audit for tool calls
- [ ] T3.7 Contract tests: valid input passes, invalid input rejected, unauthorized call fails

**Exit:** every tool in README §4 can be called over HTTP with a schema-checked request, and RBAC and audit apply to it.

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
