import { ClaudeAutoConnect } from '../src/claude-code/auto-connect';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getEventListeners } from 'node:events';
import { join } from 'node:path';
import { ManagedClaudeCode } from '../src/claude-code/managed';
import type { query, ModelInfo } from '@anthropic-ai/claude-agent-sdk';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(modelCatalog?: ModelInfo[]) {
  let rejectSync = false;
  let failFork = false;
  let failBranchRead = false;
  const forks: any[] = [];
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'remodex-managed-'))); roots.push(root);
  const runs: any[] = [];
  const remoteCalls: any[] = [];
  const fake = ((input: any) => {
    const events: any[] = []; let wake: (() => void) | undefined; let closed = false;
    const q = {
      enableRemoteControl: async (enabled: boolean, name: string, options: any) => { remoteCalls.push({ enabled, name, options }); if (enabled && rejectSync) throw new Error('Remote Control server rejected the request (HTTP 403)'); return { bridge_session_id: options?.reattachSessionId ?? 'cse_fixture' }; },
      setModel: async (_model: string) => {},
      setPermissionMode: async (_mode: string) => {},
      applyFlagSettings: async (_settings: any) => {},
      supportedModels: async () => modelCatalog ?? [{ value: 'sonnet', displayName: 'Sonnet', description: '', supportedEffortLevels: ['low', 'high', 'xhigh'] }],
      accountInfo: async () => ({ apiProvider: 'firstParty', subscriptionType: 'Claude Pro' }),
      close: () => { closed = true; wake?.(); },
      interrupt: async () => { events.push({ type: 'result', is_error: true, errors: ['Stopped'] }); wake?.(); },
      stopTask: async (taskId: string) => { events.push({ type: 'system', subtype: 'task_notification', task_id: taskId, status: 'stopped' }); wake?.(); },
      async *[Symbol.asyncIterator]() { while (!closed) { if (events.length) yield events.shift(); else await new Promise<void>(r => { wake = r; }); } },
    };
    if (input.options.sessionId || input.options.resume) runs.push({ input, q, emit: (e: any) => { events.push(e); wake?.(); } });
    return q;
  }) as typeof query;
  const branchRows: any[] = [];
  const reader = { list: async () => [], info: async (sessionId: string) => ({ sessionId, cwd: root, summary: 'Fork', lastModified: 1, fileSize: 100 }),
    messages: async () => { if (failBranchRead) throw new Error('Read unavailable'); return structuredClone(branchRows); } };
  const service = new ManagedClaudeCode(root, fake, reader, async (id, options) => { forks.push({id,options}); if (failFork) throw new Error('Fork failed'); return { sessionId: '11111111-2222-4333-8444-555555555555' }; }, undefined, undefined, new ClaudeAutoConnect(join(root, 'claude-user')));
  const dispatch = (c: any) => service.dispatch({ commandId: crypto.randomUUID(), ...c }, 'phone');
  const setup = async () => {
    await service.configure({ enabled: true, binary: process.execPath });
    await dispatch({ type: 'project.create', projectId: 'project', workspaceRoot: root, title: 'Project' });
    await dispatch({ type: 'thread.create', threadId: 'task', projectId: 'project', runtimeMode: 'approval-required', modelSelection: { instanceId: 'claude-code', model: 'sonnet' } });
  };
  const send = (id = 'send') => dispatch({ type: 'thread.turn.start', threadId: 'task', commandId: id,
    message: { messageId: 'prompt', text: 'Test prompt', attachments: [] }, modelSelection: { instanceId: 'claude-code', model: 'sonnet', options: [{ id: 'effort', value: 'xhigh' }] } });
  return { rejectSync: (v: boolean) => { rejectSync = v; }, failFork: () => { failFork = true; }, branchRows, reader, failBranchRead: (v: boolean) => { failBranchRead = v; }, forks, root, fake, service, runs, remoteCalls, dispatch, setup, send };
}
const flush = () => Bun.sleep(20);

test('branching preserves its source and resumes a separate native history with fresh approvals', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  f.runs[0].emit({ type: 'system', subtype: 'init' });
  f.runs[0].emit({ type: 'assistant', uuid: 'answer', message: { id: 'answer', content: [{ type: 'text', text: 'Remember the blue kite' }] } });
  f.runs[0].emit({ type: 'result', is_error: false }); await flush();
  f.branchRows.push(
    { type: 'user', uuid: 'fork-prompt', parent_tool_use_id: null, message: { content: 'Test prompt' } },
    { type: 'assistant', uuid: 'fork-answer', parent_tool_use_id: null, message: { content: 'Remember the blue kite' } },
    { type: 'user', uuid: 'fork-task-notice', message: { content: '<task-notification>\n<task-id>background-1</task-id>\n<status>completed</status>\n<summary>Internal task finished</summary>\n</task-notification>' } },
  );
  const original = (f.service as any).threads.get('task');
  original.permissionRules = ['Write']; original.fileCheckpoints = [{ id: 'old-checkpoint', label: 'Old change' }];
  original.thread.runtimeMode = 'full-access'; original.thread.session.runtimeMode = 'full-access';
  const source = structuredClone(f.service.detail('task').thread);
  const input = { action: 'branchChat', threadId: 'task', commandId: 'branch' };
  try {
    const [a, b] = await Promise.all([f.service.sessionAction(input, 'phone'), f.service.sessionAction(input, 'phone')]);
    expect(a).toEqual(b); expect(f.forks).toHaveLength(1); expect(f.runs).toHaveLength(1);
    expect(f.forks[0]).toEqual({ id: source.nativeSessionId, options: { dir: f.root, title: `${source.title} (branch)` } });
    const [loaded] = await Promise.all([f.service.readDetail(a.threadId), f.service.prepareThread(a.threadId)]);
    expect(loaded.thread.messages.map((m: any) => [m.id, m.text])).toEqual([['fork-prompt', 'Test prompt'], ['fork-answer', 'Remember the blue kite']]);
    expect(loaded.thread.runtimeMode).toBe('approval-required'); expect(loaded.thread.checkpoints).toEqual([]);
    expect(loaded.thread.activities.some((a: any) => a.kind === 'claude.desktop-sync.updated')).toBe(false);
    const saved = JSON.parse(readFileSync(join(f.root, 'sessions', `${loaded.thread.nativeSessionId}.json`), 'utf8'));
    expect(saved.bridgeId).toBeUndefined(); expect(saved.permissionRules).toBeUndefined(); expect(saved.fileCheckpoints).toBeUndefined();
    expect(saved.deliveries).toBeUndefined(); expect(saved.followUps).toBeUndefined(); expect(saved.external).toBeUndefined();
    await f.dispatch({ type: 'thread.turn.start', threadId: a.threadId, message: { text: 'Continue the branch', messageId: 'branch-followup' } });
    expect(f.runs[1].input.options.resume).toBe(saved.nativeId);
    expect(f.runs[1].input.options.permissionMode).toBe('default');
    // A replay of the fork's remapped UUID cannot duplicate the old prompt.
    f.runs[1].emit({ type: 'user', uuid: 'fork-prompt', message: { content: 'Test prompt' } }); await flush();
    expect(f.service.detail(a.threadId).thread.messages.filter((m: any) => m.text === 'Test prompt')).toHaveLength(1);
    expect(f.service.detail('task').thread).toEqual(source);
    expect(f.runs[0].input.options.resume).toBeUndefined();
  } finally { await f.service.close(); }
});

test('branch identity survives a history read failure and restart without reforking or sending empty context', async () => {
  const f = fixture(); await f.setup(); await f.send(); f.runs[0].emit({ type: 'system', subtype: 'init' }); f.runs[0].emit({ type: 'result', is_error: false }); await flush();
  const input = { action: 'branchChat', threadId: 'task', commandId: 'branch-retry' };
  const result = await f.service.sessionAction(input, 'phone'); f.failBranchRead(true);
  await expect(f.service.readDetail(result.threadId)).rejects.toThrow('Read unavailable');
  await expect(f.dispatch({ type: 'thread.turn.start', threadId: result.threadId, message: { text: 'Continue' } })).rejects.toThrow('Read unavailable');
  expect(f.runs).toHaveLength(1); await f.service.close();
  const restarted = new ManagedClaudeCode(f.root, f.fake, f.reader, async () => { throw new Error('Must not fork again'); });
  try {
    expect(await restarted.sessionAction(input, 'phone')).toEqual(result);
    f.failBranchRead(false);
    f.branchRows.push({ type: 'user', uuid: 'remapped', message: { content: 'History intact' }, parent_tool_use_id: null });
    expect((await restarted.readDetail(result.threadId)).thread.messages[0].text).toBe('History intact');
    expect(f.forks).toHaveLength(1);
  } finally { await restarted.close(); }
});

test('branching refuses unsaved, running, queued, background and Desktop-owned chats', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true });
  const branch = () => f.service.sessionAction({ action: 'branchChat', threadId: 'task', commandId: crypto.randomUUID() }, 'phone');
  try {
    await expect(branch()).rejects.toThrow('Send a message'); await f.send();
    await expect(branch()).rejects.toThrow('Finish the task');
    f.runs[0].emit({ type: 'system', subtype: 'init' }); f.runs[0].emit({ type: 'result', is_error: false }); await flush();
    const saved = (f.service as any).threads.get('task'); saved.followUps = [{ id: 'queued' }];
    await expect(branch()).rejects.toThrow('Finish the task'); saved.followUps = [];
    saved.external = true; await expect(branch()).rejects.toThrow('Desktop-owned'); saved.external = false;
    const worker = (f.service as any).active.get('task'); worker.backgroundTasks = 1;
    await expect(branch()).rejects.toThrow('Finish the task'); worker.backgroundTasks = 0;
    f.service.detail('task').thread.hasPendingUserInput = true;
    await expect(branch()).rejects.toThrow('Finish the task'); f.service.detail('task').thread.hasPendingUserInput = false;
    expect(f.forks).toHaveLength(0); f.failFork(); const before = structuredClone(f.service.detail('task').thread);
    await expect(branch()).rejects.toThrow('Fork failed'); expect(f.service.detail('task').thread).toEqual(before);
    expect((f.service as any).threads.size).toBe(1);
  } finally { await f.service.close(); }
});

test('Claude default labels refresh from the SDK while execution keeps the default selection', async () => {
  const catalog: ModelInfo[] = [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: '' },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: '' },
  ];
  const f = fixture(catalog); await f.setup();
  try {
    const config = await f.service.config({}, {}, null);
    expect(config.providers[0].models[0]).toMatchObject({ slug: 'default', name: 'Opus 5.5 (default)', shortName: 'Opus 5.5' });
    await f.dispatch({ type: 'thread.turn.start', threadId: 'task', message: { messageId: 'default-prompt', text: 'Hello', attachments: [] }, modelSelection: { instanceId: 'claude-code', model: 'default' } });
    expect(f.runs[0].input.options.model).toBe('default');
    expect(f.service.detail('task').thread.modelSelection.model).toBe('default');
    f.runs[0].emit({ type: 'result', is_error: false }); await flush();
    catalog[0].resolvedModel = 'claude-sonnet-5-5';
    expect((await f.service.status(true)).models[0].name).toBe('Sonnet 5.5 (default)');
    expect((await f.service.config({}, {}, null)).providers[0].models[0].shortName).toBe('Sonnet 5.5');
  } finally { await f.service.close(); }
});

test('resolved Claude permissions release abort listeners while the worker stays connected', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const controller = new AbortController();
  try {
    for (let i = 0; i < 40; i++) {
      const permission = f.runs[0].input.options.canUseTool('Write', { content: 'temporary content'.repeat(1000) }, { signal: controller.signal });
      const requestId = f.service.detail('task').thread.activities.at(-1).payload.requestId;
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
      await f.dispatch({ type: 'thread.approval.respond', threadId: 'task', requestId, decision: i % 2 ? 'accept' : 'decline' });
      expect((await permission).behavior).toBe(i % 2 ? 'allow' : 'deny');
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
    expect(f.runs).toHaveLength(1);
    expect((f.service as any).pending.size).toBe(0);
  } finally { await f.service.close(); }
});

