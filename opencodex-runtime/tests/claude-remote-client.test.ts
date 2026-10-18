import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existingBridgeId, remoteClientHeaders } from '../src/claude-code/remote-client';
import { ManagedClaudeCode } from '../src/claude-code/managed';
const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), 'claude-client-')); roots.push(value); return value; };
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const flush = () => Bun.sleep(20);
const native = '11111111-2222-4333-8444-555555555555';
const id = `claude-history-${native}`;
function fixture(options: { noLink?: boolean; denied?: boolean } = {}) {
  const dir = root();
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabled: true, desktopSync: true, projects: [] }));
  const events: any[] = []; let wake: (() => void) | undefined; let closed = false;
  let interrupted = 0; let locals = 0; let forks = 0; let input: any; let connects = 0;
  const emit = (e: any) => { events.push({ session_id: 'cse_fixture', ...e }); wake?.(); };
  const q: any = { supportedModels: async () => [], close() { closed = true; wake?.(); },
    interrupt: async () => { interrupted++; emit({ type: 'result', terminal_reason: 'aborted_tools' }); },
    async *[Symbol.asyncIterator]() { while (!closed) { if (events.length) yield events.shift(); else await new Promise<void>(r => { wake = r; }); } },
  };
  const historyMessages: any[] = [{ type: 'user', uuid: 'old-user', parent_tool_use_id: null, session_id: native, message: { role: 'user', content: 'Hello' } }];
  const service = new ManagedClaudeCode(dir, (() => { locals++; throw new Error('Unexpected local worker'); }) as any,
    { list: async () => [{ sessionId: native, cwd: dir, summary: 'Existing Desktop', lastModified: 1000 + historyMessages.length }],
      messages: async () => historyMessages },
    async () => { forks++; throw new Error('Unexpected fork'); },
    async i => { if (options.denied) throw new Error('Claude denied access'); input = i; closed = false; connects++; emit({ type: 'system', subtype: 'init', cwd: dir, model: 'sonnet', permissionMode: 'default' }); return { query: q, metadata: { worker_status: 'idle' } }; },
    async () => options.noLink ? undefined : 'cse_fixture');
  const open = async () => { await service.refreshHistory(true); await service.readDetail(id); await service.prepareThread(id); };
  const dispatch = (c: any) => service.dispatch({ threadId: id, commandId: crypto.randomUUID(), ...c }, 'phone');
  return { dir, service, open, emit, dispatch, historyMessages, q, get input() { return input; }, counts: () => ({ locals, forks, interrupted, connects }) };
}
test('opening an older saved Desktop projection repairs injected user text without reconnecting or sending', async () => {
  const f = fixture();
  const reminder = '<system-reminder>Desktop setup instructions</system-reminder>\n\n';
  f.historyMessages[0].message.content = [{ type: 'text', text: reminder }, { type: 'text', text: 'Hii' }];
  await f.open();
  // Simulate an already-imported projection from the previous version.
  const t = f.service.detail(id).thread;
  t.messages[0].text = reminder + '\nHii';
  const timestamp = t.messages[0].createdAt;
  const turnId = t.messages[0].turnId;
  const history = (f.service as any).history;
  const detail = history.detail.bind(history); let reads = 0;
  history.detail = (...args: any[]) => { reads++; return detail(...args); };
  const repaired = (await f.service.readDetail(id)).thread;
  expect(repaired.messages).toHaveLength(1);
  expect(repaired.messages[0]).toMatchObject({ id: 'old-user', text: 'Hii', createdAt: timestamp, turnId });
  expect(f.counts()).toEqual({ locals: 0, forks: 0, interrupted: 0, connects: 1 });
  await f.service.readDetail(id); await f.service.readDetail(id);
  expect(reads).toBe(1);
  await f.service.close();
  const saved = JSON.parse(await Bun.file(join(f.dir, 'sessions', native + '.json')).text());
  expect(saved.thread.messages[0].text).toBe('Hii');
  expect(f.historyMessages[0].message.content[0].text).toBe(reminder);
});

test('an unavailable native transcript does not hide an already-saved Desktop chat', async () => {
  const f = fixture(); await f.open();
  (f.service as any).history.detail = async () => { throw new Error('Native history unavailable'); };
  expect((await f.service.readDetail(id)).thread.messages[0].text).toBe('Hello');
  await f.service.close();
});

