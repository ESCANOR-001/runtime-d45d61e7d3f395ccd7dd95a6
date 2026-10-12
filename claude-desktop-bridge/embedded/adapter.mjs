import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ROOT = '00000000-0000-4000-8000-000000000000';
const label = name => name?.replace(/^Claude /, '') || 'Desktop selected model';
const credentials = fileURLToPath(new URL('../.local/embedded-credentials.json', import.meta.url));

export async function embeddedRequest(input) {
  const stat = await fs.lstat(credentials);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Embedded Claude credentials must be private.');
  const { token } = JSON.parse(await fs.readFile(credentials, 'utf8'));
  const response = await fetch('http://127.0.0.1:10102/request', { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(25000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Claude direct bridge failed.');
  return body;
}

export function visibleMessages(conversation) {
  const all = conversation.chat_messages;
  if (!Array.isArray(all)) throw new Error('Claude returned an invalid transcript.');
  if (!all.length) return [];
  const byId = new Map(all.map(message => [message.uuid, message]));
  let next = conversation.current_leaf_message_uuid;
  if (!next) throw new Error('Claude did not identify the active conversation branch.');
  const chain = [], seen = new Set();
  while (next && next !== ROOT) {
    if (seen.has(next)) throw new Error('Claude returned a cyclic transcript.');
    seen.add(next);
    const message = byId.get(next);
    if (!message) throw new Error('Claude returned incomplete conversation history.');
    chain.unshift(message); next = message.parent_message_uuid;
  }
  return chain.filter(message => ['human', 'assistant'].includes(message.sender)).map(message => ({
    id: message.uuid, role: message.sender === 'human' ? 'user' : 'assistant',
    text: (message.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n\n') || message.text || '',
    createdAt: message.created_at, updatedAt: message.updated_at,
  }));
}

export function createEmbeddedAdapter({ request = embeddedRequest } = {}) {
  let selected = null, knownModels = [], modelsAt = 0;
  const runIds = new Map();
  const selectedModels = new Map();
  async function models() {
    if (!knownModels.length || Date.now() - modelsAt > 30000) {
      knownModels = (await request({ op: 'models' })).models; modelsAt = Date.now();
    }
    return knownModels.map(model => ({ id: hash(model.id), label: label(model.name), value: model.id }));
  }
  async function snapshot(id = selected) {
    if (!id) return { sessionId: 'new', revision: hash('new'), title: 'New chat', model: (await models())[0]?.label,
      busy: false, draftPresent: false, messages: [], chats: [], capabilities: ['direct'], history: { start: 0, end: 0, total: 0, hasMore: false } };
    const { conversation, run } = await request({ op: 'read', sessionId: id });
    if (conversation.uuid !== id) throw new Error('Claude returned a different chat.');
    const messages = visibleMessages(conversation);
    // Persisted messages remain authoritative. The stream supplements only
    // the active response while Claude has not stored its completed text yet.
    if (run?.busy && run.text) {
      const last = messages.at(-1);
      if (last?.role === 'assistant' && last.id !== run.parentId) last.text = run.text;
      else if (last?.role === 'user' && last.id !== run.parentId) messages.push({ role: 'assistant', text: run.text });
    }
    const modelId = selectedModels.get(id) || conversation.model;
    const revision = hash({ id, leaf: conversation.current_leaf_message_uuid, messages, model: modelId });
    const start = Math.max(0, messages.length - 60);
    return { sessionId: id, revision, title: conversation.name || 'New chat',
      model: label(knownModels.find(model => model.id === modelId)?.name || modelId),
      createdAt: conversation.created_at, updatedAt: conversation.updated_at,
      busy: run?.busy === true, lastError: run?.error || null, draftPresent: false, draftHash: null,
      messages: messages.slice(start), chats: [], capabilities: ['direct', 'model', 'stop'],
      history: { start, end: messages.length, total: messages.length, hasMore: start > 0 },
      parentId: conversation.current_leaf_message_uuid || ROOT, allMessages: messages };
  }
  const publicSnapshot = ({ allMessages, parentId, ...rest }) => rest;
  return async input => {
    if (input.op === 'models') return { models: await models() };
    if (input.op === 'catalog') {
      const result = await request({ op: 'catalog' });
      if (result.truncated) throw new Error('Claude chat catalog exceeds the supported limit; it was not treated as complete.');
      return { chats: result.chats.filter(row => !row.is_archived && !row.is_temporary).map(row => ({
        sessionId: row.uuid, title: row.name, createdAt: row.created_at, updatedAt: row.updated_at,
      })) };
    }
    await models();
    if (input.op === 'snapshot') return publicSnapshot(await snapshot());
    if (input.op === 'history') {
      const state = await snapshot(input.sessionId);
      if (state.revision !== input.revision) throw new Error('Claude history changed. Refresh before loading more.');
      const end = Math.min(input.before ?? state.history.start, state.allMessages.length), start = Math.max(0, end - 60);
      return { sessionId: input.sessionId, revision: state.revision, messages: state.allMessages.slice(start, end), start, end, hasMore: start > 0 };
    }
    const state = await snapshot();
    if (input.sessionId !== state.sessionId || (!['open', 'stop'].includes(input.op) && input.revision !== state.revision)) throw new Error('Claude chat changed. Refresh before trying again.');
    if (input.op === 'open') {
      const next = await snapshot(input.targetSessionId); selected = input.targetSessionId;
      return publicSnapshot(next);
    }
    if (input.op === 'new') {
      const id = randomUUID(); await request({ op: 'create', sessionId: id, title: 'New chat' });
      selected = id; return publicSnapshot(await snapshot());
    }
    if (input.op === 'model') {
      const model = (await models()).find(model => model.id === input.modelId);
      if (!model || !selected) throw new Error('Choose a chat and an available model.');
      if (state.busy) throw new Error('Wait for the current reply before changing models.');
      // Regular Chat applies the chosen model on its next completion request.
      // Its conversation update endpoint does not accept a top-level model.
      selectedModels.set(selected, model.value);
      return publicSnapshot(await snapshot());
    }
    if (input.op === 'send') {
      if (input.image) throw new Error('Image sending is not implemented by the direct Claude bridge yet.');
      if (state.busy) throw new Error('Claude is already replying.');
      const model = (await models()).find(model => model.label === state.model);
      if (!selected || !model) throw new Error('Choose an available Claude model before sending.');
      const commandId = randomUUID();
      await request({ op: 'send', sessionId: selected, parentId: state.parentId, commandId, model: model.value, text: input.text });
      runIds.set(selected, commandId);
      return { submitted: true, state: publicSnapshot(await snapshot()) };
    }
    if (input.op === 'stop') {
      await request({ op: 'stop', sessionId: selected, commandId: runIds.get(selected) });
      return publicSnapshot(await snapshot());
    }
    throw new Error('This action is not implemented by the direct Claude bridge yet.');
  };
}

export const embeddedDesktop = createEmbeddedAdapter();