test('timed-out Claude capability reads do not accumulate controls and recover after settlement', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  let commands = 0, servers = 0, release!: () => void;
  const hung = new Promise<void>(resolve => { release = resolve; });
  f.runs[0].q.supportedCommands = async () => { commands++; await hung; return []; };
  f.runs[0].q.mcpServerStatus = async () => { servers++; await hung; return []; };
  try {
    await expect(f.service.capabilities('task')).rejects.toThrow('temporarily unavailable');
    const retry = f.service.capabilities('task');
    const observed = retry.catch(() => {});
    await flush();
    expect(commands).toBe(1); expect(servers).toBe(1);
    await observed;
    release(); await flush();
    expect((await f.service.capabilities('task')).status).toBe('ready');
    expect(commands).toBe(2); expect(servers).toBe(2);
  } finally { release(); await f.service.close(); }
}, 15_000);

test('closing Claude workers releases restore previews and stream metadata but preserves history', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const run = f.runs[0]; writeFileSync(join(f.root, 'checkpoint.txt'), 'content');
  run.q.rewindFiles = async () => ({ canRewind: true, filesChanged: ['checkpoint.txt'] });
  run.emit({ type: 'user', uuid: 'checkpoint', message: { content: 'Change checkpoint file' } });
  run.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'reply', model: 'claude-opus-4-6' } } });
  run.emit({ type: 'result', is_error: false }); await flush();
  try {
    const preview = await f.service.sessionAction({ action: 'previewRestore', point: 'checkpoint', threadId: 'task', commandId: 'preview' }, 'phone');
    expect(preview.token).toBeTruthy();
    expect((f.service as any).restorePreviews.size).toBe(1);
    const before = f.service.detail('task').thread.messages.map((m: any) => m.text);
    await (f.service as any).disconnectIdle('task');
    expect((f.service as any).restorePreviews.size).toBe(0);
    expect((f.service as any).streamSummaryModels.size).toBe(0);
    expect(f.service.detail('task').thread.messages.map((m: any) => m.text)).toEqual(before);
  } finally { await f.service.close(); }
});

test('Claude project creation only creates a folder explicitly and preserves existing contents', async () => {
  const f = fixture(); await f.setup();
  try {
    const folder = join(f.root, 'New project');
    await expect(f.dispatch({ type: 'project.create', projectId: 'missing', workspaceRoot: folder })).rejects.toThrow('Create folder');
    expect(existsSync(folder)).toBe(false);
    await f.dispatch({ type: 'project.create', projectId: 'new', workspaceRoot: folder, createWorkspaceRootIfMissing: true });
    expect(statSync(folder).isDirectory()).toBe(true);
    writeFileSync(join(folder, 'keep.txt'), 'keep');
    await f.dispatch({ type: 'project.create', projectId: 'existing', workspaceRoot: folder, createWorkspaceRootIfMissing: true });
    expect(readFileSync(join(folder, 'keep.txt'), 'utf8')).toBe('keep');
    const nested = join(f.root, 'missing-parent', 'child');
    await expect(f.dispatch({ type: 'project.create', projectId: 'nested', workspaceRoot: nested, createWorkspaceRootIfMissing: true })).rejects.toThrow('parent folder');
    expect(existsSync(join(f.root, 'missing-parent'))).toBe(false);
    await expect(f.dispatch({ type: 'project.create', projectId: 'file', workspaceRoot: join(folder, 'keep.txt'), createWorkspaceRootIfMissing: true })).rejects.toThrow('existing project folder');
    expect(f.runs).toHaveLength(0);
  } finally { await f.service.close(); }
});

test('live Desktop reminders stay out of prompts and file-checkpoint labels without losing echoes', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const run = f.runs[0]; run.emit({ type: 'result', is_error: false }); await flush();
  const event = { type: 'user', uuid: 'desktop-greeting', message: { content: [
    { type: 'text', text: '<system-reminder>Internal workspace setup</system-reminder>\n\n' },
    { type: 'text', text: 'Hii' },
  ] } };
  run.emit(event); run.emit(event); await flush();
  const messages = f.service.detail('task').thread.messages.filter((m: any) => m.id === 'desktop-greeting');
  expect(messages).toHaveLength(1); expect(messages[0].text).toBe('Hii');
  expect((f.service as any).requireThread('task').fileCheckpoints.find((p: any) => p.id === 'desktop-greeting').label).toBe('Hii');
  expect(f.service.detail('task').thread.session.status).toBe('running');
  run.emit({ type: 'result', is_error: false }); await flush();
  expect(f.service.detail('task').thread.session.status).toBe('idle');
  await f.service.close();
});

test('Claude session tool controls require a known live server, stay idle and sanitize refreshed plugins', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const run = f.runs[0], calls: any[] = [];
  run.q.supportedCommands = async () => [];
  run.q.mcpServerStatus = async () => [{ name: 'docs', status: 'connected', tools: [] }];
  run.q.toggleMcpServer = async (...args: any[]) => { calls.push(args); };
  run.q.reconnectMcpServer = async (...args: any[]) => { calls.push(args); };
  run.q.reloadPlugins = async (options: any) => { expect(options).toEqual({ holdOnCacheImpact: true }); return { plugins: [{ name: 'pkg', path: '/private' }], commands: [{ name: 'pkg:review' }], error_count: 0 }; };
  run.emit({ type: 'system', subtype: 'init', skills: [] });
  await flush();
  const act = (action: string, extra: any = {}) => f.service.sessionAction({ action, threadId: 'task', commandId: crypto.randomUUID(), ...extra }, 'phone');
  await expect(act('mcpReconnect', { name: 'docs' })).rejects.toThrow('Finish the task');
  run.emit({ type: 'result', is_error: false }); await flush();
  await expect(act('mcpReconnect', { name: 'unconfigured' })).rejects.toThrow('configured');
  await expect(act('mcpToggle', { name: 'docs', enabled: 'yes' })).rejects.toThrow('boolean');
  await act('mcpToggle', { name: 'docs', enabled: false });
  await act('mcpReconnect', { name: 'docs' });
  await act('reloadPlugins');
  expect(calls).toEqual([['docs', false], ['docs']]);
  const catalog = await f.service.capabilities('task');
  expect(catalog.skills[0].name).toBe('pkg:review'); expect(JSON.stringify(catalog)).not.toContain('private');
  run.q.reloadPlugins = async () => ({ held: true });
  expect((await act('reloadPlugins')).held).toBe(true);
  await f.service.close();
});

test('resumed Claude catalogs and reloads work before a new system init without another prompt', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const run = f.runs[0];
  run.q.supportedCommands = async () => [{ name: 'review', description: 'Review this workspace' }];
  run.q.mcpServerStatus = async () => [{ name: 'docs', status: 'connected' }];
  run.q.reloadSkills = async () => ({ skills: [{ name: 'updated' }] });
  const catalog = await f.service.capabilities('task');
  expect(catalog.status).toBe('ready'); expect(catalog.skills[0].name).toBe('review');
  expect(catalog.pluginsReported).toBe(false); expect(catalog.mcpServers[0].name).toBe('docs');
  run.emit({ type: 'result', is_error: false }); await flush();
  await f.service.sessionAction({ action: 'reloadSkills', threadId: 'task', commandId: 'reload' }, 'phone');
  expect((await f.service.capabilities('task')).skills[0].name).toBe('updated');
  expect(f.runs).toHaveLength(1);
  await f.service.close();
});

test('Claude restore previews are owned, idle, file-bound, and consumed once without deleting conversation', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const file = join(f.root, 'checkpoint.txt'); writeFileSync(file, 'after');
  const run = f.runs[0]; expect(run.input.options.enableFileCheckpointing).toBe(true);
  run.emit({ type: 'user', uuid: 'checkpoint', message: { content: 'Change checkpoint file' } });
  run.emit({ type: 'result', is_error: false }); await flush();
  let restores = 0;
  run.q.rewindFiles = async (_id: string, options: any) => { if (!options?.dryRun) { restores++; writeFileSync(file, 'before'); } return { canRewind: true, filesChanged: ['checkpoint.txt'] }; };
  const action = (action: string, more: any = {}, client = 'phone') => f.service.sessionAction({ action, commandId: crypto.randomUUID(), threadId: 'task', ...more }, client);
  expect((await action('checkpoints')).points[0].id).toBe('checkpoint');
  await expect(action('previewRestore', { point: 'foreign' })).rejects.toThrow('does not belong');
  const first = await action('previewRestore', { point: 'checkpoint' });
  writeFileSync(file, 'user changed after preview');
  await expect(action('restoreFiles', { token: first.token })).rejects.toThrow('changed after');
  expect(restores).toBe(0);
  const preview = await action('previewRestore', { point: 'checkpoint' });
  const messages = f.service.detail('task').thread.messages.map((m: any) => m.text);
  await action('restoreFiles', { token: preview.token });
  expect(readFileSync(file, 'utf8')).toBe('before'); expect(restores).toBe(1);
  expect(f.service.detail('task').thread.messages.map((m: any) => m.text)).toEqual(messages);
  await expect(action('restoreFiles', { token: preview.token })).rejects.toThrow('expired');
  f.service.detail('task').thread.session.status = 'running';
  await expect(action('previewRestore', { point: 'checkpoint' })).rejects.toThrow('Finish the task');
  f.service.detail('task').thread.session.status = 'idle';
  await f.service.close();
});

test('Claude Auto effort delegates to the model default instead of forcing High', async () => {
  const f = fixture(); await f.setup();
  const config = await f.service.config({}, {}, {});
  expect(config.providers[0].models[0].capabilities.optionDescriptors[0]).toMatchObject({
    currentValue: 'auto', options: [{ id: 'auto', label: 'Auto' }, { id: 'low' }, { id: 'high' }, { id: 'xhigh' }],
  });
  await f.dispatch({ type: 'thread.turn.start', threadId: 'task', message: { text: 'Use the native default' },
    modelSelection: { instanceId: 'claude-code', model: 'sonnet', options: [{ id: 'effort', value: 'auto' }] } });
  expect(f.runs[0].input.options.effort).toBeUndefined();
  expect(f.service.detail('task').thread.modelSelection.options).toEqual([]);
  await f.service.close();
});

test('returning Claude to Auto clears only its effort override without restarting the shared chat', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const run = f.runs[0];
  expect(run.input.options.effort).toBe('xhigh'); // Explicit choices remain honored.
  run.emit({ type: 'result', is_error: false }); await flush();
  const settings: any[] = [];
  run.q.applyFlagSettings = async (v: any) => { settings.push(v); };
  await f.dispatch({ type: 'thread.meta.update', threadId: 'task', modelSelection: {
    instanceId: 'claude-code', model: 'sonnet', options: [{ id: 'effort', value: 'auto' }],
  } });
  expect(settings).toEqual([{ effortLevel: null }]);
  expect(f.runs).toHaveLength(1);
  expect(f.service.detail('task').thread.modelSelection.options).toEqual([]);
  // A later Desktop change may not be reflected in this saved Auto selection.
  // Sending Auto again must still clear the live override, not just the metadata.
  await f.dispatch({ type: 'thread.turn.start', threadId: 'task', message: { text: 'Continue with Auto' },
    modelSelection: { instanceId: 'claude-code', model: 'sonnet', options: [{ id: 'effort', value: 'auto' }] } });
  expect(settings).toEqual([{ effortLevel: null }, { effortLevel: null }]);
  expect(f.runs).toHaveLength(1);
  await f.service.close();
});

