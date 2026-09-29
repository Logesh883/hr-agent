# AI HR Operations Agent

**Scope 2 of 2: the AI employee (agent runtime, RAG, document AI, evaluation)**

An agentic AI employee for HR back-office operations. It converts natural-language HR requests into validated, auditable workflows using policy RAG, typed tools, verification, and human approval.

> The companion scope, the HR full-stack web app that this agent acts through, is described in [HR_WEB_APP_README.md](HR_WEB_APP_README.md).

| Dimension | Target |
| --- | --- |
| AI role | Digital HR Operations Employee |
| Core interaction | Natural language → plan → tools → verification → audit |
| Runtime | Python + FastAPI + LangGraph |
| Acts through | Typed HR API tool endpoints (never the database directly) |
| Deployment goal | Public portfolio application |
| Target cost | ₹0/month within free-tier limits |
| Repository | Single monorepo (shared with the web app) |

> **Core principle:** the AI does not merely answer questions. It understands intent, plans work, retrieves applicable policy, calls approved tools, verifies the resulting state, and records what happened.

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [Agent Goals](#2-agent-goals)
3. [AI Employee Architecture](#3-ai-employee-architecture)
4. [Agent Execution Flow](#4-agent-execution-flow)
5. [HR Policy RAG](#5-hr-policy-rag)
6. [AI Tool Catalog](#6-ai-tool-catalog)
7. [AI Capabilities by HR Area](#7-ai-capabilities-by-hr-area)
8. [AI Data Model](#8-ai-data-model)
9. [Technology Stack](#9-technology-stack)
10. [Free Deployment Architecture](#10-free-deployment-architecture)
11. [Safety & Guardrails](#11-safety--guardrails)
12. [AI Evaluation](#12-ai-evaluation)
13. [Testing Strategy](#13-testing-strategy)
14. [Repository Structure](#14-repository-structure)
15. [Development Roadmap](#15-development-roadmap)
16. [MVP Boundary](#16-mvp-boundary)
17. [Interview / Portfolio Demo](#17-interview--portfolio-demo)
18. [Portfolio Positioning](#18-portfolio-positioning)
19. [Key Architecture Decisions](#19-key-architecture-decisions)
20. [Definition of Done](#20-definition-of-done)

---

## 1. Product Vision

Repetitive HR back-office work is delegated to an AI employee while humans retain control over sensitive decisions.

### Example

> “Onboard Priya as a Software Engineer joining October 12, reporting to Rahul in Bangalore.”

- Identify or create the employee.
- Validate department, manager, location, and joining date.
- Retrieve the onboarding policy.
- Determine required documents and tasks.
- Create the onboarding workflow.
- Ask for missing information.
- Request human approval for sensitive actions.
- Execute through controlled tools.
- Verify the final state.
- Write an audit trail.

## 2. Agent Goals

- Demonstrate agentic AI: planning, tool calling, state management, verification, recovery, and human-in-the-loop.
- Use RAG for HR policies and knowledge rather than for deterministic business rules.
- Keep permissions and business rules outside the LLM.
- Make AI actions observable, measurable, and auditable.

## 3. AI Employee Architecture

| Component | Responsibility |
| --- | --- |
| Intent / Router | Understand the request and identify the HR operation. |
| Planner | Break the request into ordered actions. |
| Policy RAG | Retrieve applicable HR policy and evidence. |
| Tool Selector | Choose approved tools. |
| Executor | Call secure application APIs. |
| Verifier | Confirm expected business state after execution. |
| Recovery | Handle failures, retries, partial completion, and safe compensation. |
| Human Approval | Pause sensitive or irreversible operations. |
| Audit / Trace | Record request, plan, tools, results, approvals, and final state. |

## 4. Agent Execution Flow

**Request:** “Onboard Priya as a Software Engineer joining October 12, reporting to Rahul.”

1. **Understand:** extract intent and entities; resolve whether Priya already exists.
2. **Retrieve:** retrieve onboarding policy and required-document rules.
3. **Plan:** create employee → set employment details → assign manager/department → create checklist → request missing documents → prepare welcome message.
4. **Validate:** permissions, dates, manager, department, required fields.
5. **Approve:** pause on configured medium/high-risk actions.
6. **Execute:** call strongly typed tools through the HR API.
7. **Verify:** re-read the affected state and confirm each expected result.
8. **Audit:** persist the complete execution trace.

## 5. HR Policy RAG

RAG is used for policies and knowledge, **not** for permissions or deterministic business rules.

- **Sources:** PDF, DOCX, Markdown, and text policy documents (uploaded and versioned in the web app).
- **Pipeline:** parse → chunk → metadata → embeddings → pgvector → retrieval → optional reranking → LLM.
- **Metadata:** policy category, effective date, version, department, jurisdiction.
- Return supporting evidence so the command center can show it when a policy affects a workflow.
- Keep policy versions so historical decisions remain traceable.

## 6. AI Tool Catalog

The agent's toolset. Most tools are thin clients over the HR API's typed endpoints; `search_policy`, `extract_document`, and `compare_documents` run inside the AI service.

| Tool | Purpose | Approval | Runs in |
| --- | --- | --- | --- |
| `search_employee` | Find employee by ID, name, email, or attributes. | No | HR API |
| `create_employee` | Create employee profile. | Configurable | HR API |
| `update_employee` | Update non-sensitive fields. | Usually no | HR API |
| `change_manager` | Change reporting manager. | Recommended | HR API |
| `change_department` | Transfer employee/team. | Recommended | HR API |
| `create_leave_request` | Create leave request. | Configurable | HR API |
| `approve_leave` | Approve leave. | Yes in approval workflow | HR API |
| `read_attendance` | Read attendance data. | No | HR API |
| `propose_attendance_correction` | Prepare correction without applying it. | No | HR API |
| `apply_attendance_correction` | Apply approved correction. | Yes | HR API |
| `search_policy` | Retrieve policy evidence. | No | AI service |
| `upload_document` | Store document/file metadata. | Configurable | HR API |
| `extract_document` | Run OCR/document extraction. | No | AI service |
| `compare_documents` | Compare extracted fields. | No | AI service |
| `generate_document` | Prepare HR document. | Configurable | HR API |
| `send_email` | Send approved HR communication. | Yes initially | HR API |

## 7. AI Capabilities by HR Area

| HR area | What the agent does |
| --- | --- |
| Employee management | “Create Priya as a Software Engineer.” / “Move Arun to Product.” / “Show employees whose probation ends next month.” / “Find incomplete employee profiles.” |
| Onboarding | Plan the multi-step onboarding workflow, determine required documents from policy, ask for missing information, draft the welcome message. |
| Leave | Check requests against retrieved policy and explain why a request cannot be approved. |
| Attendance | Detect anomalies, cross-check with approved leave, and propose corrections (never apply them without approval). |
| Documents | OCR and structured extraction, document classification, cross-document comparison, missing-field and identity mismatch detection. |
| Payroll preparation | Flag missing bank details and inconsistent employee data for the preparation report. |

**Document example:** if a name differs between an offer letter, bank document, and tax document, flag it for review instead of automatically correcting it.

## 8. AI Data Model

Stored in the shared PostgreSQL database (Prisma schema in `packages/db`). HR entities are described in [HR_WEB_APP_README.md](HR_WEB_APP_README.md#7-core-data-model).

| Entity | Important fields |
| --- | --- |
| PolicyChunk | id, policyId, content, embedding, metadata |
| WorkflowRun | id, requestId, workflowType, status, startedAt, completedAt |
| AgentRun | id, workflowRunId, model, promptVersion, status, latency |
| ToolCall | id, agentRunId, toolName, input, output, status, timestamp |
| Approval | id, toolCallId, approverId, status, reason, timestamp |

## 9. Technology Stack

| Layer | Technology | Purpose |
| --- | --- | --- |
| AI service | Python + FastAPI | AI runtime |
| Agent orchestration | LangGraph | Stateful multi-step agent workflows |
| LLM layer | OpenAI-compatible abstraction + free/local provider | Model flexibility |
| Embeddings | Sentence Transformers / local embedding model | RAG embeddings |
| Vector search | pgvector | Policy/document semantic search |
| OCR | PaddleOCR or Tesseract | Document extraction |
| AI observability | Langfuse | Traces, latency, generations, evaluation |
| Testing | Python tests | Agent/RAG/evaluation tests |
| Containers | Docker + Docker Compose | Reproducible local environment |

## 10. Free Deployment Architecture

| Service | Use | Notes |
| --- | --- | --- |
| Render | FastAPI AI service | Free services may sleep when idle and have limited compute. |
| Supabase | pgvector | Shared with the HR app; free quotas apply. |
| Langfuse Cloud | AI observability | Free tier suitable for portfolio-scale usage. |
| Hosted/free LLM inference | Public AI runtime | Keep provider replaceable; free quotas can be rate-limited. |

> **Local fallback:** Ollama can run a supported open model during development. The public deployment should use a hosted/free inference option rather than trying to run a large local model on free web-service compute.

## 11. Safety & Guardrails

- LLM has no unrestricted database credentials.
- Every state-changing operation is an explicit, typed tool.
- Tool inputs are schema-validated before execution.
- Sensitive fields are masked in traces where possible.
- High-impact operations require human approval.
- Use idempotency keys for retryable actions.
- Never invent missing employee data.
- Document conflicts go to manual review.
- Keep proposed actions separate from executed actions.

| Risk | Examples | Default behavior |
| --- | --- | --- |
| Low | Read employee, search policy, create checklist | May execute automatically |
| Medium | Change manager, department transfer, send email | Configurable approval |
| High | Salary, bank details, termination, payroll changes | Mandatory human approval |

## 12. AI Evaluation

Create a synthetic evaluation set of roughly 50–100 HR requests covering normal cases, ambiguity, missing information, conflicting documents, permission violations, and tool failures.

- Intent accuracy.
- Entity extraction accuracy.
- Tool-selection accuracy.
- Tool-argument accuracy.
- Policy retrieval recall.
- Groundedness of policy-dependent responses.
- Workflow completion rate.
- Verification accuracy.
- Approval correctness.
- Regression performance across prompt/model changes.

## 13. Testing Strategy

| Layer | Examples |
| --- | --- |
| Agent | Intent → plan → correct tool selection |
| RAG | Policy retrieval and evidence correctness |
| Tool safety | Unauthorized tool calls fail |
| Workflow | Onboarding completes across multiple steps |
| Failure | Timeouts, duplicate requests, partial execution |
| E2E | Natural-language request → verified HR state |

## 14. Repository Structure

The parts of the monorepo owned by this scope:

```text
hr-ai-employee/
├── apps/
│   └── ai/             # FastAPI + LangGraph agent
├── ai/
│   ├── agents/
│   ├── graphs/
│   ├── tools/
│   ├── prompts/
│   ├── rag/
│   ├── evaluators/
│   └── guardrails/
├── docs/
│   └── evaluation/
└── tests/
    ├── agent/
    └── evaluation/
```

## 15. Development Roadmap

Starts once the HR app's tool API (web app phase 3) is available.

| Phase | Scope | Outcome |
| --- | --- | --- |
| 1. AI Command Center | LLM gateway, intent parsing, structured requests | Natural-language interface |
| 2. Tool Calling | Typed tools + permission checks | Agent performs real actions |
| 3. LangGraph | Planning, execution, verification, recovery | True agentic workflow |
| 4. RAG | Policy ingestion + pgvector + evidence UI | Grounded workflows |
| 5. Document AI | OCR + extraction + conflict detection | Automated document operations |
| 6. Human-in-loop | Risk classes + approvals | Safe execution |
| 7. Evaluation | Dataset + regression + traces | Measurable AI quality |
| 8. Deployment | Render + Langfuse + hosted LLM inference | Public portfolio demo |

## 16. MVP Boundary

**Build first:** AI command center backend, 5–8 safe tools, LangGraph planner/executor/verifier, policy RAG, document extraction, approval pauses, and full execution traces.

**Defer:** autonomous high-risk operations.

## 17. Interview / Portfolio Demo

| Demo scenario | What it demonstrates |
| --- | --- |
| “Onboard Priya” | Intent, planning, RAG, tools, multi-step execution |
| Conflicting documents | OCR, extraction, cross-document reasoning, safe review |
| Leave approval | Policy retrieval + deterministic validation + approval |
| Sensitive change | Risk classification + RBAC + human-in-loop |
| Tool failure | Recovery + retry + verification + auditability |
| Evaluation dashboard | AI quality measurement and regression testing |

## 18. Portfolio Positioning

**Suggested description:**

> “An agentic AI HR Operations Employee that converts natural-language HR requests into validated, auditable business workflows. It combines LangGraph-based planning, policy RAG, typed tool calling, document intelligence, human approval, state verification, and AI observability.”

**Skills demonstrated:** full-stack engineering, agentic AI, RAG, tool calling, workflow orchestration, document AI, security, evaluation, observability, and public deployment.

## 19. Key Architecture Decisions

| Decision | Reason |
| --- | --- |
| Separate AI service from HR API | AI experimentation stays independent from deterministic business logic. |
| LangGraph for workflows | Stateful multi-step behavior is explicit and testable. |
| PostgreSQL + pgvector | Avoids unnecessary vector infrastructure. |
| LLM provider abstraction | Supports free/local models now and hosted models later. |
| AI tools call application APIs | Prevents unrestricted LLM database access. |
| Verification after actions | Tool success does not guarantee correct business state. |
| Human approval for sensitive actions | Controls risk and demonstrates responsible agent design. |

## 20. Definition of Done

- [ ] Selected HR operations can be performed through natural language.
- [ ] The agent produces an explicit plan for multi-step tasks.
- [ ] Policy-dependent workflows retrieve supporting evidence.
- [ ] Every AI mutation uses a typed backend tool.
- [ ] Sensitive operations require human approval.
- [ ] The agent verifies the final state.
- [ ] Failures/retries are visible.
- [ ] Agent runs are auditable.
- [ ] An evaluation suite measures quality.
- [ ] The AI service runs locally with Docker Compose.
- [ ] The AI service is deployed within free-tier limits.
