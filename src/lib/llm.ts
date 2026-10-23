/**
 * Provider abstraction — the ONLY file allowed to talk to an LLM or embedding API.
 * Nothing else in the codebase imports a provider SDK.
 *
 * DEMO MODE (no key set): a deterministic extractive engine built on keyword
 * overlap. It costs nothing, needs no network, and is honest about what it found —
 * which is exactly what a prospective client needs to see.
 */
import { embedLocal, lexicalScore } from "./demo-data.ts";
import { installEmbeddingProvider, type Usage } from "./store.ts";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type Generation = {
  text: string;
  usage: Usage;
};

type Env = {
  apiBase: string;
  apiKey: string;
  model: string;
  embeddingApiBase: string;
  embeddingApiKey: string;
  embeddingModel: string;
};

function readEnv(): Env {
  return {
    apiBase: (process.env.LLM_API_BASE || "http://localhost:1234/v1").replace(/\/$/, ""),
    apiKey: (process.env.LLM_API_KEY || "").trim(),
    model: (process.env.LLM_MODEL || "gpt-4o-mini").trim(),
    embeddingApiBase: (process.env.EMBEDDING_API_BASE || "http://localhost:1234/v1").replace(/\/$/, ""),
    embeddingApiKey: (process.env.EMBEDDING_API_KEY || process.env.LLM_API_KEY || "").trim(),
    embeddingModel: (process.env.EMBEDDING_MODEL || "text-embedding-3-small").trim(),
  };
}

export function llmMode(): { engine: "demo" | "openai-compatible"; model: string; apiBase: string } {
  const env = readEnv();
  return { engine: env.apiKey ? "openai-compatible" : "demo", model: env.model, apiBase: env.apiBase };
}

export function embeddingMode(): { engine: "demo" | "openai-compatible"; model: string; apiBase: string } {
  const env = readEnv();
  return { engine: env.embeddingApiKey ? "openai-compatible" : "demo", model: env.embeddingModel, apiBase: env.embeddingApiBase };
}

/** Rough token estimate — good enough for cost accounting, exact for the paid path. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ────────────────────────── pricing ──────────────────────────

/** USD per 1M tokens. Override with PRICING_* env vars if your provider differs. */
const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  default: { input: 0.15, output: 0.6 },
};

export function priceFor(model: string): { input: number; output: number } {
  return PRICING[model] ?? PRICING.default;
}

/** Engines that are structurally free — they never call a paid provider. */
const FREE_ENGINES = new Set(["demo", "refused", "escalation"]);

/**
 * USD cost for a generation.
 * `engine` is required whenever the caller knows it: a demo or refused run must
 * never be billed, no matter what the model string says.
 */
export function costFor(model: string, promptTokens: number, completionTokens: number, engine?: string): number {
  if (engine && FREE_ENGINES.has(engine)) return 0;
  const price = priceFor(model);
  return (promptTokens / 1_000_000) * price.input + (completionTokens / 1_000_000) * price.output;
}

// ────────────────────────── embeddings ──────────────────────────

/**
 * Wired into the store once at boot so the store never imports a provider.
 * Falls back to the local hashing embedder when no key is configured.
 */
let installed = false;

export function installProviders(): void {
  if (installed) return;
  installed = true;
  const { embeddingApiBase, embeddingApiKey, embeddingModel } = readEnv();

  installEmbeddingProvider(async (texts: string[]) => {
    if (!embeddingApiKey) return texts.map(embedLocal);

    const res = await fetch(`${embeddingApiBase}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${embeddingApiKey}` },
      body: JSON.stringify({ model: embeddingModel, input: texts }),
    });
    if (!res.ok) throw new Error(`embeddings failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  });
}

// ────────────────────────── generation ──────────────────────────

/**
 * Generate an answer. In demo mode this is an extractive summariser: it returns the
 * retrieved sentences that actually overlap the question, so the demo is grounded by
 * construction rather than by hoping a model behaves.
 */
export async function generateChat(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<Generation> {
  const env = readEnv();
  const maxTokens = opts?.maxTokens ?? 320;

  if (!env.apiKey) {
    return { text: demoGenerate(messages), usage: { promptTokens: estimateTokens(messages.map((m) => m.content).join(" ")), completionTokens: 0, costUsd: 0, model: "demo-extractive", engine: "demo" } };
  }

  const res = await fetch(`${env.apiBase}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.apiKey}` },
    body: JSON.stringify({ model: env.model, messages, max_tokens: maxTokens, temperature: opts?.temperature ?? 0 }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM request failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = json.choices[0]?.message?.content ?? "";
  const promptTokens = json.usage?.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join(" "));
  const completionTokens = json.usage?.completion_tokens ?? estimateTokens(text);
  return {
    text,
    usage: { promptTokens, completionTokens, costUsd: costFor(env.model, promptTokens, completionTokens, "openai-compatible"), model: env.model, engine: "openai-compatible" },
  };
}

/** Sentence-level extractive answer from the fenced document block in the system prompt. */
function demoGenerate(messages: ChatMessage[]): string {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const question = messages.filter((m) => m.role === "user").pop()?.content ?? "";

  const begin = system.indexOf("--- BEGIN DOCUMENTS");
  const end = system.indexOf("--- END DOCUMENTS ---");
  if (begin === -1 || end === -1) return "";

  // Drop the BEGIN marker line itself — leaving it in glues it to block 1, which then
  // fails the /^\[/ test and silently discards the top-ranked chunk.
  const body = system
    .slice(begin, end)
    .replace(/^--- BEGIN DOCUMENTS[^\n]*\n/, "");
  const blocks = body
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter((block) => block && /^\[/.test(block));

  if (blocks.length === 0) return "";

  // Scored with the same lexical scorer retrieval uses, so "refund window" still
  // matches a chunk that says "refunds".
  const scored = blocks
    .map((block) => {
      const marker = /^\[(\d+)\]\s*/.exec(block);
      const text = block.replace(/^\[(\d+)\]\s*\([^)]*\)\s*/, "");
      return { marker: marker?.[1] ?? "?", text, score: lexicalScore(question, text) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (scored.length === 0) return "";

  const sentences = scored
    .flatMap((r) =>
      r.text
        // Drop markdown headings: they are structure, not answer content.
        .split(/(?<=[.!?؟])\s+|^#{1,6}\s+.*$/gm)
        .map((s) => ({ s: s.trim(), marker: r.marker, score: r.score }))
    )
    .filter((x) => x.s.length > 25)
    .sort((a, b) => b.score - a.score);

  const picked = sentences.slice(0, 3);
  if (picked.length === 0) return "";

  const sources = [...new Set(picked.map((p) => p.marker))].map((m) => `[${m}]`).join(" ");
  return `${picked.map((p) => p.s).join(" ")}\n\nSources: ${sources}`;
}
