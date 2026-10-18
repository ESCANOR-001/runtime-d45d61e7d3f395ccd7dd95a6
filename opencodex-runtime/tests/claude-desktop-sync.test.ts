import { expect, test } from 'bun:test';
import { claudeInputQueue, connectDesktop } from '../src/claude-code/desktop-sync';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

test('missing Remote Control fails explicitly without patching or creating a fallback session', async () => {
  await expect(connectDesktop({} as Query, 'test')).rejects.toThrow('does not support');
});
test('reattachment cannot silently replace a Desktop identity', async () => {
  const calls: boolean[] = [];
  const q = { enableRemoteControl: async (enabled: boolean) => { calls.push(enabled); return { bridge_session_id: 'different' }; } } as unknown as Query;
  await expect(connectDesktop(q, 'test', 'original')).rejects.toThrow('duplicate');
  expect(calls).toEqual([true, false]);
});
test('input queue remains idle between messages, closes without replaying queued input', async () => {
  const q = claudeInputQueue(); const iterator = q[Symbol.asyncIterator]();
  const pending = iterator.next(); q.push({ type: 'user' } as SDKUserMessage);
  expect((await pending).done).toBe(false);
  q.push({ type: 'user' } as SDKUserMessage); q.close();
  expect((await iterator.next()).done).toBe(true);
  expect(() => q.push({} as SDKUserMessage)).toThrow('disconnected');
});

test('cancels an unread local input before the SDK consumes it', async () => {
  const q = claudeInputQueue();
  q.push({type:'user', uuid:'11111111-2222-4333-8444-555555555555'} as SDKUserMessage);
  expect(q.cancel('11111111-2222-4333-8444-555555555555')).toBe(true);
  expect(q.cancel('11111111-2222-4333-8444-555555555555')).toBe(false);
  q.close(); expect((await q[Symbol.asyncIterator]().next()).done).toBe(true);
});

test('interrupt cancels only our unread UUIDs and respects the SDK queue receipt', async () => {
  const { interruptClaude } = await import('../src/claude-code/desktop-sync');
  const calls: string[] = [];
  const q = { cancelAsyncMessage: async (uuid: string) => { calls.push(uuid); return calls.length > 1; },
    interrupt: async () => ({ still_queued: ['ours', 'desktop-client'] }) } as unknown as Query;
  expect(await interruptClaude(q, ['ours'])).toEqual(['ours']);
  expect(calls).toEqual(['ours', 'ours']);
});
