# AI agent: module notes

One file per finished module of the [learning and build plan](../AI_AGENT_TASKS.md). The plan says **what** to build; these notes record **what was actually built, how it works and why**, so you can come back months later (or explain it in an interview) without re-reading the code.

| Module | Notes | What it added |
| --- | --- | --- |
| M0 | [Python service foundations](M0-python-service.md) | `apps/ai` FastAPI service, settings, typed HR API client |
| M1 | [LLM fundamentals](M1-llm-fundamentals.md) | Provider-neutral LLM client, retries, streaming, logging, versioned prompts, `FakeLLM`, `hr-ai` CLI |

## How each note is laid out

1. **In one paragraph**: what the module added and where it sits in the system.
2. **How it works**: the main flow, with a diagram, and a map of the files.
3. **Design decisions**: what was chosen, what was rejected, and why.
4. **Try it**: commands to run, and what you should see.
5. **What happened along the way**: real problems hit while building it, and the fix.
6. **Check yourself**: the plan's questions, with answers folded away so you can try first.
7. **Next**: what the following module builds on.
