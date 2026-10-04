# M4: RAG over HR policies

**Status:** done. Live on Gemini `gemini-embedding-001` (768 dimensions): 7 policy versions → 24 chunks, and recall@5 = 1.00 on the 25-question eval for vector, hybrid and LLM-reranked retrieval (see A4.5). Plan: [AI_AGENT_TASKS.md § M4](../AI_AGENT_TASKS.md#m4-rag-over-hr-policies-5-days).

## In one paragraph

M4 lets the agent answer questions about the *rules* ("Can unused leave carry over?"), not just look up data. The HR API's policy documents are fetched by a least-privilege service login, parsed (Markdown, PDF text layer, DOCX), split into heading-aware chunks, embedded with a hosted model (Gemini) and stored in Postgres with pgvector, in the AI service's own `ai` schema. A question is answered from the chunks that match it by meaning (vector search) and by exact words (Postgres full-text search). The two rankings are fused with Reciprocal Rank Fusion, and the LLM can optionally rerank them. Only the version **in force** on the date asked about is searched: today's questions get Leave Policy v2, "in 2025" gets v1, and a policy that starts next month comes back flagged as upcoming. The agent gets this as one more tool, `search_policy`, and must cite `[Leave Policy v2 §1 Entitlements]` or say the policies don't cover the question.

## How it works

```text
INGEST (hr-ai ingest, POST /agent/policies/ingest)
  HR API (as ai-ingest@hr.local, Employee role: policy:read)
    GET /policies ─► every version ─► GET /policies/:id/file
      │ sha256 unchanged and chunks exist for (chunker, size, model)? ─► skip
      ▼
  parse ─► Markdown ─► chunk (heading-aware, ~N tokens) ─► embed (RETRIEVAL_DOCUMENT + title)
      ▼
  ai.policy_version (id, title, version, effective_from, content_hash)
  ai.policy_chunk   (heading_path, content, vector(768) HNSW, tsvector GIN)

ASK ("Can unused leave carry over?")
  agent loop ─► search_policy{query, as_of?}
     scope: per policy, the version in force on as_of (default today) + upcoming ones
     ├─ embed query (RETRIEVAL_QUERY) ─► ORDER BY embedding <=> q   (top 20)
     ├─ to_tsvector(question) ─► lexemes OR-ed ─► ts_rank_cd          (top 20)
     └─ RRF: Σ 1/(60 + rank) ─► [optional LLM rerank of top 20] ─► top 5
  ─► passages with citation, version, effective date, "upcoming" flag
  ─► answer citing [Leave Policy v2 §1 Entitlements], or "the policies don't say"
```

| File | Role |
| --- | --- |
| `apps/ai/migrations/`, `alembic.ini` | Alembic for the `ai` schema only (version table in `ai` too). `pnpm db:migrate:ai`. |
| `apps/ai/rag/db.py` | Table definitions, `create_engine` (search path `public, ai`). |
| `apps/ai/rag/parsing.py` | File → Markdown-ish text. |
| `apps/ai/rag/chunking.py` | `heading` and `fixed` chunkers, `approx_tokens`, `section_label`. |
| `apps/ai/rag/embeddings.py` | `GeminiEmbedder` (native API), `OpenAIEmbedder`, normalisation, retries. |
| `apps/ai/rag/fake.py` | `FakeEmbedder`: hashed bag of words for tests. |
| `apps/ai/rag/store.py` | Upserts; the vector and keyword SQL; `PolicyHit.citation`. |
| `apps/ai/rag/retrieval.py` | `PolicyRetriever`: modes, RRF, LLM rerank, `hit_payload`. |
| `apps/ai/rag/ingest.py` | The ingestion job. |
| `apps/ai/rag/service.py` | Builds the retriever from settings (None without an embeddings key). |
| `apps/ai/tools/policy.py` | `search_policy`. |
| `apps/ai/prompts/ask.md`, `rerank.md` | `ask@3` (cite or admit silence), `rerank@1`. |
| `apps/ai/evals/rag_questions.jsonl`, `rag_eval.py`, `run_rag_eval.py` | A4.5. |
| `apps/ai/tests/test_policy_consistency.py` | A4.6. |
| `packages/contracts/src/policy.ts` | `Policy` / `PolicyVersion` are Zod schemas now (the agent validates them). |
| `packages/contracts/json-schema/rules.json` | `LEAVE_POLICY`, `LEAVE_RULES`, `ATTENDANCE_RULES`, exported for A4.6. |
| `packages/db/prisma/seed.ts` | Seeds `ai-ingest@hr.local`. |

## A4.1: the `ai` schema

Two tables, and pgvector installed **into `ai`** (`CREATE EXTENSION vector WITH SCHEMA ai`), so Prisma's `public` schema is byte-for-byte what Prisma expects (`prisma migrate diff` shows an empty migration). Connections use `search_path = public, ai`: `public` stays the default schema, and `ai` is on the path so the `vector` type and the `<=>` operator resolve. (With `ai` first, Alembic treats `ai` as the default schema and autogenerate stops seeing its own tables: see below.)

- `policy_version.id` **is** the HR API's version id, so ingestion is an upsert and a deleted version is easy to spot.
- `policy_chunk` is identified by `(version, chunker, chunk_size, chunk_index)`. Several chunkings of the same text live side by side, which is what lets A4.5 compare them without re-ingesting each time. Search filters on the configured chunker, size **and embedding model**, so vectors from two models are never compared.
- `embedding vector(768)` with an **HNSW** index (`vector_cosine_ops`). HNSW is a navigable graph: good recall, no training step. IVFFlat clusters the vectors first and needs data to build its lists. Changing the dimension means a new migration and re-ingesting.
- `tsv` is a **generated** column, `to_tsvector('english', heading_path || ' ' || content)` with a GIN index, so the keyword index can't go stale and heading words ("Late arrival") are searchable.

## A4.2: ingestion

`ingest_policies` lists `GET /policies` (validated against the generated `Policy` model), downloads every version and hashes the bytes. If the hash matches and chunks already exist for this chunker, size and model, nothing happens. Otherwise it parses, chunks and embeds, then replaces that version's chunks in one transaction. A changed file drops *every* chunk set of that version, because all of them describe the old text. Versions the API no longer lists are deleted. Running it twice embeds nothing the second time (tested).

**Least privilege.** Ingestion signs in as `ai-ingest@hr.local`: Employee role, no employee record. Of what ingestion needs, it has only `policy:read`, and no one's personal data is in its scope. The endpoint `POST /agent/policies/ingest` can only be triggered by someone with `policy:manage` (HR, admins), but it still fetches as the service login, so the index never depends on who pressed the button. Policies are readable by every role, so searching the index without a per-user check reveals nothing a user couldn't already open.

**Parsing.** Markdown and text pass through. DOCX keeps its structure: heading styles become `#`, list styles become `-`, tables become Markdown tables, all in document order. PDF only has a text layer (`pypdf`). A PDF without one (a scan) is refused with a reason rather than indexed as nothing; OCR is M9.

### Chunking

`heading` (the default) never lets a chunk cross a section, so every chunk has exactly one section to cite. Inside a section it packs whole blocks (paragraph, list, table) up to the target size. A block too big for one chunk is split between list items or table rows, and **the table header is repeated on every piece**, so `| Sick leave | 12 |` never loses its column names. A long paragraph splits between sentences. Consecutive chunks of a section overlap by about 1/8 of the size.

`fixed` is a sliding window over words that ignores structure: it cuts tables and rules in half, and that's the point of comparing. Sizes are approximate tokens (4 characters ≈ 1 token); the chunker needs a consistent ruler, not the provider's tokenizer.

Every chunk is embedded as `heading path + content` (and Gemini also gets the title): the bare row `| Annual leave | 18 |` means little without "Leave Policy (v2) > 1. Entitlements" in front of it.

## A4.3: retrieval

**Embeddings.** Gemini `gemini-embedding-001` through its native `batchEmbedContents` API (up to 100 inputs per request), not its OpenAI-compatible endpoint, because only the native API takes **task types**: chunks are embedded as `RETRIEVAL_DOCUMENT` (with a title) and questions as `RETRIEVAL_QUERY`. A question and the passage that answers it aren't paraphrases, and asymmetric embeddings are trained for that gap. Newer Gemini models (`gemini-embedding-2`) take the task as a text prefix instead (`task: search result | query: …`); the client handles both. `gemini-embedding-001` returns **unnormalised** vectors below its full 3072 dimensions, so every vector is L2-normalised in the client. After that, cosine similarity is a dot product, and the database never sees a provider-specific scale. `EMBEDDING_PROVIDER=openai` swaps in any OpenAI-compatible `/embeddings` endpoint.

**Scope (effective dates).** One CTE picks the versions to search: per policy title, the latest version with `effective_from <= as_of` (`DISTINCT ON (title) … ORDER BY title, effective_from DESC`), plus, for questions about now, versions that take effect later, which come back with `upcoming = true`. Superseded versions are invisible unless `as_of` falls in their time. That's the answer to "why filter by effective date": without it, "how much annual leave do we get?" retrieves v1 (15 days) and v2 (18 days) side by side, and the model picks one.

**Vector search.** `ORDER BY embedding <=> :q` (cosine distance) over the scoped chunks. HNSW with a `WHERE` clause finds its nearest neighbours *first* and filters after, so it can return fewer than k rows. Each search sets `hnsw.iterative_scan = strict_order` (pgvector 0.8+), which keeps scanning until k rows pass the filter.

**Keyword search.** Postgres full-text search, with one twist: `websearch_to_tsquery('Can unused leave carry over?')` ANDs every word, and a question rarely shares *all* its words with the answer. So the question goes through `to_tsvector` (stemming, stop words dropped), and its lexemes are quoted and **OR-ed** into a `tsquery` (`'simple'` config, so stems aren't stemmed twice). `ts_rank_cd` then ranks chunks that match more terms, closer together, higher. A question of only stop words becomes an empty query and matches nothing.

**Hybrid.** Reciprocal Rank Fusion over the top 20 of each: `score = Σ 1/(60 + rank)`. Cosine similarities and text ranks are on different scales and can't be added; ranks can. A chunk both searches like beats a chunk only one of them ranks first.

**Rerank.** The plan used a cross-encoder (`bge-reranker-base`). This project uses hosted models only, so the **LLM** reranks: one call with the question and the 20 fused candidates (cut to 1,200 characters each), returning `{"scores": [{"id", "score" 0–3}]}` as JSON. Fused order breaks ties. Any model failure returns the fused order unchanged: reranking can improve results, never block them. Off by default (`RAG_RERANK=true` turns it on); A4.5 decides.

## A4.4: `search_policy`

Input: `query`, and `as_of` only for questions about the past. Output: up to five passages, each with `citation` ("Leave Policy v2 §1 Entitlements"), policy, version, effective date, section and text, plus `status: upcoming: not in force until …` where it applies, or a note that nothing matched. The `ask@3` prompt adds two rules: state only what the passages say and cite each fact with its citation in square brackets; if nothing covers the question, say the policies don't cover it rather than answering from general knowledge.

The tool is only **offered** when embeddings are configured. Offering a tool that always fails wastes a step and tempts the model to improvise. Without a key the agent works exactly as in M3.

## A4.5: retrieval eval

`evals/rag_questions.jsonl`: 25 questions, each with the policy, version and section that answer it and an **evidence phrase** from that text. A retrieved chunk is a hit only if it's from the right version *and* contains the phrase, so the same check works for every chunker. A chunk with the right heading that lost the sentence to a cut doesn't count. The runner ingests each configuration (heading 64/128/256 and fixed 256), embeds each question **once** for the whole run (the query vector doesn't depend on chunking), and writes recall@5, MRR and latency for vector / keyword / hybrid / rerank to [docs/evaluation/rag-retrieval.md](../evaluation/rag-retrieval.md).

Why 64/128/256 and not bigger: every section in the seeded policies is under ~125 tokens, and heading chunks never span sections, so 256, 512 and 1024 produce identical chunks. A dry run with the fake embedder showed exactly that.

**Results:** pending `GEMINI_API_KEY`.

## A4.6: consistency

The HR API *enforces* 18 annual days, 12 sick, 6 casual, a 10:30 late cutoff and 6 hours for a full day, from `@hr/contracts`. The agent *answers* from the policy documents. If someone edits one and not the other, the agent and the system disagree, and nothing else would notice. The export script now also writes those constants to `packages/contracts/json-schema/rules.json` (the CI diff check covers it), and `test_policy_consistency.py` checks two layers, so a failure says where the drift is:

1. **Retrieval:** the passages retrieved for each rule contain the enforced value. If this fails, the policy text drifted.
2. **Answer:** the agent's answer, through `search_policy`, contains the value and a `[<Policy> v…` citation. If this fails, the model misread a correct passage.

Both are live (`RAG_LIVE_TESTS=1`); a third, always-on test checks that `rules.json` exists and has the rules.

## Tests

| File | What it checks |
| --- | --- |
| `test_rag_chunking.py` | sections and heading paths, never crossing sections, table split with repeated header, list split and overlap, sentence split, fixed windows |
| `test_rag_parsing.py` | Markdown, DOCX (headings, table, list in order), a hand-written PDF's text layer, scanned PDF refused |
| `test_rag_embeddings.py` | Gemini request shape (task type, title, size, key header), prefix-style models, batching by 100, `retryDelay` honoured, size mismatch, OpenAI-compatible order |
| `test_rag_retrieval.py` | RRF arithmetic, modes, rerank order and fallback, citations, `search_policy` scoping, tool offered only when configured |
| `test_rag_store.py` | **real Postgres**: idempotent ingest, re-embed only what changed, removed versions, version in force / past / upcoming, OR-ed keyword search, category filter, hybrid. Opt-in: `AI_TEST_DATABASE_URL=postgresql://hr:hr@localhost:5433/hr_test` (refuses a database without "test" in its name) |
| `test_ingest_route.py` | only `policy:manage` may re-index; ingestion uses the service login; a clear 503 without a key |
| `test_policy_consistency.py` | A4.6 |

## Try it

```bash
pnpm db:migrate:ai                       # once: the ai schema
pnpm db:seed                             # adds ai-ingest@hr.local
# root .env: GEMINI_API_KEY=…  AI_SERVICE_PASSWORD=Password123!
cd apps/ai
uv run hr-ai ingest                      # 7 versions → chunks (re-run: "7 unchanged")
uv run hr-ai search "Can unused leave carry over?"
uv run hr-ai search "annual leave" --as-of 2025-06-01            # Leave Policy v1
uv run hr-ai search "PAN" --mode keyword
HR_PASSWORD='Password123!' uv run hr-ai ask "Do we get more sick days than last year?" --login employee@hr.local
uv run python -m evals.run_rag_eval      # A4.5 table → docs/evaluation/rag-retrieval.md
RAG_LIVE_TESTS=1 uv run pytest tests/test_policy_consistency.py   # A4.6
```

## What happened along the way

- **Hosted embeddings, not local.** The plan said `sentence-transformers` with `bge-small` (384 dimensions) and a `bge-reranker-base` cross-encoder. Both were swapped for hosted models: Gemini embeddings at 768 dimensions and the LLM as reranker. That keeps the laptop free of torch, in line with the hosted-only LLM decision from M1. The embedder is an interface, so a local or ONNX model can come back later without touching retrieval.
- **Alembic couldn't see its own tables.** With `search_path = ai, public`, `alembic check` reported both tables as missing: reflection treats the first schema on the path as the *default* schema and reports its tables with schema `None`, which the `ai`-only filter dropped. Putting `public` first fixed it, with no changes to the tables.
- **The asyncpg vector codec would have clashed.** pgvector's docs register a binary asyncpg codec, but the SQLAlchemy `Vector` type already sends vectors as text (`[0.1,…]`), and asyncpg handles unknown types as text. So no codec, and one less moving part.
- **An empty keyword query was a syntax error.** A question of only stop words ("what is the") produced an empty term list, and the fallback literal wasn't valid `tsquery` syntax. The Postgres test caught it; it's now `''::tsquery`, which matches nothing.
- **Alembic silenced the tracing logger.** Running migrations in-process (the store tests) called `logging.config.fileConfig`, which by default *disables every existing logger*. Three tracing tests then failed, but only when they ran after the database tests. Fixed with `disable_existing_loggers=False` in `migrations/env.py`.
- **Chunk size barely matters here.** The dry run showed heading chunks identical at 128, 256 and 512, because the seeded sections are short. Real policies (multi-page PDFs) would differ; the eval sizes were moved down to 64/128/256 so the comparison measures something.

## Check yourself

<details>
<summary>Why filter by effective date, and what goes wrong without it? Try "How much annual leave did we get in 2025?"</summary>

Leave Policy v1 (15 days, 2025) and v2 (18 days, from 2026) both exist, and their entitlement chunks are nearly identical text. Without a filter, both come back for "how much annual leave do we get?", and the model has to guess which applies; often it picks the higher-ranked one, which can be v1. With the in-force filter, today's question sees only v2, and "in 2025" (`as_of=2025-06-01`) sees only v1 (tested in `test_as_of_a_past_date_finds_the_rules_in_force_then`). The Hybrid Work Policy shows the other side: it starts on 1 Nov 2026, so it comes back flagged as upcoming instead of being presented as today's rule.
</details>

<details>
<summary>When does keyword search beat vector search? (Think of "PAN", "IFSC", "30-day check-in".)</summary>

When the query is a rare exact token rather than a meaning: acronyms (PAN), codes, numbers ("10:30", "30-day"). An embedding spreads "PAN" across a general "identity document / finance" region, and close neighbours like "bank details" or "Aadhaar" can outrank the exact passage, while full-text search matches the literal lexeme. Vector search wins on paraphrase: "Do weekends come off my balance?" shares almost no words with "Only working days count". Hybrid takes both. The A4.5 table will show per-mode numbers once embeddings are live.
</details>

<details>
<summary>What does reranking cost you, and did your numbers show it was worth it?</summary>

One extra LLM call per question: a prompt of about 20 passages × up to 1,200 characters, roughly 2–4k tokens, plus its latency (hundreds of ms on Groq, more under rate limits). It's worth it only if it raises recall@5 or MRR over hybrid by more than noise. On 25 questions, one question is 0.04 recall. Pending the live run.
</details>

## Next

M5 re-implements the M3 loop as a LangGraph graph; `search_policy` comes along as one of its tools, and the HR agent graph's "retrieve policy" step uses the same retriever.