test('Claude exposes bounded progress metadata without revealing private thinking or raw retry errors', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const emit = f.runs[0].emit;
  const progress = () => f.service.detail('task').thread.activities.filter((a: any) => a.kind === 'claude.progress');
  emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 100, thinking: 'private-thought' });
  emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 230 });
  await flush();
  expect(progress()).toHaveLength(1);
  expect(progress()[0]).toMatchObject({ summary: 'Claude is thinking', payload: { status: 'running', estimatedTokens: 230 } });
  expect(JSON.stringify(progress())).not.toContain('private-thought');
  emit({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 3200, error: 'raw-secret-error', no_response: { waited_ms: 60000 } });
  await flush();
  expect(progress()).toHaveLength(1);
  expect(progress()[0]).toMatchObject({ summary: 'Claude is retrying (2/10)', payload: { status: 'running', retryDelayMs: 3200 } });
  expect(progress()[0].payload.detail).toContain('4 seconds');
  expect(JSON.stringify(progress())).not.toContain('raw-secret-error');
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'reply' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Ready' } } });
  await flush();
  expect(progress()[0]).toMatchObject({ summary: 'Claude resumed', payload: { status: 'completed' } });
  expect(progress()[0].payload.detail).not.toContain('Retrying in');
  emit({ type: 'result', is_error: false }); await flush();
  emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 999 }); await flush();
  expect(progress()[0].payload.status).toBe('completed');
  await f.service.close();
});

test('Claude progress clears on Stop and failure and ignores stale or subagent thinking', async () => {
  for (const stop of [false, true]) {
    const f = fixture(); await f.setup(); await f.send();
    const emit = f.runs[0].emit;
    emit({ type: 'system', subtype: 'thinking_tokens', user_message_uuid: 'old-prompt', estimated_tokens: 100 });
    emit({ type: 'system', subtype: 'thinking_tokens', parent_tool_use_id: 'subagent', estimated_tokens: 100 });
    await flush();
    expect(f.service.detail('task').thread.activities.some((a: any) => a.kind === 'claude.progress')).toBe(false);
    emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: Number.NaN }); await flush();
    if (stop) await f.dispatch({ type: 'thread.turn.interrupt', threadId: 'task' });
    else emit({ type: 'result', is_error: true, errors: ['Test failure'] });
    await flush();
    const progress = f.service.detail('task').thread.activities.find((a: any) => a.kind === 'claude.progress');
    expect(progress.payload.status).toBe(stop ? 'stopped' : 'failed');
    expect(progress.payload.detail).not.toContain('Waiting');
    expect(JSON.stringify(progress)).not.toContain('NaN');
    await f.service.close();
  }
});

test('Claude MCP forms wait for phone input, validate, cancel and release listeners', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const controller = new AbortController();
  const request = { serverName: 'test-server', message: 'Choose count', requestedSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['count'] } };
  try {
    const response = f.runs[0].input.options.onElicitation(request, { signal: controller.signal, requestId: 'sdk-request' });
    const t = f.service.detail('task').thread, requestId = t.activities.at(-1).payload.requestId;
    expect(t.hasPendingUserInput).toBe(true); expect(t.hasPendingApprovals).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    const answer = (value: string) => f.dispatch({ type: 'thread.user-input.respond', threadId: 'task', requestId, answers: { 'mcp-field-0': value } });
    await expect(answer('9')).rejects.toThrow('Check the MCP answers');
    expect(t.hasPendingUserInput).toBe(true);
    await expect(f.dispatch({ type: 'thread.user-input.respond', threadId: 'another-chat', requestId, answers: {} })).rejects.toThrow();
    await answer('3'); expect(await response).toEqual({ action: 'accept', content: { count: 3 } });
    expect(t.hasPendingUserInput).toBe(false); expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await expect(answer('3')).rejects.toThrow('expired');
    const stopped = f.runs[0].input.options.onElicitation(request, { signal: controller.signal, requestId: 'second' });
    await f.dispatch({ type: 'thread.turn.interrupt', threadId: 'task' });
    expect(await stopped).toEqual({ action: 'cancel' });
    expect(t.hasPendingUserInput).toBe(false); expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(t.messages.filter((m: any) => m.role === 'user')).toHaveLength(1);
  } finally { await f.service.close(); }
});

test('Claude MCP browser requests report a clear notice without storing authentication links', async () => {
  const f = fixture(); await f.setup(); await f.send();
  try {
    expect(await f.runs[0].input.options.onElicitation({ mode: 'url', serverName: 'auth', message: 'Sign in', url: 'https://example.com/?secret=not-persisted' }, { signal: new AbortController().signal, requestId: 'url' })).toEqual({ action: 'cancel' });
    const t = f.service.detail('task').thread;
    expect(t.activities.at(-1).payload.detail).toContain('browser step');
    expect(JSON.stringify(t)).not.toContain('not-persisted');
    expect(t.hasPendingUserInput).toBe(false);
  } finally { await f.service.close(); }
});

test('typing Claude question drafts does not save or reorder chats or retain keystroke commands', async () => {
  const f = fixture(); await f.setup(); await f.send();
  try {
    const t = f.service.detail('task').thread, before = t.updatedAt;
    let saves = 0; const saved = (f.service as any).save.bind(f.service);
    (f.service as any).save = (...args: any[]) => { saves++; return saved(...args); };
    const mutations = (f.service as any).mutations.size;
    for (let i = 0; i < 40; i++) await f.dispatch({ type: 'thread.user-input.draft.update', threadId: 'task', requestId: 'question', answers: { text: 'x'.repeat(i) } });
    expect(saves).toBe(0); expect(t.updatedAt).toBe(before); expect((f.service as any).mutations.size).toBe(mutations);
  } finally { await f.service.close(); }
});

test('accepts shared UI question answers and retains choices after reload', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const questions = [
    { question: 'Choose a color', header: 'Color', multiSelect: false, options: [{ label: 'Blue' }, { label: 'Green' }] },
    { question: 'Choose shapes', header: 'Shapes', multiSelect: true, options: [{ label: 'Circle' }, { label: 'Square' }] },
  ];
  f.runs[0].emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'question-tool', name: 'AskUserQuestion', input: { questions } }] } });
  await flush();
  const permission = f.runs[0].input.options.canUseTool('AskUserQuestion', { questions }, { signal: new AbortController().signal, toolUseID: 'question-tool' });
  const request = f.service.detail('task').thread.activities.at(-1);
  expect(request.payload.questions[1].multiSelect).toBe(true);
  const answer = (answers: any) => f.dispatch({ type: 'thread.user-input.respond', threadId: 'task', requestId: request.payload.requestId, answers });
  await expect(answer({ 'question-0': 'Blue', 'question-1': [] })).rejects.toThrow('Answer each question');
  expect(f.service.detail('task').thread.hasPendingUserInput).toBe(true);
  const answers = { 'question-0': 'Blue', 'question-1': ['Circle', 'Square'] };
  await answer(answers);
  expect((await permission).updatedInput.answers).toEqual({ 'Choose a color': 'Blue', 'Choose shapes': 'Circle, Square' });
  expect(f.service.detail('task').thread.hasPendingUserInput).toBe(false);
  expect(f.service.detail('task').thread.activities.find((a: any) => a.id === 'question-tool').payload).toMatchObject({ title: 'Question', detail: 'Choose a color\nChoose shapes' });
  await f.service.close();
  const restored = new ManagedClaudeCode(f.root, f.fake);
  expect(restored.detail('task').thread.activities.find((a: any) => a.kind === 'user-input.resolved').payload.answers).toEqual(answers);
  await restored.close();
});

test('presents plan approval as readable content while retaining the permission decision', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const plan = '# Plan\n\n1. Read the project.\n2. Add the greeting.';
  const permission = f.runs[0].input.options.canUseTool('ExitPlanMode', { plan }, { signal: new AbortController().signal, toolUseID: 'plan-tool' });
  const request = f.service.detail('task').thread.activities.at(-1);
  expect(request.payload).toMatchObject({ displayTitle: 'Plan approval requested', detail: plan, providerName: 'claude-code' });
  await f.dispatch({ type: 'thread.approval.respond', threadId: 'task', requestId: request.payload.requestId, decision: 'decline' });
  expect((await permission).behavior).toBe('deny');
  await f.service.close();
});

test('projects Claude tool inputs and approvals into the shared transcript contract', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const emit = f.runs[0].emit;
  for (const [id, name, input] of [
    ['read', 'Read', { file_path: '/workspace/README.md' }],
    ['write', 'Write', { file_path: '/workspace/result.txt', content: 'hello' }],
    ['bash', 'Bash', { command: 'echo hello' }],
    ['search', 'Grep', { pattern: 'hello' }],
  ]) emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  await flush();
  const t = f.service.detail('task').thread;
  expect(t.activities.find((a: any) => a.id === 'read').payload.readFiles).toEqual(['/workspace/README.md']);
  expect(t.activities.find((a: any) => a.id === 'write').payload.data.changes).toBeUndefined();
  expect(t.activities.find((a: any) => a.id === 'bash').payload.data.command).toBe('echo hello');
  expect(t.activities.find((a: any) => a.id === 'search').payload.itemType).toBe('codebase-search');
  const permission = f.runs[0].input.options.canUseTool('Write', { file_path: '/workspace/result.txt', content: 'hello' }, { signal: new AbortController().signal, toolUseID: 'write' });
  const request = f.service.detail('task').thread.activities.at(-1);
  expect(request.payload).toMatchObject({ providerName: 'claude-code', data: { toolCallId: 'write' }, detail: 'Write /workspace/result.txt\n\nhello' });
  await f.dispatch({ type: 'thread.approval.respond', threadId: 'task', requestId: request.payload.requestId, decision: 'decline' });
  expect((await permission).behavior).toBe('deny');
  expect(f.service.detail('task').thread.activities.at(-1).payload.data.toolCallId).toBe('write');
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'read contents' }] } });
  await flush();
  expect(f.service.detail('task').thread.activities.find((a: any) => a.id === 'read').payload.readFiles).toEqual(['/workspace/README.md']);
  await f.service.close();
});

test('uses the normal CLI subscription and isolates managed sessions from Desktop IDs', async () => {
  const f = fixture(); await f.setup(); await f.send();
  expect(f.runs[0].input.options.pathToClaudeCodeExecutable).toBe(process.execPath);
  expect(f.runs[0].input.options.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(f.runs[0].input.options.effort).toBe('xhigh');
  expect(f.runs[0].input.options.resume).toBeUndefined();
  expect(f.service.shell().threads).toHaveLength(1);
  await expect(f.dispatch({ type: 'thread.turn.start', threadId: 'desktop-session' })).rejects.toThrow('not found');
  await f.service.close();
});

test('publishes the user prompt, tool status, streaming text and terminal status', async () => {
  const f = fixture(); await f.setup(); await f.send();
  expect(f.service.detail('task').thread.messages[0].id).toBe('prompt');
  expect(f.service.shell().threads[0].session.status).toBe('running');
  const emit = f.runs[0].emit;
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'answer' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Live' } } });
  emit({ type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: 'Live answer' }, { type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: '/fixture' } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'file content' }] } });
  emit({ type: 'result', is_error: false }); await flush();
  const t = f.service.detail('task').thread;
  expect(t.messages).toHaveLength(2); expect(t.messages[1].text).toBe('Live answer');
  expect(t.activities.find((a: any) => a.id === 'tool').payload.status).toBe('completed');
  expect(t.session.status).toBe('idle'); expect(t.latestTurn.state).toBe('completed');
  await f.service.close();
});

test('deduplicates send retries across restart and resumes the exact native UUID', async () => {
  const f = fixture(); await f.setup(); await f.send(); await f.send(); expect(f.runs).toHaveLength(1);
  const nativeId = f.runs[0].input.options.sessionId;
  f.runs[0].emit({ type: 'result', is_error: false }); await flush(); await f.service.close();
  const restored = new ManagedClaudeCode(f.root, f.fake);
  await restored.dispatch({ type: 'thread.turn.start', commandId: 'send', threadId: 'task', message: { text: 'Duplicate' } }, 'phone');
  expect(f.runs).toHaveLength(1);
  await restored.dispatch({ type: 'thread.turn.start', commandId: 'followup', threadId: 'task', message: { text: 'Continue' } }, 'phone');
  expect(f.runs[1].input.options.resume).toBe(nativeId);
  await restored.close();
});

