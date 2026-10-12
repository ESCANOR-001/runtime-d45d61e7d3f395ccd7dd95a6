import { setTimeout as sleep } from 'node:timers/promises';
import { nativeCall } from './native-helper.mjs';
import { hash, stableJson, modelName, controlId, chatId, historyPage, messageBodies, extractMessages, displayDate } from './desktop-content.mjs';

// Shared chat semantics, independent of the operating system's accessibility API.
// Native backends supply a normalized tree and verify application/control identity
// again before each action. Authentication and command deduplication stay upstream.
export class NativeDesktop {
  constructor(call = nativeCall, wait = sleep) { this.call = call; this.wait = wait; this.nodes = {}; this.order = []; }
  values() { return Object.values(this.nodes); }
  find(name, role = 'button') {
    const ids = this.order.filter(id => this.nodes[id].name === name && this.nodes[id].role === role);
    if (ids.length !== 1) throw new Error('Expected Claude control is unavailable: ' + name);
    return ids[0];
  }
  target(id) { const n = this.nodes[id]; return { application: this.application, id, name: n.name, role: n.role }; }
  actId(id, op = 'action') { return this.call({ op, target: this.target(id) }); }
  action(name, role = 'button') { return this.actId(this.find(name, role)); }
  descendants(id) {
    const n = this.nodes[id];
    return n ? [id, ...n.children.flatMap(c => this.descendants(c))] : [];
  }
  attachments() { return this.values().filter(n => n.role === 'button' && n.name.startsWith('Remove ')).map(n => n.name).sort(); }
  draft() {
    const read = id => this.nodes[id].role === 'static' ? this.nodes[id].name : this.nodes[id].children.filter(c => this.nodes[c]).map(read).join('');
    return this.nodes[this.find('Write your prompt to Claude', 'entry')].children.map(read).join('\n').trim();
  }
  draftHash() { const text = this.draft(), files = this.attachments(); return text || files.length ? hash(stableJson([text, files])) : null; }
  async scan({ allowDialog = false, allowCatalog = false } = {}) {
    const tree = await this.call({ op: 'scan' });
    this.nodes = tree.nodes; this.order = tree.order; this.application = tree.application;
    const docs = this.values().filter(n => n.role === 'document web').flatMap(n => {
      const uri = n.document?.URI, id = chatId(uri);
      if (allowCatalog && uri === 'https://claude.ai/chats') return [{ sessionId: 'catalog', title: 'Chats' }];
      if (!id && !['https://claude.ai/new','https://claude.ai/'].includes(uri)) return [];
      return [{ sessionId: id || 'new', title: (n.document.Title || '').replace(/ - Claude$/, '') }];
    });
    if (docs.length !== 1) throw new Error('Open a regular Claude Chat conversation in Desktop.');
    const state = docs[0];
    if (allowDialog || state.sessionId === 'catalog') return state;
    if (this.values().some(n => ['dialog','alert','alert dialog'].includes(n.role))) throw new Error('Claude is showing a dialog. Close it on Desktop and refresh.');
    this.find('Write your prompt to Claude', 'entry');
    this.messages = extractMessages(this.nodes, this.order);
    const { messages, ...history } = historyPage(this.messages, this.messages.length, 80);
    const models = this.values().filter(n => n.role === 'button' && n.name.startsWith('Model: '));
    const model = models.length === 1 ? modelName(models[0].name.slice(7)) : '';
    return { ...state, model, messages, history,
      busy: this.values().some(n => n.role === 'button' && ['Stop response','Stop generating','Stop'].includes(n.name)),
      historyScope: 'visible', platform: process.platform + '-accessibility',
      chats: this.order.filter(id => this.nodes[id].role === 'button' && this.nodes[id].name.startsWith('Idle ')).map(id => {
        const n = this.nodes[id]; return { id: controlId(id, n.name), title: n.name.slice(5), selected: n.attrs?.current === 'page' };
      }), chatScope: 'desktop-recents', draftPresent: Boolean(this.draft() || this.attachments().length), draftHash: this.draftHash(),
      capabilities: ['send','recent-chats','new-chat','models','stop','pin','delete','history','retry','images'],
      revision: hash(stableJson([state.sessionId, model, this.messages])) };
  }
  async awaitState(predicate) {
    for (let i = 0; i < 24; i++) {
      await this.wait(250);
      try { const state = await this.scan(); if (predicate(state)) return state; } catch { /* A transient render is not confirmation. */ }
    }
    throw new Error('Desktop has not confirmed the change. Refresh before trying again.');
  }
  async checkTarget(request) {
    const state = await this.scan();
    if (state.sessionId !== request.sessionId || state.revision !== request.revision) throw new Error('Desktop conversation changed. Refresh before sending.');
    if (state.busy) throw new Error('Claude is still responding. Wait for it to finish.');
    return state;
  }
  async idleTarget(request) {
    const state = await this.checkTarget(request);
    if (this.draft() || this.attachments().length) throw new Error('Desktop has an unsent draft. Finish or clear it on Desktop first.');
    return state;
  }
  async catalog() {
    const state = await this.scan();
    if (state.busy || state.draftPresent) throw new Error('Finish the current response or draft before refreshing all chats.');
    await this.action('View all');
    try {
      const records = new Map(); let stable = 0, previous = '';
      for (let i = 0; i < 24; i++) {
        await this.wait(600); await this.scan({ allowCatalog: true });
        const links = this.order.filter(id => this.nodes[id].role === 'link' && chatId(this.nodes[id].uri));
        for (const id of links) {
          const n = this.nodes[id], sessionId = chatId(n.uri);
          const labels = this.descendants(n.parent).map(p => this.nodes[p]).filter(n => n.role === 'static').map(n => n.name);
          const timeLabel = labels.reverse().find(label => displayDate(label)) || null;
          records.set(sessionId, { sessionId, title: n.name, updatedAt: displayDate(timeLabel), timeLabel });
        }
        const fingerprint = [...records.keys()].join(','); stable = fingerprint === previous ? stable + 1 : 0; previous = fingerprint;
        if (!links.length) {
          if (this.values().some(n => ['No chats yet','No conversations yet'].includes(n.name)) && stable >= 2) return {chats:[],scope:'desktop-all-chats',timePrecision:'desktop-display'};
          continue;
        }
        if (stable >= 3) return { chats: [...records.values()], scope: 'desktop-all-chats', timePrecision: 'desktop-display' };
        if (records.size >= 500) throw new Error('The chat list exceeds the current 500-chat limit.');
        const more = this.values().filter(n => n.role === 'button' && ['Load more','Show more'].includes(n.name));
        if (more.length === 1) await this.action(more[0].name);
        else await this.actId(links.at(-1), 'scroll').catch(() => {});
      }
      throw new Error('The complete chat list is still loading. Refresh again shortly.');
    } finally {
      await this.scan({ allowCatalog: true }); await this.action('Back');
      await this.awaitState(s => s.sessionId === state.sessionId && (state.sessionId === 'new' || s.messages.length));
    }
  }
  async navigate(request) {
    await this.checkTarget(request);
    if ((this.draft() || this.attachments().length) && request.discardDraftHash !== this.draftHash()) throw new Error('Desktop has an unsent draft. Confirm discarding it before changing chats.');
    if (request.op === 'new') { await this.action('New'); return this.awaitState(s => s.sessionId === 'new'); }
    const id = request.targetSessionId || request.chatId;
    if (request.targetSessionId) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid chat identity.');
      if (id === request.sessionId) return this.scan();
      await this.action('View all');
      for (let i = 0; i < 24; i++) {
        await this.wait(350); await this.scan({ allowCatalog: true });
        const matches = this.order.filter(p => this.nodes[p].uri === 'https://claude.ai/chat/' + id);
        if (matches.length === 1) { await this.actId(matches[0]); return this.awaitState(s => s.sessionId === id && s.messages.length); }
        const links = this.order.filter(p => chatId(this.nodes[p].uri));
        if (!links.length) break;
        try { await this.actId(links.at(-1), 'scroll'); } catch { break; }
      }
      await this.action('Back'); throw new Error('This conversation is no longer in Claude Desktop. Refresh all chats.');
    }
    const matches = this.order.filter(p => this.nodes[p].role === 'button' && this.nodes[p].name.startsWith('Idle ') && controlId(p, this.nodes[p].name) === id);
    if (matches.length !== 1) throw new Error('The chat list changed. Refresh it before selecting a chat.');
    const name = this.nodes[matches[0]].name; await this.action(name);
    return this.awaitState(s => s.sessionId !== 'new' && s.title === name.slice(5) && s.messages.length);
  }
  async modelMenu() {
    await this.scan(); await this.call({ op: 'activate' });
    const button = this.values().find(n => n.role === 'button' && n.name.startsWith('Model: '))?.name;
    if (!button) throw new Error('Claude model control is unavailable.');
    if (!this.values().some(n => n.role === 'menu' && n.name === button)) await this.action(button);
    await this.wait(200); await this.scan();
    const expanded = () => this.values().some(n => n.role === 'menu' && n.name === 'More models');
    try {
      if (this.values().some(n => n.role === 'menu item' && n.name === 'More models') && !expanded()) {
        await this.action('More models', 'menu item'); await this.wait(400); await this.scan();
        if (!expanded()) {
          await this.actId(this.find('More models','menu item'), 'hover');
          for (let i = 0; i < 8 && !expanded(); i++) { await this.wait(150); await this.scan(); }
          if (!expanded()) throw new Error('Claude did not open the complete model list. Refresh models.');
        }
      }
      return button;
    } catch (error) { await this.action(button).catch(() => {}); throw error; }
  }
  modelItems() { return this.values().filter(n => n.role === 'radio menu item' && !n.name.startsWith('Effort ')); }
  async models() {
    const button = await this.modelMenu();
    try { return { models: [...new Map(this.modelItems().map(n => [modelName(n.name), { id: hash(modelName(n.name)), label: modelName(n.name) }])).values()] }; }
    finally { await this.action(button); }
  }
  async selectModel(request) {
    await this.idleTarget(request); const button = await this.modelMenu();
    const matches = this.modelItems().filter(n => hash(modelName(n.name)) === request.modelId);
    if (matches.length !== 1) { await this.action(button); throw new Error('That model is no longer available. Reload models.'); }
    await this.action(matches[0].name, 'radio menu item');
    return this.awaitState(() => !this.values().some(n => n.role === 'menu'));
  }
  async history(request) {
    const state = await this.scan();
    if (state.sessionId !== request.sessionId || state.revision !== request.revision) throw new Error('Conversation changed. Reload history before reading another page.');
    return { ...historyPage(this.messages, request.before), sessionId: state.sessionId, revision: state.revision };
  }
  async stop(request) {
    const state = await this.scan();
    if (state.sessionId !== request.sessionId) throw new Error('Desktop switched chats. Refresh before stopping a response.');
    if (!state.busy) return state;
    const matches = this.values().filter(n => n.role === 'button' && ['Stop response','Stop generating','Stop'].includes(n.name));
    if (matches.length !== 1) throw new Error('The stop control is unavailable. Refresh Desktop.');
    await this.action(matches[0].name); return this.awaitState(s => !s.busy);
  }
  async retry(request) {
    await this.idleTarget(request);
    const last = messageBodies(this.nodes, this.order).at(-1);
    if (last?.role !== 'assistant') throw new Error('Wait for an assistant reply before retrying.');
    const matches = this.descendants(last.article).filter(p => this.nodes[p].role === 'button' && this.nodes[p].name === 'Retry');
    if (matches.length !== 1) throw new Error('The last response retry control is unavailable.');
    await this.actId(matches[0]); await this.wait(300); return this.scan();
  }
  async contextMenu(state) {
    const title = this.find(state.title + ', rename chat');
    const matches = this.nodes[this.nodes[title].parent].children.filter(p => this.nodes[p]?.name === 'More options for ' + state.title);
    if (matches.length !== 1) throw new Error('The current chat menu is unavailable.');
    const id = matches[0]; await this.actId(id); await this.wait(200); await this.scan(); return id;
  }
  async pin(request) {
    const state = await this.idleTarget(request);
    if (state.sessionId === 'new') throw new Error('Send a message before pinning this chat.');
    const button = await this.contextMenu(state), name = request.pinned ? 'Pin' : 'Unpin';
    if (this.values().some(n => n.role === 'menu item' && n.name === name)) await this.action(name, 'menu item');
    else {
      if (!this.values().some(n => n.role === 'menu item' && n.name === (request.pinned ? 'Unpin' : 'Pin'))) throw new Error('The pin control is unavailable. Refresh Desktop.');
      await this.actId(button);
    }
    return this.awaitState(s => s.sessionId === state.sessionId && !this.values().some(n => n.role === 'menu'));
  }
  async delete(request) {
    const state = await this.idleTarget(request);
    if (state.sessionId === 'new' || request.confirmTitle !== state.title) throw new Error('The chat changed. Confirm its title again before deleting.');
    await this.contextMenu(state); await this.action('Delete','menu item'); await this.wait(200);
    const confirmation = await this.scan({ allowDialog: true });
    if (confirmation.sessionId !== state.sessionId || !this.values().some(n => n.role === 'alert' && n.name === 'Delete chat?')) throw new Error('The expected chat deletion confirmation is unavailable. Nothing was confirmed.');
    await this.action('Delete'); return this.awaitState(s => s.sessionId !== state.sessionId);
  }
  async clipboard(data, mime, run) {
    const previous = await this.call({ op: 'clipboardRead' });
    const encoded = Buffer.from(data).toString('base64');
    try { await this.call({op:'clipboardWrite',mime,data:encoded}); return await run(); }
    finally {
      const current = await this.call({ op:'clipboardRead' }).catch(() => null);
      // Never overwrite clipboard content copied by the desktop user meanwhile.
      if (current?.data === encoded && current.mime === mime) await this.call({op:'clipboardWrite', ...previous});
    }
  }
  async pasteMenu() {
    for (const [name, role] of [['Menu','button'],['Edit','menu item'],['Paste Ctrl+V','menu item']]) {
      await this.scan(); await this.action(name, role); await this.wait(200);
    }
  }
  async send(request) {
    const text = request.text ?? '', image = request.image;
    if (typeof text !== 'string' || (!text.trim() && !image) || [...text].length > 8000 || text.includes('\0')) throw new Error('Enter a message or attach an image (maximum 8000 characters).');
    let data;
    if (image) {
      data = typeof image.data === 'string' ? Buffer.from(image.data, 'base64') : Buffer.alloc(0);
      const valid = image.mime === 'image/png' ? data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) : image.mime === 'image/jpeg' && data.subarray(0,3).equals(Buffer.from('ffd8ff','hex'));
      if (!valid || data.length > 4 * 1024 * 1024 || data.toString('base64') !== image.data) throw new Error('Choose a PNG or JPEG image smaller than 4 MB.');
    }
    await this.idleTarget(request); await this.call({ op:'activate' });
    await this.actId(this.find('Write your prompt to Claude','entry'), 'focus');
    let attached = [];
    if (data) {
      await this.clipboard(data, image.mime, async () => { await this.pasteMenu(); await this.awaitState(() => this.attachments().length === 1); });
      attached = this.attachments();
    }
    if (text.trim()) await this.clipboard(text, 'text/plain;charset=utf-8', async () => { await this.pasteMenu(); await this.wait(300); });
    await this.checkTarget(request);
    if (this.draft() !== text.trim() || JSON.stringify(this.attachments()) !== JSON.stringify(attached)) throw new Error('The prepared message changed. Inspect Desktop; nothing was sent.');
    await this.action('Send message');
    // No automatic replay after this point, including uncertain acknowledgement.
    const state = await this.awaitState(s => !this.draft() && !this.attachments().length && (request.sessionId !== 'new' || s.sessionId !== 'new'));
    return {submitted:true,state};
  }
  execute(request) {
    const methods = { snapshot:'scan',catalog:'catalog',models:'models',model:'selectModel',send:'send',new:'navigate',open:'navigate',stop:'stop',history:'history',retry:'retry',pin:'pin',delete:'delete' };
    const method = methods[request.op];
    if (!method) throw new Error('Unknown operation.');
    return this[method](request);
  }
}
export const nativeDesktop = request => {
  const deadline = Date.now() + 45000;
  return new NativeDesktop(input => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Desktop action timed out. Inspect Desktop before retrying.');
    return nativeCall(input, { timeout: Math.min(15000, remaining) });
  }).execute(request);
};
