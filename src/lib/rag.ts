/**
 * Chunking, retrieval and reranking.
 *
 * Splitting: prefer markdown headings, then blank lines, then sentence boundaries —
 * never cut mid-sentence unless a single sentence exceeds the chunk size.
 */
import { cosine, embedLocal } from "./demo-data.ts";
import { keywordScore, type SearchHit } from "./store.ts";

export type ChunkOptions = {
  /** Target chunk size in characters. */
  size: number;
  /** Characters of overlap so a fact split across a boundary is still retrievable. */
  overlap: number;
};

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  size: Number(process.env.RAG_CHUNK_SIZE || 900),
  overlap: Number(process.env.RAG_CHUNK_OVERLAP || 150),
};

export function chunkDocument(text: string, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const units = splitIntoUnits(normalized);
  const chunks: string[] = [];
  let current = "";

  for (const unit of units) {
    if (current.length + unit.length + 1 <= options.size) {
      current = current ? `${current}\n${unit}` : unit;
      continue;
    }
    if (current) {
      chunks.push(current.trim());
      // Carry the tail of the previous chunk forward as overlap.
      const tail = current.slice(-options.overlap).trim();
      current = tail ? `${tail}\n${unit}` : unit;
    } else {
      // A single unit larger than the chunk size: hard-split it.
      for (let i = 0; i < unit.length; i += options.size) chunks.push(unit.slice(i, i + options.size));
      current = "";
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 0);
}

/** Heading → paragraph → sentence, in that order of preference. */
function splitIntoUnits(text: string): string[] {
  const sections = text.split(/\n{2,}/);
  const units: string[] = [];
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    if (trimmed.length <= 1200) {
      units.push(trimmed);
      continue;
    }
    units.push(...splitSentences(trimmed));
  }
  return units;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?؟])\s+(?=[\p{L}\p{N}“"'(])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ────────────────────────── retrieval ──────────────────────────

/**
 * Retrieve, then rerank. Reranking blends the vector score with keyword overlap —
 * vector search alone misses exact-number and product-name matches, which is exactly
 * where support questions live.
 */
export function rerank(hits: SearchHit[], query: string, limit: number): SearchHit[] {
  // Normalise against the query's own self-score so `similarityThreshold` means the
  // same thing no matter how the embedder scales. The blend below mixes a bounded
  // cosine with an unbounded BM25 term, so a raw score of 8.5 and a raw score of 0.65
  // are indistinguishable to a fixed threshold. Dividing by the self-score puts every
  // query on a 0-1 scale where 1.0 is "this chunk *is* the question".
  const qv = embedLocal(query);
  const selfRaw = 0.6 * cosine(qv, qv) + 0.4 * keywordScore(query, query);
  const selfScore = selfRaw > 1e-9 ? selfRaw : 1;

  return hits
    .map((hit) => {
      const kw = keywordScore(query, hit.chunk.text);
      const raw = hit.method === "pgvector" ? 0.7 * hit.score + 0.3 * kw : 0.6 * hit.score + 0.4 * kw;
      return { ...hit, score: raw / selfScore };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