test('only a matching pending request can approve a tool and interruption resolves it', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const controller = new AbortController();
  const result = f.runs[0].input.options.canUseTool('Write', { file_path: '/fixture', content: 'test' }, { signal: controller.signal });
  const request = f.service.detail('task').thread.activities.at(-1).payload.requestId;
  expect(f.service.shell().threads[0].hasPendingApprovals).toBe(true);
  await expect(f.dispatch({ type: 'thread.approval.respond', threadId: 'task', requestId: 'stale', decision: 'accept' })).rejects.toThrow('expired');
  await f.dispatch({ type: 'thread.approval.respond', threadId: 'task', requestId: request, decision: 'decline' });
  expect((await result).behavior).toBe('deny');
  expect(f.service.shell().threads[0].hasPendingApprovals).toBe(false);
  await f.dispatch({ type: 'thread.turn.interrupt', threadId: 'task' }); await flush();
  expect(f.service.detail('task').thread.latestTurn.state).toBe('interrupted');
  await f.service.close();
});

test('concurrent different send IDs cannot start two writers for the same session', async () => {
  const f = fixture(); await f.setup();
  const results = await Promise.allSettled([f.send('one'), f.send('two')]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.runs).toHaveLength(1); await f.service.close();
});

test('a resumed background notification does not complete the new user prompt', async () => {
  const f = fixture(); await f.setup(); await f.send();
  f.runs[0].emit({ type: 'result', is_error: false, origin: { kind: 'task-notification' } });
  await flush();
  expect(f.service.detail('task').thread.session.status).toBe('running');
  f.runs[0].emit({ type: 'assistant', message: { id: 'real-answer', content: [{ type: 'text', text: 'The new answer' }] } });
  f.runs[0].emit({ type: 'result', is_error: false, origin: { kind: 'human' } });
  await flush();
  expect(f.service.detail('task').thread.messages.at(-1).text).toBe('The new answer');
  expect(f.service.detail('task').thread.session.status).toBe('idle');
  await f.service.close();
});

test('keeps background tools alive until their completion and still permits stopping', async () => {
  const f = fixture(); await f.setup(); await f.send();
  f.runs[0].emit({ type: 'system', subtype: 'task_started', task_id: 'background', description: 'Background work' });
  f.runs[0].emit({ type: 'result', is_error: false }); await flush();
  expect(f.service.detail('task').thread.session.status).toBe('running');
  f.runs[0].emit({ type: 'system', subtype: 'task_notification', task_id: 'background', status: 'completed', summary: 'Done' });
  await flush();
  expect(f.service.detail('task').thread.session.status).toBe('idle');
  await f.send('next');
  f.runs[1].emit({ type: 'system', subtype: 'task_started', task_id: 'another', description: 'More background work' });
  f.runs[1].emit({ type: 'result', is_error: false }); await flush();
  await f.dispatch({ type: 'thread.turn.interrupt', threadId: 'task' }); await flush();
  expect(f.service.detail('task').thread.latestTurn.state).toBe('interrupted');
  await f.service.close();
});

test('Stop cancels detached tools even when control replies produce no transcript events, then resumes the paused queue', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const run = f.runs[0];
  const stopped: string[] = [];
  run.q.interrupt = async () => undefined;
  run.q.stopTask = async (id: string) => { stopped.push(id); };
  run.emit({ type: 'system', subtype: 'task_started', task_id: 'owned-background' });
  run.emit({ type: 'result', is_error: false }); await flush();
  await f.dispatch(followUp('after-stop'));
  expect(f.service.detail('task').thread.session.status).toBe('running');
  await f.dispatch({ type: 'thread.turn.interrupt', threadId: 'task' });
  expect(stopped).toEqual(['owned-background']);
  expect(f.service.detail('task').thread.session.status).toBe('idle');
  expect(f.service.detail('task').thread.latestTurn.state).toBe('interrupted');
  await f.dispatch({ type: 'thread.turn.queue.steer', threadId: 'task', messageId: 'after-stop' });
  expect(f.service.detail('task').thread.session.status).toBe('running');
  expect(f.runs).toHaveLength(1);
  const promptUuid = (f.service as any).requireThread('task').activePromptUuid;
  run.emit({ type: 'user', uuid: 'stop-notice', message: { content: '<task-notification>\n<task-id>owned-background</task-id>\n<tool-use-id>bg-tool</tool-use-id>\n<status>killed</status>\n<summary>Task was stopped by the user</summary>\n</task-notification>' } });
  run.emit({ type: 'assistant', message: { id: 'after-stop-answer', content: [{ type: 'text', text: 'AFTER_STOP_OK' }] } });
  run.emit({ type: 'result', is_error: false, user_message_uuid: promptUuid }); await flush();
  expect(f.service.detail('task').thread.messages.some((m: any) => m.id === 'stop-notice')).toBe(false);
  expect(f.service.detail('task').thread.session.status).toBe('idle');
  await f.service.close();
});

test('remembered approvals stay in this managed session, not Claude settings', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const suggestions = [{ type: 'addRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'git status' }] }];
  const permission = f.runs[0].input.options.canUseTool('Bash', { command: 'git status' }, { signal: new AbortController().signal, suggestions });
  const requestId = f.service.detail('task').thread.activities.at(-1).payload.requestId;
  await f.dispatch({ type: 'thread.approval.respond', threadId: 'task', requestId, decision: 'acceptForSession' });
  expect((await permission).updatedPermissions[0].destination).toBe('session');
  f.runs[0].emit({ type: 'result', is_error: false }); await flush(); await f.service.close();
  const restored = new ManagedClaudeCode(f.root, f.fake);
  await restored.dispatch({ type: 'thread.turn.start', commandId: 'resume-with-permission', threadId: 'task', message: { text: 'Continue' } }, 'phone');
  expect(f.runs[1].input.options.settings.permissions.allow).toEqual(['Bash(git status)']);
  await restored.close();
});

test('completed work keeps its duration when another turn starts and after reopening', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const stored = (f.service as any).threads.get('task');
  stored.thread.latestTurn.startedAt = new Date(Date.now() - 33_000).toISOString();
  f.runs[0].emit({ type: 'assistant', message: { id: 'tool-message', content: [{ type: 'tool_use', id: 'read-duration', name: 'Read', input: { file_path: 'notes.txt' } }] } });
  f.runs[0].emit({ type: 'result', is_error: false }); await flush();
  const turn = f.service.detail('task').thread.latestTurn;
  const expected = Date.parse(turn.completedAt) - Date.parse(turn.startedAt);
  expect(expected).toBeGreaterThanOrEqual(33_000);
  await f.send('duration-followup');
  expect(f.service.detail('task').thread.activities.find((a: any) => a.id === 'read-duration').payload.turnDurationMs).toBe(expected);
  await f.service.close();
  const reopened = new ManagedClaudeCode(f.root, f.fake);
  expect(reopened.detail('task').thread.activities.find((a: any) => a.id === 'read-duration').payload.turnDurationMs).toBe(expected);
  await reopened.close();
});

test('text-only replies retain the completion time after status activities move to the next turn', async () => {
  const f = fixture(); await f.setup(); await f.send();
  f.runs[0].emit({ type: 'assistant', message: { id: 'text-duration', content: [{ type: 'text', text: 'Done' }] } });
  await flush();
  const stored = (f.service as any).requireThread('task');
  stored.thread.messages.find((m: any) => m.id === 'text-duration').updatedAt = '2026-01-01T00:00:00.000Z';
  f.runs[0].emit({ type: 'result', is_error: false }); await flush();
  const completed = f.service.detail('task').thread.latestTurn.completedAt;
  await f.send('next-text-turn');
  expect(f.service.detail('task').thread.messages.find((m: any) => m.id === 'text-duration').updatedAt).toBe(completed);
  await f.service.close();
});

test('cancel turn interrupts instead of merely declining a tool', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const permission = f.runs[0].input.options.canUseTool('Write', {}, { signal: new AbortController().signal });
  const requestId = f.service.detail('task').thread.activities.at(-1).payload.requestId;
  await f.dispatch({ type: 'thread.approval.respond', threadId: 'task', requestId, decision: 'cancel' });
  expect((await permission).behavior).toBe('deny'); await flush();
  expect(f.service.detail('task').thread.latestTurn.state).toBe('interrupted');
  await f.service.close();
});

test('Desktop sync keeps one worker idle and forwards remote prompts without duplicate echoes', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const run = f.runs[0]; const local = (await run.input.prompt[Symbol.asyncIterator]().next()).value;
  run.emit({ ...local, isReplay: true }); run.emit({ type: 'result', is_error: false }); await flush();
  expect((await f.service.status()).activeSessions).toBe(0);
  expect((await f.service.status()).connectedSessions).toBe(1);
  run.emit({ type: 'command_lifecycle', state: 'started', command_uuid: 'remote' });
  run.emit({ type: 'user', uuid: 'remote', isReplay: true, message: { content: 'Desktop prompt' } });
  run.emit({ type: 'user', uuid: 'remote', isReplay: true, message: { content: 'Desktop prompt' } }); await flush();
  const t = f.service.detail('task').thread;
  expect(t.messages.filter((m: any) => m.role === 'user').map((m: any) => m.text)).toEqual(['Test prompt', 'Desktop prompt']);
  expect(t.session.status).toBe('running');
  run.emit({ type: 'result', is_error: false }); await flush(); await f.send('second');
  expect(f.runs).toHaveLength(1); expect(f.remoteCalls).toHaveLength(1);
  await f.service.close();
});

test('restores the same Desktop identity after restart without resending a prompt', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  f.runs[0].emit({ type: 'system', subtype: 'init' }); f.runs[0].emit({ type: 'result', is_error: false }); await flush(); await f.service.close();
  const restored = new ManagedClaudeCode(f.root, f.fake); await restored.status(); await flush();
  expect(f.runs).toHaveLength(2);
  expect(f.runs[1].input.options.resume).toBe(f.runs[0].input.options.sessionId);
  expect(f.remoteCalls[1].options).toEqual({ reattachSessionId: 'cse_fixture', keepSessionOnExit: true });
  const result = await Promise.race([f.runs[1].input.prompt[Symbol.asyncIterator]().next().then(() => 'replayed'), Bun.sleep(30).then(() => 'idle')]);
  expect(result).toBe('idle'); await restored.close();
});

test('Desktop approval cancellation removes the Android request and rejects late responses', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const abort = new AbortController();
  const decision = f.runs[0].input.options.canUseTool('Write', { file_path: '/fixture' }, { signal: abort.signal });
  const id = f.service.detail('task').thread.activities.findLast((a: any) => a.kind === 'approval.requested').payload.requestId;
  abort.abort(); await decision;
  expect(f.service.detail('task').thread.hasPendingApprovals).toBe(false);
  await expect(f.dispatch({ type: 'thread.approval.respond', threadId: 'task', requestId: id, decision: 'accept' })).rejects.toThrow('expired');
  expect(f.service.detail('task').thread.session.status).toBe('running'); await f.service.close();
});