test('reconnect repairs native user text while preserving Android message identity', async () => {
  const f = fixture(); await f.open();
  const stored = (f.service as any).requireThread(id);
  stored.deliveries = [{ uuid: 'old-user', messageId: 'android-user', state: 'consumed', turnId: 'android-turn' }];
  stored.thread.messages[0] = { ...stored.thread.messages[0], id: 'android-user', turnId: 'android-turn', text: 'Old projected setup text' };
  await f.dispatch({ type: 'thread.session.stop' });
  await f.service.prepareThread(id);
  expect(f.service.detail(id).thread.messages).toHaveLength(1);
  expect(f.service.detail(id).thread.messages[0]).toMatchObject({ id: 'android-user', text: 'Hello', turnId: 'android-turn' });
  expect(f.counts()).toEqual({ locals: 0, forks: 0, interrupted: 0, connects: 2 });
  await f.service.close();
});
test('existing Desktop capabilities use the connected worker and clear after detaching', async () => {
  const f = fixture(); await f.open();
  f.q.supportedCommands = async () => [{ name: 'review', description: 'Review this project' }];
  f.q.mcpServerStatus = async () => [{ name: 'docs', status: 'connected', config: { env: { SECRET: 'hidden' } }, tools: [{ name: 'search' }] }];
  f.emit({ type: 'system', subtype: 'init', skills: ['review'], plugins: [{ name: 'sample', version: '1', path: '/private' }] });
  await flush();
  const result = await f.service.capabilities(id);
  expect(result.status).toBe('ready'); expect(result.skills[0].name).toBe('review');
  expect(result.mcpServers).toEqual([{ name: 'docs', status: 'connected', tools: ['search'] }]);
  expect(JSON.stringify(result)).not.toMatch(/SECRET|hidden|private/);
  await f.dispatch({ type: 'thread.session.stop' });
  expect((await f.service.capabilities(id)).status).toBe('unavailable');
  expect(f.counts()).toEqual({ locals: 0, forks: 0, interrupted: 0, connects: 1 });
  await f.service.close();
});
test('Auto effort clears the existing Desktop session override through its own control connection', async () => {
  const f = fixture(); await f.open();
  const settings: any[] = [];
  f.q.applyFlagSettings = async (value: any) => { settings.push(value); };
  // Desktop may have an override that the history snapshot did not report.
  await f.dispatch({ type: 'thread.meta.update', modelSelection: { instanceId: 'claude-code', model: 'sonnet', options: [{ id: 'effort', value: 'auto' }] } });
  await f.dispatch({ type: 'thread.meta.update', modelSelection: { instanceId: 'claude-code', model: 'sonnet', options: [{ id: 'effort', value: 'xhigh' }] } });
  await f.dispatch({ type: 'thread.meta.update', modelSelection: { instanceId: 'claude-code', model: 'sonnet', options: [{ id: 'effort', value: 'auto' }] } });
  expect(settings).toEqual([{ effortLevel: null }, { effortLevel: 'xhigh' }, { effortLevel: null }]);
  expect(f.service.detail(id).thread.modelSelection.options).toEqual([]);
  expect(f.counts()).toEqual({ locals: 0, forks: 0, interrupted: 0, connects: 1 });
  await f.service.close();
});
test('reads only matching bridge identities and never accepts a path as an ID', async () => {
  const dir = root(); mkdirSync(join(dir, 'projects', 'project'), { recursive: true });
  const p = join(dir, 'projects', 'project', native + '.jsonl');
  writeFileSync(p, [JSON.stringify({ type: 'bridge-session', sessionId: native, bridgeSessionId: 'cse_first' }),
    JSON.stringify({ type: 'bridge-session', sessionId: 'wrong', bridgeSessionId: 'cse_wrong' }),
    JSON.stringify({ type: 'bridge-session', sessionId: native, bridgeSessionId: 'cse_latest' }), '{unfinished'].join('\n'));
  expect(await existingBridgeId(native, dir)).toBe('cse_latest');
  expect(await existingBridgeId('../credentials', dir)).toBeUndefined();
});
test('auth errors never include credentials or file content', async () => {
  const dir = root(); writeFileSync(join(dir, '.credentials.json'), '{invalid secret fixture');
  await expect(remoteClientHeaders(dir)).rejects.toThrow('Sign in');
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-only', expiresAt: 1, scopes: ['user:sessions:claude_code'] } }));
  await expect(remoteClientHeaders(dir)).rejects.toThrow('Refresh');
});
test('attaches existing history once, sends through original client, deduplicates echoes, detaches without stopping Desktop', async () => {
  const f = fixture(); await f.open();
  expect(f.service.shell().threads).toHaveLength(1);
  expect(f.service.detail(id).thread.activities.at(-1).payload).toMatchObject({ existingSession: true, readOnly: false, status: 'connected' });
  f.emit({ type: 'user', uuid: 'old-user', message: { content: 'Hello' } }); await flush();
  expect(f.service.detail(id).thread.messages).toHaveLength(1);
  const c = { type: 'thread.turn.start', commandId: 'one-send', message: { text: 'Continue' } };
  await f.dispatch(c); await f.dispatch(c);
  const sent = await f.input.inbox[Symbol.asyncIterator]().next();
  expect(sent.value.session_id).toBe(native); expect(sent.value.message.content).toEqual([{ type: 'text', text: 'Continue' }]);
  f.emit(sent.value); await flush();
  expect(f.service.detail(id).thread.messages).toHaveLength(2);
  await f.service.close();
  expect(f.counts()).toEqual({ locals: 0, forks: 0, interrupted: 0, connects: 1 });
});
test('long-lived Desktop sync bounds transient event IDs without replaying saved history', async () => {
  const f = fixture(); await f.open();
  const worker = (f.service as any).active.get(id);
  try {
    for (let i = 0; i < 12_000; i++) f.emit({ type: 'stream_event', uuid: `frame-${i}`, event: { type: 'ping' } });
    await flush();
    expect(worker.remoteEvents.size).toBe(8000);
    expect(worker.remoteEvents.has('frame-0')).toBe(false);
    expect(worker.remoteEvents.has('frame-11999')).toBe(true);
    expect((f.service as any).requireThread(id).remoteEventUuids).toHaveLength(8000);
    const before = structuredClone(f.service.detail(id).thread.messages);
    // The bounded stream window must not turn an old human prompt into new work.
    f.emit({ type: 'user', uuid: 'old-user', message: { content: 'Hello' } });
    f.emit({ type: 'user', uuid: 'frame-11999', message: { content: 'Duplicate frame must not become a prompt' } });
    await flush();
    expect(f.service.detail(id).thread.messages).toEqual(before);
    expect(f.service.detail(id).thread.session.status).toBe('idle');
    await f.dispatch({ type: 'thread.session.stop' });
    expect(worker.remoteEvents.size).toBe(0);
    await f.service.prepareThread(id);
    f.emit({ type: 'user', uuid: 'frame-11999', message: { content: 'Duplicate after reconnect' } });
    await flush();
    expect(f.service.detail(id).thread.messages).toEqual(before);
    expect(f.counts()).toEqual({ locals: 0, forks: 0, interrupted: 0, connects: 2 });
  } finally { await f.service.close(); }
});
test('Desktop-originated prompt, tools and cancellation share the phone timeline', async () => {
  const f = fixture(); await f.open();
  f.emit({ type: 'user', uuid: 'desktop-new', message: { content: 'Read file' } });
  f.emit({ type: 'assistant', uuid: 'tool-message', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/fixture/readme' } }] } });
  await flush();
  const t = f.service.detail(id).thread;
  expect(t.messages.at(-1).text).toBe('Read file'); expect(t.session.status).toBe('running');
  expect(t.activities.find((a: any) => a.id === 'tool-1').payload.data.input.file_path).toBe('/fixture/readme');
  await f.dispatch({ type: 'thread.turn.interrupt' }); await flush();
  expect(t.latestTurn.state).toBe('interrupted'); expect(f.counts().interrupted).toBe(1);
  await f.service.close(); expect(f.counts().interrupted).toBe(1);
});
test('approval is resolved through the existing worker and cancelled requests clear', async () => {
  const f = fixture(); await f.open();
  const controller = new AbortController();
  const promise = f.input.canUseTool('Write', { file_path: '/fixture/test', content: 'ok' }, { signal: controller.signal, toolUseID: 'write-1' });
  const t = f.service.detail(id).thread; const request = t.activities.at(-1).payload.requestId;
  expect(t.hasPendingApprovals).toBe(true);
  await f.dispatch({ type: 'thread.approval.respond', requestId: request, decision: 'decline' });
  expect((await promise).behavior).toBe('deny'); expect(t.hasPendingApprovals).toBe(false);
  const second = f.input.canUseTool('Write', {}, { signal: controller.signal, toolUseID: 'write-2' });
  controller.abort(); await second; expect(t.hasPendingApprovals).toBe(false);
  await expect(f.dispatch({ type: 'thread.delete' })).rejects.toThrow('Claude Desktop');
  await f.service.close();
});

test('a saved Android client identifies the actual UI platform without exposing credentials to the phone', async () => {
  const dir = root();
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-only', expiresAt: Date.now() + 60000, scopes: ['user:sessions:claude_code'] }, trustedDeviceToken: 'fixture-device' }));
  const headers = await remoteClientHeaders(dir);
  expect(headers['anthropic-client-platform']).toBe('android');
  expect(headers['X-Trusted-Device-Token']).toBe('fixture-device');
});
test('concurrent subscribers attach one existing worker without duplicate history', async () => {
  const f = fixture(); await f.service.refreshHistory(true);
  await Promise.all([f.service.prepareThread(id), f.service.prepareThread(id)]);
  expect(f.counts().connects).toBe(1); expect(f.service.shell().threads).toHaveLength(1);
  await f.service.close(); expect(f.counts().interrupted).toBe(0);
});
test('missing links and denied attachments stay read-only without creating replacement sessions', async () => {
  for (const options of [{noLink: true}, {denied: true}]) {
    const f = fixture(options); await f.open();
    expect(f.service.detail(id).thread.activities.at(-1).payload).toMatchObject({readOnly: true, existingSession: true, status: 'disconnected'});
    await expect(f.dispatch({type: 'thread.turn.start', message: {text: 'Never silently fork'}})).rejects.toThrow();
    expect(f.counts().locals).toBe(0); expect(f.counts().forks).toBe(0);
    await f.service.close();
  }
});
test('reopening a detached client keeps the original chat and does not interrupt it', async () => {
  const f = fixture(); await f.open();
  await f.dispatch({type: 'thread.session.stop'});
  await f.service.prepareThread(id);
  expect(f.counts().connects).toBe(2); expect(f.counts().interrupted).toBe(0);
  expect(f.service.detail(id).thread.messages).toHaveLength(1);
  await f.service.close();
});

test('final live replies retain native UUIDs so history reconnect does not duplicate streamed text', async () => {
  const f = fixture(); await f.open();
  f.emit({type: 'user', uuid: 'new-user', message: {content: 'hello'}});
  f.emit({type: 'stream_event', event: {type: 'message_start', message: {id: 'api-id'}}});
  f.emit({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'answer'}}});
  f.emit({type: 'assistant', uuid: 'native-reply', message: {id: 'api-id', content: [{type: 'text', text: 'answer'}]}});
  await flush();
  const replies = f.service.detail(id).thread.messages.filter((m: any) => m.role === 'assistant');
  expect(replies).toHaveLength(1); expect(replies[0].id).toBe('native-reply');
  await f.service.close();
});

