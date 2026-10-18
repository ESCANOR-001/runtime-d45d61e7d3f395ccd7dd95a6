import { listSessions, getSessionInfo, getSessionMessages, type SDKSessionInfo, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import { claudeToolInput, claudeToolResult } from './tool-presentation';
import { claudeUserText, isClaudeControlMessage } from './user-message';
import type { ClaudeToolImages } from './tool-images';
import { claudeThinkingSummary } from './thinking-summary';

type Row = Record<string, any>;
export type ClaudeHistoryReader = {
  list: typeof listSessions;
  messages: typeof getSessionMessages;
  info?: typeof getSessionInfo;
};
export const localClaudeHistory: ClaudeHistoryReader = { list: listSessions, messages: getSessionMessages, info: getSessionInfo };
export const emptyClaudeHistory: ClaudeHistoryReader = { list: async () => [], messages: async () => [] };
const iso = (n: number | undefined) => new Date(Number.isFinite(n) ? n! : 0).toISOString();
const idFor = (id: string) => `claude-history-${id}`;
const projectId = (cwd: string) => `claude-project-${createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 24)}`;
const text = (v: unknown) => typeof v === 'string' ? v : '';

/** Read native SDK history, never resume it or write to its transcript/settings. */
export class ClaudeHistory {
  private entries = new Map<string, SDKSessionInfo>();
  private cached = new Map<string, { stamp: number; thread: Row }>();
  private pending: Promise<boolean> | null = null;
  private refreshedAt = 0;
  constructor(private reader: ClaudeHistoryReader, private images?: ClaudeToolImages) {}
  has(id: string) { return this.entries.has(id); }
  async refresh(owned: Set<string>, force = false): Promise<boolean> {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.refreshedAt < 5000) return false;
    this.pending = (async () => {
      const next = new Map<string, SDKSessionInfo>();
      for (let offset = 0; ; offset += 200) {
        const page = await this.reader.list({ limit: 200, offset });
        for (const s of page) if (!owned.has(s.sessionId) && s.cwd && isAbsolute(s.cwd)) next.set(idFor(s.sessionId), s);
        if (page.length < 200) break;
      }
      const changed = JSON.stringify([...next]) !== JSON.stringify([...this.entries]);
      this.entries = next; this.refreshedAt = Date.now();
      for (const id of this.cached.keys()) if (!next.has(id)) this.cached.delete(id);
      return changed;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  projects(existing: Row[]) {
    const known = new Set(existing.map(p => resolve(p.workspaceRoot)));
    const result = new Map<string, Row>();
    for (const s of this.entries.values()) if (!known.has(resolve(s.cwd!))) {
      const id = projectId(s.cwd!);
      result.set(id, { id, title: basename(s.cwd!) || s.cwd!, workspaceRoot: s.cwd, repositoryIdentity: null,
        defaultModelSelection: null, scripts: [], createdAt: iso(s.createdAt), updatedAt: iso(s.lastModified) });
    }
    return [...result.values()];
  }
  shells(existing: Row[]) { return [...this.entries].map(([id, s]) => this.shell(id, s, existing)); }
  private shell(id: string, s: SDKSessionInfo, projects: Row[]) {
    const project = projects.find(p => resolve(p.workspaceRoot) === resolve(s.cwd!));
    const createdAt = iso(s.createdAt ?? s.lastModified), updatedAt = iso(s.lastModified);
    return { id, nativeSessionId: s.sessionId, projectId: project?.id ?? projectId(s.cwd!),
      title: (s.customTitle || s.summary || 'Claude Code session').slice(0, 256),
      modelSelection: { instanceId: 'claude-code', model: 'sonnet', options: [] },
      runtimeMode: 'approval-required', interactionMode: 'default', branch: s.gitBranch || null, worktreePath: s.cwd,
      latestTurn: null, createdAt, updatedAt, archivedAt: null, deletedAt: null, latestUserMessageAt: null,
      hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
      source: { kind: 'remodex-projected' },
      // A transcript is not a live worker: do not invent execution status.
      session: null,
    };
  }
  async detail(id: string, projects: Row[]): Promise<Row> {
    const info = this.entries.get(id);
    if (!info) throw new TypeError('Claude Code history was not found. Refresh the chat list.');
    const cached = this.cached.get(id);
    if (cached?.stamp === info.lastModified) { cached.thread.projectId = this.shell(id, info, projects).projectId; return cached.thread; }
    if ((info.fileSize ?? 0) > 16 * 1024 * 1024) throw new Error('This Claude history is too large to load on the phone. Open it in Claude Desktop.');
    const rows = await this.reader.messages(info.sessionId, { dir: info.cwd });
    const thread = { ...this.shell(id, info, projects), ...projectHistory(id, rows, info, this.images) };
    this.cached.delete(id); this.cached.set(id, { stamp: info.lastModified, thread });
    while (this.cached.size > 4) this.cached.delete(this.cached.keys().next().value!);
    return thread;
  }
  cachedDetail(id: string) { return this.cached.get(id)?.thread; }

  /** Load a newly forked native transcript without publishing it as imported Desktop history. */
  async branchDetail(nativeId: string, cwd: string, threadId: string, projects: Row[]): Promise<Row> {
    const info = await this.reader.info?.(nativeId, { dir: cwd });
    if (!info || info.sessionId !== nativeId || !info.cwd || resolve(info.cwd) !== resolve(cwd))
      throw new Error('The branched conversation is saved but its history is not available yet. Reopen this branch to retry.');
    if ((info.fileSize ?? 0) > 16 * 1024 * 1024) throw new Error('This Claude history is too large to load on the phone. Open it in Claude Desktop.');
    const rows = await this.reader.messages(nativeId, { dir: cwd });
    return { ...this.shell(threadId, info, projects), ...projectHistory(threadId, rows, info, this.images) };
  }
}

function projectHistory(id: string, all: SessionMessage[], info: SDKSessionInfo, images?: ClaudeToolImages) {
  const messages: Row[] = [], activities: Row[] = [], tools = new Map<string, Row>();
  let sequence = 0, turnId = `history-${id}`, lastUser: string | null = null;
  // The native transcript is byte-bounded before reading, and Android receives
  // ten-prompt pages. Keep earlier entries so its older-page cursors can reach
  // the start of the conversation instead of silently losing history here.
  const rows = all;
  for (const entry of rows) {
    if (entry.parent_tool_use_id) continue;
    const message = entry.message as Row;
    if (!message || typeof message !== 'object') continue;
    const timestamp = text((entry as unknown as Row).timestamp);
    const date = timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : iso(info.createdAt ?? info.lastModified);
    const blocks: Row[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : [];
    const body = entry.type === 'user' ? claudeUserText(message.content)
      : blocks.filter(b => b.type === 'text').map(b => text(b.text)).join('\n');
    const toolResult = blocks.some(b => b.type === 'tool_result');
    if (entry.type === 'user' && !toolResult && isClaudeControlMessage(entry as unknown as Row, body)) continue;
    if (entry.type === 'user' && !toolResult) { turnId = `history-${entry.uuid}`; lastUser = date; }
    if (body && !toolResult && ['user', 'assistant'].includes(entry.type)) messages.push({ id: entry.uuid, role: entry.type, text: body.slice(0, 512000), turnId,
      sequence: ++sequence, streaming: false, ...(entry.type === 'assistant' ? { phase: 'final_answer' } : {}), createdAt: date, updatedAt: date });
    for (const [index, block] of blocks.entries()) {
      const summary = entry.type === 'assistant' ? claudeThinkingSummary(message.model, block) : null;
      if (summary) activities.push({ id: `claude-thinking-${message.id || entry.uuid}-${index}`, kind: 'claude.thinking-summary', summary: 'Thinking',
        turnId, sequence: ++sequence, createdAt: date, tone: 'thinking', payload: { status: 'completed', detail: summary, data: { providerName: 'claude-code' } } });
      if (block.type === 'tool_use') {
        const name = text(block.name), input = block.input && typeof block.input === 'object' ? block.input : {};
        const activity: Row = { id: block.id, kind: 'tool.started', summary: name, turnId, sequence: ++sequence, createdAt: date, tone: 'tool',
          payload: { itemType: name === 'Bash' ? 'command_execution' : name === 'Read' ? 'file-read' : 'dynamic_tool_call', title: name,
            status: 'unknown', detail: claudeToolInput(name, input), data: { providerName: 'claude-code', tool: name, input, inputDetail: claudeToolInput(name, input).slice(0, 16_000), ...(name === 'Bash' ? { command: text(input.command) } : {}) } } };
        tools.set(block.id, activity); activities.push(activity);
      } else if (block.type === 'tool_result') {
        const activity = tools.get(block.tool_use_id);
        if (activity) { activity.kind = 'tool.completed'; activity.payload.status = block.is_error ? 'failed' : 'completed';
          const paths = images?.capture(id, block.content) ?? [];
          if (paths.length) activity.payload.data.toolImages = paths;
          activity.payload.detail = claudeToolResult(activity.payload.data.tool, block.content, undefined); }
      }
    }
  }
  activities.push({ id: `history-status-${id}`, kind: 'claude.desktop-sync.updated', summary: 'Existing Claude Code history', turnId: null,
    sequence: ++sequence, createdAt: iso(info.lastModified), tone: 'info', payload: { status: 'history', readOnly: true,
      detail: 'Read-only history. Continue this session in Claude Desktop. Live execution status is not available.' } });
  return { messages, activities, latestUserMessageAt: lastUser, checkpoints: [], proposedPlans: [] };
}