test('Desktop interruption is stopped rather than failed and synthetic text is not a prompt', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  f.runs[0].emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'cancelled-tool', name: 'Bash', input: { command: 'test-command' } }] } });
  f.runs[0].emit({ type: 'user', uuid: 'interrupted', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  f.runs[0].emit({ type: 'result', is_error: true, terminal_reason: 'aborted_streaming' }); await flush();
  expect(f.service.detail('task').thread.messages).toHaveLength(1);
  expect(f.service.detail('task').thread.latestTurn.state).toBe('interrupted');
  expect(f.service.detail('task').thread.session.lastError).toBeNull();
  expect(f.service.detail('task').thread.activities.find((a: any) => a.id === 'cancelled-tool').payload.status).toBe('stopped');
  await f.send('after-stop'); expect(f.runs).toHaveLength(1);
  expect(f.service.detail('task').thread.session.status).toBe('running'); await f.service.close();
});

test('changing sync while running is refused and disabling idle sync closes only owned workers', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  await expect(f.service.configure({ desktopSync: false })).rejects.toThrow('Finish');
  f.runs[0].emit({ type: 'result', is_error: false }); await flush();
  await f.service.configure({ desktopSync: false }); expect((await f.service.status()).connectedSessions).toBe(0);
  await f.service.close();
});

test('a crashed worker does not silently retry an accepted prompt or stale approval', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const approval = f.runs[0].input.options.canUseTool('Write', {}, { signal: new AbortController().signal });
  f.runs[0].q.close(); await flush(); await approval;
  expect(f.service.detail('task').thread.latestTurn.state).toBe('interrupted');
  expect(f.service.detail('task').thread.hasPendingApprovals).toBe(false);
  await f.send(); expect(f.runs).toHaveLength(1); await f.service.close();
});

test('retains successful structured patches across reload and never records denied writes as changes', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const emit = f.runs[0].emit;
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'write-ok', name: 'Write', input: { file_path: '/work/new.txt', content: 'one\n' } }] } });
  emit({ type: 'user', tool_use_result: { type: 'create', filePath: '/work/new.txt', content: 'one\n', structuredPatch: [] }, message: { content: [{ type: 'tool_result', tool_use_id: 'write-ok', content: [{ type: 'text', text: 'Created file' }] }] } });
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'write-no', name: 'Write', input: { file_path: '/work/denied.txt', content: 'bad' } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write-no', is_error: true, content: "The user doesn't want to proceed with this tool use." }] } });
  await flush();
  const activities = f.service.detail('task').thread.activities;
  expect(activities.find((a: any) => a.id === 'write-ok').payload).toMatchObject({ itemType: 'file_change', detail: 'Created file', fileChanges: [{ path: '/work/new.txt', additions: 1, deletions: 0 }] });
  expect(activities.find((a: any) => a.id === 'write-no').payload).toMatchObject({ itemType: 'dynamic_tool_call', status: 'declined', detail: 'You declined this action.' });
  await f.service.close();
  const restored = new ManagedClaudeCode(f.root, f.fake);
  expect(restored.detail('task').thread.activities.find((a: any) => a.id === 'write-ok').payload.fileChanges[0].diff).toContain('+one');
  await restored.close();
});

test('a fifth idle-shared session parks the oldest worker and reopens with both original identities', async () => {
 const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true });
 for (let i = 0; i < 5; i++) {
   const threadId = i ? `task-${i}` : 'task';
   if (i) await f.dispatch({ type: 'thread.create', threadId, projectId: 'project' });
   await f.dispatch({ type: 'thread.turn.start', threadId, message: { text: 'Hi' } });
   f.runs.at(-1).emit({ type: 'result', is_error: false }); await flush();
 }
 expect((await f.service.status()).connectedSessions).toBe(4);
 expect(f.service.shell().threads).toHaveLength(5);
 expect(f.service.detail('task').thread.activities.find((a:any) => a.kind === 'claude.desktop-sync.updated').payload.status).toBe('parked');
 await f.service.prepareThread('task');
 expect(f.runs.at(-1).input.options.resume).toBe(f.runs[0].input.options.sessionId);
 expect(f.remoteCalls.at(-1).options.reattachSessionId).toBe('cse_fixture');
 expect(f.service.detail('task').thread.messages).toHaveLength(1);
 await f.service.close();
});

test('never parks running workers or creates an empty task when every slot is busy', async () => {
 const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true });
 for (let i = 0; i < 4; i++) {
   const threadId = i ? `task-${i}` : 'task'; if (i) await f.dispatch({ type: 'thread.create', threadId, projectId: 'project' });
   await f.dispatch({ type: 'thread.turn.start', threadId, message: { text: 'Hi' } });
 }
 await expect(f.dispatch({ type: 'thread.create', threadId: 'overflow', projectId: 'project' })).rejects.toThrow('running');
 expect(f.service.shell().threads).toHaveLength(4); expect((await f.service.status()).activeSessions).toBe(4);
 await f.service.close();
});

test('native history is discoverable but cannot mutate or launch an SDK writer', async () => {
 const f = fixture(); const service = new ManagedClaudeCode(f.root, f.fake, { list: async () => [{ sessionId: 'native', cwd: f.root, summary: 'Greeting', lastModified: 1000 }], messages: async () => [] });
 await service.configure({enabled:true,binary:process.execPath}); await service.refreshHistory();
 expect(service.shell().threads[0].title).toBe('Greeting');
 await service.readDetail('claude-history-native'); await service.prepareThread('claude-history-native');
 for (const type of ['thread.turn.start','thread.meta.update','thread.delete','thread.archive','thread.turn.interrupt']) await expect(service.dispatch({type,commandId:crypto.randomUUID(),threadId:'claude-history-native'},'phone')).rejects.toThrow('read-only');
 expect(f.runs).toHaveLength(0); await service.close();
});


test('retries rejected links without forking, then explicitly replaces while preserving the Android chat', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  f.runs[0].emit({ type: 'system', subtype: 'init' }); f.runs[0].emit({ type: 'result', is_error: false }); await flush();
  const original = structuredClone(f.service.detail('task').thread);
  await f.dispatch({ type: 'thread.session.stop', threadId: 'task' }); f.rejectSync(true);
  await f.service.prepareThread('task');
  expect((await f.service.status()).connectedSessions).toBe(0);
  await expect(f.service.recoverDesktop('task', 'retry', 'retry-link', 'phone')).rejects.toThrow('403');
  expect(f.forks).toHaveLength(0);
  expect(f.runs.at(-1).input.options.resume).toBe(original.nativeSessionId);
  expect(f.service.detail('task').thread.messages).toEqual(original.messages);
  await expect(f.service.recoverDesktop('task', 'replace', 'replace-link', 'phone')).rejects.toThrow('403');
  expect((await f.service.status()).connectedSessions).toBe(0);
  f.rejectSync(false);
  await f.service.recoverDesktop('task', 'replace', 'retry-copied-link', 'phone');
  expect(f.forks).toHaveLength(1);
  expect(f.forks[0].id).toBe(original.nativeSessionId);
  expect(f.runs.at(-1).input.options.resume).toBe('11111111-2222-4333-8444-555555555555');
  expect(f.remoteCalls.at(-1).options.reattachSessionId).toBeUndefined();
  expect(f.service.detail('task').thread.messages).toEqual(original.messages);
  expect((await f.service.status()).connectedSessions).toBe(1);
  await f.service.recoverDesktop('task', 'replace', 'replace-link', 'phone');
  expect(f.forks).toHaveLength(1);
  expect(readdirSync(join(f.root, 'sessions'))).toHaveLength(1);
  await f.service.close();
  const restored = new ManagedClaudeCode(f.root, f.fake);
  expect(restored.detail('task').thread.nativeSessionId).toBe('11111111-2222-4333-8444-555555555555');
  expect(restored.detail('task').thread.messages).toEqual(original.messages);
  await restored.close();
});

test('link repair never forks a running task or mutates saved history if the SDK fork fails', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); f.rejectSync(true); await f.send();
  f.runs[0].emit({ type: 'system', subtype: 'init' }); await flush();
  await expect(f.service.recoverDesktop('task', 'replace', 'busy', 'phone')).rejects.toThrow('Finish or stop');
  expect(f.forks).toHaveLength(0);
  f.runs[0].emit({ type: 'result', is_error: false }); await flush();
  // A linked identity is required to fork; simulate an older previously shared saved task.
  const stored = (f.service as any).threads.get('task'); stored.bridgeId = 'old-link';
  const original = stored.nativeId; f.failFork();
  await expect(f.service.recoverDesktop('task', 'replace', 'failed', 'phone')).rejects.toThrow('Fork failed');
  expect(stored.nativeId).toBe(original); expect(stored.bridgeId).toBe('old-link');
  await f.service.close();
});

test('offers session approval only when Claude supplies a nonempty reusable allow rule', async () => {
  const f = fixture(); await f.setup(); await f.send();
  for (const suggestions of [undefined, [], [{ type: 'addRules', behavior: 'allow', rules: [] }], [{ type: 'setMode', mode: 'bypassPermissions' }]]) {
    const permission = f.runs[0].input.options.canUseTool('Write', {}, { signal: new AbortController().signal, suggestions });
    const payload = f.service.detail('task').thread.activities.at(-1).payload;
    expect(payload.canApproveForSession).toBe(false);
    await expect(f.dispatch({ type: 'thread.approval.respond', threadId: 'task', requestId: payload.requestId, decision: 'acceptForSession' })).rejects.toThrow('reusable permission');
    await f.dispatch({ type: 'thread.approval.respond', threadId: 'task', requestId: payload.requestId, decision: 'accept' });
    expect((await permission).behavior).toBe('allow');
  }
  await f.service.close();
});

test('capabilities belong to the live worker and never launch a session or read another workspace', async () => {
  const f = fixture(); await f.setup();
  expect((await f.service.capabilities('task')).status).toBe('unavailable');
  expect(f.runs).toHaveLength(0);
  await f.send();
  const run = f.runs[0];
  run.q.supportedCommands = async () => [{ name: 'sample:review', description: 'Review changes' }];
  run.q.mcpServerStatus = async () => [{ name: 'sample', status: 'connected', config: { headers: { Authorization: 'never-forward' } }, tools: [{ name: 'lookup' }] }];
  run.emit({ type: 'system', subtype: 'init', skills: ['sample:review'], plugins: [{ name: 'sample', path: '/private/plugin' }] });
  await flush();
  const catalog = await f.service.capabilities('task');
  expect(catalog.skills[0].name).toBe('sample:review');
  expect(catalog.mcpServers[0].tools).toEqual(['lookup']);
  expect(JSON.stringify(catalog)).not.toContain('never-forward');
  expect(JSON.stringify(catalog)).not.toContain('/private');
  expect((await f.service.capabilities('other')).skills).toEqual([]);
  await f.service.close();
  expect((await f.service.capabilities('task')).status).toBe('unavailable');
});


test('renaming and changing idle settings retain the shared worker and session identity', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const run = f.runs[0]; run.emit({ type: 'system', subtype: 'init' });
  run.emit({ type: 'result', is_error: false }); await flush();
  const original = f.service.detail('task').thread.nativeSessionId;
  const controls: any[] = [];
  run.q.applyFlagSettings = async (v: any) => { controls.push(v); };
  run.q.setPermissionMode = async (v: any) => { controls.push(v); };
  await f.dispatch({ type: 'thread.meta.update', threadId: 'task', title: 'Renamed Claude chat' });
  expect((await f.service.status()).connectedSessions).toBe(1);
  expect(controls).toEqual([]);
  await f.dispatch({ type: 'thread.meta.update', threadId: 'task', modelSelection: { instanceId: 'claude-code', model: 'sonnet', options: [{ id: 'effort', value: 'low' }] }, runtimeMode: 'auto-accept-edits', interactionMode: 'plan' });
  expect(controls).toEqual([{ effortLevel: 'low' }, 'plan']);
  await f.dispatch({ type: 'thread.meta.update', threadId: 'task', modelSelection: { instanceId: 'claude-code', model: 'sonnet' }, interactionMode: 'default' });
  expect(controls.slice(-2)).toEqual([{ effortLevel: null }, 'acceptEdits']);
  await f.send('follow-up');
  expect(f.runs).toHaveLength(1);
  expect(f.remoteCalls.filter(c => c.enabled)).toHaveLength(1);
  expect(f.service.detail('task').thread).toMatchObject({ title: 'Renamed Claude chat', nativeSessionId: original, session: { status: 'running', runtimeMode: 'auto-accept-edits', interactionMode: 'default' } });
  await f.service.close();
});

