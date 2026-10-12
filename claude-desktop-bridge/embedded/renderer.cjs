'use strict';

// This function executes in Claude's own signed-in renderer. There is no DOM
// scraping, input simulation, cookie export, or arbitrary URL/RPC operation.
module.exports = async function installRemodexChat() {
  if (globalThis.__remodexChatBridge) return;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  let accountCache = null;
  let accountAt = 0;
  let boundOrg = null;
  const runs = new Map();
  const sentCommands = new Set();
  let configurationCache = null, configurationAt = 0;
  async function context() {
    const active = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]*)/)?.[1];
    if (!uuid.test(active || '')) throw new Error('Select a Claude account in Desktop.');
    if (boundOrg && boundOrg !== active) throw new Error('Claude account changed. Restart the bridge before using a different account.');
    if (!accountCache || Date.now() - accountAt > 30000) {
      const response = await fetch('/api/account', { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Claude account request failed (${response.status}).`);
      accountCache = await response.json(); accountAt = Date.now();
    }
    const org = accountCache.memberships?.find(m => m.organization?.uuid === active)?.organization;
    if (!org) throw new Error('Active Claude account is unavailable.');
    boundOrg = active;
    return org;
  }
  async function api(org, suffix, method = 'GET', data) {
    const response = await fetch(`/api/organizations/${org.uuid}/${suffix}`, {
      method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Claude request failed (${response.status}). No automatic retry was made.`);
    return response.status === 204 ? {} : response.json();
  }
  function session(input) {
    if (!uuid.test(input.sessionId || '')) throw new Error('Invalid Claude conversation ID.');
    return input.sessionId;
  }
  const read = (org, id) => api(org, `chat_conversations/${id}?tree=True&rendering_mode=messages`);
  async function configuration(org) {
    if (!configurationCache || Date.now() - configurationAt > 30000) {
      const data = await api(org, 'model_selector/chat');
      const config = data.model_selector_config?.find(item => item.id === 'chat');
      const selected = data.model_selector_state?.find(item => item.id === 'chat');
      if (!Array.isArray(config?.models)) throw new Error('Claude model settings are unavailable.');
      const options = rows => (rows || []).filter(row => typeof row.id === 'string' && typeof row.name === 'string')
        .map(row => ({ id: row.id, name: row.name, recommended: row.recommended === true,
          description: [row.description, row.tooltip?.content].filter(v => typeof v === 'string').join(' ') }));
      configurationCache = { models: config.models.filter(model => !model.disabled_reason && !['deprecated', 'legacy'].includes(model.section))
        .map(model => ({ id: model.id, name: model.name, legacy: model.section === 'overflow',
          thinking: { effort_options: options(model.thinking?.effort_options), mode_options: options(model.thinking?.mode_options),
            always_on: model.thinking?.always_on === true, description: typeof model.thinking?.description === 'string' ? model.thinking.description : undefined } })),
        selected: selected ? { model: selected.model, thinking: selected.thinking } : null };
      configurationAt = Date.now();
    }
    return configurationCache;
  }
  async function applySettings(org, input) {
    const id = session(input), settings = input.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !Object.keys(settings).length ||
      Object.keys(settings).some(key => !['permission_mode', 'effort_level', 'thinking_mode'].includes(key))) throw new Error('Unsupported Claude setting.');
    if ('permission_mode' in settings) throw new Error('Access changes are not supported by this Claude Desktop bridge. Manage access in Claude Desktop.');
    const model = (await configuration(org)).models.find(model => model.id === input.model);
    if (!model) throw new Error('Model is not available in Claude Desktop.');
    for (const [key, options] of [['effort_level', model.thinking.effort_options], ['thinking_mode', model.thinking.mode_options]]) {
      if (key in settings && !options.some(option => option.id === settings[key])) throw new Error('This setting is unavailable for the selected Claude model.');
    }
    const before = await read(org, id);
    if ((before.current_leaf_message_uuid || '00000000-0000-4000-8000-000000000000') !== input.parentId) throw new Error('Claude chat changed. Refresh before changing settings.');
    if (runs.get(id)?.busy || (await api(org, `chat_conversations/${id}/completion_status?poll=false`)).is_pending) throw new Error('Wait for Claude to finish before changing settings.');
    await api(org, `chat_conversations/${id}?rendering_mode=raw`, 'PUT', { settings });
    const after = await read(org, id);
    if (Object.entries(settings).some(([key, value]) => after.settings?.[key] !== value)) throw new Error('Claude did not confirm the setting. Refresh before trying again.');
    return { applied: true };
  }
  async function stream(org, id, input, run) {
    try {
      const response = await fetch(`/api/organizations/${org.uuid}/chat_conversations/${id}/completion`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ prompt: input.text, parent_message_uuid: input.parentId,
          model: input.model, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: 'en-US',
          attachments: [], files: [], sync_sources: [], rendering_mode: 'messages',
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.thinkingMode ? { thinking_mode: input.thinkingMode } : {}),
          completion_request_id: run.id }), signal: run.controller.signal,
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
        throw new Error(`Claude message request failed (${response.status}).`);
      }
      run.accepted = true;
      run.resolveAccepted();
      const reader = response.body.getReader(); const decoder = new TextDecoder();
      let pending = '', total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 8 * 1024 * 1024) throw new Error('Claude response exceeded the bridge limit.');
        pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          const event = JSON.parse(data);
          if (event.type === 'error' || frame.includes('event: error')) throw new Error('Claude rejected the message stream. Refresh before retrying.');
          // Only user-visible text. Thinking/tool argument deltas never leave Desktop.
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') run.text += event.delta.text || '';
          if (typeof event.completion === 'string') run.text += event.completion;
          if (event.type === 'message_stop' || frame.includes('event: message_stop')) run.finished = true;
        }
      }
      if (!run.finished) throw new Error('Claude stream ended without completion. Refresh before retrying.');
    } catch (error) { run.error = run.stopped ? null : error.name === 'AbortError' ? 'Response timed out. Refresh before retrying.' : error.message; run.rejectAccepted(new Error(run.error || 'Response stopped.')); }
    finally { run.busy = false; clearTimeout(run.timeout); }
  }
  globalThis.__remodexChatBridge = Object.freeze({ async request(input) {
    if (!input || typeof input !== 'object') throw new Error('Invalid bridge request.');
    const org = await context();
    switch (input.op) {
      case 'models': case 'configuration': return configuration(org);
      case 'settings': return applySettings(org, input);
      case 'access': {
        const id = session(input);
        const serving = await api(org, `chat_conversations/${id}/serving`);
        if (typeof serving.workspace_served !== 'boolean') throw new Error('Claude did not identify this conversation runtime.');
        return { workspaceServed: serving.workspace_served,
          permissionMode: ['default', 'acceptEdits', 'auto', 'bypassPermissions'].includes(serving.permission_mode) ? serving.permission_mode : null,
          deviceBound: serving.device_bound === true };
      }
      case 'catalog': {
        const rows = await api(org, 'chat_conversations?limit=1000');
        if (!Array.isArray(rows)) throw new Error('Claude returned an unsupported chat catalog.');
        return { chats: rows.map(row => ({ uuid: row.uuid, name: row.name, created_at: row.created_at,
          updated_at: row.updated_at, is_archived: row.is_archived, is_temporary: row.is_temporary })), truncated: rows.length >= 1000 };
      }
      case 'read': {
        const id = session(input), conversation = await read(org, id), run = runs.get(id);
        return { conversation: { uuid: conversation.uuid, name: conversation.name, model: conversation.model,
          settings: { permission_mode: conversation.settings?.permission_mode,
            effort_level: conversation.settings?.effort_level, thinking_mode: conversation.settings?.thinking_mode },
          created_at: conversation.created_at, updated_at: conversation.updated_at,
          current_leaf_message_uuid: conversation.current_leaf_message_uuid,
          chat_messages: conversation.chat_messages?.map(message => ({ uuid: message.uuid, sender: message.sender,
            parent_message_uuid: message.parent_message_uuid, created_at: message.created_at, updated_at: message.updated_at,
            content: (message.content || []).filter(block => block.type === 'text').map(block => ({ type: 'text', text: block.text })) })) },
          run: run ? { busy: run.busy, text: run.text, error: run.error, accepted: run.accepted, parentId: run.parentId } : null };
      }
      case 'stop': {
        const id = session(input), run = runs.get(id);
        if (!run?.busy || run.id !== input.commandId) throw new Error('This bridge does not own an active response in this chat.');
        await api(org, `chat_conversations/${id}/stop_response`, 'POST', { completion_request_id: run.id });
        run.stopped = true;
        run.controller.abort();
        return { stopped: true };
      }
      case 'create': {
        if (typeof input.title !== 'string' || input.title.length > 200) throw new Error('Invalid chat title.');
        const id = session(input);
        return api(org, 'chat_conversations', 'POST', { uuid: id, name: input.title });
      }
      case 'send': {
        const id = session(input);
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000) throw new Error('Invalid prompt.');
        if (!uuid.test(input.parentId || '') || !uuid.test(input.commandId || '')) throw new Error('Invalid turn identity.');
        const model = (await configuration(org)).models.find(model => model.id === input.model);
        if (!model) throw new Error('Model is not in this account catalog.');
        if (input.effort !== undefined && !model.thinking.effort_options.some(option => option.id === input.effort)) throw new Error('Invalid Claude effort.');
        if (input.thinkingMode !== undefined && !model.thinking.mode_options.some(option => option.id === input.thinkingMode)) throw new Error('Invalid Claude thinking mode.');
        if (runs.get(id)?.busy) throw new Error('Claude is already replying in this chat.');
        if (sentCommands.has(input.commandId)) throw new Error('This command has already been submitted; it will not be replayed.');
        if (sentCommands.size >= 1000) throw new Error('Restart the bridge before sending more commands.');
        const conversation = await read(org, id);
        if ((conversation.current_leaf_message_uuid || '00000000-0000-4000-8000-000000000000') !== input.parentId) throw new Error('Claude chat changed. Refresh before sending.');
        const status = await api(org, `chat_conversations/${id}/completion_status?poll=false`);
        if (status.is_pending) throw new Error('Claude Desktop is already replying in this chat.');
        const run = { id: input.commandId, parentId: input.parentId, busy: true, accepted: false, text: '', error: null, controller: new AbortController() };
        const accepted = new Promise((resolve, reject) => { run.resolveAccepted = resolve; run.rejectAccepted = reject; });
        run.timeout = setTimeout(() => run.controller.abort(), 180000);
        runs.set(id, run);
        sentCommands.add(input.commandId);
        void stream(org, id, input, run);
        await accepted;
        return { submitted: true, commandId: run.id };
      }
      default: throw new Error('Unsupported direct bridge operation.');
    }
  } });
};