test('queue and steer use the original Desktop worker without a local writer or fork', async () => {
  const f = fixture(); await f.open();
  f.emit({ type: 'user', uuid: 'desktop-running', message: { content: 'Original task' } }); await flush();
  await f.dispatch({ type: 'thread.turn.start', deliveryMode: 'queue', modelSelection: { instanceId: 'claude-code', model: 'sonnet' }, message: { messageId: 'later', text: 'After completion' } });
  await f.dispatch({ type: 'thread.turn.start', deliveryMode: 'steer', message: { messageId: 'now', text: 'Change direction' } });
  const iterator = f.input.inbox[Symbol.asyncIterator](); const steer = (await iterator.next()).value;
  expect(steer).toMatchObject({ priority: 'now', session_id: native });
  f.emit({ type: 'result', user_message_uuid: 'desktop-running', terminal_reason: 'aborted_streaming' }); await flush();
  expect(f.service.detail(id).thread.session.status).toBe('running');
  f.emit({ type: 'command_lifecycle', state: 'started', command_uuid: steer.uuid });
  f.emit({ type: 'result', user_message_uuid: steer.uuid, terminal_reason: 'completed' }); await flush();
  const queued = (await iterator.next()).value;
  expect(queued.message.content[0].text).toBe('After completion');
  expect(f.counts()).toEqual({ locals: 0, forks: 0, interrupted: 0, connects: 1 });
  await f.service.close();
});

