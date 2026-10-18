import { expect, test } from 'bun:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeUsageReader, claudeContextUsage, claudeUsageWindows } from '../src/claude-code/usage';
const usage = { rate_limits_available: true, rate_limits: { five_hour: { utilization: 0, resets_at: '2026-10-17T07:00:00Z' }, seven_day: { utilization: 85, resets_at: null } } };
test('context uses the current compaction window, not cumulative model usage', () => {
  expect(claudeContextUsage({ totalTokens: 65000, maxTokens: 1000000, rawMaxTokens: 200000, secret: 'private' })).toEqual({ usedTokens: 65000, maxTokens: 200000, estimated: true });
  expect(claudeContextUsage({ totalTokens: 250000, rawMaxTokens: 200000 })).toMatchObject({ usedTokens: 250000 });
  for (const value of [null, {}, { totalTokens: -1, maxTokens: 10 }, { totalTokens: NaN, maxTokens: 10 }, { totalTokens: 1, maxTokens: 0 }, { totalTokens: '1', maxTokens: 10 }]) expect(claudeContextUsage(value)).toBeNull();
  expect(claudeContextUsage({ modelUsage: { opus: { inputTokens: 900000, contextWindow: 1000000 } } })).toBeNull();
});
test('windows preserve zero, reset dates and model limits without private fields', () => {
  expect(claudeUsageWindows(usage)).toEqual([{ label: '5-hour', usedPercent: 0, resetsAt: '2026-10-17T07:00:00.000Z' }, { label: 'Weekly', usedPercent: 85, resetsAt: null }]);
  expect(claudeUsageWindows({ ...usage, rate_limits: { seven_day_opus: { utilization: 40 }, model_scoped: [{ display_name: 'Opus', utilization: 40 }, { display_name: 'Future', utilization: 70, resets_at: 'invalid', secret: 'private' }] } })).toEqual([{ label: 'Weekly Opus', usedPercent: 40, resetsAt: null }, { label: 'Weekly Future', usedPercent: 70, resetsAt: null }]);
  for (const v of [null, {}, { rate_limits_available: false, rate_limits: usage.rate_limits }, { rate_limits_available: true, rate_limits: { five_hour: { utilization: null }, seven_day: { utilization: 101 } } }]) expect(claudeUsageWindows(v)).toBeNull();
});
test('reads coalesce and throttle without full token counts or transcript scans', async () => {
  let now = 100000, contexts = 0, plans = 0, closed = 0;
  const reader = new ClaudeUsageReader(() => now);
  const q = { getContextUsage: async (options: unknown) => { contexts++; expect(options).toEqual({ detail: 'summary' }); return { totalTokens: 5, rawMaxTokens: 10 }; } } as unknown as Query;
  const create = () => { plans++; return { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (options: unknown) => { expect(options).toEqual({ skipBehaviors: true }); return usage; }, close: () => { closed++; } } as unknown as Query; };
  const results = await Promise.all([reader.context(q), reader.context(q), reader.limits(create), reader.limits(create)]);
  expect(results[0].value).toMatchObject({ usedTokens: 5 }); expect(contexts).toBe(1); expect(plans).toBe(1); expect(closed).toBe(1);
  now += 16000; await reader.context(q); await reader.limits(create); expect(contexts).toBe(2); expect(plans).toBe(1);
  now += 60000; await reader.limits(create); expect(plans).toBe(2); expect(closed).toBe(2);
});
test('unavailable and timed out controls fail closed without closing a chat worker', async () => {
  let now = 100000, calls = 0, closed = 0;
  const reader = new ClaudeUsageReader(() => now, 10);
  expect((await reader.context({} as Query)).value).toBeNull();
  const q = { getContextUsage: () => { calls++; return new Promise(() => {}); }, close: () => { closed++; } } as unknown as Query;
  expect((await reader.context(q)).value).toBeNull(); now += 60000; await reader.context(q); expect(calls).toBe(1); expect(closed).toBe(0);
  expect((await reader.limits(() => ({ close: () => { closed++; } }) as Query)).value).toBeNull(); expect(closed).toBe(1);
  now += 60000;
  expect((await reader.limits(() => ({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('unavailable'); }, close: () => { closed++; } }) as unknown as Query)).value).toBeNull(); expect(closed).toBe(2);
});
