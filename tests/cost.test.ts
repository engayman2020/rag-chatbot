import assert from "node:assert/strict";
import { test } from "node:test";

/** Cost accounting tests — money is involved, so these are not optional. */
import { formatCost, summarizeLogs } from "../src/lib/cost.ts";
import { costFor, estimateTokens, priceFor } from "../src/lib/llm.ts";

test("demo mode costs nothing, and says so", () => {
  // The engine flag is the safety net: a demo run must never be billed even if the
  // model string looks like a paid one.
  assert.equal(costFor("demo-extractive", 5000, 500, "demo"), 0);
  assert.equal(costFor("gpt-4o-mini", 5000, 500, "refused"), 0);
  assert.equal(formatCost(0), "$0.00");
});

test("token cost uses the provider's published per-million price", () => {
  // gpt-4o-mini: $0.15/M in, $0.60/M out
  const cost = costFor("gpt-4o-mini", 1_000_000, 1_000_000);

  assert.equal(cost, 0.75);
});

test("small usage formats sensibly instead of rounding to zero", () => {
  assert.equal(formatCost(0.00004), "<$0.01");
  assert.equal(formatCost(0.1234), "$0.1234");
});

test("unknown models fall back to a sane default price", () => {
  assert.deepEqual(priceFor("some-local-model"), priceFor("gpt-4o-mini"));
});

test("token estimation is roughly a quarter of the character count", () => {
  const text = "a".repeat(400);

  assert.equal(estimateTokens(text), 100);
  assert.equal(estimateTokens(""), 0);
});

test("summarising logs aggregates tokens, cost and per-engine split", () => {
  const summary = summarizeLogs([
    { usage: { promptTokens: 100, completionTokens: 50, costUsd: 0.01, engine: "openai-compatible" } },
    { usage: { promptTokens: 200, completionTokens: 100, costUsd: 0.02, engine: "openai-compatible" } },
    { usage: { promptTokens: 300, completionTokens: 0, costUsd: 0, engine: "demo" } },
  ]);

  assert.equal(summary.conversations, 3);
  assert.equal(summary.totalPromptTokens, 600);
  assert.equal(summary.totalCompletionTokens, 150);
  assert.equal(summary.totalCostUsd, 0.03);
  assert.equal(summary.byEngine["openai-compatible"].conversations, 2);
  assert.equal(summary.byEngine["demo"].costUsd, 0);
});

test("an empty log set summarises to zeros rather than throwing", () => {
  const summary = summarizeLogs([]);

  assert.equal(summary.conversations, 0);
  assert.equal(summary.totalCostUsd, 0);
  assert.deepEqual(summary.byEngine, {});
});
