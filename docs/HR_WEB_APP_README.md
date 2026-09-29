# HR Full-Stack Web App

**Scope 1 of 2: the HR admin platform, backend APIs, data, and deployment**

The deterministic HR back-office application: employee records, onboarding, leave, attendance, documents, payroll preparation, approvals, and audit. It is fully usable through a normal admin UI, and it exposes the typed, permission-checked APIs that the AI agent calls.

> The companion scope, the AI agent build, is described in [AI_AGENT_README.md](AI_AGENT_README.md).

| Dimension | Target |
| --- | --- |
| Product | HR back-office operations platform |
| Primary user | HR administrator / HR operations executive |
| Owns | UI, business rules, permissions, data, approvals, audit |
| Does not own | Intent parsing, planning, RAG, OCR/extraction, LLM calls |
| Deployment goal | Public portfolio application |
| Target cost | ₹0/month within free-tier limits |
| Repository | Single monorepo (shared with the AI agent) |

> **Core principle:** permissions and business rules live here, outside the LLM. The AI agent can only act through the typed APIs this app exposes, and the backend enforces RBAC, validation, approvals, and audit whether the caller is a human or the agent.

---

## Table of Contents

1. [Product Goals](#1-product-goals)
2. [HR Operations Scope](#2-hr-operations-scope)
3. [AI Command Center UI](#3-ai-command-center-ui)
4. [Tool API (Contract with the AI Agent)](#4-tool-api-contract-with-the-ai-agent)
5. [Technology Stack](#5-technology-stack)
6. [Free Deployment Architecture](#6-free-deployment-architecture)
7. [Core Data Model](#7-core-data-model)
8. [Security & Approvals](#8-security--approvals)
9. [Testing Strategy](#9-testing-strategy)
10. [Repository Structure](#10-repository-structure)
11. [Development Roadmap](#11-development-roadmap)
12. [MVP Boundary](#12-mvp-boundary)
13. [Key Architecture Decisions](#13-key-architecture-decisions)
14. [Definition of Done](#14-definition-of-done)

---

## 1. Product Goals

- Create a genuine software product rather than a chatbot demo.
- Build a realistic HR administration application where repetitive back-office work can be delegated to an AI employee while humans retain control over sensitive decisions.
- Keep permissions and business rules outside the LLM.
- Make every change, human or AI, observable and auditable.
- Deploy a usable public demo with free-tier infrastructure.

## 2. HR Operations Scope

### 2.1 Employee Management

- Employee profile: identity, contact, employment, department, job title, manager, location, joining date, status.
- Create, edit, search, archive, reactivate, and view employees.
- Employee document inventory and verification status.
- Role and permission assignment.
- Bulk operations with preview and approval.

### 2.2 Employee Onboarding

- Create employee record.
- Assign department, manager, role, and location.
- Create onboarding checklist.
- Track required documents.
- Detect missing information.
- Generate/prepare onboarding documents.
- Prepare welcome communication.
- Track onboarding progress and completion.

### 2.3 Leave Management

- Create and view leave requests.
- View balances.
- Approve/reject according to permissions.
- Validate dates, conflicts, and applicable policy.
- Generate leave summaries.

### 2.4 Attendance Operations

- Daily/monthly attendance views.
- Missing attendance detection.
- Attendance anomaly detection.
- Cross-check attendance with approved leave.
- Prepare correction proposals.
- Require approval before changing historical records.

### 2.5 HR Documents

- Upload employee documents to file storage.
- Document inventory per employee.
- Verification workflow (pending → verified / flagged for review).
- Audit history of every document action.
- Store extraction results and conflict flags produced by the AI agent's document pipeline.

### 2.6 Payroll Preparation — Initial Scope

- Do not build full payroll calculation in the MVP.
- Prepare payroll inputs from employee changes, attendance, leave, and compensation records.
- Detect missing bank details and inconsistent employee data.
- Generate a reviewable preparation report.

### 2.7 Policy Management

- Upload and version HR policy documents (PDF, DOCX, Markdown, text).
- Store metadata: policy category, effective date, version, department, jurisdiction.
- Keep old versions so historical decisions remain traceable.
- Ingestion into the vector index is handled by the AI agent (see [AI_AGENT_README.md](AI_AGENT_README.md#5-hr-policy-rag)).

## 3. AI Command Center UI

The web app hosts the front end for the AI employee. The AI service does the reasoning, and this UI renders it.

- Natural-language request input.
- Intent summary and extracted entities.
- Execution plan preview.
- Missing-information prompts.
- Policy evidence.
- Risk classification.
- Approval cards (approve / reject with reason).
- Live tool execution timeline.
- Verification result.
- Audit/trace view.

## 4. Tool API (Contract with the AI Agent)

Every state-changing operation is an explicit, typed endpoint in the NestJS backend. The AI agent calls these endpoints and never touches the database directly. Request and response schemas live in `packages/contracts`.

| Tool endpoint | Purpose | Approval |
| --- | --- | --- |
| `search_employee` | Find employee by ID, name, email, or attributes. | No |
| `create_employee` | Create employee profile. | Configurable |
| `update_employee` | Update non-sensitive fields. | Usually no |
| `change_manager` | Change reporting manager. | Recommended |
| `change_department` | Transfer employee/team. | Recommended |
| `create_leave_request` | Create leave request. | Configurable |
| `approve_leave` | Approve leave. | Yes in approval workflow |
| `read_attendance` | Read attendance data. | No |
| `propose_attendance_correction` | Prepare correction without applying it. | No |
| `apply_attendance_correction` | Apply approved correction. | Yes |
| `upload_document` | Store document/file metadata. | Configurable |
| `generate_document` | Prepare HR document. | Configurable |
| `send_email` | Send approved HR communication. | Yes initially |

Backend responsibilities for every tool call:

- Validate input against the shared schema before execution.
- Enforce RBAC for the acting user, independent of the model.
- Check the risk class and hold the call for human approval when required.
- Accept idempotency keys for retryable actions.
- Use version checks/optimistic locking for concurrent updates.
- Write an audit event for every mutation.

## 5. Technology Stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| Frontend | Next.js + TypeScript | HR admin UI + AI command center |
| UI | Tailwind CSS + shadcn/ui | Enterprise-style components |
| Data fetching | TanStack Query | API state/caching |
| Backend | NestJS + TypeScript | HR business logic and tools |
| Database | PostgreSQL | Transactional HR data |
| Vector search | pgvector | Extension on the same database, used by the AI agent |
| ORM | Prisma | Type-safe database access |
| Redis/queue | Upstash Redis + BullMQ | Background jobs/caching |
| File storage | Supabase Storage | HR documents |
| Auth | Auth.js / NextAuth | Authentication |
| Authorization | Backend RBAC | Permissions |
| App observability | OpenTelemetry | Distributed traces/metrics |
| Testing | Vitest + Playwright | Unit/API/E2E tests |
| Containers | Docker + Docker Compose | Reproducible local environment |
| Deployment | Cloudflare Pages + Render + Supabase + Upstash | Free-tier public deployment |
| CI | GitHub Actions | Build/test/deploy automation |

## 6. Free Deployment Architecture

| Service | Use | Notes |
| --- | --- | --- |
| Cloudflare Pages | Next.js frontend | Public web UI; free-tier limits apply. |
| Render | NestJS API | Free services may sleep when idle and have limited compute. |
| Supabase | PostgreSQL + pgvector + storage | Demo-scale HR data; free quotas apply. |
| Upstash | Redis | Use only where needed; stay within free request limits. |

## 7. Core Data Model

| Entity | Important fields |
| --- | --- |
| Employee | id, employeeCode, name, email, DOB, departmentId, managerId, jobTitle, location, joiningDate, status |
| Department | id, name, managerId, status |
| LeaveRequest | id, employeeId, type, startDate, endDate, reason, status, approverId |
| AttendanceRecord | id, employeeId, date, checkIn, checkOut, status, correctionReason |
| Document | id, employeeId, type, storageKey, status, uploadedAt, verifiedAt |
| PolicyDocument | id, title, version, effectiveFrom, category, storageKey |
| OnboardingTask | id, employeeId, taskType, status, assignee, dueDate |
| Approval | id, toolCallId, approverId, status, reason, timestamp |
| AuditLog | id, actorType, actorId, action, entityType, entityId, before, after, timestamp |

AI-run entities (`WorkflowRun`, `AgentRun`, `ToolCall`, `PolicyChunk`) live in the same Prisma schema and are described in [AI_AGENT_README.md](AI_AGENT_README.md#8-ai-data-model).

## 8. Security & Approvals

- Backend RBAC is enforced independently of the model.
- Tool inputs are schema-validated before execution.
- High-impact operations require human approval.
- Every mutation creates an audit event (`actorType` distinguishes human from AI).
- Use idempotency keys for retryable actions.
- Use version checks/optimistic locking for concurrent updates.
- Keep proposed actions separate from executed actions.

| Risk | Examples | Default behavior |
| --- | --- | --- |
| Low | Read employee, search policy, create checklist | May execute automatically |
| Medium | Change manager, department transfer, send email | Configurable approval |
| High | Salary, bank details, termination, payroll changes | Mandatory human approval |

## 9. Testing Strategy

| Layer | Examples |
| --- | --- |
| Unit | Leave validation, permission checks, state transitions |
| API | Employee, leave, attendance, document endpoints |
| Tool safety | Unauthorized tool calls fail |
| E2E | Admin UI flows; natural-language request → verified HR state (with the AI agent) |

## 10. Repository Structure

The parts of the monorepo owned by this scope:

```text
hr-ai-employee/
├── apps/
│   ├── web/            # Next.js HR admin UI + AI command center
│   └── api/            # NestJS HR backend + tool endpoints
├── packages/
│   ├── db/             # Prisma schema/client
│   ├── contracts/      # Shared DTOs/schemas (tool contracts)
│   ├── ui/             # Shared UI
│   └── config/         # Shared configuration
├── docs/
│   ├── architecture/
│   ├── product/
│   └── policies/
├── tests/
│   └── e2e/
├── infra/
├── docker-compose.yml
└── README.md
```

## 11. Development Roadmap

| Phase | Scope | Outcome |
| --- | --- | --- |
| 1. Foundation | Monorepo, auth, DB, employee CRUD, RBAC | Working HR admin |
| 2. Core HR | Leave, attendance, onboarding, documents | Usable HR operations app |
| 3. Tool API | Typed tool endpoints + permission checks + contracts | Agent-callable backend |
| 4. Approvals & Audit | Risk classes, approval flow, audit log, command center UI | Safe execution surface |
| 5. Deployment | Cloudflare + Render + Supabase + Upstash | Public portfolio demo |

## 12. MVP Boundary

**Build first:** employee management, departments/managers, leave, onboarding checklist, document upload, command center UI, typed tool endpoints for 5–8 safe tools, approval flow, audit trail, and public deployment.

**Defer:** full payroll, banking integrations, statutory compliance, multi-company tenancy, complex workflow builder, and enterprise SSO.

## 13. Key Architecture Decisions

| Decision | Reason |
| --- | --- |
| Separate HR API from AI service | Deterministic business logic stays independent from AI experimentation. |
| AI tools call application APIs | Prevents unrestricted LLM database access. |
| PostgreSQL + pgvector | Avoids unnecessary vector infrastructure. |
| Human approval for sensitive actions | Controls risk and demonstrates responsible agent design. |
| Single monorepo | Simple cloning, development, CI, and deployment. |

## 14. Definition of Done

- [ ] HR users can manage core records through the normal admin UI.
- [ ] Every AI mutation goes through a typed backend tool endpoint.
- [ ] RBAC is enforced on every endpoint regardless of caller.
- [ ] Sensitive operations are held for human approval.
- [ ] Every mutation writes an audit event.
- [ ] The command center renders plans, evidence, approvals, and traces.
- [ ] The project runs locally with Docker Compose.
- [ ] A public demo is deployed within free-tier limits.
