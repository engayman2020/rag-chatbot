import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Document + chunk store.
 *
 * Two backends, same interface:
 *   - DEMO MODE (no keys): JSON file at DATA_DIR, everything in-process. Zero cost,
 *     zero setup — this is what a prospective client sees in 2 minutes.
 *   - SUPABASE MODE: documents live in Postgres with pgvector for retrieval.
 *
 * Retrieval is pluggable too: pgvector when configured, otherwise in-process keyword
 * cosine similarity. The embeddings provider is injected via `installEmbeddingProvider`
 * so this module stays free of any provider SDK.
 */
import { cosine, embedLocal, lexicalScore } from "./demo-data.ts";

export type StoredDoc = {
  id: string;
  name: string;
  mimeType: string;
  byteSize: number;
  charCount: number;
  chunkCount: number;
  createdAt: string;
  /** Stored but excluded from retrieval because it looks like an injection payload. */
  quarantined?: boolean;
};

export type StoredChunk = {
  id: string;
  docId: string;
  docName: string;
  index: number;
  text: string;
  embedding?: number[];
};

export type SearchHit = {
  chunk: StoredChunk;
  score: number;
  method: "pgvector" | "keyword";
};

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  model: string;
  engine: string;
  cached?: boolean;
};

export type Citation = {
  docId: string;
  docName: string;
  chunkId: string;
  index: number;
};

export type ChatLog = {
  id: string;
  conversationId: string;
  question: string;
  answer: string;
  engine: string;
  citations: Citation[];
  usage: Usage;
  grounded: boolean;
  createdAt: string;
};

// ────────────────────────── provider injection ──────────────────────────

export type EmbeddingProvider = (texts: string[]) => Promise<number[][]>;

let embeddingProvider: EmbeddingProvider | null = null;

/** Wired once at boot (see src/lib/llm.ts). */
export function installEmbeddingProvider(provider: EmbeddingProvider): void {
  embeddingProvider = provider;
}

async function embed(texts: string[]): Promise<number[][]> {
  if (!embeddingProvider) throw new Error("no embedding provider installed");
  return embeddingProvider(texts);
}

// ────────────────────────── store backend ──────────────────────────

export type StoreBackend = {
  kind: "demo" | "supabase";
  listDocs(): Promise<StoredDoc[]>;
  addDoc(input: {
    name: string;
    mimeType: string;
    byteSize: number;
    text: string;
    chunks: string[];
    quarantined?: boolean;
  }): Promise<StoredDoc>;
  deleteDoc(id: string): Promise<void>;
  search(query: string, queryEmbedding: number[] | null, k: number): Promise<SearchHit[]>;
};

function env(key: string): string {
  return (process.env[key] ?? "").trim();
}

