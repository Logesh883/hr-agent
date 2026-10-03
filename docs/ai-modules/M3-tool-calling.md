# M3: Tool calling

**Status:** in progress. A3.1 is underway: request/query schemas generate correctly; runtime response schemas remain to be added for response types currently declared only as TypeScript interfaces. Plan: [AI_AGENT_TASKS.md § M3](../AI_AGENT_TASKS.md#m3-tool-calling-and-traces-4-days).

## In one paragraph

A3.1 connects the shared TypeScript API contracts to Python. The `@hr/contracts` Zod request and query validators are exported as JSON Schema, then `datamodel-code-generator` turns those files into Pydantic models. This gives the upcoming Python tools typed request shapes derived from the same source the HR API uses.

## How it works

```text
packages/contracts/src/*.ts
   │ Zod validators
   ▼
pnpm contracts:generate
   ├── packages/contracts/json-schema/api.json
   └── apps/ai/contracts/generated.py
```

The export list is explicit in `packages/contracts/scripts/export-json-schemas.mjs`. When a request/query validator is added or changed, update that list if it should be shared with the AI service, then run `pnpm contracts:generate`. The output JSON Schema preserves field names, enums, constraints, formats and defaults where JSON Schema can express them. Pydantic generation is deterministic with the version pinned by `apps/ai/uv.lock`.

The generated Python classes are data-shape models for future tool inputs. They do not replace the HR API's own authorization or business-rule validation. Zod refinements such as cross-field checks are not representable in standard JSON Schema and therefore are not carried into generated models.

Currently, the shared runtime schemas cover request bodies and query parameters. Many response types in `@hr/contracts` are TypeScript interfaces rather than Zod validators, so they are not part of this export yet.

## Files

| File | Role |
| --- | --- |
| `packages/contracts/scripts/export-json-schemas.mjs` | Names the Zod schemas to export and writes the combined JSON Schema document. |
| `packages/contracts/json-schema/api.json` | Checked-in JSON Schema source for Python generation. |
| `apps/ai/contracts/generated.py` | Checked-in generated Pydantic models. Do not edit by hand. |
| `apps/ai/pyproject.toml`, `apps/ai/uv.lock` | Pin the generator in the Python development environment. |
| `.github/workflows/contracts.yml` | Regenerates both outputs in CI and fails if either tracked file changes. |

## Generate locally

From the repository root:

```bash
pnpm contracts:generate
```

If the Python development environment has not been synced yet, run `cd apps/ai && uv sync --dev` first. Commit the updated JSON Schema and Python output along with any source contract changes.
