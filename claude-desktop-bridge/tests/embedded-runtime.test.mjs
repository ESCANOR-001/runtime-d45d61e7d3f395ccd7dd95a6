import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createEmbeddedAdapter, visibleMessages } from '../embedded/adapter.mjs';
import install from '../embedded/renderer.cjs';

const root = '00000000-0000-4000-8000-000000000000';
const id = '11111111-1111-4111-8111-111111111111';
const human = '22222222-2222-4222-8222-222222222222';
const answer = '33333333-3333-4333-8333-333333333333';
const models = [{ id: 'haiku', name: 'Claude Haiku' }, { id: 'sonnet', name: 'Claude Sonnet' }];
const conversation = () => ({ uuid: id, model: 'haiku', name: 'Test', current_leaf_message_uuid: answer,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', chat_messages: [
    { uuid: human, sender: 'human', parent_message_uuid: root, content: [{ type: 'text', text: 'Hello' }], created_at: '2026-01-01T00:00:00Z' },
    { uuid: answer, sender: 'assistant', parent_message_uuid: human, content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Hi' }], created_at: '2026-01-02T00:00:00Z' },
  ] });

test('direct transcripts use only the selected branch and preserve real timestamps', () => {
  const c = conversation();
  c.chat_messages.push({ uuid: 'other-branch', sender: 'assistant', parent_message_uuid: human, content: [{ type: 'text', text: 'Wrong branch' }] });
  const messages = visibleMessages(c);
  assert.deepEqual(messages.map(m => m.text), ['Hello', 'Hi']);
  assert.equal(messages[1].createdAt, c.updated_at);
  assert.doesNotMatch(JSON.stringify(messages), /private|Wrong branch/);
  c.chat_messages[0].parent_message_uuid = answer;
  assert.throws(() => visibleMessages(c), /cyclic/);
  c.current_leaf_message_uuid = 'missing';
  assert.throws(() => visibleMessages(c), /incomplete/);
});

test('direct model selection applies on send; stale sends never reach the in-app bridge', async () => {
  const calls = []; let c = conversation();
  const adapter = createEmbeddedAdapter({ request: async input => {
    calls.push(input);
    if (input.op === 'models') return { models };
    if (input.op === 'read') return { conversation: c };
    if (input.op === 'send') return { submitted: true };
    if (input.op === 'stop') return { stopped: true };
    throw new Error('Unexpected mutation');
  } });
  let state = await adapter({ op: 'snapshot' });
  state = await adapter({ op: 'open', sessionId: state.sessionId, revision: state.revision, targetSessionId: id });
  const old = state;
  const selected = (await adapter({ op: 'models' })).models[1];
  state = await adapter({ op: 'model', sessionId: id, revision: state.revision, modelId: selected.id });
  assert.equal(state.model, 'Sonnet');
  await assert.rejects(adapter({ op: 'send', sessionId: id, revision: old.revision, text: 'stale' }), /changed/);
  assert.equal(calls.filter(c => c.op === 'send').length, 0);
  await adapter({ op: 'send', sessionId: id, revision: state.revision, text: 'Selected model' });
  assert.equal(calls.find(c => c.op === 'send').model, 'sonnet');
  assert.equal(calls.find(c => c.op === 'send').parentId, answer);
  assert.equal(calls.filter(c => c.op === 'model').length, 0);
  c.chat_messages[1].content.push({ type: 'text', text: 'stream advanced' });
  await adapter({ op: 'stop', sessionId: id, revision: state.revision });
  assert.equal(calls.find(c => c.op === 'stop').commandId, calls.find(c => c.op === 'send').commandId);
});

test('truncated catalogs and unsupported image sends cannot silently succeed', async () => {
  const adapter = createEmbeddedAdapter({ request: async input => {
    if (input.op === 'models') return { models };
    if (input.op === 'catalog') return { chats: [], truncated: true };
    throw new Error('Unexpected mutation');
  } });
  await assert.rejects(adapter({ op: 'catalog' }), /not treated as complete/);
  const state = await adapter({ op: 'snapshot' });
  await assert.rejects(adapter({ op: 'send', sessionId: 'new', revision: state.revision, text: 'image', image: {} }), /not implemented/);
});

