import { NextResponse } from "next/server";

/**
 * retrieve → decide → generate → verify
 *
 * `decide()` runs before the model is called, so an out-of-scope question costs zero
 * tokens. `verifyAnswer()` runs after, so a model that wanders is still caught.
 */
import { DEFAULT_GUARDRAILS, buildPrompt, decide, neutralizeInjections, redactPii, verifyAnswer, FALLBACK_MESSAGE } from "@/lib/guardrails";
import { generateChat, installProviders, llmMode } from "@/lib/llm";
import { rerank } from "@/lib/rag";
import { saveLog, searchChunks } from "@/lib/store";
import { seedDemoDocsIfEmpty } from "@/lib/seed";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_QUESTION_LENGTH = 1000;

/** “escalate” is handled before retrieval — it is a routing request, not a question. */
const ESCALATION = /^\s*(escalate|human|agent|شخص|موظف)\s*$/i;

export async function POST(request: Request) {
  try {
    await installProviders();
    const seeded = await seedDemoDocsIfEmpty();

    const body = (await request.json().catch(() => null)) as { question?: unknown; conversationId?: unknown } | null;
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    const conversationId = typeof body?.conversationId === "string" && body.conversationId ? body.conversationId : crypto.randomUUID();

    if (!question) {
      return NextResponse.json({ error: "Send a JSON body with a `question` string." }, { status: 400 });
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      return NextResponse.json({ error: `Question is too long (max ${MAX_QUESTION_LENGTH} characters).` }, { status: 413 });
    }

    if (ESCALATION.test(question)) {
      const answer = "Done — I've flagged this for a teammate. They'll pick it up from here.";
      await saveLog({
        id: crypto.randomUUID(),
        conversationId,
        question,
        answer,
        engine: "escalation",
        citations: [],
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, model: "none", engine: "escalation" },
        grounded: true,
        createdAt: new Date().toISOString(),
      });
      return NextResponse.json({ answer, citations: [], grounded: true, usage: { promptTokens: 0, completionTokens: 0, costUsd: 0, model: "none", engine: "escalation" } });
    }

    // 1. Retrieve, then rerank.
    const hits = rerank(await searchChunks(question, null, DEFAULT_GUARDRAILS.topK), question, DEFAULT_GUARDRAILS.topK);

    // 2. The gate. No token is spent unless this passes.
    const decision = decide(
      question,
      hits.map((h) => ({ chunkId: h.chunk.id, docId: h.chunk.docId, docName: h.chunk.docName, index: h.chunk.index, score: h.score, text: h.chunk.text })),
      DEFAULT_GUARDRAILS
    );

    if (!decision.generate) {
      const usage = { promptTokens: 0, completionTokens: 0, costUsd: 0, model: "none", engine: "refused" };
      await saveLog({
        id: crypto.randomUUID(),
        conversationId,
        question,
        answer: decision.message,
        engine: "refused",
        citations: [],
        usage,
        grounded: false,
        createdAt: new Date().toISOString(),
      });
      return NextResponse.json({
        answer: decision.message,
        citations: [],
        grounded: false,
        reason: decision.reason,
        usage,
        suggestion: "Try asking about refunds, shipping, plans or troubleshooting.",
      });
    }

    // 3. Neutralise untrusted content before it reaches the model.
    const guardedChunks = hits.map((hit, i) => {
      const { text, stripped } = neutralizeInjections(hit.chunk.text);
      return {
        id: hit.chunk.id,
        docId: hit.chunk.docId,
        docName: hit.chunk.docName,
        index: i + 1, // 1-based marker the model is told to quote
        text: redactPii(text).text,
        stripped,
        score: hit.score,
        method: hit.method,
      };
    });

    const prompt = buildPrompt(question, guardedChunks, "Northwind");

    // 4. Generate.
    const { text, usage } = await generateChat(
      [
        { role: "system", content: prompt },
        { role: "user", content: question },
      ],
      { maxTokens: DEFAULT_GUARDRAILS.maxTokens, temperature: 0 }
    );

    // 5. Verify what came back.
    const verdict = verifyAnswer(text, decision, DEFAULT_GUARDRAILS);
    const answer = verdict.answer;
    // Citations carry the 1-based marker the model was told to quote, not the chunk's
    // position in the store — that is what makes "[2]" resolvable for a reader.
    // Only the sources the answer actually references are surfaced: a customer does not
    // want four documents listed for a question answered from one of them.
    const cited = new Set((answer.match(/\[(\d+)\]/g) ?? []).map((m) => m.slice(1, -1)));
    const citations = guardedChunks
      .filter((chunk) => cited.has(String(chunk.index)))
      .map((chunk) => ({
        docId: chunk.docId,
        docName: chunk.docName,
        chunkId: chunk.id,
        index: chunk.index,
        preview: chunk.text.slice(0, 200),
      }));

    await saveLog({
      id: crypto.randomUUID(),
      conversationId,
      question,
      answer,
      engine: usage.engine,
      citations,
      usage: { ...usage, costUsd: verdict.ok ? usage.costUsd : 0 },
      grounded: verdict.ok,
      createdAt: new Date().toISOString(),
    });

    return NextResponse.json({
      answer,
      citations,
      grounded: verdict.ok,
      reason: verdict.ok ? undefined : verdict.reason,
      usage: usage.engine === "demo" ? { ...usage, costUsd: 0 } : usage,
      engine: usage.engine,
      model: usage.model,
      seeded,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "chat failed";
    return NextResponse.json({ error: message, answer: FALLBACK_MESSAGE }, { status: 500 });
  }
}

export async function GET() {
  const llm = llmMode();
  return NextResponse.json({ ok: true, engine: llm.engine, model: llm.model, apiBase: llm.apiBase });
}
