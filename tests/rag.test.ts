import assert from "node:assert/strict";
import { test } from "node:test";

/** Retrieval tests — chunking, reranking, and the keyless demo embedding. */
import { chunkDocument, rerank } from "../src/lib/rag.ts";
import { cosine, embedLocal, keywords } from "../src/lib/demo-data.ts";
import { keywordScore, type SearchHit } from "../src/lib/store.ts";

test("chunking never loses content and respects the target size", () => {
  const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. `.repeat(20)).join("\n\n");

  const chunks = chunkDocument(paragraphs, { size: 400, overlap: 50 });

  assert.equal(chunks.length > 1, true);
  for (const chunk of chunks) assert.equal(chunk.length <= 460, true, `chunk too long: ${chunk.length}`);
  // Every source paragraph is still represented somewhere.
  for (let i = 0; i < 12; i += 1) {
    assert.equal(chunks.some((c) => c.includes(`Paragraph ${i}.`)), true, `paragraph ${i} lost`);
  }
});

test("a single oversized sentence is hard-split rather than dropped", () => {
  const huge = "word ".repeat(500);

  const chunks = chunkDocument(huge, { size: 200, overlap: 20 });

  assert.equal(chunks.length > 1, true);
  assert.match(chunks.join(" "), /word/);
});

test("empty and whitespace-only documents produce no chunks", () => {
  assert.deepEqual(chunkDocument(""), []);
  assert.deepEqual(chunkDocument("   \n\n  "), []);
});

test("the demo embedding is deterministic and normalised", () => {
  const a = embedLocal("refunds within 30 days");
  const b = embedLocal("refunds within 30 days");

  assert.deepEqual(a, b);
  assert.equal(Math.abs(Math.sqrt(a.reduce((sum, v) => sum + v * v, 0)) - 1) < 1e-6, true);
});

test("a question ranks its own document above unrelated documents", () => {
  const query = embedLocal("What is the refund window?");

  const refund = cosine(query, embedLocal("Refunds are processed within 5 business days. Full refunds within 30 days of purchase."));
  const shipping = cosine(query, embedLocal("Express shipping costs 60 EGP and arrives next business day in Cairo only."));
  const pricing = cosine(query, embedLocal("Starter is 99 EGP per month and includes 1 workspace and 500 AI answers."));

  assert.equal(refund > shipping, true, `refund ${refund} should beat shipping ${shipping}`);
  assert.equal(refund > pricing, true, `refund ${refund} should beat pricing ${pricing}`);
});

test("the n-gram embedder matches word variants a word-level hash would miss", () => {
  const refund = cosine(embedLocal("refund window"), embedLocal("refunds are processed within 30 days"));
  const shipping = cosine(embedLocal("refund window"), embedLocal("express shipping costs 60 egp"));

  assert.equal(refund > 0, true, "refund should share signal with refunds");
  assert.equal(refund > shipping, true, `refund ${refund} should beat shipping ${shipping}`);
});

test("keyword overlap finds exact numbers that vector search misses", () => {
  assert.equal(keywordScore("How much is express shipping?", "Express shipping costs 60 EGP and arrives next business day in Cairo only.") > 0, true);
  assert.equal(keywordScore("What is the refund window?", "Express shipping costs 60 EGP and arrives next business day in Cairo only."), 0);
});

test("the lexical score prefers the document that shares the query's topic word", () => {
  const refund = keywordScore("What is the refund window?", "Refunds are processed within 5 business days. Full refunds within 30 days of purchase.");
  const shipping = keywordScore("What is the refund window?", "Express shipping costs 60 EGP and arrives next business day in Cairo only.");

  assert.equal(refund > shipping, true, `refund ${refund} should beat shipping ${shipping}`);
});

test("reranking promotes the chunk that matches the query keywords", () => {
  const makeHit = (text: string, score: number): SearchHit => ({
    chunk: { id: "x", docId: "d", docName: "d.md", index: 0, text },
    score,
    method: "keyword",
  });

  const ranked = rerank(
    [makeHit("Standard shipping is free on orders over 500 EGP.", 0.5), makeHit("Refunds within 30 days of purchase.", 0.4)],
    "What is the refund window?",
    2
  );

  assert.match(ranked[0].chunk.text, /refund/i);
});

test("Arabic questions still match Arabic content", () => {
  const query = embedLocal("ما هي سياسة الاسترجاع؟");
  const policy = cosine(query, embedLocal("الاسترجاع خلال 30 يوم من الشراء"));

  assert.equal(policy > 0, true);
  assert.equal(keywords("ما هي سياسة الاسترجاع؟").includes("سياسه"), true);
});