export function isSupabaseConfigured(): boolean {
  return Boolean(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY"));
}

function dataDir(): string {
  return path.join(process.cwd(), env("DATA_DIR") || ".data");
}

type FileShape = { docs: StoredDoc[]; chunks: StoredChunk[]; logs: ChatLog[] };

async function readShape(): Promise<FileShape> {
  try {
    const raw = await readFile(path.join(dataDir(), "store.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<FileShape>;
    return {
      docs: Array.isArray(parsed.docs) ? (parsed.docs as StoredDoc[]) : [],
      chunks: Array.isArray(parsed.chunks) ? (parsed.chunks as StoredChunk[]) : [],
      logs: Array.isArray(parsed.logs) ? (parsed.logs as ChatLog[]) : [],
    };
  } catch {
    return { docs: [], chunks: [], logs: [] };
  }
}

async function writeShape(shape: FileShape): Promise<void> {
  const dir = dataDir();
  await mkdir(dir, { recursive: true });
  const payload = JSON.stringify(shape);
  const file = path.join(dir, "store.json");
  // Write-then-rename so a crash mid-write cannot corrupt the demo corpus.
  await writeFile(`${file}.tmp`, payload, "utf8");
  await rename(`${file}.tmp`, file);
}

const demoBackend: StoreBackend = {
  kind: "demo",
  async listDocs() {
    return (await readShape()).docs;
  },

  async addDoc({ name, mimeType, byteSize, text, chunks, quarantined }) {
    const id = createHash("sha1").update(`${name}:${Date.now()}:${chunks.length}`).digest("hex").slice(0, 16);
    const shape = await readShape();
    const doc: StoredDoc = {
      id,
      name,
      mimeType,
      byteSize,
      charCount: text.length,
      chunkCount: chunks.length,
      createdAt: new Date().toISOString(),
      quarantined: quarantined ?? false,
    };
    // One provider round-trip per document, not one per chunk.
    const vectors = chunks.length ? await embed(chunks) : [];
    const stored: StoredChunk[] = chunks.map((chunkText, index) => ({
      id: `${id}:${index}`,
      docId: id,
      docName: name,
      index,
      text: chunkText,
      embedding: vectors[index] ?? embedLocal(chunkText),
    }));
    await writeShape({
      docs: [...shape.docs.filter((d) => d.id !== id), doc],
      chunks: [...shape.chunks.filter((c) => c.docId !== id), ...stored],
      logs: shape.logs,
    });
    return doc;
  },

  async deleteDoc(id: string) {
    const shape = await readShape();
    await writeShape({
      docs: shape.docs.filter((d) => d.id !== id),
      chunks: shape.chunks.filter((c) => c.docId !== id),
      logs: shape.logs,
    });
  },

  async search(query, queryEmbedding, k) {
    const shape = await readShape();
    const quarantinedDocs = new Set(shape.docs.filter((d) => d.quarantined).map((d) => d.id));
    const qEmb = queryEmbedding ?? embedLocal(query);
    // Demo retrieval is a blend: the n-gram vector catches morphology, the lexical
    // score carries exact-word matches. Pure vector search was returning zeros.
    return shape.chunks
      .filter((chunk) => !quarantinedDocs.has(chunk.docId))
      .map((chunk) => {
        const vector = cosine(qEmb, chunk.embedding ?? embedLocal(chunk.text));
        const lexical = lexicalScore(query, chunk.text);
        return { chunk, score: normalizeScore(0.45 * vector + 0.55 * lexical), method: "keyword" as const };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  },
};

/** Map the blended score onto 0-1 so the similarity threshold is meaningful. */
function normalizeScore(raw: number): number {
  if (raw <= 0) return 0;
  return Math.min(1, raw / (raw + 1));
}

/** pgvector column width — see supabase/migrations/001_init.sql. */
const SUPABASE_VECTOR_DIM = Number(process.env.EMBEDDING_DIM || 1536);

/**
 * A dimension mismatch is otherwise a bare Postgres error at insert time, after the
 * document has been read and chunked. Fail with the fix instead.
 */
function toVector(embedding: number[]): string {
  if (embedding.length !== SUPABASE_VECTOR_DIM) {
    throw new Error(
      `Embedding is ${embedding.length}-dimensional but the Supabase column is vector(${SUPABASE_VECTOR_DIM}). ` +
        `Set EMBEDDING_MODEL to a ${SUPABASE_VECTOR_DIM}-dim model, or change the column and EMBEDDING_DIM together.`
    );
  }
  return `[${embedding.join(",")}]`;
}

/** Keyword score used by the local reranker — kept here so search and rerank agree. */
export function keywordScore(query: string, text: string): number {
  return lexicalScore(query, text);
}

const supabaseBackend: StoreBackend = {
  kind: "supabase",
  async listDocs() {
    const rows = await rpc("rag_list_docs", {});
    return (rows ?? []) as StoredDoc[];
  },

  async addDoc(input) {
    const vectors = await embed(input.chunks);
    const doc = (await rpc("rag_ingest_document", {
      p_name: input.name,
      p_mime_type: input.mimeType,
      p_byte_size: input.byteSize,
      p_chunks: input.chunks,
      p_embeddings: vectors.map(toVector),
      p_quarantined: input.quarantined ?? false,
    })) as StoredDoc | null;
    if (!doc) throw new Error("rag_ingest_document returned no document");
    return doc;
  },

  async deleteDoc(id) {
    await rpc("rag_delete_document", { p_doc_id: id });
  },

  async search(query, queryEmbedding, k) {
    const rows = (await rpc("rag_search", {
      p_query: query,
      p_embedding: toVector(queryEmbedding ?? embedLocal(query)),
      p_k: k,
    })) as
      | { chunk_id: string; doc_id: string; doc_name: string; idx: number; text: string; score: number }[]
      | null;
    return (rows ?? []).map((r) => ({
      chunk: { id: r.chunk_id, docId: r.doc_id, docName: r.doc_name, index: r.idx, text: r.text },
      score: r.score,
      method: "pgvector" as const,
    }));
  },
};

async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const url = `${env("SUPABASE_URL").replace(/\/$/, "")}/rest/v1/rpc/${fn}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
      Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`supabase rpc ${fn} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

let cached: StoreBackend | null = null;

export function getStore(): StoreBackend {
  if (!cached) cached = isSupabaseConfigured() ? supabaseBackend : demoBackend;
  return cached;
}

/** Snake-case row from Postgres → the app's shape. */
function mapLogRow(row: {
  id: string;
  conversation_id: string;
  question: string;
  answer: string;
  engine: string;
  citations: Citation[] | string;
  usage: Usage | string;
  grounded: boolean;
  created_at: string;
}): ChatLog {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    question: row.question,
    answer: row.answer,
    engine: row.engine,
    citations: typeof row.citations === "string" ? (JSON.parse(row.citations) as Citation[]) : row.citations,
    usage: typeof row.usage === "string" ? (JSON.parse(row.usage) as Usage) : row.usage,
    grounded: row.grounded,
    createdAt: row.created_at,
  };
}

export function storeKind(): "demo" | "supabase" {
  return getStore().kind;
}

export async function listLogs(): Promise<ChatLog[]> {
  if (isSupabaseConfigured()) {
    const rows = (await rpc("rag_list_logs", {})) as
      | { id: string; conversation_id: string; question: string; answer: string; engine: string; citations: Citation[]; usage: Usage; grounded: boolean; created_at: string }[]
      | null;
    return (rows ?? []).map(mapLogRow);
  }
  return (await readShape()).logs;
}

export async function saveLog(log: ChatLog): Promise<void> {
  if (isSupabaseConfigured()) {
    await rpc("rag_save_log", {
      p_id: log.id,
      p_conversation_id: log.conversationId,
      p_question: log.question,
      p_answer: log.answer,
      p_engine: log.engine,
      p_citations: JSON.stringify(log.citations),
      p_usage: JSON.stringify(log.usage),
      p_grounded: log.grounded,
    });
    return;
  }
  const shape = await readShape();
  await writeShape({ ...shape, logs: [log, ...shape.logs].slice(0, 500) });
}

export async function deleteLog(id: string): Promise<void> {
  if (isSupabaseConfigured()) {
    await rpc("rag_delete_log", { p_id: id });
    return;
  }
  const shape = await readShape();
  await writeShape({ ...shape, logs: shape.logs.filter((l) => l.id !== id) });
}

export async function clearLogs(): Promise<void> {
  if (isSupabaseConfigured()) {
    await rpc("rag_clear_logs", {});
    return;
  }
  const shape = await readShape();
  await writeShape({ ...shape, logs: [] });
}

export async function ingestDoc(input: {
  name: string;
  mimeType: string;
  byteSize: number;
  text: string;
  chunks: string[];
  quarantined?: boolean;
}): Promise<StoredDoc> {
  return getStore().addDoc(input);
}

export async function removeDoc(id: string): Promise<void> {
  return getStore().deleteDoc(id);
}

export async function searchChunks(query: string, embedding: number[] | null, k: number): Promise<SearchHit[]> {
  return getStore().search(query, embedding, k);
}