test('reconnect maps native user UUIDs to Android IDs without duplicating a sent prompt', async () => {
  const f = fixture(); await f.open();
  await f.dispatch({ type: 'thread.turn.start', message: { messageId: 'android-message', text: 'Same prompt' } });
  const nativePrompt = (await f.input.inbox[Symbol.asyncIterator]().next()).value;
  f.historyMessages.push(nativePrompt);
  f.emit({ type: 'result', user_message_uuid: nativePrompt.uuid, terminal_reason: 'completed' }); await flush();
  await f.dispatch({ type: 'thread.session.stop' }); await f.service.prepareThread(id);
  expect(f.service.detail(id).thread.messages.filter((m: any) => m.text === 'Same prompt')).toHaveLength(1);
  expect(f.service.detail(id).thread.messages.find((m: any) => m.text === 'Same prompt').id).toBe('android-message');
  expect(f.counts()).toEqual({ locals: 0, forks: 0, interrupted: 0, connects: 2 });
  await f.service.close();
});

test('Desktop context reads the original worker and discards results after detach', async () => {
  const f = fixture(); await f.open();
  let resolve: (value: any) => void = () => {};
  f.q.getContextUsage = () => new Promise(r => { resolve = r; });
  const read = f.service.refreshUsage(id); await flush();
  await f.dispatch({ type: 'thread.session.stop' });
  resolve({ totalTokens: 65000, rawMaxTokens: 1000000 }); await read;
  expect(f.service.detail(id).thread.activities.find((a: any) => a.kind === 'context-window.updated').payload.status).toBe('unavailable');
  expect(f.counts().interrupted).toBe(0); expect(f.counts().forks).toBe(0);
  await f.service.close();
});