test('invalid or failed settings leave sharing connected and do not claim unapplied changes', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const run = f.runs[0]; run.emit({ type: 'system', subtype: 'init' }); run.emit({ type: 'result', is_error: false }); await flush();
  const original = f.service.detail('task').thread;
  await expect(f.dispatch({ type: 'thread.meta.update', threadId: 'task', title: 'Should not change', modelSelection: { instanceId: 'claude-code', model: 'unknown' } })).rejects.toThrow('available model');
  expect(f.service.detail('task').thread.title).toBe(original.title);
  run.q.setPermissionMode = async () => { throw new Error('Access mode rejected'); };
  await expect(f.dispatch({ type: 'thread.runtime-mode.set', threadId: 'task', runtimeMode: 'full-access' })).rejects.toThrow('Access mode rejected');
  expect(f.service.detail('task').thread.runtimeMode).toBe('approval-required');
  expect(f.service.detail('task').thread.session.runtimeMode).toBe('approval-required');
  expect((await f.service.status()).connectedSessions).toBe(1);
  expect(f.runs).toHaveLength(1);
  await f.service.close();
});

test('compaction updates one live activity and clears it on completion or Stop', async () => {
  const f = fixture(); await f.setup(); await f.send(); const emit = f.runs[0].emit;
  emit({ type: 'system', subtype: 'status', status: 'compacting' });
  emit({ type: 'system', subtype: 'status', status: 'compacting' }); await flush();
  const live = f.service.detail('task').thread.activities.filter((a: any) => a.kind === 'context-compaction');
  expect(live).toHaveLength(1); expect(live[0].payload.status).toBe('inProgress');
  emit({ type: 'system', subtype: 'compact_boundary', uuid: 'compact-one', compact_metadata: { trigger: 'auto', pre_tokens: 100000 } }); await flush();
  const completed = f.service.detail('task').thread.activities.filter((a: any) => a.kind === 'context-compaction');
  expect(completed).toHaveLength(1); expect(completed[0].id).toBe(live[0].id);
  expect(completed[0].payload.status).toBe('completed');
  emit({ type: 'result', is_error: false }); await flush(); await f.send('next');
  f.runs.at(-1).emit({ type: 'system', subtype: 'status', status: 'compacting' }); await flush();
  await f.dispatch({ type: 'thread.turn.interrupt', threadId: 'task' }); await flush();
  const activities = f.service.detail('task').thread.activities.filter((a: any) => a.kind === 'context-compaction');
  expect(activities).toHaveLength(2);
  expect(activities.at(-1)).toMatchObject({ summary: 'Context compaction stopped', payload: { status: 'stopped' } });
  expect(activities.some((a: any) => a.payload.status === 'inProgress')).toBe(false);
  await f.service.close();
});


test('subscription warnings update in place without stopping or resending a paid turn', async () => {
  const f = fixture(); await f.setup(); await f.send(); const emit = f.runs[0].emit;
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } }); await flush();
  expect(f.service.detail('task').thread.activities.filter((a: any) => a.kind === 'claude.rate-limit.updated')).toHaveLength(0);
  for (const status of ['allowed_warning', 'rejected', 'allowed']) {
    emit({ type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: 'five_hour', resetsAt: 1900000000, privateField: 'never-forward' } }); await flush();
    const t = f.service.detail('task').thread;
    const warnings = t.activities.filter((a: any) => a.kind === 'claude.rate-limit.updated');
    expect(warnings).toHaveLength(1); expect(warnings[0].payload.rateLimitStatus).toBe(status);
    expect(JSON.stringify(warnings)).not.toContain('never-forward');
    expect(t.session.status).toBe('running'); expect(t.messages.filter((m: any) => m.role === 'user')).toHaveLength(1);
  }
  expect(f.runs).toHaveLength(1); await f.service.close();
});


test('SDK control output does not create a phantom prompt or leave an idle session running', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const emit = f.runs[0].emit; emit({ type: 'result', is_error: false }); await flush();
  const before = f.service.detail('task').thread;
  for (const value of [
    { text: '<local-command-stdout>Set model to haiku</local-command-stdout>' },
    { text: '<local-command-stderr>Unknown command</local-command-stderr>' },
    { text: 'Control metadata', isSynthetic: true },
    { text: 'Session context', isMeta: true },
    { text: 'Context without a turn', shouldQuery: false },
  ]) emit({ type: 'user', uuid: crypto.randomUUID(), ...value, message: { content: value.text } });
  await flush();
  const after = f.service.detail('task').thread;
  expect(after.messages).toEqual(before.messages);
  expect(after.latestTurn).toEqual(before.latestTurn);
  expect(after.session.status).toBe('idle');
  emit({ type: 'user', uuid: 'real-desktop-user', message: { content: 'A real Desktop follow-up' } }); await flush();
  expect(f.service.detail('task').thread.session.status).toBe('running');
  expect(f.service.detail('task').thread.messages.at(-1).text).toBe('A real Desktop follow-up');
  await f.service.close();
});


test('explicit Full access reopens only an idle worker when Claude requires launch consent', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const run = f.runs[0]; run.emit({ type: 'system', subtype: 'init' }); run.emit({ type: 'result', is_error: false }); await flush();
  const nativeId = f.service.detail('task').thread.nativeSessionId;
  expect(run.input.options.permissionMode).toBe('default');
  expect(run.input.options.allowDangerouslySkipPermissions).toBe(false);
  run.q.setPermissionMode = async () => { throw Object.assign(new Error('Launch consent required'), { errorCode: 'bypass_not_launched' }); };
  await f.dispatch({ type: 'thread.runtime-mode.set', threadId: 'task', runtimeMode: 'full-access' });
  expect(f.runs).toHaveLength(2);
  expect(f.runs[1].input.options.permissionMode).toBe('bypassPermissions');
  expect(f.runs[1].input.options.allowDangerouslySkipPermissions).toBe(true);
  expect(f.runs[1].input.options.resume).toBe(nativeId);
  expect(f.remoteCalls.at(-1).options.reattachSessionId).toBe('cse_fixture');
  expect((await f.service.status()).connectedSessions).toBe(1);
  expect(f.service.detail('task').thread.session.status).toBe('idle');
  expect(f.service.detail('task').thread.messages).toHaveLength(1);
  await f.service.close();
});


test('automatic connection off preserves a running shared chat and enabling it never interrupts an unshared task', async () => {
  const f = fixture(); await f.setup(); await f.send();
  await expect(f.service.setAutoConnect({ enabled: true })).rejects.toThrow('Finish Claude tasks');
  expect(f.service.syncSettings().autoConnect.preference).toBeNull();
  f.runs[0].emit({ type: 'result', is_error: false }); await flush();
  await f.service.setAutoConnect({ enabled: true });
  await f.send('shared-send');
  const worker = f.runs.at(-1);
  await f.service.setAutoConnect({ enabled: false });
  expect(f.service.detail('task').thread.session.status).toBe('running');
  expect(f.service.syncSettings()).toMatchObject({ enabled: true, desktopSync: true, autoConnect: { preference: false } });
  expect(f.runs.at(-1)).toBe(worker);
  worker.emit({ type: 'assistant', message: { id: 'still-working', content: [{ type: 'text', text: 'Still connected' }] } });
  await flush();
  expect(f.service.detail('task').thread.messages.at(-1).text).toBe('Still connected');
  worker.emit({ type: 'result', is_error: false }); await flush();
  await f.service.close();
});

const followUp = (id: string, deliveryMode = 'queue') => ({ type: 'thread.turn.start', threadId: 'task', deliveryMode, message: { messageId: id, text: `Prompt ${id}`, attachments: [] } });

test('Claude queue is editable, reorderable, cancellable and drains once in FIFO order', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const run = f.runs[0], input = run.input.prompt[Symbol.asyncIterator]();
  await input.next();
  const queued = { ...followUp('one'), commandId: 'queue-once' };
  await f.dispatch(queued); await f.dispatch(queued);
  await f.dispatch(followUp('two')); await f.dispatch(followUp('three'));
  await f.dispatch({ type: 'thread.turn.queue.update', threadId: 'task', messageId: 'two', text: 'Edited second prompt' });
  await f.dispatch({ type: 'thread.turn.queue.move', threadId: 'task', messageId: 'two', direction: 'up' });
  await f.dispatch({ type: 'thread.turn.queue.cancel', threadId: 'task', messageId: 'three' });
  let queuedRows = f.service.detail('task').thread.messages.filter((m: any) => m.phase === 'queued');
  expect(queuedRows.map((m: any) => m.id)).toEqual(['two', 'one']);
  expect(queuedRows[0]).toMatchObject({ text: 'Edited second prompt', queuePosition: 0 });
  expect(f.runs.length).toBe(1);
  run.emit({ type: 'result', is_error: false }); await flush();
  expect((await input.next()).value.message.content[0].text).toBe('Edited second prompt');
  expect(f.service.detail('task').thread.session.status).toBe('running');
  run.emit({ type: 'result', is_error: false }); await flush();
  expect((await input.next()).value.message.content[0].text).toBe('Prompt one');
  run.emit({ type: 'result', is_error: false }); await flush();
  expect(f.service.detail('task').thread.messages.filter((m: any) => m.phase === 'queued')).toHaveLength(0);
  expect(f.service.detail('task').thread.messages.filter((m: any) => m.id === 'one')).toHaveLength(1);
  await f.service.close();
});

test('Claude steer uses native priority and old results cannot finish the steered turn or drain its queue', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const run = f.runs[0], input = run.input.prompt[Symbol.asyncIterator](); const initial = (await input.next()).value;
  await f.dispatch(followUp('later'));
  await f.dispatch(followUp('redirect', 'steer'));
  const steer = (await input.next()).value;
  expect(steer).toMatchObject({ priority: 'now', session_id: initial.session_id });
  run.emit({ type: 'result', user_message_uuid: initial.uuid, is_error: false }); await flush();
  expect(f.service.detail('task').thread.session.status).toBe('running');
  run.emit({ type: 'command_lifecycle', state: 'started', command_uuid: steer.uuid });
  run.emit({ type: 'result', user_message_uuid: initial.uuid, is_error: false }); await flush();
  expect(f.service.detail('task').thread.session.status).toBe('running');
  expect(f.service.detail('task').thread.activities.find((a: any) => a.id === `steer-${steer.uuid}`).payload.status).toBe('completed');
  run.emit({ type: 'result', user_message_uuids: [steer.uuid], is_error: false });
  // Windows ACL writes can delay the queue timer beyond a single 20ms tick.
  const deadline = Date.now() + 5000;
  while (f.runs.length < 2 && Date.now() < deadline) await flush();
  expect(f.runs).toHaveLength(2); // A non-shared worker resumes for queued work only after completion.
  expect((await f.runs[1].input.prompt[Symbol.asyncIterator]().next()).value.message.content[0].text).toBe('Prompt later');
  await f.service.close();
});

test('Stop pauses Claude queued work and an explicit queue steer resumes it', async () => {
  const f = fixture(); await f.setup(); await f.send(); await f.dispatch(followUp('later'));
  await f.dispatch({ type: 'thread.turn.interrupt', threadId: 'task' }); await flush();
  expect(f.runs).toHaveLength(1);
  expect(f.service.detail('task').thread.messages.find((m: any) => m.id === 'later').phase).toBe('queued');
  await f.dispatch({ type: 'thread.turn.queue.steer', threadId: 'task', messageId: 'later' });
  expect(f.runs).toHaveLength(2);
  expect(f.service.detail('task').thread.messages.filter((m: any) => m.id === 'later')).toHaveLength(1);
  await f.service.close();
});

