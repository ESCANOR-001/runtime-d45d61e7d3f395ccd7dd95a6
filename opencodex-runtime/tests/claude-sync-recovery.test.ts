import { expect, test } from 'bun:test';
import { ClaudeSyncRecovery, canRecoverClaudeSync } from '../src/claude-code/sync-recovery';

test('recovery retries only transport failures, respecting auth, identity and ownership refusals', () => {
  for (const text of ['network unavailable', 'HTTP 429', 'HTTP 503', 'Claude worker is offline', 'connection timed out', '']) expect(canRecoverClaudeSync(text)).toBe(true);
  for (const text of ['HTTP 403', 'HTTP 401', 'HTTP 404', 'HTTP 409', 'HTTP 410', 'Claude denied access', 'Sign in to Claude Code', 'session expired for trusted-device check', 'Remote Control is disabled by policy.', 'Another worker took over', 'session archived', 'session deleted', 'different session identity', 'different working folder', 'original shared session could not reconnect', 'Claude history changed during reconnect']) expect(canRecoverClaudeSync(text)).toBe(false);
});

test('transient recovery backs off, coalesces errors and stops after success', async () => {
  let calls = 0;
  const retry = new ClaudeSyncRecovery(async () => { calls++; if (calls < 5) throw new Error('HTTP 503'); return 'connected'; });
  retry.schedule('chat'); retry.schedule('chat');
  const entries = (retry as any).entries;
  for (const delay of [15_000, 30_000, 60_000, 120_000]) {
    const before = Date.now(); await retry.tick(Infinity);
    expect(entries.get('chat').due - before).toBeGreaterThanOrEqual(delay);
    expect(entries.get('chat').due - Date.now()).toBeLessThanOrEqual(delay);
    retry.schedule('chat', 'more transport errors');
    expect(entries.size).toBe(1);
  }
  await retry.tick(Infinity); await retry.tick(Infinity);
  expect(calls).toBe(5); expect(entries.size).toBe(0); await retry.close();
});

test('a running retry is single-flight and cancellation cannot resurrect it', async () => {
  let release!: () => void, calls = 0;
  const retry = new ClaudeSyncRecovery(async () => { calls++; await new Promise<void>(r => { release = r; }); throw new Error('offline'); });
  retry.schedule('chat'); const one = retry.tick(Infinity); const two = retry.tick(Infinity);
  await Promise.resolve(); retry.cancel('chat'); release(); await Promise.all([one, two]);
  expect(calls).toBe(1); await retry.tick(Infinity); expect(calls).toBe(1);
  retry.schedule('chat', 'HTTP 403'); await retry.tick(Infinity); expect(calls).toBe(1);
  await retry.close(); retry.schedule('chat'); await retry.tick(Infinity); expect(calls).toBe(1);
});

test('a deferral waits without consuming retry attempts; terminal refusal removes the entry', async () => {
  let fail = false;
  const retry = new ClaudeSyncRecovery(async () => { if (fail) throw new Error('HTTP 403'); return 'defer'; });
  retry.schedule('chat'); await retry.tick(Infinity);
  expect((retry as any).entries.get('chat').attempts).toBe(0);
  fail = true; await retry.tick(Infinity); expect((retry as any).entries.size).toBe(0); await retry.close();
});
