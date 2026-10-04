# AI agent: module notes

One file per finished module of the [learning and build plan](../AI_AGENT_TASKS.md). The plan says **what** to build; these notes record **what was actually built, how it works and why**, so you can come back months later (or explain it in an interview) without re-reading the code.

| Module | Notes | What it added |
| --- | --- | --- |
| M0 | [Python service foundations](M0-python-service.md) | `apps/ai` FastAPI service, settings, typed HR API client |
| M1 | [LLM fundamentals](M1-llm-fundamentals.md) | Provider-neutral LLM client, retries, streaming, logging, versioned prompts, `FakeLLM`, `hr-ai` CLI |
| M2 (in progress) | [Structured outputs](M2-structured-outputs.md) | A2.1–A2.5 schema, retry, tool-based entity resolution and authenticated `/agent/parse`; A2.6 dataset and eval runner (provider scores pending) |
| M3 | [Tool calling](M3-tool-calling.md) | Contracts shared with Python, tool framework, nine read-only HR tools, hand-written agent loop, RBAC through tools, masked OTLP tracing to Langfuse, `POST /agent/ask` |
| M4 | [RAG over HR policies](M4-rag.md) | `ai` schema with pgvector, ingestion as a least-privilege login, heading-aware chunking, hosted embeddings, vector + keyword + RRF + LLM rerank, effective-date scoping, `search_policy` with citations, retrieval eval (recall@5 = 1.00) and rules consistency test |
| M5 | [LangGraph workflows](M5-langgraph.md) | The M3 loop as a graph (proved identical), the HR agent graph (understand → route → plan → validate → execute step by step → verify → respond), clarification and "which one?" interrupts, Postgres checkpoints that survive restarts, runs API with SSE timeline, run/LLM/tool records |
| M6 | [Writes and approval](M6-writes-approval.md) | HR API: AI audit entries with run id, Idempotency-Key; eleven write tools with previews; risk policy file; approval node (approve / reject / edit, stored); "never invent data" provenance checks that ask instead; Onboard Priya live on hr_test |

## How each note is laid out

1. **In one paragraph**: what the module added and where it sits in the system.
2. **How it works**: the main flow, with a diagram, and a map of the files.
3. **Design decisions**: what was chosen, what was rejected, and why.
4. **Try it**: commands to run, and what you should see.
5. **What happened along the way**: real problems hit while building it, and the fix.
6. **Check yourself**: the plan's questions, with answers folded away so you can try first.
7. **Next**: what the following module builds on.
