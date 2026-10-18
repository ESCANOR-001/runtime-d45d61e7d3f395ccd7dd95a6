/** Claude 4+ exposes API-side summaries. Older/unknown models may expose raw thinking. */
export function hasClaudeThinkingSummary(model: unknown): boolean {
  return typeof model === 'string' && /^claude-(?:opus|sonnet|haiku)-[4-9](?:[.\-]|$)/i.test(model);
}

export function claudeThinkingSummary(model: unknown, block: Record<string, any>): string | null {
  if (!hasClaudeThinkingSummary(model) || block.type !== 'thinking' || typeof block.thinking !== 'string') return null;
  return block.thinking.trim().slice(0, 16_000) || null;
}
