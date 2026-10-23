/**
 * Per-conversation token and cost accounting.
 * Demo mode is free and says so; paid mode reports real usage from the provider.
 */

export type CostSummary = {
  conversations: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  byEngine: Record<string, { conversations: number; costUsd: number; tokens: number }>;
};

export function summarizeLogs(logs: { usage: { promptTokens: number; completionTokens: number; costUsd: number; engine: string } }[]): CostSummary {
  const summary: CostSummary = {
    conversations: logs.length,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCostUsd: 0,
    byEngine: {},
  };

  for (const log of logs) {
    const { promptTokens, completionTokens, costUsd, engine } = log.usage;
    summary.totalPromptTokens += promptTokens;
    summary.totalCompletionTokens += completionTokens;
    summary.totalCostUsd += costUsd;
    const bucket = (summary.byEngine[engine] ??= { conversations: 0, costUsd: 0, tokens: 0 });
    bucket.conversations += 1;
    bucket.costUsd += costUsd;
    bucket.tokens += promptTokens + completionTokens;
  }

  summary.totalCostUsd = Number(summary.totalCostUsd.toFixed(6));
  for (const key of Object.keys(summary.byEngine)) {
    summary.byEngine[key].costUsd = Number(summary.byEngine[key].costUsd.toFixed(6));
  }
  return summary;
}

/** Format for the admin panel. */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `<$0.01`;
  return `$${usd.toFixed(4)}`;
}