test('Claude Stop cancels only unread Remodex steers and restores them to the paused queue', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const run = f.runs[0], input = run.input.prompt[Symbol.asyncIterator](); await input.next();
  await f.dispatch(followUp('unread', 'steer')); const offered = (await input.next()).value;
  const cancelled: string[] = [];
  run.q.cancelAsyncMessage = async (uuid: string) => { cancelled.push(uuid); return true; };
  await f.dispatch({ type: 'thread.turn.interrupt', threadId: 'task' }); await flush();
  expect(cancelled).toEqual([offered.uuid]);
  expect(f.service.detail('task').thread.messages.find((m: any) => m.id === 'unread').phase).toBe('queued');
  expect(f.runs).toHaveLength(1);
  await f.service.close();
});

test('Claude queue survives a bridge restart without automatic replay', async () => {
  const f = fixture(); await f.setup(); await f.send(); await f.dispatch(followUp('persisted')); await f.service.close();
  const restored = new ManagedClaudeCode(f.root, f.fake);
  expect(restored.detail('task').thread.messages.find((m: any) => m.id === 'persisted').phase).toBe('queued');
  await flush(); expect(f.runs).toHaveLength(1);
  await restored.dispatch({ type: 'thread.turn.queue.cancel', commandId: 'cancel', threadId: 'task', messageId: 'persisted' }, 'phone');
  expect(restored.detail('task').thread.messages.some((m: any) => m.id === 'persisted')).toBe(false);
  await restored.close();
});

test('Claude errors pause queued work instead of starting the next paid task', async () => {
  const f = fixture(); await f.setup(); await f.send(); await f.dispatch(followUp('on-error'));
  f.runs[0].emit({ type: 'result', is_error: true, errors: ['fixture failure'] }); await flush();
  expect(f.runs).toHaveLength(1);
  expect(f.service.detail('task').thread.messages.find((m: any) => m.id === 'on-error').phase).toBe('queued');
  await f.service.close();
});

test('a late original result without an earlier acknowledgment does not rewind the active steer', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const run = f.runs[0], input = run.input.prompt[Symbol.asyncIterator](), original = (await input.next()).value;
  await f.dispatch(followUp('now', 'steer')); const steer = (await input.next()).value;
  run.emit({ type: 'command_lifecycle', state: 'started', command_uuid: steer.uuid });
  run.emit({ type: 'result', user_message_uuid: original.uuid, terminal_reason: 'aborted_streaming' }); await flush();
  expect(f.service.detail('task').thread.session.status).toBe('running');
  run.emit({ type: 'result', user_message_uuid: steer.uuid, terminal_reason: 'completed' }); await flush();
  expect(f.service.detail('task').thread.latestTurn.state).toBe('completed'); await f.service.close();
});

test('an unacknowledged steer stays visible and cannot replay on reconnect', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const run = f.runs[0], input = run.input.prompt[Symbol.asyncIterator](); await input.next();
  await f.dispatch(followUp('uncertain', 'steer')); await input.next();
  run.q.close(); await flush();
  expect(f.service.detail('task').thread.messages.find((m: any) => m.id === 'uncertain').phase).toBe('queued');
  await expect(f.dispatch({ type: 'thread.turn.queue.steer', threadId: 'task', messageId: 'uncertain' })).rejects.toThrow('could not be confirmed');
  expect(f.runs).toHaveLength(1); await f.service.close();
});

test('queued attachment bytes are staged on the PC and still send after a bridge restart', async () => {
  const f = fixture(); await f.setup(); await f.send();
  await f.dispatch({ ...followUp('attachment'), message: { messageId: 'attachment', text: '', attachments: [
    { type: 'file', name: 'queue-fixture.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,cXVldWUtZml4dHVyZQ==' },
  ] } });
  await f.service.close();
  const restored = new ManagedClaudeCode(f.root, f.fake);
  await restored.dispatch({ type: 'thread.turn.queue.steer', commandId: 'attachment-resume', threadId: 'task', messageId: 'attachment' }, 'phone');
  const sent = (await f.runs.at(-1).input.prompt[Symbol.asyncIterator]().next()).value;
  expect(sent.message.content[0].text).toContain('Attached files on this PC:');
  expect(sent.message.content[0].text).toContain('queue-fixture-');
  expect(restored.detail('task').thread.messages.find((m: any) => m.id === 'attachment').phase).not.toBe('queued');
  await restored.close();
});

test('verification failures survive cleanup and restart, while an acknowledged reconnect clears them', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  expect(f.service.syncSettings().connection).toMatchObject({ connectedSessions: 1, verificationRequiredSessions: 0, verificationIssue: null, desktopVerification: 'unconfirmed' });
  f.runs[0].emit({ type: 'system', subtype: 'bridge_state', state: 'failed', detail: 'session expired for trusted-device check' });
  await flush();
  expect(f.service.syncSettings().connection).toMatchObject({ connectedSessions: 0, verificationRequiredSessions: 1, verificationIssue: 'device-verification' });
  f.runs[0].emit({ type: 'system', subtype: 'bridge_state', state: 'connected' }); await flush();
  expect(f.service.syncSettings().connection).toMatchObject({ connectedSessions: 1, verificationRequiredSessions: 0, verificationIssue: null, desktopVerification: 'unconfirmed' });
  f.runs[0].emit({ type: 'system', subtype: 'bridge_state', state: 'failed', detail: 'Your organization requires Trusted Devices for Remote Control, but this device is not enrolled' }); await flush();
  await f.service.close();
  const restored = new ManagedClaudeCode(f.root, f.fake);
  expect(restored.syncSettings().connection).toMatchObject({ connectedSessions: 0, verificationRequiredSessions: 1, verificationIssue: 'device-verification', desktopVerification: 'unconfirmed' });
  expect(restored.detail('task').thread.activities.find((a: any) => a.kind === 'claude.desktop-sync.updated').payload).toMatchObject({ verificationIssue: 'device-verification', status: 'disconnected' });
  await restored.close();
});

test('account sign-in failures are visible before the first session exists', async () => {
  const f = fixture();
  const service = new ManagedClaudeCode(f.root, (() => ({ supportedModels: async () => [], accountInfo: async () => { throw new Error('Sign in to Claude Code on this PC'); }, close() {} })) as any);
  const status = await service.configure({ enabled: true, binary: process.execPath });
  expect(status.connection).toMatchObject({ verificationIssue: 'sign-in', verificationRequiredSessions: 0, connectedSessions: 0, desktopVerification: 'unconfirmed' });
  expect(service.syncSettings().connection.verificationIssue).toBe('sign-in');
  await service.close(); await f.service.close();
});


test('Claude public summaries and tool images survive replay without binary snapshot payloads', async () => {
  const f = fixture(); await f.setup(); await f.send();
  const emit = f.runs[0].emit;
  expect(f.runs[0].input.options.settings.showThinkingSummaries).toBe(true);
  expect(f.runs[0].input.options.extraArgs['thinking-display']).toBe('summarized');
  emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 20 });
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'answer', model: 'claude-sonnet-5-5' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking the page layout.' } } });
  emit({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 30 });
  emit({ type: 'assistant', message: { id: 'answer', model: 'claude-sonnet-5-5', content: [
    { type: 'thinking', thinking: 'Checking the page layout.', signature: 'NEVER_FORWARD_SIGNATURE' },
    { type: 'tool_use', id: 'screenshot', name: 'mcp__browser__take_screenshot', input: { format: 'png' } },
  ] } });
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'screenshot', content: [
    { type: 'text', text: 'RAW_OUTPUT_ONLY' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
  ] }] } });
  emit({ type: 'tool_use_summary', uuid: 'summary', summary: 'Checked the page screenshot.', preceding_tool_use_ids: ['screenshot'] });
  emit({ type: 'assistant', message: { id: 'replay', content: [
    { type: 'tool_use', id: 'screenshot', name: 'mcp__browser__take_screenshot', input: { format: 'png' } },
  ] } });
  emit({ type: 'result', is_error: false }); await flush();
  const activities = f.service.detail('task').thread.activities;
  expect(activities.filter((a: any) => a.kind === 'claude.thinking-summary')).toHaveLength(1);
  expect(activities.filter((a: any) => a.kind === 'claude.progress')).toHaveLength(0);
  expect(activities.find((a: any) => a.kind === 'claude.tool-summary').summary).toBe('Checked the page screenshot.');
  const paths = activities.find((a: any) => a.id === 'screenshot').payload.data.toolImages;
  expect(paths).toHaveLength(1);
  expect(await f.service.toolImagePath('task', paths[0])).toBe(paths[0]);
  await expect(f.service.toolImagePath('task', '/etc/passwd')).rejects.toThrow('not returned');
  await expect(f.service.toolImagePath('other-chat', paths[0])).rejects.toThrow();
  expect(JSON.stringify(activities)).not.toContain(image);
  expect(JSON.stringify(activities)).not.toContain('NEVER_FORWARD_SIGNATURE');
  await f.service.close();
  const restored = new ManagedClaudeCode(f.root, f.fake);
  expect(await restored.toolImagePath('task', paths[0])).toBe(paths[0]);
  await restored.close();
});

test('stopping during a Claude thinking summary ends its live indicator', async () => {
  const f = fixture(); await f.setup(); await f.send(); const emit = f.runs[0].emit;
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'summary-stop', model: 'claude-sonnet-5-5' } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking the layout.' } } });
  await flush();
  await f.dispatch({ type: 'thread.turn.interrupt', threadId: 'task' }); await flush();
  expect(f.service.detail('task').thread.activities.find((a: any) => a.kind === 'claude.thinking-summary').payload)
    .toMatchObject({ status: 'stopped', detail: 'Checking the layout.' });
  await f.service.close();
});

test('unknown and old Claude model thinking never becomes a display summary', async () => {
  const f = fixture(); await f.setup(); await f.send(); const emit = f.runs[0].emit;
  for (const model of [undefined, 'claude-3-7-sonnet', 'custom-model']) {
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'private', model } } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_RAW' } } });
    emit({ type: 'assistant', message: { id: 'private', model, content: [{ type: 'thinking', thinking: 'PRIVATE_RAW' }, { type: 'redacted_thinking', data: 'PRIVATE_ENCRYPTED' }] } });
  }
  await flush(); expect(JSON.stringify(f.service.detail('task'))).not.toMatch(/PRIVATE_RAW|PRIVATE_ENCRYPTED/);
  await f.service.close();
});

test('usage reads preserve active turns and never use cumulative result totals', async () => {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  const run = f.runs[0]; run.q.getContextUsage = async () => ({ totalTokens: 1234, rawMaxTokens: 200000 });
  const before = f.service.detail('task').thread, turn = before.latestTurn.turnId, messages = structuredClone(before.messages);
  await f.service.refreshUsage('task');
  const t = f.service.detail('task').thread;
  expect(t.latestTurn.turnId).toBe(turn); expect(t.session.status).toBe('running'); expect(t.messages).toEqual(messages); expect(f.runs).toHaveLength(1);
  expect(t.activities.find((a: any) => a.kind === 'context-window.updated').payload).toMatchObject({ providerName: 'claude-code', usedTokens: 1234, maxTokens: 200000, estimated: true });
  expect(t.activities.find((a: any) => a.kind === 'provider.usage.updated').payload).toMatchObject({ status: 'unavailable', windows: [] });
  run.emit({ type: 'result', is_error: false, modelUsage: { sonnet: { inputTokens: 900000, contextWindow: 200000 } } }); await flush();
  expect(t.activities.find((a: any) => a.kind === 'context-window.updated').payload.usedTokens).toBe(1234);
  await f.service.close();
});