test('in-app requests keep account credentials inside the renderer and reject account switches', async () => {
  const requests = [];
  const document = { cookie: `lastActiveOrg=${id}; sessionKey=must-not-leave-renderer` };
  const sandbox = { document, AbortSignal, URL, setTimeout, clearTimeout, Map, Set, Object, Date,
    fetch: async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.credentials, 'same-origin');
      if (url.endsWith('/model_selector/chat')) return new Response(JSON.stringify({ model_selector_config: [{ id: 'chat', models: [{ id: 'haiku', name: 'Haiku' }] }] }));
      return new Response(JSON.stringify({ memberships: [{ organization: { uuid: id, claude_ai_bootstrap_models_config: [{ model: 'haiku', name: 'Haiku' }] } }] }));
    } };
  vm.createContext(sandbox);
  await vm.runInContext(`(${install.toString()})()`, sandbox);
  const result = await sandbox.__remodexChatBridge.request({ op: 'models' });
  assert.doesNotMatch(JSON.stringify(result), /sessionKey|must-not-leave/);
  await assert.rejects(sandbox.__remodexChatBridge.request({ op: 'executeJavaScript', code: 'bad' }), /Unsupported/);
  document.cookie = `lastActiveOrg=${human}`;
  await assert.rejects(sandbox.__remodexChatBridge.request({ op: 'models' }), /account changed/);
  assert.equal(requests.length, 2);
});

