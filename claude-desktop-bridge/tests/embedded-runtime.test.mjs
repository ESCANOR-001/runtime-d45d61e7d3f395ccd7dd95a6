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
      return new Response(JSON.stringify({ memberships: [{ organization: { uuid: id, claude_ai_bootstrap_models_config: [{ model: 'haiku', name: 'Haiku' }] } }] }));
    } };
  vm.createContext(sandbox);
  await vm.runInContext(`(${install.toString()})()`, sandbox);
  const result = await sandbox.__remodexChatBridge.request({ op: 'models' });
  assert.doesNotMatch(JSON.stringify(result), /sessionKey|must-not-leave/);
  await assert.rejects(sandbox.__remodexChatBridge.request({ op: 'executeJavaScript', code: 'bad' }), /Unsupported/);
  document.cookie = `lastActiveOrg=${human}`;
  await assert.rejects(sandbox.__remodexChatBridge.request({ op: 'models' }), /account changed/);
  assert.equal(requests.length, 1);
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