test('a dropped Desktop client automatically rejoins the original worker and merges history once', async () => {
  const f = fixture(); await f.open();
  const original = structuredClone(f.service.detail(id).thread.messages[0]);
  f.q.close(); await flush();
  f.historyMessages.push({ type: 'assistant', uuid: 'offline-answer', message: { content: [{ type: 'text', text: 'Finished while disconnected' }] } });
  await (f.service as any).syncRecovery.tick(Infinity);
  expect(f.counts()).toEqual({ locals: 0, forks: 0, interrupted: 0, connects: 2 });
  expect(f.service.detail(id).thread.messages[0]).toEqual(original);
  expect(f.service.detail(id).thread.messages.filter((m: any) => m.id === 'offline-answer')).toHaveLength(1);
  expect(f.input.bridgeId).toBe('cse_fixture');
  await (f.service as any).syncRecovery.tick(Infinity); expect(f.counts().connects).toBe(2);
  await f.service.close();
});

test('an explicitly detached Desktop client stays detached', async () => {
  const f = fixture(); await f.open(); await f.dispatch({ type: 'thread.session.stop' });
  await (f.service as any).syncRecovery.tick(Infinity);
  expect(f.counts().connects).toBe(1); expect((f.service as any).requireThread(id).syncPaused).toBe(true);
  await f.service.close();
});

test('an already-shared Desktop chat that is initially offline reconnects when its original worker returns', async () => {
  const f = fixture(); const service = f.service as any, connect = service.remoteConnect;
  let offline = true;
  service.remoteConnect = (input: any) => offline ? Promise.reject(new Error('Desktop worker is offline')) : connect(input);
  await f.open(); expect(service.syncRecovery.entries.has(id)).toBe(true);
  offline = false; await service.syncRecovery.tick(Infinity);
  expect(f.counts()).toEqual({ locals: 0, forks: 0, interrupted: 0, connects: 1 });
  expect(f.service.detail(id).thread.activities.at(-1).payload.status).toBe('connected'); await f.service.close();
});

test('an attach-time verification failure survives client cleanup and never enters an automatic retry loop', async () => {
  const f = fixture(); f.q.supportedModels = async () => { throw new Error('session expired for trusted-device check'); };
  await f.open(); await flush(); await (f.service as any).syncRecovery.tick(Infinity);
  expect(f.counts().connects).toBe(1);
  expect(f.service.detail(id).thread.activities.find((a: any) => a.kind === 'claude.desktop-sync.updated').payload).toMatchObject({ status: 'disconnected', verificationIssue: 'device-verification' });
  await f.service.close();
});


test('Desktop-owned MCP forms use the existing remote worker and phone answers', async () => {
  const f = fixture(); await f.open();
  const abort = new AbortController();
  try {
    const response = f.input.onElicitation({ serverName: 'remote-tool', message: 'Pick a report', requestedSchema: { type: 'object', properties: { report: { type: 'string', enum: ['brief', 'full'] } }, required: ['report'] } }, { signal: abort.signal, requestId: 'native-mcp' });
    const requestId = f.service.detail(id).thread.activities.at(-1).payload.requestId;
    await f.dispatch({ type: 'thread.user-input.respond', requestId, answers: { 'mcp-field-0': 'brief' } });
    expect(await response).toEqual({ action: 'accept', content: { report: 'brief' } });
    expect(f.service.detail(id).thread.hasPendingUserInput).toBe(false);
    expect(f.counts()).toEqual({ locals: 0, forks: 0, interrupted: 0, connects: 1 });
  } finally { await f.service.close(); }
});