test('embedded listener authenticates before renderer access and rejects browser origins and oversized bodies', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'remodex-embedded-auth-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const credential = path.join(temp, 'credential.json'), token = 'a'.repeat(43);
  await fs.writeFile(credential, JSON.stringify({ token }), { mode: 0o600 });
  const require = createRequire(import.meta.url);
  let server, evaluations = 0;
  const electron = { app: { getVersion: () => 'test', whenReady: () => Promise.resolve(), on() {} },
    webContents: { getAllWebContents: () => [{ isDestroyed: () => false, getURL: () => 'https://claude.ai/new',
      executeJavaScript: async () => { evaluations++; return { ok: true }; } }] } };
  const sandbox = { Buffer, URL, console, setTimeout, clearTimeout,
    process: { platform: process.platform, env: { REMODEX_CLAUDE_EMBEDDED_CREDENTIAL: credential } },
    require: name => name === 'electron' ? electron : name === './renderer.cjs' ? install : name === 'node:http' ? {
      createServer: handler => { server = http.createServer(handler); const listen = server.listen.bind(server);
        server.listen = () => listen(0, '127.0.0.1'); return server; },
    } : require(name) };
  vm.runInNewContext(await fs.readFile(new URL('../embedded/main.cjs', import.meta.url), 'utf8'), sandbox);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(extra = {}, body = '{"op":"models"}') {
    return new Promise((resolve, reject) => {
      const req = http.request(base + '/request', { method: 'POST', headers: {
        Host: '127.0.0.1:10102', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...extra } }, res => {
        res.resume(); res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  assert.equal((await request({ Authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await request({ Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await request({ Host: 'unrelated.example' })).status, 403);
  assert.equal((await request({}, 'x'.repeat(40001))).status, 413);
  assert.equal(evaluations, 0);
  assert.equal((await request()).status, 200);
  assert.equal(evaluations, 2);
});

test('access reads only the named conversation serving metadata without exposing account or device identifiers', async () => {
  const requests = [];
  const sandbox = { document: { cookie: `lastActiveOrg=${id}` }, AbortSignal, URL, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/account') return new Response(JSON.stringify({ memberships: [{ organization: { uuid: id } }] }));
      assert.equal(url, `/api/organizations/${id}/chat_conversations/${human}/serving`);
      assert.equal(options.method, 'GET');
      return new Response(JSON.stringify({ workspace_served: false, permission_mode: 'acceptEdits', device_bound: true, bound_device_id: 'private-device' }));
    } };
  vm.createContext(sandbox);
  await vm.runInContext(`(${install.toString()})()`, sandbox);
  const result = await sandbox.__remodexChatBridge.request({ op: 'access', sessionId: human });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { workspaceServed: false, permissionMode: 'acceptEdits', deviceBound: true });
  await assert.rejects(sandbox.__remodexChatBridge.request({ op: 'access', sessionId: '../another' }), /Invalid/);
  assert.equal(requests.length, 2);
});

test('Desktop model metadata supplies effort and thinking choices without upgrade-only models', async () => {
  const sandbox = { document: { cookie: `lastActiveOrg=${id}` }, AbortSignal, URL, setTimeout, clearTimeout,
    fetch: async url => new Response(JSON.stringify(url === '/api/account' ? { memberships: [{ organization: { uuid: id } }] } : {
      model_selector_config: [{ id: 'chat', models: [
        { id: 'haiku', name: 'Haiku', thinking: { always_on: true, effort_options: [{ id: 'medium', name: 'Medium', recommended: true }, { id: 'high', name: 'High' }], mode_options: [{ id: 'auto', name: 'Thinking' }] } },
        { id: 'locked', name: 'Locked', disabled_reason: { type: 'upgrade_required' } },
        { id: 'retired', name: 'Retired', section: 'deprecated' },
      ] }], model_selector_state: [{ id: 'chat', model: 'haiku', thinking: { effort: 'medium', mode: 'auto' } }],
    })) };
  vm.createContext(sandbox); await vm.runInContext(`(${install.toString()})()`, sandbox);
  const result = await sandbox.__remodexChatBridge.request({ op: 'models' });
  assert.deepEqual(Array.from(result.models, model => model.id), ['haiku']);
  assert.equal(result.models[0].thinking.always_on, true);
  const adapter = createEmbeddedAdapter({ request: async input => input.op === 'models' ? result : { conversation: { ...conversation(), settings: { effort_level: 'high', thinking_mode: 'auto' } } } });
  const catalog = await adapter({ op: 'models' });
  assert.deepEqual(Array.from(catalog.models[0].capabilities.optionDescriptors[0].options, option => option.id), ['medium', 'high']);
  let state = await adapter({ op: 'snapshot' });
  state = await adapter({ op: 'open', sessionId: state.sessionId, revision: state.revision, targetSessionId: id });
  assert.equal(state.modelOptions.find(option => option.id === 'reasoningEffort').value, 'high');
  assert.equal(state.modelOptions.find(option => option.id === 'thinking').value, 'auto');
  await assert.rejects(adapter({ op: 'settings', sessionId: id, revision: state.revision, runtimeMode: 'full-access' }), /not available/);
});

test('settings validate model support and confirm server persistence instead of accepting ignored writes', async () => {
  const calls = []; let saved = {}, ignore = false;
  const sandbox = { document: { cookie: `lastActiveOrg=${id}` }, AbortSignal, URL, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, method: options.method });
      let data;
      if (url === '/api/account') data = { memberships: [{ organization: { uuid: id } }] };
      else if (url.endsWith('/model_selector/chat')) data = { model_selector_config: [{ id: 'chat', models: [{ id: 'haiku', name: 'Haiku', thinking: { effort_options: [{ id: 'low', name: 'Low' }], mode_options: [{ id: 'auto', name: 'Thinking' }] } }] }] };
      else if (url.includes('completion_status')) data = { is_pending: false };
      else if (options.method === 'PUT') { if (!ignore) saved = JSON.parse(options.body).settings; data = {}; }
      else data = { ...conversation(), settings: saved };
      return new Response(JSON.stringify(data));
    } };
  vm.createContext(sandbox); await vm.runInContext(`(${install.toString()})()`, sandbox);
  const request = settings => sandbox.__remodexChatBridge.request({ op: 'settings', sessionId: id, model: 'haiku', parentId: answer, settings });
  await assert.rejects(request({ thinking_mode: 'off' }), /unavailable/);
  await assert.rejects(request({ effort_level: 'max' }), /unavailable/);
  await assert.rejects(request({ permission_mode: 'bypassPermissions' }), /not supported/);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal((await request({ effort_level: 'low' })).applied, true);
  ignore = true;
  await assert.rejects(request({ thinking_mode: 'auto' }), /did not confirm/);
});

test('saved reasoning survives adapter reconnect and is forwarded on completion without changing access', async () => {
  let settings = { effort_level: 'low', thinking_mode: 'auto' };
  const calls = [];
  const request = async input => {
    calls.push(input);
    if (input.op === 'models') return { models: [{ id: 'haiku', name: 'Haiku', thinking: {
      effort_options: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], mode_options: [{ id: 'auto', name: 'Thinking' }],
    } }] };
    if (input.op === 'read') return { conversation: { ...conversation(), settings } };
    if (input.op === 'access') return { permissionMode: 'auto', workspaceServed: false };
    if (input.op === 'settings') { settings = { ...settings, ...input.settings }; return { applied: true }; }
    if (input.op === 'send') return { submitted: true };
    throw Error('Unexpected operation');
  };
  async function open(adapter) { const s = await adapter({ op: 'snapshot' }); return adapter({ op: 'open', sessionId: s.sessionId, revision: s.revision, targetSessionId: id }); }
  const first = createEmbeddedAdapter({ request });
  let state = await open(first);
  state = await first({ op: 'settings', sessionId: id, revision: state.revision, options: [{ id: 'reasoningEffort', value: 'high' }] });
  const reconnected = createEmbeddedAdapter({ request });
  state = await open(reconnected);
  assert.equal(state.modelOptions.find(option => option.id === 'reasoningEffort').value, 'high');
  assert.equal(state.runtimeMode, 'auto-accept-edits');
  assert.equal(state.accessSupported, false);
  await reconnected({ op: 'send', sessionId: id, revision: state.revision, text: 'Test' });
  const sent = calls.find(call => call.op === 'send');
  assert.equal(sent.effort, 'high'); assert.equal(sent.thinkingMode, 'auto');
  assert.equal(calls.filter(call => call.op === 'settings').length, 1);
  assert.equal(calls.find(call => call.op === 'settings').settings.permission_mode, undefined);
});
