# RAG Support Chatbot

A production-grade chatbot that answers customer questions **from a company's own
documents** — with source citations, hallucination guardrails, and per-conversation cost
tracking.

Built with Next.js, TypeScript and Supabase. Runs **with zero API keys** in demo mode, and
against any OpenAI-compatible LLM when you're ready.

---

## Why this exists

Most AI chatbots answer from the model's training data and **invent the rest**. That's fine
for a toy, and unacceptable when the bot is talking to your customers.

This one is different:

- It answers **only** from the documents you upload
- It **cites the source** on every reply
- When the answer isn't in your documents, it says **"I don't have that"** — it does not guess
- It **refuses to leak** its own instructions, even when a document tries to make it
- It **redacts personal data** (emails, phone numbers, card-like numbers) before anything reaches the model or the user

That's what makes it safe to put in front of real customers.

---

## Features

| Feature | What it does |
|---|---|
| **Document Q&A** | Upload `.txt`, `.md` or `.pdf`; the bot answers from them with citations |
| **Grounding enforcement** | Answers only from retrieved content. Below a similarity threshold, it refuses instead of generating |
| **Coverage check** | Measures how much of the question the top chunk actually contains — this is what stops an unrelated question from being answered |
| **Prompt-injection resistance** | Retrieved documents are treated as *data*, never as instructions. Instruction-shaped content is quarantined before it enters the prompt |
| **PII redaction** | Emails, phone numbers and card-like numbers are stripped from both retrieved content and generated output |
| **Topic boundaries** | Configurable allowlist/denylist keeps the bot in scope |
| **Human escalation** | The fallback message admits uncertainty and offers to escalate |
| **Admin panel** | Upload and delete documents, browse conversation logs, see token usage and cost per conversation |
| **Cost tracking** | Every conversation records tokens and estimated cost, so you know what the bot costs to run |
| **Arabic support** | Retrieval works for Arabic questions against Arabic content |

---

## Quick start (no API keys needed)

Needs Node.js **22.6 or newer** (the test runner uses TypeScript type-stripping).

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000> — the chat is live immediately, answering from the bundled
demo documents. Open <http://localhost:3000/admin> to upload your own.

That's the whole point: you can see it working in under two minutes without spending a cent.

---

## Pointing it at your own documents

1. Go to **`/admin`**
2. Upload a `.txt`, `.md` or `.pdf`
3. Wait a few seconds — the content is chunked, embedded and indexed
4. Ask a question about it

To update your content later, just upload the new version. To remove something, delete it
from the admin panel.

---

## Going live with a real LLM

The demo mode uses a bundled deterministic engine so you can evaluate the product for free.
To get real model answers, set one environment variable:

```bash
cp .env.example .env.local
```

Then edit `.env.local`:

```bash
LLM_API_BASE=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
```

Set `EMBEDDING_API_KEY` too if you want real embeddings instead of the demo keyword matcher.
Leave it empty and the demo embedder handles it.

**To run a local model instead** (free, private, no API key):

```bash
LLM_API_BASE=http://localhost:1234/v1   # LM Studio
EMBEDDING_API_BASE=http://localhost:1234/v1
```

Any OpenAI-compatible endpoint works — OpenAI, Anthropic-compatible proxies, Groq, Ollama,
LM Studio, vLLM.

---

## Configuration

All optional. Copy `.env.example` to `.env.local` and change what you need.

| Variable | Default | Purpose |
|---|---|---|
| `LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL` | demo mode | The chat model. Empty key = demo engine |
| `EMBEDDING_API_BASE` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` | demo mode | Embeddings. `EMBEDDING_DIM` must match the model |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | in-process store | Vector database. Empty = no database needed |
| `ADMIN_PASSWORD` | open (local only) | Gates `/admin` and the admin APIs. **Set before exposing to the internet** |
| `GUARDRAIL_SIMILARITY_THRESHOLD` | `0.5` | Retrieval-score floor — below this, refuse to answer |
| `GUARDRAIL_MIN_COVERAGE` | `0.5` | Share of the question's content words the top chunk must contain |
| `GUARDRAIL_MAX_TOKENS` | `320` | Output length cap per response |
| `GUARDRAIL_TOP_K` | `5` | Chunks retrieved per question |
| `GUARDRAIL_QUARANTINE_THRESHOLD` | `0.15` | Documents at/above this instruction-ratio are quarantined |
| `GUARDRAIL_BLOCKED_TOPICS` / `GUARDRAIL_REQUIRED_TOPICS` | empty | Denylist / allowlist for topic boundaries |
| `RAG_CHUNK_SIZE` / `RAG_CHUNK_OVERLAP` | `900` / `150` | Chunking behaviour |

---

## Using a real vector database (Supabase)

The demo runs on an in-process store. For production, use Supabase with `pgvector`:

1. Create a Supabase project and enable the **Vector** extension
2. Run `supabase/migrations/001_init.sql` in the SQL editor
3. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`

The `vector(1536)` column matches `text-embedding-3-small`. A different embedding model
needs `EMBEDDING_DIM` set **and** that column altered to match.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/chat` | Ask a question. Body: `{ "question": "...", "sessionId": "..." }` |
| `POST` | `/api/ingest` | Upload a document. `multipart/form-data` with a `file` field |
| `GET` | `/api/docs` | List indexed documents |
| `DELETE` | `/api/docs?id=...` | Delete a document |
| `GET` | `/api/logs` | Conversation logs with token and cost data |

---

## Architecture

```
src/
├── app/
│   ├── page.tsx              public chat
│   ├── admin/page.tsx        document management + logs + cost
│   └── api/
│       ├── chat/route.ts     retrieve → guard → generate → respond
│       ├── ingest/route.ts   upload → chunk → embed → store
│       ├── docs/route.ts     list / delete documents
│       └── logs/route.ts     conversation history + cost
├── components/
│   ├── ChatWidget.tsx
│   ├── Citation.tsx
│   └── Citations.tsx
└── lib/
    ├── llm.ts                provider abstraction — any OpenAI-compatible endpoint
    ├── rag.ts                chunking, retrieval, reranking
    ├── guardrails.ts         ← the important one
    ├── store.ts              document + vector storage
    ├── cost.ts               token and cost accounting
    ├── seed.ts               demo document seeding
    └── demo-data.ts          bundled sample documents
```

### How a question is answered

1. **Embed** the question
2. **Retrieve** the top-k chunks (vector search + lexical fallback)
3. **Rerank** by combined score
4. **Guard** — check similarity and coverage. Fail either, and the bot returns the
   fallback message *without calling the model at all* (so a refusal costs nothing)
5. **Neutralise** any instruction-shaped content in the retrieved chunks
6. **Redact** PII from the chunks
7. **Build the prompt** with the chunks as quoted data
8. **Generate**, then verify the answer before returning it
9. **Record** tokens and cost against the conversation

---

## Testing

```bash
pnpm test
```

48 tests covering the guardrail behaviour that matters: low-similarity refusal, coverage
enforcement, injection quarantine thresholds, PII redaction, chunking integrity, retrieval
ranking, and Arabic-language matching.

---

## Deployment

Any Node.js host. Vercel is the zero-config option:

```bash
pnpm build
```

Set the environment variables in your host's dashboard. **Set `ADMIN_PASSWORD`** before the
URL is reachable from the internet.

---

## Licence

MIT