const recoverAutomatically = (service: ManagedClaudeCode) => (service as any).syncRecovery.tick(Infinity);
async function connectedRecoveryFixture() {
  const f = fixture(); await f.setup(); await f.service.configure({ desktopSync: true }); await f.send();
  f.runs[0].emit({ type: 'system', subtype: 'init' });
  f.runs[0].emit({ type: 'assistant', uuid: 'answer', message: { content: [{ type: 'text', text: 'Original answer' }] } });
  f.runs[0].emit({ type: 'result', is_error: false }); await flush(); return f;
}

test('unexpected worker exit reconnects without opening the chat, changing IDs, history, or replaying prompts', async () => {
  const f = await connectedRecoveryFixture();
  const before = structuredClone(f.service.detail('task').thread);
  f.runs[0].q.close(); await flush();
  await Promise.all([recoverAutomatically(f.service), recoverAutomatically(f.service)]);
  expect(f.runs).toHaveLength(2); expect(f.forks).toHaveLength(0);
  expect(f.runs[1].input.options.resume).toBe(before.nativeSessionId);
  expect(f.remoteCalls.at(-1).options.reattachSessionId).toBe('cse_fixture');
  expect(f.service.detail('task').thread.messages).toEqual(before.messages);
  expect((f.service as any).desktopState((f.service as any).requireThread('task'))).toBe('connected');
  let replayed = false; const read = f.runs[1].input.prompt[Symbol.asyncIterator]().next().then(() => { replayed = true; });
  await flush(); expect(replayed).toBe(false); await f.service.close(); await read;
});

test('stale live sharing waits for a running turn, approval and background tools before recovering', async () => {
  const f = await connectedRecoveryFixture(); const t = f.service.detail('task').thread;
  f.runs[0].emit({ type: 'system', subtype: 'bridge_state', state: 'failed', detail: 'network timeout' }); await flush();
  t.session.status = 'running'; await recoverAutomatically(f.service); expect(f.runs).toHaveLength(1);
  t.session.status = 'idle'; t.hasPendingApprovals = true; await recoverAutomatically(f.service); expect(f.runs).toHaveLength(1);
  t.hasPendingApprovals = false; (f.service as any).active.get('task').backgroundTasks = 1;
  await recoverAutomatically(f.service); expect(f.runs).toHaveLength(1);
  (f.service as any).active.get('task').backgroundTasks = 0;
  await recoverAutomatically(f.service); expect(f.runs).toHaveLength(2); await f.service.close();
});

test('automatic retry never forks a rejected identity or retries verification and policy errors', async () => {
  for (const detail of ['HTTP 403', 'session expired for trusted-device check', 'Remote Control is disabled by policy.']) {
    const f = await connectedRecoveryFixture();
    f.runs[0].emit({ type: 'system', subtype: 'bridge_state', state: 'failed', detail }); await flush();
    f.runs[0].q.close(); await flush(); await recoverAutomatically(f.service);
    expect(f.runs).toHaveLength(1); expect(f.forks).toHaveLength(0); await f.service.close();
    const restored = new ManagedClaudeCode(f.root, f.fake);
    await (restored as any).restoreDesktop(); await recoverAutomatically(restored);
    expect(f.runs).toHaveLength(1); await restored.close();
  }
});

test('automatic restoration leaves paused and archived chats alone across a bridge restart', async () => {
  for (const type of ['thread.session.stop', 'thread.archive', 'thread.delete']) {
    const f = await connectedRecoveryFixture(); await f.dispatch({ type, threadId: 'task' });
    await recoverAutomatically(f.service); expect(f.runs).toHaveLength(1); await f.service.close();
    const restored = new ManagedClaudeCode(f.root, f.fake); await (restored as any).restoreDesktop(); await recoverAutomatically(restored);
    expect(f.runs).toHaveLength(1); await restored.close();
  }
});

test('recovery of an interrupted task retains uncertain steers and pauses the queue', async () => {
  const f = await connectedRecoveryFixture(); await f.send('second');
  await f.dispatch(followUp('uncertain-recovery', 'steer'));
  await f.dispatch(followUp('queued-recovery'));
  f.runs[0].q.close(); await flush();
  const before = structuredClone(f.service.detail('task').thread.messages);
  await recoverAutomatically(f.service);
  expect(f.runs).toHaveLength(2); expect(f.service.detail('task').thread.messages).toEqual(before);
  expect((f.service as any).requireThread('task').queuePaused).toContain('Queue paused');
  await flush(); expect(f.runs).toHaveLength(2); await f.service.close();
});

test('background recovery cannot evict other workers or unpark the fifth chat', async () => {
  const f = await connectedRecoveryFixture();
  for (let i = 1; i <= 4; i++) {
    await f.dispatch({ type: 'thread.create', threadId: `other-${i}`, projectId: 'project' });
    await f.dispatch({ type: 'thread.turn.start', threadId: `other-${i}`, message: { text: 'Hi' } });
    f.runs.at(-1).emit({ type: 'system', subtype: 'init' }); f.runs.at(-1).emit({ type: 'result', is_error: false }); await flush();
  }
  await recoverAutomatically(f.service); expect(f.runs).toHaveLength(5);
  const stored = (f.service as any).requireThread('task'); expect(stored.syncPaused).toBe(true);
  stored.syncPaused = false; (f.service as any).syncStatus(stored, 'disconnected', 'network timeout');
  await recoverAutomatically(f.service); expect(f.runs).toHaveLength(5);
  await f.service.close(); await recoverAutomatically(f.service); expect(f.runs).toHaveLength(5);
});

async function recoveryCapacityFixture() {
  const f = await connectedRecoveryFixture();
  for (let i = 1; i <= 3; i++) {
    await f.dispatch({ type: 'thread.create', threadId: `active-${i}`, projectId: 'project' });
    await f.dispatch({ type: 'thread.turn.start', threadId: `active-${i}`, message: { text: 'Hi' } });
    f.runs.at(-1).emit({ type: 'system', subtype: 'init' });
    f.runs.at(-1).emit({ type: 'result', is_error: false }); await flush();
  }
  // An older saved session is already waiting for capacity when the current
  // worker exits. Its retry is due before the new five-second recovery delay.
  await f.dispatch({ type: 'thread.create', threadId: 'waiting', projectId: 'project' });
  const stored = (f.service as any).requireThread('waiting');
  stored.resumed = true; stored.bridgeId = 'cse_waiting';
  (f.service as any).syncStatus(stored, 'disconnected', 'transport unavailable');
  f.runs[0].q.close(); await flush();
  return f;
}

test('an older capacity retry cannot steal the slot of a recently disconnected chat', async () => {
  const f = await recoveryCapacityFixture();
  const before = structuredClone(f.service.detail('task').thread.messages);
  const recover = (id: string) => (f.service as any).reconnectStaleSync(id);
  expect(await recover('waiting')).toBe('defer'); expect(f.runs).toHaveLength(4);
  expect(await recover('task')).toBe('connected'); expect(f.runs).toHaveLength(5);
  expect(f.runs[4].input.options.resume).toBe(f.service.detail('task').thread.nativeSessionId);
  expect(f.service.detail('task').thread.messages).toEqual(before);
  expect((f.service as any).active.size).toBe(4);
  for (let i = 1; i <= 3; i++) expect((f.service as any).active.get(`active-${i}`).query).toBe(f.runs[i].q);
  expect(await recover('waiting')).toBe('defer'); await f.service.close();
});

test('terminal refusal or an explicit pause releases the disconnected worker reservation', async () => {
  for (const action of ['refused', 'paused']) {
    const f = await recoveryCapacityFixture();
    if (action === 'refused') (f.service as any).syncStatus((f.service as any).requireThread('task'), 'disconnected', 'HTTP 403');
    else await f.dispatch({ type: 'thread.session.stop', threadId: 'task' });
    expect(await (f.service as any).reconnectStaleSync('waiting')).toBe('connected');
    expect(f.runs).toHaveLength(5); expect((f.service as any).active.has('task')).toBe(false);
    await f.service.close();
  }
});

test('multiple lost workers still recover when an explicit new chat consumes one reserved slot', async () => {
  const f = await recoveryCapacityFixture();
  f.runs[1].q.close(); await flush();
  // Explicitly opening another chat is allowed to use the free capacity.
  await f.service.prepareThread('waiting');
  expect((f.service as any).active.size).toBe(3);
  expect(await (f.service as any).reconnectStaleSync('task')).toBe('connected');
  expect((f.service as any).active.size).toBe(4);
  expect(await (f.service as any).reconnectStaleSync('active-1')).toBe('defer');
  expect((f.service as any).active.get('waiting').query).toBe(f.runs[4].q);
  expect(f.runs).toHaveLength(6); await f.service.close();
});

test('an intentional setup disconnect releases a stale live worker reservation', async () => {
  const f = await connectedRecoveryFixture();
  f.runs[0].emit({ type: 'system', subtype: 'bridge_state', state: 'failed', detail: 'transport unavailable' }); await flush();
  expect((f.service as any).recoverySlots.has('task')).toBe(true);
  await (f.service as any).disconnectIdle('task');
  expect((f.service as any).recoverySlots.has('task')).toBe(false);
  expect((f.service as any).syncRecovery.entries.has('task')).toBe(false);
  await f.service.close();
});

test('failed startup restoration retries in the background without opening or sending', async () => {
  const f = await connectedRecoveryFixture(); const before = structuredClone(f.service.detail('task').thread.messages); await f.service.close();
  let unavailable = true;
  const fake = ((input: any) => {
    const q = f.fake(input) as any, connect = q.enableRemoteControl.bind(q);
    q.enableRemoteControl = (...args: any[]) => unavailable ? Promise.reject(new Error('HTTP 503')) : connect(...args);
    return q;
  }) as typeof query;
  const restored = new ManagedClaudeCode(f.root, fake);
  await (restored as any).restoreDesktop();
  expect((restored as any).syncRecovery.entries.has('task')).toBe(true);
  unavailable = false; await recoverAutomatically(restored);
  expect((restored as any).desktopState((restored as any).requireThread('task'))).toBe('connected');
  expect(restored.detail('task').thread.messages).toEqual(before);
  expect(f.remoteCalls.at(-1).options.reattachSessionId).toBe('cse_fixture'); await restored.close();
});

test('an idle worker lost between a result and queue drain cannot release queued prompts during recovery', async () => {
  const f = await connectedRecoveryFixture(); await f.send('second');
  await f.dispatch(followUp('queued-at-disconnect'));
  // The previous result may have arrived just before the transport ends, before
  // the queued turn has been accepted. Recovery must not become a queue trigger.
  f.service.detail('task').thread.session.status = 'idle';
  f.runs[0].q.close(); await flush();
  expect((f.service as any).requireThread('task').queuePaused).toContain('disconnected');
  await recoverAutomatically(f.service); await flush();
  expect(f.service.detail('task').thread.messages.filter((m: any) => m.id === 'queued-at-disconnect')).toHaveLength(1);
  expect((f.service as any).requireThread('task').followUps[0].attempted).not.toBe(true);
  await f.service.close();
});


test('unsupported owned Claude dialogs cancel instead of parking forever or exposing their payload', async () => {
  const f = fixture(); await f.setup(); await f.send();
  try {
    const response = await f.runs[0].input.options.onUserDialog({ dialogKind: 'future-dialog', payload: { secret: 'private-dialog-payload' } }, { signal: new AbortController().signal, requestId: 'dialog' });
    expect(response).toEqual({ behavior: 'cancelled' });
    const t = f.service.detail('task').thread;
    expect(t.activities.at(-1).payload.detail).toContain('cannot display');
    expect(JSON.stringify(t)).not.toContain('private-dialog-payload');
    const count = t.activities.length;
    await f.runs[0].input.options.onUserDialog({ dialogKind: 'future-dialog', payload: {} }, { signal: AbortSignal.abort(), requestId: 'aborted' });
    expect(t.activities).toHaveLength(count);
    expect(t.session.status).toBe('running'); // Wait for real terminal evidence.
  } finally { await f.service.close(); }
});
