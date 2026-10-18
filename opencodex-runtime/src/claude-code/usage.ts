import type { Query } from '@anthropic-ai/claude-agent-sdk';

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
export type ClaudeContextUsage = { usedTokens: number; maxTokens: number; estimated: true };
export type ClaudeUsageWindow = { label: string; usedPercent: number; resetsAt: string | null };
export type ClaudeUsageReading<T> = { value: T | null; checkedAt: string };

/** Keep only numeric display data. Never forward paths, prompts, account identity or cost history. */
export function claudeContextUsage(value: unknown): ClaudeContextUsage | null {
  const data = row(value);
  // rawMaxTokens is the compaction-policy window against which Claude computes its percentage.
  const maximum = data.rawMaxTokens ?? data.maxTokens;
  if (!number(data.totalTokens) || !number(maximum) || maximum <= 0) return null;
  return { usedTokens: data.totalTokens, maxTokens: maximum, estimated: true };
}

export function claudeUsageWindows(value: unknown): ClaudeUsageWindow[] | null {
  const data = row(value);
  if (data.rate_limits_available !== true) return null;
  const limits = row(data.rate_limits), windows: ClaudeUsageWindow[] = [];
  const add = (label: string, raw: unknown) => {
    const window = row(raw);
    if (!number(window.utilization) || window.utilization > 100) return;
    const date = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    windows.push({ label, usedPercent: window.utilization, resetsAt: Number.isFinite(date) ? new Date(date).toISOString() : null });
  };
  for (const [key, label] of Object.entries({ five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet', seven_day_oauth_apps: 'Weekly apps' })) add(label, limits[key]);
  if (Array.isArray(limits.model_scoped)) for (const raw of limits.model_scoped.slice(0, 20)) {
    const model = row(raw);
    if (typeof model.display_name === 'string' && /^[\p{L}\p{N} ._-]{1,64}$/u.test(model.display_name)) {
      const label = `Weekly ${model.display_name}`;
      if (!windows.some(w => w.label.toLowerCase() === label.toLowerCase())) add(label, model);
    }
  }
  return windows.length ? windows : null;
}

/** Reads do not send prompts, resume sessions or interrupt a worker. Cache across phones. */
export class ClaudeUsageReader {
  private contexts = new WeakMap<Query, { at: number; promise: Promise<ClaudeUsageReading<ClaudeContextUsage>> }>();
  private plan?: { at: number; promise: Promise<ClaudeUsageReading<ClaudeUsageWindow[]>> };
  constructor(private readonly clock = Date.now, private readonly timeoutMs = 8000) {}

  private async bounded<T>(work: () => Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.timeoutMs); })]);
    } catch { return null; }
    finally { if (timer) clearTimeout(timer); }
  }
  context(query?: Query): Promise<ClaudeUsageReading<ClaudeContextUsage>> {
    const checkedAt = new Date(this.clock()).toISOString();
    if (!query || typeof query.getContextUsage !== 'function') return Promise.resolve({ value: null, checkedAt });
    const cached = this.contexts.get(query);
    if (cached && this.clock() - cached.at < 15_000) return cached.promise;
    const entry = { at: Infinity, promise: Promise.resolve({ value: null, checkedAt }) as Promise<ClaudeUsageReading<ClaudeContextUsage>> };
    // Retain the in-flight entry even if the UI deadline expires: a hung control
    // must not accumulate requests or close the user's running worker.
    const work = Promise.resolve().then(() => query.getContextUsage({ detail: 'summary' })).finally(() => { entry.at = this.clock(); });
    entry.promise = this.bounded(() => work).then(value => ({ value: claudeContextUsage(value), checkedAt }));
    this.contexts.set(query, entry);
    return entry.promise;
  }
  limits(createProbe: () => Query): Promise<ClaudeUsageReading<ClaudeUsageWindow[]>> {
    if (this.plan && this.clock() - this.plan.at < 60_000) return this.plan.promise;
    const checkedAt = new Date(this.clock()).toISOString();
    const entry = { at: Infinity, promise: Promise.resolve({ value: null, checkedAt }) as Promise<ClaudeUsageReading<ClaudeUsageWindow[]>> };
    entry.promise = (async () => {
      let probe: Query | undefined;
      try {
        const value = await this.bounded(async () => {
          probe = createProbe();
          const read = probe.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
          // Optional, isolated compatibility boundary for the SDK's experimental API.
          return typeof read === 'function' ? read.call(probe, { skipBehaviors: true }) : null;
        });
        return { value: claudeUsageWindows(value), checkedAt };
      } finally {
        try { probe?.close(); } catch { /* A disconnected metadata probe cannot fail the chat. */ }
        entry.at = this.clock();
      }
    })();
    this.plan = entry;
    return entry.promise;
  }
}
