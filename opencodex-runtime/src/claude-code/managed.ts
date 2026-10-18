import { query, forkSession, type Query, type ModelInfo, type SDKMessage, type PermissionResult, type PermissionUpdate, type SDKUserMessage, type EffortLevel, type SpawnOptions, type ElicitationResult, type OnElicitation } from '@anthropic-ai/claude-agent-sdk';
import { getCcrEvent } from '@anthropic-ai/claude-agent-sdk/browser';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFile } from '../config';
import { redactSecretString } from '../lib/redact';
import { commandInvocation } from '../lib/win-exec';
import { stageAndroidAttachments, type StagedAndroidAttachments } from '../android-remote/attachments';
import { createProjectedThreadStreamState, projectedThreadBoundedSnapshot, readProjectedOlderPage } from '../android-remote/thread-stream';
import { claudeInputQueue, connectDesktop, interruptClaude } from './desktop-sync';
import { claudeVerificationIssue } from './verification';
import { claudeFileChange, claudeToolInput, claudeToolResult, claudeToolText } from './tool-presentation';
import { ClaudeHistory, localClaudeHistory, emptyClaudeHistory, type ClaudeHistoryReader } from './history';
import { projectedTurnWorkPage } from '../android-remote/thread-work-page';
import { claudeCapabilities } from './capabilities';
import { createClaudeWorktree, restoreFingerprint } from './session-files';
import { claudeUserText, isClaudeControlMessage } from './user-message';
import { claudeElicitationForm, type ClaudeElicitationForm } from './elicitation';
import { ClaudeAutoConnect } from './auto-connect';
import { ClaudeToolImages } from './tool-images';
import { claudeThinkingSummary, hasClaudeThinkingSummary } from './thinking-summary';
import { ClaudeUsageReader } from './usage';
import { claudeModelLabels } from './model-presentation';
import { ClaudeSyncRecovery, canRecoverClaudeSync } from './sync-recovery';
import { connectRemoteClient, existingBridgeId, type RemoteClientConnect } from './remote-client';
import { claudeQueuedMessages, consumedClaudePromptIds, validateClaudeFollowUp, type ClaudeQueuedPrompt, type ClaudePromptDelivery } from './follow-ups';

type Row = Record<string, any>;
type StoredThread = { version: 1; nativeId: string; resumed: boolean; thread: Row; commands: string[]; permissionRules?: string[]; bridgeId?: string; userUuids?: string[]; storageId?: string; previousNativeIds?: string[]; external?: boolean; remoteEventUuids?: string[]; remoteSequence?: number;
  followUps?: ClaudeQueuedPrompt[]; deliveries?: ClaudePromptDelivery[]; queuePaused?: string; activePromptUuid?: string;
  fileCheckpoints?: { id: string; label: string }[]; syncPaused?: boolean; branchImportPending?: boolean };
type Pending = { threadId: string; input: Row; name: string; toolCallId?: string; cleanup: () => void } & (
  { kind: 'tool'; suggestions?: PermissionUpdate[]; resolve: (value: PermissionResult) => void } |
  { kind: 'elicitation'; form: ClaudeElicitationForm; resolve: (value: ElicitationResult | null) => void }
);
const isUserInput = (pending: Pending) => pending.kind === 'elicitation' || pending.name === 'AskUserQuestion';
export const CLAUDE_CODE_AGENT = 'claude-code';
const INSTANCE = 'claude-code';
const MAX_ACTIVE = 4;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const now = () => new Date().toISOString();
const str = (value: unknown) => typeof value === 'string' ? value : '';
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const safeError = (error: unknown) => redactSecretString(error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Match the shared transcript contract without changing the Codex adapter. */
function toolPresentation(name: string, input: Row) {
  const path = str(input.file_path);
  const isChange = ['Write', 'Edit', 'MultiEdit'].includes(name);
  const itemType = name === 'Bash' ? 'command_execution' : name === 'Read' ? 'file-read'
    : isChange ? 'dynamic_tool_call' : ['Grep', 'Glob'].includes(name) ? 'codebase-search'
    : name === 'WebSearch' ? 'web_search' : 'dynamic_tool_call';
  return {
    itemType, title: ['Read', 'Write', 'Edit', 'MultiEdit'].includes(name) && path ? `${name === 'MultiEdit' ? 'Edit' : name} ${basename(path)}` : name === 'AskUserQuestion' ? 'Question' : name === 'ExitPlanMode' ? 'Review plan' : name,
    ...(name === 'Read' && path ? { readFiles: [path] } : {}),
    data: {
      tool: name, input, providerName: INSTANCE,
      inputDetail: claudeToolInput(name, input).slice(0, 16_000),
      ...(name === 'Bash' ? { command: str(input.command) } : {}),
    },
  };
}

function approvalDetail(name: string, input: Row): string {
  const path = str(input.file_path);
  if (name === 'ExitPlanMode') return (str(input.plan) || 'Claude is asking to leave plan mode and begin implementation.').slice(0, 16_000);
  if (name === 'Bash') return str(input.command).slice(0, 16_000);
  if (path) {
    const content = name === 'Write' ? str(input.content) : name === 'Edit'
      ? `Replace:\n${str(input.old_string)}\n\nWith:\n${str(input.new_string)}` : '';
    return `${name} ${path}${content ? `\n\n${content}` : ''}`.slice(0, 16_000);
  }
  return `${name}\n${JSON.stringify(input)}`.slice(0, 16_000);
}

/** Own local workers only for Remodex chats; existing Desktop chats use a remote client. */
export class ManagedClaudeCode {
  private threads = new Map<string, StoredThread>();
  private projects = new Map<string, Row>();
  private active = new Map<string, { query: Query; stopped: boolean; persistent: boolean; parked?: boolean; intentionalDisconnect?: boolean; backgroundTasks?: number; backgroundTaskIds?: Set<string>; flushResult?: () => void; abort?: AbortController; awaitingStart?: boolean; sentAt?: number; remoteEvents?: Set<string>; inbox: ReturnType<typeof claudeInputQueue>; done?: Promise<void> }>();
  private syncRecovery = new ClaudeSyncRecovery(id => this.reconnectStaleSync(id));
  private recoverySlots = new Set<string>();
  private capabilityInit = new Map<string, { query: Query; value: Row }>();
  private capabilityReads = new Map<string, { query: Query; promise: Promise<Row> }>();
  private usageReader = new ClaudeUsageReader();
  private sessionActions = new Map<string, Promise<Row>>();
  private branchImports = new Map<string, Promise<void>>();
  private restorePreviews = new Map<string, { threadId: string; clientId: string; point: string; query: Query; updatedAt: string; fingerprint: string; files: string[]; expires: number }>();
  private recovering = new Set<string>();
  private starting = new Set<string>();
  private desktopSync = false;
  private restoring: Promise<void> | null = null;
  private closing = false;
  private restoreAttempted = false;
  private pending = new Map<string, Pending>();
  private streamMessageIds = new Map<string, string>();
  private streamSummaryModels = new Map<string, string>();
  private mutations = new Map<string, Promise<{ sequence: number }>>();
  private threadMutations = new Map<string, Promise<unknown>>();
  private queueTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private sequence = Date.now();
  private models: ModelInfo[] = [];
  private history: ClaudeHistory;
  private toolImages: ClaudeToolImages;
  private historyTimer: ReturnType<typeof setInterval> | null = null;
  private workerGate: Promise<void> = Promise.resolve();
  private viewed = new Map<string, number>();
  private userTextReconciled = new Set<string>();
  private catalog: Promise<void> | null = null;
  private catalogAt = 0;
  private account: Row = {};
  private error: string | null = null;
  private enabled = false;
  private binary = '';
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly root: string, private readonly sdkQuery: typeof query = query, historyReader: ClaudeHistoryReader = sdkQuery === query ? localClaudeHistory : emptyClaudeHistory, private readonly sdkFork: typeof forkSession = forkSession, private readonly remoteConnect: RemoteClientConnect = connectRemoteClient, private readonly findBridge = existingBridgeId, private readonly autoConnect = new ClaudeAutoConnect()) {
    this.toolImages = new ClaudeToolImages(join(root, 'tool-images'));
    this.history = new ClaudeHistory(historyReader, this.toolImages);
    const settings = this.readJson(join(root, 'settings.json'));
    this.enabled = settings.enabled === true;
    this.desktopSync = settings.desktopSync === true;
    this.binary = str(settings.binary);
    for (const p of Array.isArray(settings.projects) ? settings.projects : []) this.projects.set(p.id, p);
    if (existsSync(join(root, 'sessions'))) for (const name of readdirSync(join(root, 'sessions'))) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
      const saved = this.readJson(join(root, 'sessions', name)) as StoredThread;
      if (saved.version !== 1 || !saved.nativeId || !saved.thread?.id) continue;
      const t = saved.thread;
      // Old versions used cumulative session token totals as a context reading.
      // Usage is live status; refresh it instead of restoring an old account/window.
      t.activities = (t.activities ?? []).filter((a: Row) => !['context-window.updated', 'provider.usage.updated'].includes(a.kind));
      for (const activity of t.activities ?? []) if (activity.kind === 'claude.desktop-sync.updated') {
        if (activity.payload?.status === 'parked') saved.syncPaused = true;
        activity.payload = { ...activity.payload, status: saved.syncPaused ? 'parked' : 'disconnected', ...(saved.external ? { readOnly: true } : {}) };
      }
      if (saved.external) t.session = { ...t.session, status: 'disconnected', activeTurnId: null };
      if (t.session?.status === 'running') {
        t.session = { ...t.session, status: 'idle', activeTurnId: null, lastError: 'The PC restarted. Send a message to resume this session.' };
        if (t.latestTurn) t.latestTurn = { ...t.latestTurn, state: 'interrupted', completedAt: now() };
      }
      // Upgrade only our saved Claude presentation, never reconstruct missing patches from disk.
      for (const a of t.activities ?? []) if (a.kind.startsWith('tool.') && a.payload?.data?.tool) {
        const p = a.payload; p.data.providerName = INSTANCE;
        p.data.inputDetail = claudeToolInput(p.data.tool, row(p.data.input)).slice(0, 16_000);
        if (p.status === 'failed' && /user (?:denied|declined|rejected)|user doesn't want to proceed/.test(str(p.detail).toLowerCase())) {
          p.status = 'declined'; p.detail = 'You declined this action.'; a.tone = 'tool';
        }
        if (['declined', 'stopped', 'failed'].includes(p.status) && ['Write', 'Edit', 'MultiEdit'].includes(p.data.tool)) {
          p.itemType = 'dynamic_tool_call'; delete p.data.changes; delete p.fileChanges;
        }
        if (str(p.detail).startsWith('[')) try {
          const blocks = JSON.parse(p.detail);
          if (Array.isArray(blocks) && blocks.length && blocks.every(b => ['text', 'tool_reference', 'image', 'document', 'resource_link'].includes(b?.type))) p.detail = claudeToolText(blocks);
        } catch { /* Ordinary tool text is not JSON. */ }
      }
      t.hasPendingApprovals = false; t.hasPendingUserInput = false;
      this.finishProgress(t, 'stopped');
      for (const m of t.messages ?? []) m.streaming = false;
      // A restart cannot establish whether an offered steer reached Claude. Keep
      // its prompt visible, but never replay an ambiguous delivery automatically.
      for (const delivery of saved.deliveries ?? []) if (delivery.state === 'offered' && delivery.steer) {
        saved.followUps ??= [];
        if (!saved.followUps.some(entry => entry.id === delivery.messageId)) saved.followUps.push({ ...delivery.steer, uncertain: true });
        t.messages = t.messages.filter((m: Row) => m.id !== delivery.messageId);
      }
      for (const entry of saved.followUps ?? []) if (entry.attempted) entry.uncertain = true;
      if (saved.followUps?.length) {
        saved.queuePaused = 'Queue paused after the PC bridge restarted. Check the chat before sending queued work.';
        this.activity(t, `queue-${t.id}`, 'claude.queue.updated', 'Queued messages paused', { status: 'warning', detail: saved.queuePaused }, 'info');
      }
      // A pending permission belongs to the old process and is never replayed as actionable.
      t.activities = (t.activities ?? []).filter((a: Row) => !['approval.requested', 'user-input.requested'].includes(a.kind));
      this.threads.set(t.id, saved);
    }
  }

  private readJson(path: string): Row {
    if (!existsSync(path)) return {};
    if (statSync(path).size > MAX_FILE_BYTES) throw new Error('Claude Code state exceeds the storage limit');
    return row(JSON.parse(readFileSync(path, 'utf8')));
  }
  private write(path: string, value: unknown) {
    mkdirSync(join(this.root, 'sessions'), { recursive: true, mode: 0o700 });
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('This session reached the Remodex history limit. Start a new session.');
    atomicWriteFile(path, text);
  }
  private saveSettings() { this.write(join(this.root, 'settings.json'), { enabled: this.enabled, binary: this.binary, desktopSync: this.desktopSync, projects: [...this.projects.values()] }); }
  private save(s: StoredThread) { this.write(join(this.root, 'sessions', `${s.storageId ?? s.nativeId}.json`), s); }
  onChange(listener: () => void) {
    this.listeners.add(listener);
    this.historyTimer ??= setInterval(() => { void this.refreshHistory().catch(() => {}); }, 5000);
    this.historyTimer.unref?.();
    return () => { this.listeners.delete(listener); if (!this.listeners.size && this.historyTimer) { clearInterval(this.historyTimer); this.historyTimer = null; } };
  }
  async refreshHistory(force = false) {
    if (await this.history.refresh(new Set([...this.threads.values()].filter(s => !s.external).flatMap(s => [s.nativeId, ...(s.previousNativeIds ?? [])])), force)) this.changed();
  }
  async readDetail(id: string) {
    if (!this.threads.has(id)) return { snapshotSequence: this.sequence, thread: await this.history.detail(id, [...this.projects.values()]) };
    const s = this.threads.get(id)!;
    if (s.branchImportPending) await this.loadBranchHistory(s);
    if (s.external && !this.userTextReconciled.has(id) && this.history.has(id)) {
      // Migrate saved display text once, not on each streaming update. A missing
      // or oversized original must not make an already-saved chat disappear.
      const history = await this.history.detail(id, [...this.projects.values()]).catch(() => null);
      this.userTextReconciled.add(id);
      if (history && this.reconcileUserMessageText(s, history.messages)) { this.save(s); this.changed(); }
    }
    return this.detail(id);
  }
  private reconcileUserMessageText(s: StoredThread, messages: Row[]): boolean {
    // Repair older Remodex projections from the original structured transcript,
    // including Android's optimistic IDs. Never rewrite Claude's own files.
    const existing = new Map(s.thread.messages.filter((m: Row) => m.role === 'user').map((m: Row) => [m.id, m] as const));
    let changed = false;
    for (const m of messages) if (m.role === 'user') {
      const id = s.deliveries?.find(d => d.uuid === m.id)?.messageId ?? m.id;
      const old = existing.get(id) as Row | undefined;
      if (old && old.text !== m.text) { old.text = m.text; changed = true; }
    }
    return changed;
  }
  private loadBranchHistory(s: StoredThread): Promise<void> {
    const id = s.thread.id;
    const pending = this.branchImports.get(id); if (pending) return pending;
    const work = (async () => {
      const history = await this.history.branchDetail(s.nativeId, s.thread.worktreePath, id, [...this.projects.values()]);
      const thread = { ...s.thread, messages: history.messages,
        activities: history.activities.filter((a: Row) => a.kind !== 'claude.desktop-sync.updated'),
        latestUserMessageAt: history.latestUserMessageAt,
        latestTurn: { turnId: history.messages.at(-1)?.turnId ?? randomUUID(), state: 'completed' } };
      const updated = { ...s, thread, branchImportPending: false, userUuids: history.messages.filter((m: Row) => m.role === 'user').map((m: Row) => m.id) };
      this.save(updated); Object.assign(s, updated); this.changed();
    })().finally(() => { this.branchImports.delete(id); });
    this.branchImports.set(id, work); return work;
  }
  async prepareThread(id: string): Promise<void> {
    this.viewed.set(id, Date.now());
    if (this.closing || this.recovering.has(id)) return;
    let s = this.threads.get(id);
    if (s?.branchImportPending) await this.loadBranchHistory(s);
    if (!s && this.history.has(id) && this.enabled && this.desktopSync) {
      const thread = structuredClone(await this.history.detail(id, [...this.projects.values()]));
      // Another subscription may have imported this session while history was loading.
      if (this.threads.has(id)) return this.prepareThread(id);
      s = { version: 1, nativeId: thread.nativeSessionId, resumed: true, thread, commands: [], external: true };
      thread.activities = thread.activities.filter((a: Row) => a.kind !== 'claude.desktop-sync.updated');
      thread.session = { threadId: id, providerName: 'claude', providerInstanceId: INSTANCE, status: 'disconnected', statusConfidence: 'confirmed', activeTurnId: null };
      thread.latestTurn = { turnId: thread.messages.at(-1)?.turnId ?? randomUUID(), state: 'completed' };
      s.userUuids = thread.messages.filter((m: Row) => m.role === 'user').map((m: Row) => m.id);
      this.threads.set(id, s); this.save(s);
    }
    if (s?.external) {
      if (this.enabled && this.desktopSync && !this.active.has(id)) {
        s.syncPaused = false;
        try { await this.openRemote(s); } catch (error) { this.syncStatus(s, 'disconnected', safeError(error)); }
      }
      return;
    }
    if (this.recovering.has(id)) return;
    if (s?.resumed && s.bridgeId && !s.thread.archivedAt && !s.thread.deletedAt && this.desktopSync && this.enabled && !this.active.has(id)) {
      try { await this.openWorker(s); } catch (error) { this.syncStatus(s, 'disconnected', safeError(error)); }
    }
  }
  /** Explicit repair only: a rejected server identity cannot safely be revived by changing credentials. */
  async recoverDesktop(id: string, mode: string, commandId: string, clientId: string) {
    const result = await this.dispatch({ type: 'claude.desktop-sync.recover', threadId: id, mode, commandId }, clientId);
    const saved = this.requireThread(id);
    if (this.desktopState(saved) !== 'connected') throw new Error(str(saved.thread.activities.find((a: Row) => a.kind === 'claude.desktop-sync.updated')?.payload?.detail) || 'Claude Desktop is still disconnected. Open Status and retry.');
    return result;
  }
  private desktopState(s: StoredThread) {
    return s.thread.activities.find((a: Row) => a.kind === 'claude.desktop-sync.updated')?.payload?.status;
  }
  private async recoverLink(s: StoredThread, mode: string) {
    const id = s.thread.id;
    if (s.external) {
      if (mode !== 'retry') throw new TypeError('Existing Desktop chats keep their original identity. Open Remote Control in Desktop to reconnect.');
      s.syncPaused = false;
      await this.openRemote(s); return;
    }
    if (!this.desktopSync || !this.enabled) throw new TypeError('Enable Claude Desktop sharing first.');
    if (!['retry', 'replace'].includes(mode)) throw new TypeError('Choose retry or create a new Desktop link.');
    if (this.desktopState(s) === 'connected') return;
    if (this.recovering.has(id)) throw new TypeError('Desktop link recovery is already in progress.');
    if (s.thread.session.status === 'running' || [...this.pending.values()].some(p => p.threadId === id)) throw new TypeError('Finish or stop the task before repairing its Desktop link.');
    if (s.thread.archivedAt || s.thread.deletedAt || !s.resumed) throw new TypeError('Open a saved active chat first.');
    this.recovering.add(id);
    try {
      await this.disconnectIdle(id);
      s.syncPaused = false;
      if (mode === 'replace' && s.bridgeId) {
        // The SDK copies history into a new native session. Never edit or replay the original transcript.
        const oldId = s.nativeId;
        const fork = await this.sdkFork(oldId, { dir: s.thread.worktreePath, title: s.thread.title });
        if (!fork.sessionId || fork.sessionId === oldId) throw new Error('Claude did not create a separate recovery session.');
        const updated = { ...s, storageId: s.storageId ?? oldId, nativeId: fork.sessionId,
          previousNativeIds: [...(s.previousNativeIds ?? []), oldId], bridgeId: undefined,
          thread: { ...s.thread, nativeSessionId: fork.sessionId } };
        // Commit the new resumable identity before starting its worker; a failed share can then be retried without another fork.
        this.save(updated); Object.assign(s, updated);
      }
      if (this.closing || !this.enabled || !this.desktopSync) throw new Error('Claude Desktop sharing stopped during recovery. Reopen the chat and retry.');
      await this.openWorker(s);
    } finally { this.recovering.delete(id); }
  }
  private changed() {
    this.sequence += 1;
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => { this.notifyTimer = null; for (const listener of this.listeners) listener(); }, 60);
    this.notifyTimer.unref?.();
  }
  syncSettings() {
    return { enabled: this.enabled, desktopSync: this.desktopSync, autoConnect: this.autoConnect.status(), connection: this.connectionStatus() };
  }
  private connectionStatus() {
    const sessions = [...this.threads.values()].filter(s => !s.thread.archivedAt && !s.thread.deletedAt);
    const issues = sessions.map(s => s.thread.activities.find((a: Row) => a.kind === 'claude.desktop-sync.updated')?.payload)
      .filter(p => p?.status !== 'connected').map(p => claudeVerificationIssue(p?.detail)).filter(Boolean);
    const accountIssue = claudeVerificationIssue(this.error);
    return {
      connectedSessions: sessions.filter(s => this.active.has(s.thread.id) && this.desktopState(s) === 'connected').length,
      verificationRequiredSessions: issues.length,
      verificationIssue: issues.includes('device-verification') || accountIssue === 'device-verification' ? 'device-verification' : issues.includes('sign-in') || accountIssue === 'sign-in' ? 'sign-in' : null,
      // A connected worker cannot attest to a separate Desktop client's device verification.
      desktopVerification: 'unconfirmed' as const,
    };
  }
  async setAutoConnect(input: Row) {
    if (Object.keys(input).length !== 1 || typeof input.enabled !== 'boolean') throw new TypeError('Provide only the automatic sync enabled boolean.');
    if (this.recovering.size || this.starting.size) throw new Error('Wait for Claude session startup or recovery to finish before changing sync.');
    if (input.enabled && !this.desktopSync && this.runningCount()) throw new Error('Finish Claude tasks before enabling Desktop sharing for the first time.');
    // Enabling discovery also enables Remodex's existing sharing path. Turning this
    // preference off never disconnects a worker or disables Android-created chats.
    const result = this.autoConnect.set(input.enabled);
    if (input.enabled) {
      if (!this.desktopSync) await this.disconnectIdle();
      this.desktopSync = true; this.enabled = true; this.restoreAttempted = false;
      this.saveSettings();
    }
    this.changed();
    return { ...this.syncSettings(), autoConnect: result };
  }
  async configure(input: Row) {
    if ('autoConnectNewSessions' in input) {
      if (Object.keys(input).length !== 1) throw new TypeError('Change automatic sync separately from other settings.');
      await this.setAutoConnect({ enabled: input.autoConnectNewSessions });
      return this.status();
    }
    if (this.recovering.size) throw new TypeError('Wait for Claude Desktop link recovery to finish before changing setup.');
    if (input.enabled === false && this.runningCount()) throw new Error('Stop or finish Claude Code tasks before disabling it.');
    if (typeof input.binary === 'string') {
      if (this.runningCount()) throw new Error('Finish Claude Code tasks before changing its executable.');
      const path = input.binary.trim();
      if (path && (!isAbsolute(path) || !existsSync(path))) throw new TypeError('Choose an installed Claude Code executable using its full path.');
      this.binary = path;
    }
    if (typeof input.desktopSync === 'boolean' && input.desktopSync !== this.desktopSync) {
      if (this.runningCount()) throw new Error('Finish Claude Code tasks before changing Desktop sync.');
      await this.disconnectIdle(); this.desktopSync = input.desktopSync; this.restoreAttempted = false;
    }
    if (input.enabled === false || typeof input.binary === 'string') await this.disconnectIdle();
    if (typeof input.enabled === 'boolean') this.enabled = input.enabled;
    this.catalogAt = 0; this.saveSettings(); this.changed();
    return this.status(true);
  }
  private runningCount() { return [...this.threads.values()].filter(s => !s.external && s.thread.session?.status === 'running').length; }
  private async disconnectIdle(id?: string, forRecovery = false) {
    for (const [threadId, worker] of this.active) if ((!id || id === threadId) && (this.requireThread(threadId).external || this.requireThread(threadId).thread.session.status !== 'running')) {
      worker.intentionalDisconnect = true;
      if (!forRecovery) { this.recoverySlots.delete(threadId); this.syncRecovery.cancel(threadId); }
      worker.inbox.close(); worker.abort?.abort(); worker.query.close(); await worker.done;
    }
  }
  private syncStatus(s: StoredThread, status: string, error?: string) {
    const previous = s.thread.activities.find((a: Row) => a.kind === 'claude.desktop-sync.updated')?.payload;
    const detail = status === 'connected' ? undefined : error ?? previous?.detail;
    const verificationIssue = claudeVerificationIssue(detail);
    this.activity(s.thread, `desktop-sync-${s.storageId ?? s.nativeId}`, 'claude.desktop-sync.updated', 'Claude Desktop sync', {
      status, ...(s.external ? { existingSession: true, readOnly: status !== 'connected' } : {}),
      ...(detail ? { detail } : {}), ...(verificationIssue ? { verificationIssue } : {}),
    }, 'info');
    this.save(s);
    if (status === 'connected' || status === 'parked') {
      this.recoverySlots.delete(s.thread.id); this.syncRecovery.cancel(s.thread.id);
    } else if (status === 'disconnected') {
      const worker = this.active.get(s.thread.id);
      if (this.shouldRecoverSync(s) && !worker?.intentionalDisconnect && canRecoverClaudeSync(detail)) {
        if (worker && !s.external) this.recoverySlots.add(s.thread.id);
        this.syncRecovery.schedule(s.thread.id, detail);
      } else {
        this.recoverySlots.delete(s.thread.id); this.syncRecovery.cancel(s.thread.id);
      }
    }
  }
  private shouldRecoverSync(s: StoredThread) {
    return this.enabled && this.desktopSync && !this.closing && !!s.bridgeId && s.resumed && !s.syncPaused && !s.thread.archivedAt && !s.thread.deletedAt;
  }
  private async reconnectStaleSync(id: string): Promise<'connected' | 'defer' | 'cancel'> {
    const s = this.threads.get(id);
    if (!s || !this.shouldRecoverSync(s)) return 'cancel';
    if (this.desktopState(s) === 'connected') return 'connected';
    if (this.desktopState(s) === 'connecting' && this.active.has(id)) return 'defer';
    const detail = s.thread.activities.find((a: Row) => a.kind === 'claude.desktop-sync.updated')?.payload?.detail;
    if (!canRecoverClaudeSync(detail)) return 'cancel';
    if (this.recovering.has(id) || this.starting.has(id) || this.remoteOpening.has(id)) return 'defer';
    const worker = this.active.get(id);
    // A lost client can rejoin a Desktop-owned running task. An owned live worker
    // must finish its turn/tools first; recovery must never interrupt useful work.
    if (!s.external && (s.thread.session.status === 'running' || worker?.backgroundTasks || s.thread.hasPendingApprovals || s.thread.hasPendingUserInput)) return 'defer';
    if (!s.external && !worker && this.ownedWorkerCount() >= MAX_ACTIVE) return 'defer';
    this.recovering.add(id);
    try {
      if (s.external) {
        if (worker) await this.disconnectIdle(id, true);
        await this.openRemote(s);
      } else {
        // Reuse the saved native and bridge IDs. No fork, prompt, permission or
        // queue is replayed. A stale live worker is replaced only while idle.
        this.disconnectedQueue(s);
        if (worker) await this.disconnectIdle(id, true);
        if (!this.shouldRecoverSync(s)) return 'cancel';
        const opened = await this.openWorker(s, true);
        if (!opened) return 'defer';
      }
      if (this.desktopState(s) !== 'connected') throw new Error(str(s.thread.activities.find((a: Row) => a.kind === 'claude.desktop-sync.updated')?.payload?.detail) || 'Claude sync is still disconnected.');
      return 'connected';
    } catch (error) {
      this.syncStatus(s, 'disconnected', safeError(error));
      throw error;
    } finally { this.recovering.delete(id); }
  }
  // Resume only our previously linked workers, without replaying any prompt or approval.
  private restoreDesktop() {
    if (!this.enabled || !this.desktopSync || this.closing || this.restoring || this.restoreAttempted) return this.restoring;
    this.restoreAttempted = true;
    this.restoring = (async () => {
      const saved = [...this.threads.values()].sort((a, b) => Date.parse(b.thread.updatedAt) - Date.parse(a.thread.updatedAt));
      for (const s of saved) {
        if (!this.shouldRecoverSync(s) || this.active.has(s.thread.id)) continue;
        const detail = s.thread.activities.find((a: Row) => a.kind === 'claude.desktop-sync.updated')?.payload?.detail;
        if (!canRecoverClaudeSync(detail)) continue;
        this.syncRecovery.schedule(s.thread.id, detail);
        if (s.external || this.ownedWorkerCount() >= MAX_ACTIVE) continue;
        try { await this.openWorker(s, true); } catch (error) { this.syncStatus(s, 'disconnected', safeError(error)); }
      }
    })().finally(() => { this.restoring = null; });
    return this.restoring;
  }
  private executable() {
    const path = this.binary || Bun.which('claude') || [
      join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
      join(homedir(), '.claude', 'local', 'claude'),
    ].find(candidate => existsSync(candidate));
    if (!path) throw new Error('Install Claude Code on this PC, run claude auth login with your subscription, then refresh.');
    return path;
  }
  private environment() {
    const env = { ...process.env };
    // Never silently charge a separate API account or inherit Remodex proxy routing.
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
    return env;
  }
  private processOptions() {
    return { pathToClaudeCodeExecutable: this.executable(), env: this.environment(),
      spawnClaudeCodeProcess: (o: SpawnOptions) => {
        const invocation = commandInvocation(o.command, o.args, process.platform, { env: o.env });
        const child = spawn(invocation.file, invocation.args, { ...invocation.options, cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: o.signal });
        child.stderr?.resume(); return child;
      },
    };
  }
  async status(refresh = false): Promise<Row> {
    if (this.enabled) await this.loadCatalog(refresh);
    if (this.enabled && !this.error) void this.restoreDesktop()?.catch(() => {});
    let installed = false; try { installed = Boolean(this.executable()); } catch { /* setup required */ }
    return { autoConnect: this.autoConnect.status(), connection: this.connectionStatus(), enabled: this.enabled, installed, ready: this.enabled && !this.error && this.models.length > 0,
      error: this.error, account: this.account, activeSessions: this.runningCount(), desktopSync: this.desktopSync, connectedSessions: [...this.active.keys()].filter(id => this.desktopState(this.requireThread(id)) === 'connected').length, binary: this.binary,
      setupCommand: 'claude auth login', models: this.models.map(m => ({ id: m.value, name: claudeModelLabels(m, this.models).name })) };
  }
  private async loadCatalog(refresh = false) {
    if (!refresh && this.catalogAt > Date.now() - 60_000) return;
    if (this.catalog) return this.catalog;
    this.catalog = (async () => {
      let probe: Query | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        async function* empty(): AsyncGenerator<SDKUserMessage> { /* no prompt, no paid turn */ }
        probe = this.sdkQuery({ prompt: empty(), options: { ...this.processOptions(), cwd: this.root, settingSources: [], tools: [], settings: { remoteControlAtStartup: false }, strictMcpConfig: true, mcpServers: {} } });
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Claude Code did not respond. Check its installation and login on the PC.')), 12_000); });
        const [models, account] = await Promise.race([Promise.all([probe.supportedModels(), probe.accountInfo()]), timeout]);
        if (account.apiProvider !== 'firstParty' || !account.subscriptionType) throw new Error('Sign in to Claude Code with your Claude subscription: claude auth login');
        this.models = models; this.account = { subscriptionType: account.subscriptionType }; this.error = null;
      } catch (error) { this.error = safeError(error); this.models = []; }
      finally { if (timer) clearTimeout(timer); probe?.close(); this.catalogAt = Date.now(); this.catalog = null; }
    })();
    return this.catalog;
  }
  async config(environment: Row, auth: Row, connection: unknown, refresh = false): Promise<Row> {
    const status = await this.status(refresh);
    const models = this.models.map(m => ({ slug: m.value, ...claudeModelLabels(m, this.models), isCustom: false, description: m.description,
      capabilities: { optionDescriptors: m.supportedEffortLevels?.length ? [{ id: 'effort', label: 'Reasoning', type: 'select',
        // Let Claude resolve its per-model/user default rather than forcing High
        // on models whose standard effort is lower. Explicit choices still win.
        currentValue: 'auto',
        options: [{ id: 'auto', label: 'Auto' }, ...m.supportedEffortLevels.map(id => ({ id, label: id === 'xhigh' ? 'Extra high' : id[0]!.toUpperCase() + id.slice(1) }))] }] : [] } }));
    return { environment, auth, cwd: homedir(), keybindingsConfigPath: '', keybindings: [], issues: [], availableEditors: [],
      providers: [{ instanceId: INSTANCE, driver: 'claude', displayName: 'Claude Code', enabled: this.enabled, installed: status.installed,
        status: status.ready ? 'ready' : 'error', version: null, auth: { status: status.ready ? 'authenticated' : 'unknown', type: 'Claude subscription' },
        message: this.enabled ? (this.error || "Claude Code is ready.") : 'Enable Claude Code in the Remodex dashboard.', checkedAt: now(), availability: status.ready ? 'available' : 'unavailable',
        showInteractionModeToggle: true, models, skills: [], plugins: [], slashCommands: [] }],
      settings: { addProjectBaseDirectory: homedir(), providerInstances: { [INSTANCE]: { driver: 'claude', displayName: 'Claude Code', enabled: this.enabled } }, providers: { claude: { enabled: this.enabled } } },
      observability: { logsDirectoryPath: '', localTracingEnabled: false, otlpTracesEnabled: false, otlpMetricsEnabled: false }, remodexMobileConnection: connection };
  }
  shell(): Row {
    return { snapshotSequence: this.sequence, projects: [...this.projects.values(), ...this.history.projects([...this.projects.values()])], threads: [...this.threads.values()].filter(s => !s.thread.deletedAt).map(s => {
      const { messages, activities, checkpoints, proposedPlans, ...shell } = s.thread; return shell;
    }).concat(this.history.shells([...this.projects.values()]).filter(t => !this.threads.has(t.id))), nativeProjects: [], nativeThreads: [], updatedAt: now() };
  }
  detail(id: string): Row {
    const s = this.threads.get(id); const t = s?.thread ?? this.history.cachedDetail(id);
    if (!t) throw new TypeError('Claude Code session not found');
    return { snapshotSequence: this.sequence, thread: s?.followUps?.length
      ? { ...t, messages: [...t.messages, ...claudeQueuedMessages(s.followUps)] } : t };
  }
  private requireThread(id: string) { const s = this.threads.get(id); if (!s) throw new TypeError('Claude Code session not found'); return s; }
  snapshot(id: string): Row { return projectedThreadBoundedSnapshot(createProjectedThreadStreamState(this.detail(id), this.sequence)); }
  async page(params: Row) { const detail = await this.readDetail(str(params.threadId)); return readProjectedOlderPage(createProjectedThreadStreamState(detail, this.sequence), str(params.cursor), async () => detail, 10); }
  work(params: Row) { return projectedTurnWorkPage(this.detail(str(params.threadId)).thread, str(params.turnId), str(params.cursor) || undefined); }
  workspace(id: string): string { return this.detail(id).thread.worktreePath; }
  async toolImagePath(id: string, path: string): Promise<string> {
    const detail = await this.readDetail(id);
    const images = detail.thread.activities.flatMap((a: Row) =>
      a.payload?.data?.providerName === INSTANCE && Array.isArray(a.payload.data.toolImages) ? a.payload.data.toolImages : []);
    if (!isAbsolute(path) || !images.includes(path)) throw new TypeError('This image was not returned by a tool in this Claude chat.');
    return path;
  }

  async capabilities(id: string): Promise<Row> {
    const worker = this.active.get(id);
    if (!worker) return { status: 'unavailable', ...claudeCapabilities({}, [], []) };
    const pending = this.capabilityReads.get(id); if (pending?.query === worker.query) return pending.promise;
    const entry = { query: worker.query, promise: Promise.resolve<Row>({}) };
    // A UI timeout does not cancel an SDK control. Keep its single-flight entry
    // until the actual controls settle, or menu retries retain more callbacks.
    // allSettled also prevents a failed command read from releasing a hung MCP read.
    const work = Promise.allSettled([
      Promise.resolve().then(() => worker.query.supportedCommands()),
      Promise.resolve().then(() => worker.query.mcpServerStatus()),
    ]).then(([commandsResult, serversResult]) => {
      if (commandsResult.status === 'rejected') throw commandsResult.reason;
      if (serversResult.status === 'rejected') throw serversResult.reason;
      const commands = commandsResult.value, servers = serversResult.value;
      if (this.active.get(id)?.query !== worker.query) return { status: 'unavailable', ...claudeCapabilities({}, [], []) };
      // A resumed worker may not replay system/init until its next turn.
      const init = this.capabilityInit.get(id);
      const metadata = init?.query === worker.query ? init.value : { skills: commands.map(command => command.name) };
      return { status: 'ready', pluginsReported: Array.isArray(metadata.plugins), ...claudeCapabilities(metadata, commands, servers) };
    }).finally(() => {
      if (this.capabilityReads.get(id) === entry) this.capabilityReads.delete(id);
    });
    entry.promise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Claude capabilities are temporarily unavailable.')), 5000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    })();
    this.capabilityReads.set(id, entry); return entry.promise;
  }

  async refreshUsage(id: string): Promise<Row> {
    if (!this.enabled || this.closing) return { status: 'unavailable' };
    const s = this.threads.get(id);
    if (!s) return { status: 'unavailable' };
    const worker = this.active.get(id);
    const [context, limits] = await Promise.all([
      this.usageReader.context(worker?.query),
      this.usageReader.limits(() => {
        async function* empty(): AsyncGenerator<SDKUserMessage> { /* metadata only, no model turn */ }
        return this.sdkQuery({ prompt: empty(), options: { ...this.processOptions(), cwd: this.root,
          persistSession: false, settingSources: [], tools: [], settings: { remoteControlAtStartup: false }, strictMcpConfig: true, mcpServers: {} } });
      }),
    ]);
    if (!this.enabled || this.closing || this.threads.get(id) !== s) return { status: 'unavailable' };
    const currentContext = this.active.get(id)?.query === worker?.query ? context.value : null;
    this.activity(s.thread, `context-${id}`, 'context-window.updated', 'Context window updated', {
      providerName: INSTANCE, status: currentContext ? 'ready' : 'unavailable', checkedAt: context.checkedAt, ...currentContext,
    }, 'info');
    this.activity(s.thread, `usage-${id}`, 'provider.usage.updated', 'Claude usage limits updated', {
      providerName: INSTANCE, providerLabel: 'Claude', status: limits.value ? 'ready' : 'unavailable', checkedAt: limits.checkedAt,
      windows: limits.value ?? [],
    }, 'info');
    this.save(s);
    return { status: worker ? 'ready' : 'unavailable' };
  }

  async sessionAction(input: Row, clientId: string): Promise<Row> {
    const id = str(input.threadId), commandId = str(input.commandId);
    if (!this.enabled || !id || !commandId || commandId.length > 128) throw new TypeError('A Claude chat and command ID are required.');
    const key = `${clientId}:${id}:${commandId}`;
    const existing = this.sessionActions.get(key); if (existing) return existing;
    const action = this.serializeThread(id, async () => {
      const s = this.requireThread(id), t = s.thread;
      if (input.action === 'branchChat') {
        const prior = [...this.threads.values()].find(thread => thread.commands.includes(`${key}:branch`));
        if (prior) return { threadId: prior.thread.id };
      }
      if (input.action === 'checkpoints') return { points: s.external ? [] : [...(s.fileCheckpoints ?? [])].reverse(), external: s.external === true };
      const idle = () => {
        if (t.session?.status === 'running' || t.hasPendingApprovals || t.hasPendingUserInput || s.followUps?.length || this.active.get(id)?.backgroundTasks || this.starting.has(id) || this.recovering.has(id))
          throw new Error('Finish the task and clear queued messages before using this control.');
      };
      idle();
      if (input.action === 'branchChat') {
        if (s.external) throw new Error('Branching is available for chats started by Remodex. Continue this Desktop-owned chat through its existing connection.');
        if (!s.resumed || !t.messages.length || t.archivedAt || t.deletedAt) throw new Error('Send a message in an active Claude chat before branching it.');
        if (s.branchImportPending) await this.loadBranchHistory(s);
        const title = `${str(t.title).slice(0, 240)} (branch)`;
        const fork = await this.sdkFork(s.nativeId, { dir: t.worktreePath, title });
        if (!/^[a-f0-9-]{36}$/i.test(fork.sessionId) || [...this.threads.values()].some(thread => thread.nativeId === fork.sessionId || thread.previousNativeIds?.includes(fork.sessionId)))
          throw new Error('Claude did not create a separate branch session.');
        const threadId = randomUUID(), timestamp = now();
        const thread = { ...structuredClone(t), id: threadId, nativeSessionId: fork.sessionId, title,
          runtimeMode: 'approval-required', interactionMode: 'default', createdAt: timestamp, updatedAt: timestamp,
          archivedAt: null, deletedAt: null, latestTurn: null, latestUserMessageAt: null,
          hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
          session: { threadId, providerName: 'claude', providerInstanceId: INSTANCE, status: 'idle', statusConfidence: 'confirmed', runtimeMode: 'approval-required', activeTurnId: null, lastError: null, updatedAt: timestamp },
          messages: [], activities: [], checkpoints: [], proposedPlans: [] };
        // Persist the new identity before reading it. A read failure or restart must
        // retry this branch, never fork again or start an empty conversation.
        const created: StoredThread = { version: 1, nativeId: fork.sessionId, resumed: true, thread, commands: [`${key}:branch`], branchImportPending: true };
        this.save(created); this.threads.set(threadId, created); this.changed();
        return { threadId };
      }
      if (input.action === 'newWorktree') {
        const prior = [...this.threads.values()].find(thread => thread.commands.includes(`${key}:create`));
        if (prior) return { threadId: prior.thread.id, branch: prior.thread.branch };
        if (this.ownedWorkerCount() >= MAX_ACTIVE && !this.idleWorker()) throw new Error('Finish a running Claude task before creating another chat.');
        const tree = await createClaudeWorktree(t.worktreePath, this.root);
        const threadId = randomUUID();
        await this.dispatchOnce({ type: 'thread.create', threadId, projectId: t.projectId, runtimeMode: 'approval-required', modelSelection: t.modelSelection }, `${key}:create`, clientId);
        const created = this.requireThread(threadId);
        created.thread.title = 'New isolated Claude chat'; created.thread.branch = tree.branch; created.thread.worktreePath = tree.path;
        this.save(created); this.changed(); return { threadId, branch: tree.branch };
      }
      if (s.external && ['previewRestore', 'restoreFiles'].includes(input.action)) throw new Error('File restore is available for chats started by Remodex with checkpointing enabled.');
      if (input.action === 'previewRestore') {
        if (!s.fileCheckpoints?.some(p => p.id === input.point)) throw new TypeError('This checkpoint does not belong to this chat.');
        await this.openWorker(s); idle();
        const worker = this.active.get(id); if (!worker) throw new Error('Reconnect this chat before restoring files.');
        const result = await worker.query.rewindFiles(input.point, { dryRun: true });
        if (!result.canRewind) throw new Error(safeError(result.error || 'This checkpoint is no longer available.'));
        const files = result.filesChanged ?? [];
        if (!files.length) return { files: [], token: null };
        const fingerprint = await restoreFingerprint(t.worktreePath, files); idle();
        for (const [token, p] of this.restorePreviews) if (p.expires < Date.now()) this.restorePreviews.delete(token);
        const token = randomUUID();
        this.restorePreviews.set(token, { threadId: id, clientId, point: input.point, query: worker.query, updatedAt: t.updatedAt, fingerprint, files, expires: Date.now() + 60_000 });
        while (this.restorePreviews.size > 128) this.restorePreviews.delete(this.restorePreviews.keys().next().value!);
        return { token, files, insertions: result.insertions ?? 0, deletions: result.deletions ?? 0 };
      }
      if (input.action === 'restoreFiles') {
        const preview = this.restorePreviews.get(str(input.token)); this.restorePreviews.delete(str(input.token));
        const worker = this.active.get(id);
        if (!preview || preview.threadId !== id || preview.clientId !== clientId || preview.expires < Date.now() || preview.query !== worker?.query || preview.updatedAt !== t.updatedAt)
          throw new Error('The restore preview expired or this chat changed. Preview it again.');
        if (preview.fingerprint !== await restoreFingerprint(t.worktreePath, preview.files)) throw new Error('Project files changed after the preview. Review a new preview before restoring.');
        idle();
        const result = await worker.query.rewindFiles(preview.point);
        if (!result.canRewind) throw new Error(safeError(result.error || 'Claude could not restore these files.'));
        this.activity(t, randomUUID(), 'session.notice', 'Tracked files restored', { detail: 'Restored Claude-tracked file changes. Conversation history and Bash changes are kept.', skippedLinks: result.skippedLinks ?? 0 }, 'info');
        this.save(s); this.changed(); return { restored: true, skippedLinks: result.skippedLinks ?? 0 };
      }
      if (['mcpReconnect', 'mcpToggle', 'reloadPlugins', 'reloadSkills'].includes(input.action)) {
        const worker = this.active.get(id);
        if (!worker || s.external && this.desktopState(s) !== 'connected') throw new Error('Reconnect this chat before managing its tools.');
        if (input.action === 'mcpReconnect' || input.action === 'mcpToggle') {
          const catalog = await this.capabilities(id);
          const name = str(input.name);
          if (!catalog.mcpServers.some((server: Row) => server.name === name)) throw new TypeError('Select an MCP server configured in this chat.');
          idle();
          if (input.action === 'mcpReconnect') await worker.query.reconnectMcpServer(name);
          else {
            if (typeof input.enabled !== 'boolean') throw new TypeError('Provide the MCP enabled boolean.');
            await worker.query.toggleMcpServer(name, input.enabled);
          }
        } else {
          const reported = this.capabilityInit.get(id);
          const init = reported?.query === worker.query ? reported : { query: worker.query, value: {} as Row };
          if (input.action === 'reloadSkills') {
            const result = await worker.query.reloadSkills();
            init.value = { ...init.value, skills: result.skills.map(command => command.name) };
          } else {
            // Never install packages or change the Desktop application. A reload
            // only reads the user's already-installed Claude configuration.
            const result = await worker.query.reloadPlugins({ holdOnCacheImpact: true });
            if (result.held) return { held: true, detail: 'Claude kept the current tools to protect this conversation cache. Start a new chat to use the changed plugins.' };
            init.value = { ...init.value, plugins: result.plugins, skills: result.commands.map(command => command.name) };
            if (this.active.get(id)?.query !== worker.query) throw new Error('This chat reconnected. Refresh its tools again.');
            this.capabilityInit.set(id, init);
            if (result.error_count) { this.changed(); return { warning: 'Some plugins could not reload. Check their configuration on the PC.' }; }
          }
          if (this.active.get(id)?.query !== worker.query) throw new Error('This chat reconnected. Refresh its tools again.');
          this.capabilityInit.set(id, init);
        }
        this.changed(); return { updated: true };
      }
      throw new TypeError('Unknown Claude session control.');
    });
    this.sessionActions.set(key, action);
    try { return await action; } catch (error) { this.sessionActions.delete(key); throw error; }
    finally { while (this.sessionActions.size > 128) this.sessionActions.delete(this.sessionActions.keys().next().value!); }
  }

  async dispatch(command: Row, clientId: string) {
    if (!this.enabled) throw new TypeError('Enable Claude Code in the Remodex dashboard first.');
    const commandId = str(command.commandId);
    if (!commandId || commandId.length > 128) throw new TypeError('A command ID is required');
    // Draft answers already live on the phone. Do not rewrite a whole Claude
    // transcript or move the chat in Recents for every typed character.
    if (command.type === 'thread.user-input.draft.update') return { sequence: this.sequence };
    const key = `${clientId}:${commandId}`;
    const existing = this.mutations.get(key); if (existing) return existing;
    const saved = this.threads.get(str(command.threadId));
    if (saved?.commands.includes(key)) return { sequence: this.sequence };
    const mutation = this.serializeThread(str(command.threadId), () => this.dispatchOnce(command, key, clientId));
    this.mutations.set(key, mutation);
    try { return await mutation; } catch (e) { this.mutations.delete(key); throw e; }
    finally { while (this.mutations.size > 512) this.mutations.delete(this.mutations.keys().next().value!); }
  }
  private serializeThread<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.threadMutations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.threadMutations.set(id, next);
    void next.finally(() => { if (this.threadMutations.get(id) === next) this.threadMutations.delete(id); }).catch(() => {});
    return next;
  }
  private async dispatchOnce(c: Row, key: string, clientId: string) {
    if (c.type === 'project.create') {
      if (!str(c.projectId) || !isAbsolute(str(c.workspaceRoot))) throw new TypeError('Choose a project folder on the PC.');
      // Only an explicit Create folder action may create a missing directory.
      // Its browsed parent must already exist; never create a chain of typo paths.
      if (c.createWorkspaceRootIfMissing === true) {
        try { await mkdir(c.workspaceRoot); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new TypeError('The project folder could not be created. Check its parent folder and permissions.');
        }
      }
      let cwd: string;
      try {
        cwd = await realpath(c.workspaceRoot);
        if (!(await stat(cwd)).isDirectory()) throw new TypeError('Project folder is not a directory.');
      } catch { throw new TypeError('Choose an existing project folder, or use Create folder.'); }
      const timestamp = now();
      this.projects.set(c.projectId, { id: c.projectId, title: str(c.title) || basename(cwd), workspaceRoot: cwd, repositoryIdentity: null, defaultModelSelection: null, scripts: [], createdAt: timestamp, updatedAt: timestamp });
      this.saveSettings(); this.changed(); return { sequence: this.sequence };
    }
    if (c.type === 'thread.create') {
      if (!str(c.threadId) || str(c.threadId).length > 128) throw new TypeError('Session ID required');
      if (this.threads.has(c.threadId) || str(c.threadId).startsWith('claude-history-')) throw new TypeError('Session already exists or is read-only history.');
      if (this.ownedWorkerCount() >= MAX_ACTIVE && !this.idleWorker()) throw new TypeError('Four Claude Code tasks are running. Wait for one to finish or stop a task before creating another.');
      const project = this.projects.get(str(c.projectId)) ?? this.history.projects([...this.projects.values()]).find(p => p.id === str(c.projectId));
      if (!project) throw new TypeError('Select a Claude Code project folder before starting a task.');
      if (!this.projects.has(project.id)) { this.projects.set(project.id, project); this.saveSettings(); }
      const timestamp = now(); const nativeId = randomUUID();
      const thread: Row = { id: c.threadId, nativeSessionId: nativeId, projectId: project.id, title: 'New task',
        modelSelection: { instanceId: INSTANCE, model: str(c.modelSelection?.model) || 'sonnet', options: c.modelSelection?.options },
        runtimeMode: ['approval-required', 'auto-accept-edits', 'full-access'].includes(c.runtimeMode) ? c.runtimeMode : 'approval-required',
        interactionMode: c.interactionMode === 'plan' ? 'plan' : 'default', branch: null, worktreePath: project.workspaceRoot,
        latestTurn: null, createdAt: timestamp, updatedAt: timestamp, archivedAt: null, deletedAt: null,
        latestUserMessageAt: null, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false,
        source: { kind: 'remodex-projected' }, session: { threadId: c.threadId, providerName: 'claude', providerInstanceId: INSTANCE, status: 'idle', statusConfidence: 'confirmed', runtimeMode: c.runtimeMode, activeTurnId: null, lastError: null, updatedAt: timestamp },
        messages: [], activities: [], checkpoints: [], proposedPlans: [] };
      const saved: StoredThread = { version: 1, nativeId, resumed: false, thread, commands: [key] };
      this.save(saved); this.threads.set(c.threadId, saved); this.changed(); return { sequence: this.sequence };
    }
    if (this.history.has(str(c.threadId)) && !this.threads.has(str(c.threadId))) {
      await this.prepareThread(str(c.threadId));
      if (!this.threads.has(str(c.threadId))) throw new TypeError('This is read-only history. Enable Claude Desktop sharing to connect this existing session.');
    }
    const s = this.requireThread(str(c.threadId));
    if (s.branchImportPending) await this.loadBranchHistory(s);
    const t = s.thread;
    if (s.commands.includes(key)) return { sequence: this.sequence };
    if (this.recovering.has(t.id)) throw new TypeError('Desktop link recovery is in progress. Please wait.');
    if (c.type === 'claude.desktop-sync.recover') await this.recoverLink(s, str(c.mode));
    else if (c.type === 'thread.turn.start') {
      if (c.deliveryMode === 'queue' && (t.session.status === 'running' || s.followUps?.length)) this.enqueue(s, c, key, clientId);
      else if (c.deliveryMode === 'steer' && t.session.status === 'running') await this.steer(s, this.followUp(s, c, clientId), key);
      else { this.resumeQueue(s); await this.startTurn(s, c, key, clientId); }
    }
    else if (str(c.type).startsWith('thread.turn.queue.')) await this.queueAction(s, c, key);
    else if (c.type === 'thread.turn.interrupt' || c.type === 'thread.session.stop') {
      this.pauseQueue(s, 'Queue paused because you stopped the task. Send a new prompt or choose Steer instead to continue.');
      const active = this.active.get(t.id); if (active && t.session.status === 'running') { await this.interrupt(s); }
      else if (c.type === 'thread.session.stop') { s.syncPaused = true; this.syncRecovery.cancel(t.id); await this.disconnectIdle(t.id); }
    } else if (c.type === 'thread.approval.respond' || c.type === 'thread.user-input.respond') {
      const pending = this.pending.get(str(c.requestId));
      if (!pending || pending.threadId !== t.id) throw new TypeError('This request has expired.');
      if (pending.kind === 'elicitation') {
        if (c.type !== 'thread.user-input.respond') throw new TypeError('Answer the MCP form or stop the task.');
        const result = pending.form.answer(row(c.answers));
        pending.resolve(result);
        this.resolveRequest(c.requestId, s, c.answers);
      } else if (pending.name === 'AskUserQuestion') {
        const answers: Row = {}; for (const [index, q] of (pending.input.questions ?? []).entries()) {
          const value = c.answers?.[`question-${index}`];
          const answer = typeof value === 'string' || Array.isArray(value) ? value : value?.answers;
          const values = typeof answer === 'string' ? [answer] : answer;
          if (!Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string' || !v.trim())) throw new TypeError('Answer each question.');
          answers[q.question] = values.join(', ');
        }
        pending.resolve({ behavior: 'allow', updatedInput: { ...pending.input, answers } });
        this.resolveRequest(c.requestId, s, c.answers);
      } else {
        const remember = ['approved_for_session', 'acceptForSession'].includes(c.decision);
        const updates: PermissionUpdate[] = remember ? (pending.suggestions ?? [])
          .filter(update => update.type === 'addRules' && update.behavior === 'allow' && update.rules.length > 0)
          .map(update => ({ ...update, destination: 'session' as const })) : [];
        if (remember && !updates.length) throw new TypeError('Claude did not provide a reusable permission for this action. Choose Approve once.');
        if (remember) {
          const rules = updates.flatMap(update => update.type === 'addRules'
            ? update.rules.map(rule => rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName) : []);
          s.permissionRules = [...new Set([...(s.permissionRules ?? []), ...rules])];
          this.save(s);
        }
        if (!['approved', 'approved_for_session', 'accept', 'acceptForSession'].includes(c.decision)) {
          const tool = t.activities.find((a: Row) => a.id === pending.toolCallId);
          if (tool) tool.payload = { ...tool.payload, status: c.decision === 'cancel' ? 'stopped' : 'declined' };
        }
        pending.resolve(['approved', 'approved_for_session', 'accept', 'acceptForSession'].includes(c.decision)
          ? { behavior: 'allow', updatedInput: pending.input, ...(remember ? { updatedPermissions: updates } : {}) }
          : { behavior: 'deny', message: 'The user denied this action.' });
        this.resolveRequest(c.requestId, s);
        if (c.decision === 'cancel') {
          const active = this.active.get(t.id);
          if (active) await this.interrupt(s);
        }
      }
      if (this.pending.has(c.requestId)) this.resolveRequest(c.requestId, s);
    } else if (s.external && c.type !== 'thread.user-input.draft.update') {
      if (['thread.meta.update', 'thread.runtime-mode.set', 'thread.interaction-mode.set'].includes(c.type) && !c.title) await this.remoteSettings(s, c);
      else throw new TypeError('Change this existing session’s settings in Claude Desktop.');
    } else if (c.type === 'thread.meta.update' || c.type === 'thread.runtime-mode.set' || c.type === 'thread.interaction-mode.set') {
      if (t.session.status === 'running' || this.starting.has(t.id)) throw new TypeError('Finish or stop the current turn before changing its settings.');
      await this.ownedSettings(s, c);
      if (str(c.title).trim()) t.title = c.title.trim().slice(0, 256);
    } else if (['thread.archive', 'thread.unarchive', 'thread.delete'].includes(c.type)) {
      if (t.session.status === 'running') throw new TypeError('Finish or stop the task first.');
      s.syncPaused = true; this.syncRecovery.cancel(t.id);
      await this.disconnectIdle(t.id);
      if (c.type === 'thread.delete') t.deletedAt = now(); else t.archivedAt = c.type === 'thread.archive' ? now() : null;
    } else if (c.type !== 'thread.user-input.draft.update') throw new TypeError('This action is not supported for managed Claude Code sessions.');
    s.commands = [...s.commands.filter(id => id !== key), key].slice(-512); s.thread.updatedAt = now(); this.save(s); this.changed();
    return { sequence: this.sequence };
  }
  private validateSelection(value: Row) {
    if (value.instanceId !== INSTANCE) throw new TypeError('Choose a Claude Code model.');
    const model = this.models.find(m => m.value === value.model); if (!model) throw new TypeError('Refresh the Claude Code model list and choose an available model.');
    const options = Array.isArray(value.options) ? value.options : [];
    const selected = options.find((o: Row) => o.id === 'effort' || o.id === 'reasoningEffort')?.value;
    const effort = selected === 'auto' ? undefined : selected;
    if (effort && !model.supportedEffortLevels?.includes(effort)) throw new TypeError('This model does not support the selected effort.');
    return { instanceId: INSTANCE, model: model.value, options: effort ? [{ id: 'effort', value: effort }] : [] };
  }
  private activity(t: Row, id: string, kind: string, summary: string, payload: Row, tone = 'tool') {
    const old = t.activities.find((a: Row) => a.id === id);
    const value = { id, kind, summary, payload, tone, turnId: t.latestTurn?.turnId ?? null, sequence: old?.sequence ?? ++this.sequence, createdAt: old?.createdAt ?? now() };
    if (old) Object.assign(old, value); else t.activities.push(value);
    this.changed();
  }
  private progress(t: Row, event: Row) {
    if (t.session.status !== 'running' || event.parent_tool_use_id) return;
    const retry = event.subtype === 'api_retry';
    if (!retry && t.activities.some((a: Row) => a.kind === 'claude.thinking-summary' && a.turnId === t.latestTurn?.turnId)) return;
    const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
    const tokens = count(event.estimated_tokens), attempt = count(event.attempt), max = count(event.max_retries);
    const delay = count(event.retry_delay_ms);
    // Only publish progress metadata. Never forward thinking text, request bodies,
    // raw errors or URLs from the provider into the transcript.
    this.activity(t, `claude-progress-${t.latestTurn.turnId}`, 'claude.progress',
      retry ? `Claude is retrying${attempt && max ? ` (${attempt}/${max})` : ''}` : 'Claude is thinking', {
        status: 'running', phase: retry ? 'retry' : 'thinking',
        detail: retry
          ? `Claude has not returned a response yet.${delay !== undefined ? ` Retrying in ${Math.ceil(delay / 1000)} seconds.` : ''}`
          : `Waiting for Claude's reply.${tokens !== undefined ? ` About ${tokens.toLocaleString('en-US')} thinking tokens so far.` : ''}`,
        ...(retry ? { attempt, maxRetries: max, retryDelayMs: delay } : { estimatedTokens: tokens }),
      }, 'info');
  }
  private finishProgress(t: Row, state = 'completed') {
    for (const entry of t.activities) if (entry.kind === 'claude.thinking-summary' &&
        entry.turnId === t.latestTurn?.turnId && entry.payload.status === 'running') {
      entry.payload = { ...entry.payload, status: state };
      this.changed();
    }
    const progress = t.activities.find((a: Row) => a.id === `claude-progress-${t.latestTurn?.turnId}`);
    if (!progress || progress.payload.status !== 'running') return;
    progress.summary = state === 'stopped' ? 'Claude stopped' : state === 'failed' ? 'Claude could not finish'
      : progress.payload.phase === 'retry' ? 'Claude resumed' : 'Thinking complete';
    progress.payload = { ...progress.payload, status: state, detail: state === 'stopped' ? 'The response was stopped.'
      : state === 'failed' ? 'Claude could not complete this response.' : progress.payload.phase === 'retry' ? 'Claude responded after retrying.'
      : 'Claude finished thinking and continued the response.' };
    this.changed();
  }
  private thinkingSummary(t: Row, id: string, detail: string, status: string) {
    // Replace the placeholder once a public summary arrives, instead of showing
    // two Thinking rows for the same phase. Keep real retry notices visible.
    t.activities = t.activities.filter((a: Row) => !(a.kind === 'claude.progress' &&
      a.turnId === t.latestTurn?.turnId && a.payload?.phase === 'thinking'));
    this.activity(t, id, 'claude.thinking-summary', 'Thinking', {
      status, detail, data: { providerName: INSTANCE },
    }, 'thinking');
  }
  private resolveRequest(id: string, s: StoredThread, answers?: Row) {
    const pending = this.pending.get(id); this.pending.delete(id);
    pending?.cleanup();
    this.activity(s.thread, `resolved-${id}`, pending && isUserInput(pending) ? 'user-input.resolved' : 'approval.resolved', 'Response submitted', { requestId: id, ...(answers ? { answers } : {}), providerName: INSTANCE, data: { toolCallId: pending?.toolCallId } }, 'info');
    s.thread.hasPendingApprovals = [...this.pending.values()].some(p => p.threadId === s.thread.id && !isUserInput(p));
    s.thread.hasPendingUserInput = [...this.pending.values()].some(p => p.threadId === s.thread.id && isUserInput(p));
  }
  private denyPending(id: string) {
    for (const [requestId, pending] of this.pending) if (pending.threadId === id) {
      if (pending.kind === 'elicitation') pending.resolve({ action: 'cancel' });
      else pending.resolve({ behavior: 'deny', message: 'The task was stopped.' });
      this.resolveRequest(requestId, this.requireThread(id));
    }
  }
  private followUp(s: StoredThread, c: Row, clientId: string): ClaudeQueuedPrompt {
    const message = row(c.message);
    validateClaudeFollowUp(message, (s.followUps?.length ?? 0) + this.pendingSteers(s).length);
    const id = str(message.messageId) || str(message.id);
    if (s.followUps?.some(entry => entry.id === id) || s.thread.messages.some((m: Row) => m.id === id)) throw new TypeError('This message was already accepted.');
    if (c.modelSelection) {
      if (!s.external) this.validateSelection(c.modelSelection);
      else if (c.modelSelection.instanceId !== INSTANCE || !str(c.modelSelection.model) || str(c.modelSelection.model).length > 128) throw new TypeError('Choose a Claude Code model.');
    }
    const staged = message.attachments?.length ? stageAndroidAttachments({ clientId, attachments: message.attachments, root: this.root }) : null;
    const timestamp = now();
    return { id, clientId, staged, createdAt: timestamp, updatedAt: timestamp, command: {
      type: 'thread.turn.start', threadId: s.thread.id,
      message: { messageId: id, role: 'user', text: message.text, attachments: [] },
      modelSelection: structuredClone(c.modelSelection ?? s.thread.modelSelection),
      runtimeMode: c.runtimeMode ?? s.thread.runtimeMode, interactionMode: c.interactionMode ?? s.thread.interactionMode,
      ...(typeof c.queueDisplayText === 'string' ? { queueDisplayText: c.queueDisplayText.slice(0, 120_000) } : {}),
    } };
  }
  private commitQueue(s: StoredThread, queue: ClaudeQueuedPrompt[], key?: string) {
    const commands = key ? [...new Set([...s.commands, key])].slice(-512) : s.commands;
    this.save({ ...s, followUps: queue, commands });
    s.followUps = queue; s.commands = commands;
    if (!queue.length && s.queuePaused) {
      s.queuePaused = undefined;
      this.activity(s.thread, `queue-${s.thread.id}`, 'claude.queue.updated', 'Queue cleared', { status: 'completed' }, 'info'); this.save(s);
    }
    this.changed();
  }
  private enqueue(s: StoredThread, c: Row, key: string, clientId: string) {
    this.commitQueue(s, [...(s.followUps ?? []), this.followUp(s, c, clientId)], key);
    this.scheduleQueue(s);
  }
  private async queueAction(s: StoredThread, c: Row, key: string) {
    const queue = [...(s.followUps ?? [])]; const index = queue.findIndex(entry => entry.id === c.messageId);
    if (index < 0) throw new TypeError('This queued message has already been sent or removed.');
    const entry = queue[index]!;
    if (entry.attempted && !entry.uncertain) throw new TypeError('This message is being sent. Wait for its outcome.');
    if (c.type === 'thread.turn.queue.cancel') {
      queue.splice(index, 1);
      // Explicit removal acknowledges an uncertain delivery; it must not keep
      // future turns waiting for an event that may never arrive.
      if (entry.uncertain) for (const delivery of s.deliveries ?? []) if (delivery.messageId === entry.id && delivery.state === 'offered') delivery.state = 'cancelled';
    }
    else if (entry.uncertain) throw new TypeError('Delivery could not be confirmed. Check the chat before removing and resending this message.');
    else if (c.type === 'thread.turn.queue.update') {
      const text = str(c.text);
      if (!text.trim() || text.length > 120_000) throw new TypeError('Enter a follow-up of at most 120,000 characters.');
      queue[index] = { ...entry, updatedAt: now(), command: { ...entry.command, queueDisplayText: text, message: { ...entry.command.message, text } } };
    } else if (c.type === 'thread.turn.queue.move') {
      if (!['up', 'down'].includes(c.direction)) throw new TypeError('Choose up or down.');
      const to = index + (c.direction === 'up' ? -1 : 1);
      if (to >= 0 && to < queue.length) [queue[index], queue[to]] = [queue[to]!, entry];
    } else if (c.type === 'thread.turn.queue.steer') {
      if (s.thread.session.status === 'running') await this.steer(s, entry, key);
      else { this.resumeQueue(s); await this.startTurn(s, entry.command, key, entry.clientId, entry.staged); }
      return;
    } else throw new TypeError('Unknown Claude queue action.');
    this.commitQueue(s, queue, key); this.scheduleQueue(s);
  }
  private pendingSteers(s: StoredThread) { return (s.deliveries ?? []).filter(d => d.steer && d.state === 'offered' && !s.followUps?.some(entry => entry.id === d.messageId && entry.uncertain)); }
  private async interrupt(s: StoredThread) {
    const worker = this.active.get(s.thread.id); if (!worker) return;
    worker.stopped = true; this.denyPending(s.thread.id);
    this.pauseQueue(s, 'Queue paused because you stopped the task.');
    const offered = this.pendingSteers(s).map(d => d.uuid).filter(uuid => {
      if (!worker.inbox.cancel(uuid)) return true;
      this.restoreSteer(s, uuid, false); return false;
    });
    for (const uuid of await interruptClaude(worker.query, offered)) this.restoreSteer(s, uuid, false);
    // Interrupt only stops the foreground turn in an open SDK session. Detached
    // tools need their own stop request, scoped to this worker's reported IDs.
    for (const taskId of [...(worker.backgroundTaskIds ?? [])]) {
      try { await worker.query.stopTask(taskId); }
      catch (error) { if (worker.backgroundTaskIds?.has(taskId)) throw error; }
      worker.backgroundTaskIds?.delete(taskId);
    }
    worker.backgroundTasks = worker.backgroundTaskIds?.size ?? 0;
    // The foreground result may already be waiting for those background tools.
    // A control acknowledgement need not produce another iterator event.
    worker.flushResult?.();
    if (!worker.persistent && s.thread.session.status !== 'running') { worker.query.close(); await worker.done; }
    this.save(s);
  }
  private restoreSteer(s: StoredThread, uuid: string, uncertain: boolean) {
    const delivery = s.deliveries?.find(d => d.uuid === uuid);
    if (!delivery?.steer || delivery.state !== 'offered') return;
    const entry = { ...delivery.steer, ...(uncertain ? { uncertain: true } : {}) };
    const next = { ...s, deliveries: (s.deliveries ?? []).map(item => item === delivery && !uncertain ? { ...item, state: 'cancelled' as const } : item), followUps: [...(s.followUps ?? []).filter(item => item.id !== entry.id), entry],
      thread: { ...s.thread, messages: s.thread.messages.filter((m: Row) => m.id !== entry.id) },
      queuePaused: uncertain ? 'Steer delivery could not be confirmed. Check the chat before resending.' : 'Claude cancelled the unread steering message. It was returned to the queue.' };
    this.save(next); s.deliveries = next.deliveries; s.followUps = next.followUps; s.queuePaused = next.queuePaused; s.thread.messages = next.thread.messages;
    if (!uncertain) delivery.state = 'cancelled';
    this.activity(s.thread, `steer-${uuid}`, 'claude.steer.updated', uncertain ? 'Steer delivery unconfirmed' : 'Steering message not sent', { status: 'warning', detail: s.queuePaused }, 'info');
    this.save(s); this.changed();
  }
  private consumePrompts(s: StoredThread, event: Row) {
    if (event.parent_tool_use_id) return;
    for (const uuid of consumedClaudePromptIds(event)) {
      const delivery = s.deliveries?.find(d => d.uuid === uuid);
      if (!delivery || delivery.state !== 'offered') continue;
      delivery.state = 'consumed';
      const activeIndex = s.deliveries!.findIndex(d => d.uuid === s.activePromptUuid);
      if (s.deliveries!.indexOf(delivery) >= activeIndex) s.activePromptUuid = uuid;
      if (delivery.steer) {
        // A reconnect can prove that a previously uncertain steer was consumed.
        const restored = s.followUps?.find(entry => entry.id === delivery.messageId);
        if (restored) {
          s.followUps = s.followUps!.filter(entry => entry !== restored);
          if (!s.thread.messages.some((m: Row) => m.id === delivery.messageId)) s.thread.messages.push({
            id: delivery.messageId, role: 'user', text: restored.command.message.text,
            turnId: delivery.turnId, sequence: ++this.sequence, streaming: false,
            createdAt: restored.createdAt, updatedAt: now(),
          });
        }
        this.activity(s.thread, `steer-${uuid}`, 'claude.steer.updated', 'Steering message received', { status: 'completed' }, 'info');
      }
    }
  }
  private disconnectedQueue(s: StoredThread) {
    for (const delivery of this.pendingSteers(s)) this.restoreSteer(s, delivery.uuid, true);
    this.pauseQueue(s, 'Queue paused after Claude disconnected. Review the chat before sending queued work.');
  }
  private recordDelivery(s: StoredThread, uuid: string, messageId: string, turnId: string, steer?: ClaudeQueuedPrompt) {
    s.deliveries = [...(s.deliveries ?? []).filter(d => d.uuid !== uuid), { uuid, messageId, turnId, state: 'offered' as const, ...(steer ? { steer } : {}) }].slice(-512);
    if (!steer) s.activePromptUuid = uuid;
    s.followUps = (s.followUps ?? []).filter(entry => entry.id !== messageId);
  }
  private async steer(s: StoredThread, entry: ClaudeQueuedPrompt, key: string) {
    const t = s.thread, worker = this.active.get(t.id);
    if (!worker || worker.stopped || s.external && this.desktopState(s) !== 'connected') throw new TypeError('Reconnect the running Claude chat before steering it.');
    if (this.pendingSteers(s).length >= 32) throw new TypeError('Wait for Claude to read the pending steering messages.');
    const content = this.promptContent(entry.command.message, entry.clientId, entry.staged);
    const uuid = randomUUID(), turnId = t.session.activeTurnId ?? t.latestTurn?.turnId;
    if (!turnId) throw new TypeError('Claude has not confirmed a running turn yet. Retry shortly.');
    const previous = { followUps: s.followUps, deliveries: s.deliveries, commands: s.commands, userUuids: s.userUuids };
    t.messages.push({ id: entry.id, role: 'user', text: entry.command.message.text, turnId, sequence: ++this.sequence, streaming: false, createdAt: now(), updatedAt: now() });
    this.recordDelivery(s, uuid, entry.id, turnId, entry);
    s.userUuids = [...(s.userUuids ?? []), uuid].slice(-512); s.commands = [...s.commands, key];
    try {
      this.save(s);
      // Native priority delivery redirects at Claude's supported boundary. It
      // does not kill/restart the worker or discard the current conversation.
      worker.inbox.push({ type: 'user', uuid, priority: 'now', session_id: s.nativeId, parent_tool_use_id: null, message: { role: 'user', content } });
    } catch (error) {
      Object.assign(s, previous); t.messages = t.messages.filter((m: Row) => m.id !== entry.id); this.save(s); throw error;
    }
    this.activity(t, `steer-${uuid}`, 'claude.steer.updated', 'Steering Claude', { status: 'running' }, 'info');
    this.save(s); this.changed();
  }
  private resumeQueue(s: StoredThread) {
    if (!s.queuePaused) return;
    s.queuePaused = undefined;
    this.activity(s.thread, `queue-${s.thread.id}`, 'claude.queue.updated', 'Queued messages resumed', { status: 'completed' }, 'info');
  }
  private pauseQueue(s: StoredThread, reason: string) {
    if (!s.followUps?.length) return;
    s.queuePaused = reason;
    this.activity(s.thread, `queue-${s.thread.id}`, 'claude.queue.updated', 'Queued messages paused', { status: 'warning', detail: reason }, 'info');
    this.save(s);
  }
  private scheduleQueue(s: StoredThread) {
    const id = s.thread.id;
    if (this.closing || !this.enabled || s.queuePaused || !s.followUps?.length || this.queueTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.queueTimers.delete(id);
      void this.serializeThread(id, async () => {
        const t = s.thread, entry = s.followUps?.[0];
        if (this.closing || !this.enabled || !entry || entry.attempted || entry.uncertain || s.queuePaused
          || t.session.status !== 'idle' || t.hasPendingApprovals || t.hasPendingUserInput || t.archivedAt || t.deletedAt
          || this.pendingSteers(s).length || this.starting.has(id)) return;
        // Persist before handing it to the worker. A crash never replays a
        // potentially accepted prompt just because the phone missed its reply.
        this.commitQueue(s, s.followUps!.map(item => item === entry ? { ...item, attempted: true } : item));
        try { await this.startTurn(s, entry.command, `queued:${entry.id}`, entry.clientId, entry.staged); }
        catch (error) {
          if (s.followUps?.some(item => item.id === entry.id)) this.commitQueue(s, s.followUps.map(item => item.id === entry.id ? { ...item, attempted: false } : item));
          this.pauseQueue(s, `Could not send the queued message: ${safeError(error)}`);
        }
      }).catch(error => { this.pauseQueue(s, safeError(error)); });
    }, 0);
    timer.unref?.(); this.queueTimers.set(id, timer);
  }
  private promptContent(message: Row, clientId: string, prepared?: StagedAndroidAttachments | null) {
    const prompt = str(message.text);
    const staged = prepared !== undefined ? prepared : message.attachments?.length ? stageAndroidAttachments({ clientId, attachments: message.attachments, root: this.root }) : null;
    const content: any[] = [{ type: 'text', text: prompt || 'Inspect the attached files.' }];
    if (staged?.referencedFiles.length) content[0].text += `\n\nAttached files on this PC:\n${staged.referencedFiles.join('\n')}`;
    for (const image of staged?.codexInputs ?? []) {
      const bytes = readFileSync(image.path); const mediaType = bytes[0] === 137 ? 'image/png' : bytes[0] === 255 ? 'image/jpeg' : bytes[0] === 71 ? 'image/gif' : 'image/webp';
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } });
    }
    return content;
  }
  private async startTurn(s: StoredThread, c: Row, key: string, clientId: string, prepared?: StagedAndroidAttachments | null) {
    if (this.starting.has(s.thread.id)) throw new TypeError('Claude Code is already starting this task. Wait before sending another prompt.');
    this.starting.add(s.thread.id);
    try { await this.runTurn(s, c, key, clientId, prepared); }
    finally { this.starting.delete(s.thread.id); }
  }
  private async runTurn(s: StoredThread, c: Row, key: string, clientId: string, prepared?: StagedAndroidAttachments | null) {
    const t = s.thread;
    if (s.external) { await this.startRemoteTurn(s, c, key, clientId, prepared); return; }
    if (t.session.status === 'running') throw new TypeError('Claude Code is already working on this task. Stop it before sending another prompt.');
    if (!this.active.has(t.id) && this.ownedWorkerCount() >= MAX_ACTIVE && !this.idleWorker()) throw new TypeError('Four Claude Code tasks are running. Wait for one to finish or stop a task before starting another.');
    if ((t.messages?.length ?? 0) > 2000 || (t.activities?.length ?? 0) > 4000) throw new TypeError('Start a new task; this session has reached the Remodex history limit.');
    await this.loadCatalog(); if (this.error) throw new Error(this.error);
    if (t.session.status === 'running' || (!this.active.has(t.id) && this.ownedWorkerCount() >= MAX_ACTIVE && !this.idleWorker())) throw new TypeError("Claude Code is already busy. Retry after the running task finishes.");
    const selection = this.validateSelection(c.modelSelection ?? t.modelSelection);
    const message = row(c.message); const prompt = str(message.text);
    if (!prompt.trim() && !message.attachments?.length && !prepared?.stagedPaths.length) throw new TypeError('Enter a prompt or add an attachment.');
    const content = this.promptContent(message, clientId, prepared);
    if (this.recovering.has(t.id)) throw new TypeError('Desktop link recovery is in progress. Please wait.');
    // Preserve an explicit Auto choice so it also clears an override changed
    // through Desktop that is not present in our saved selection.
    await this.ownedSettings(s, { ...c, modelSelection: c.modelSelection ?? selection });
    const turnId = randomUUID(); const timestamp = now(); const uuid = randomUUID();
    t.modelSelection = selection;
    t.latestTurn = { turnId, state: 'running', requestedAt: timestamp, startedAt: timestamp, completedAt: null, assistantMessageId: null };
    t.session = { ...t.session, status: 'running', runtimeMode: t.runtimeMode, activeTurnId: turnId, lastError: null, updatedAt: timestamp };
    t.latestUserMessageAt = timestamp; t.updatedAt = timestamp;
    if (t.title === 'New task' || t.title === 'New thread') t.title = prompt.trim().slice(0, 100) || 'Attachments';
    t.messages.push({ id: str(message.messageId) || str(message.id) || randomUUID(), role: 'user', text: prompt, turnId, sequence: ++this.sequence, streaming: false, createdAt: timestamp, updatedAt: timestamp });
    // Record acceptance before launching the CLI: retries never duplicate a paid turn.
    s.commands.push(key);
    const messageId = t.messages.at(-1).id;
    const previousDelivery = { followUps: s.followUps, deliveries: s.deliveries, activePromptUuid: s.activePromptUuid };
    this.recordDelivery(s, uuid, messageId, turnId);
    try { this.save(s); }
    catch (error) {
      s.commands = s.commands.filter(id => id !== key); Object.assign(s, previousDelivery);
      t.messages.pop();
      this.finish(s, 'error', safeError(error));
      throw error;
    }
    this.changed();
    const current = this.active.get(t.id); if (current) current.stopped = false;
    s.userUuids = [...(s.userUuids ?? []), uuid].slice(-512); this.save(s);
    try {
      const worker = this.active.get(t.id) ?? await this.openWorker(s);
      if (!worker) throw new Error('Claude worker could not start.');
      if (worker.stopped) { this.finish(s, 'interrupted'); this.save(s); return; }
      worker.inbox.push({ type: 'user', uuid, session_id: s.nativeId, parent_tool_use_id: null, message: { role: 'user', content } });
    } catch (error) { this.finish(s, 'error', safeError(error)); this.save(s); this.changed(); }
  }
  private ownedWorkerCount() { return [...this.active.keys()].filter(id => !this.requireThread(id).external).length; }
  private reservedRecoverySlots(except: string) {
    let count = 0;
    for (const id of this.recoverySlots) {
      const s = this.threads.get(id);
      if (!s || !this.shouldRecoverSync(s)) { this.recoverySlots.delete(id); continue; }
      // Earlier reservations win if explicit user opens consumed capacity.
      // Counting all peers would leave every lost worker waiting on the others.
      if (id === except) break;
      if (!this.active.has(id)) count++;
    }
    return count;
  }
  private idleWorker() {
    return [...this.active.keys()].filter(id => !this.requireThread(id).external && this.requireThread(id).thread.session.status !== 'running'
      && ![...this.pending.values()].some(p => p.threadId === id))
      .filter(id => !this.recovering.has(id))
      .sort((a, b) => (this.viewed.get(a) ?? Date.parse(this.requireThread(a).thread.updatedAt)) - (this.viewed.get(b) ?? Date.parse(this.requireThread(b).thread.updatedAt)))[0];
  }
  private async openWorker(s: StoredThread, automatic = false) {
    const previous = this.workerGate;
    let release!: () => void;
    this.workerGate = new Promise<void>(r => { release = r; });
    await previous;
    try {
      if (this.closing) throw new Error('Claude sharing is shutting down.');
      if (automatic && !this.shouldRecoverSync(s)) return;
      const existing = this.active.get(s.thread.id); if (existing) return existing;
      // Keep a disconnected worker's slot through its retry delay. Otherwise
      // older startup retries can take it and strand the already-open chat.
      // Explicit user opens still take precedence; no active worker is evicted.
      if (automatic && this.ownedWorkerCount() + this.reservedRecoverySlots(s.thread.id) >= MAX_ACTIVE) return;
      if (this.ownedWorkerCount() >= MAX_ACTIVE) {
        if (automatic) return; // Background retries never evict another chat.
        const idle = this.idleWorker();
        if (!idle) throw new Error('Four Claude Code tasks are running. Wait for one to finish or stop a task.');
        const worker = this.active.get(idle)!;
        worker.parked = true; this.requireThread(idle).syncPaused = true; this.syncRecovery.cancel(idle);
        worker.inbox.close(); worker.abort?.abort(); worker.query.close(); await worker.done;
      }
      if (!automatic) this.viewed.set(s.thread.id, Date.now());
      s.syncPaused = false;
      return await this.launchWorker(s);
    } finally { release(); }
  }
  private permissionHandler(s: StoredThread): import('@anthropic-ai/claude-agent-sdk').CanUseTool {
    const t = s.thread;
    return async (name, input, options) => {
          if (options.signal.aborted) return { behavior: 'deny', message: 'Task stopped.' };
          const id = randomUUID(); const question = name === 'AskUserQuestion';
          const payload = question ? { questions: (input.questions as Row[] ?? []).map((q, index) => ({ id: `question-${index}`, header: str(q.header), question: str(q.question), options: q.options ?? [], multiSelect: q.multiSelect === true, isOther: true, isSecret: false })) }
            : { requestKind: ['Write', 'Edit', 'MultiEdit'].includes(name) ? 'file-change' : name === 'Read' ? 'file-read' : 'command', ...(name === 'ExitPlanMode' ? { displayTitle: 'Plan approval requested' } : {}), detail: approvalDetail(name, input), providerName: INSTANCE, canApproveForSession: options.suggestions?.some(update => update.type === 'addRules' && update.behavior === 'allow' && update.rules.length > 0) === true, data: { toolCallId: options.toolUseID } };
          if (question) t.hasPendingUserInput = true; else t.hasPendingApprovals = true;
          return new Promise<PermissionResult>(resolve => {
            const cleanup = () => options.signal.removeEventListener('abort', cancelled);
            const settle = (value: PermissionResult) => { cleanup(); resolve(value); };
            const cancelled = () => { if (this.pending.has(id)) { settle({ behavior: 'deny', message: 'Request resolved or cancelled by Claude.' }); this.resolveRequest(id, s); this.save(s); } };
            this.pending.set(id, { kind: 'tool', threadId: t.id, name, input, toolCallId: options.toolUseID, suggestions: options.suggestions, resolve: settle, cleanup });
            this.activity(t, id, question ? 'user-input.requested' : 'approval.requested', question ? 'Claude needs your input' : `${name} approval requested`, { requestId: id, ...payload }, question ? 'info' : 'approval');
            this.save(s);
            if (options.signal.aborted) cancelled(); else options.signal.addEventListener('abort', cancelled, { once: true });
          });
    };
  }
  private elicitationHandler(s: StoredThread): OnElicitation {
    return async (request, options) => {
      if (options.signal.aborted) return { action: 'cancel' };
      let form: ClaudeElicitationForm;
      try {
        if ([...this.pending.values()].filter(p => p.threadId === s.thread.id).length >= 32) throw new Error('Too many pending MCP requests. Finish or stop the current task.');
        form = claudeElicitationForm(request);
      } catch (error) {
        this.activity(s.thread, randomUUID(), 'session.notice', 'MCP input needs attention', { detail: safeError(error), status: 'warning' }, 'info');
        this.save(s); return { action: 'cancel' };
      }
      const id = randomUUID();
      s.thread.hasPendingUserInput = true;
      return new Promise<ElicitationResult | null>(resolve => {
        const cleanup = () => options.signal.removeEventListener('abort', cancelled);
        const settle = (value: ElicitationResult | null) => { cleanup(); resolve(value); };
        const cancelled = () => {
          if (!this.pending.has(id)) return;
          // The SDK suppresses response writes after transport cleanup.
          settle({ action: 'cancel' });
          this.resolveRequest(id, s); this.save(s);
        };
        this.pending.set(id, { kind: 'elicitation', threadId: s.thread.id, name: 'MCP input', input: {}, form, resolve: settle, cleanup });
        this.activity(s.thread, id, 'user-input.requested', 'MCP server needs your input', {
          requestId: id, questions: form.questions, providerName: INSTANCE,
        }, 'info');
        this.save(s);
        if (options.signal.aborted) cancelled(); else options.signal.addEventListener('abort', cancelled, { once: true });
      });
    };
  }
  private remoteOpening = new Map<string, Promise<void>>();
  private async openRemote(s: StoredThread): Promise<void> {
    const id = s.thread.id;
    if (this.closing || !this.enabled || !this.desktopSync) return;
    if (this.remoteOpening.has(id)) return this.remoteOpening.get(id);
    if (this.active.has(id)) return;
    const opening = this.attachRemote(s).finally(() => this.remoteOpening.delete(id));
    this.remoteOpening.set(id, opening); return opening;
  }
  private async attachRemote(s: StoredThread) {
    const t = s.thread; const id = t.id;
    // Refresh the native transcript before attaching; it may have grown while this PC bridge was offline.
    await this.refreshHistory(true);
    if (this.history.has(id)) {
      const history = await this.history.detail(id, [...this.projects.values()]);
      this.reconcileUserMessageText(s, history.messages);
      for (const m of history.messages) {
        // Android keeps its optimistic message ID; Claude's transcript uses the
        // SDK UUID. Map the two before merging reconnect history.
        const delivery = m.role === 'user' ? s.deliveries?.find(d => d.uuid === m.id) : undefined;
        if (delivery) this.consumePrompts(s, { type: 'history', user_message_uuid: delivery.uuid });
        const messageId = delivery?.messageId ?? m.id;
        if (!t.messages.some((existing: Row) => existing.id === messageId)) t.messages.push({ ...m, id: messageId,
          ...(delivery ? { turnId: delivery.turnId } : {}), sequence: ++this.sequence });
      }
      const tools = new Set(t.activities.map((a: Row) => a.id));
      for (const a of history.activities) if (a.kind !== 'claude.desktop-sync.updated' && !tools.has(a.id)) t.activities.push({ ...a, sequence: ++this.sequence });
      t.title = history.title;
      s.userUuids = [...new Set([...(s.userUuids ?? []), ...history.messages.filter((m: Row) => m.role === 'user').map((m: Row) => m.id)])].slice(-2000);
    }
    this.syncStatus(s, 'connecting');
    const bridgeId = await this.findBridge(s.nativeId);
    if (!bridgeId) throw new Error('Open this existing chat in Claude Desktop, run /remote-control, then reopen it here to continue the same session.');
    if (s.bridgeId !== bridgeId) s.remoteSequence = undefined;
    s.bridgeId = bridgeId; this.save(s);
    const inbox = claudeInputQueue(); const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let disconnectDetail = 'Claude connection dropped. Remodex will try to reconnect automatically.';
    let verified!: () => void;
    const identity = new Promise<void>(resolve => { verified = resolve; });
    try {
      const { query: q, metadata, status } = await this.remoteConnect({ bridgeId, fromSequenceNum: s.bridgeId === bridgeId ? s.remoteSequence : undefined, inbox, abortController: abort, canUseTool: this.permissionHandler(s), onElicitation: this.elicitationHandler(s) });
      const worker = { query: q, inbox, abort, stopped: false, intentionalDisconnect: false, awaitingStart: false, sentAt: 0, persistent: true,
        remoteEvents: new Set<string>((s.remoteEventUuids ?? []).slice(-8000)), done: undefined as Promise<void> | undefined };
      this.active.set(t.id, worker);
      // Saved message identities remain protected for this connection. Transient
      // stream-frame IDs use the same bounded window in memory and on disk.
      const historyIds = new Set<string>(t.messages.map((m: Row) => m.id));
      const seen = worker.remoteEvents;
      const currentState = (state: Row) => {
        if (state.worker_status === 'idle' && worker.awaitingStart && Date.now() - worker.sentAt > 30_000) {
          worker.awaitingStart = false;
          this.finish(s, 'error', 'Desktop has not started this prompt. Check the original chat before retrying; Remodex will not send it twice.');
        } else if (state.worker_status === 'idle' && !worker.awaitingStart && t.session.status === 'running') this.finish(s, worker.stopped ? 'interrupted' : 'completed');
        else if (['running', 'working', 'requires_action'].includes(state.worker_status)) {
          worker.awaitingStart = false; t.session = { ...t.session, status: 'running' }; this.changed();
        }
      };
      if (metadata.worker_status === 'idle' && t.latestTurn?.state === 'running') {
        const answered = t.messages.some((m: Row) => m.role === 'assistant' && m.turnId === t.latestTurn.turnId);
        this.finish(s, answered ? 'completed' : 'error', answered ? null : 'Desktop is idle. Check the original chat before retrying this unanswered prompt.');
      }
      t.session = { ...t.session, status: metadata.worker_status === 'idle' ? 'idle' : 'running' };
      worker.done = (async () => {
        try {
          for await (const event of q) {
            const e = event as unknown as Row;
            const envelope = getCcrEvent(q, event);
            // Unknown-platform frames are not accepted human prompts in Desktop.
            if (envelope?.source === 'client' && e.type === 'user' && e.client_platform === 'unknown') continue;
            if (envelope) s.remoteSequence = Math.max(s.remoteSequence ?? 0, envelope.sequence_num);
            if (e.session_id && e.session_id !== bridgeId && e.session_id !== s.nativeId) throw new Error('Claude returned an event for a different session.');
            if (e.type === 'system' && e.subtype === 'init') {
              if (e.cwd && e.cwd !== t.worktreePath) throw new Error('The shared chat belongs to a different working folder. Connection stopped.');
              if (e.model) t.modelSelection = { instanceId: INSTANCE, model: e.model, options: e.effort ? [{ id: 'effort', value: e.effort }] : [] };
              verified();
            }
            if (e.uuid && (seen.has(e.uuid) || historyIds.has(e.uuid)) && e.type !== 'system') continue;
            if (e.uuid && e.type !== 'system') {
              seen.add(e.uuid);
              while (seen.size > 8000) seen.delete(seen.values().next().value!);
              s.remoteEventUuids = [...seen];
            }
            if (e.type === 'assistant' || e.type === 'stream_event' || e.type === 'command_lifecycle' && e.state === 'started') worker.awaitingStart = false;
            this.event(s, event);
            if (e.type === 'system' && e.subtype === 'session_state_changed') {
              if (e.state === 'idle' && t.session.status === 'running') this.finish(s, worker.stopped ? 'interrupted' : 'completed');
              else if (e.state === 'running') { worker.stopped = false; t.session.status = 'running'; this.changed(); }
            }
            if (event.type !== 'stream_event') this.save(s);
          }
        } catch (error) { disconnectDetail = safeError(error); }
        finally {
          if (poll) clearInterval(poll);
          seen.clear(); historyIds.clear();
          inbox.close(); abort.abort(); q.close();
          // Detach only. Never interrupt or deny a Desktop-owned task when a phone disconnects.
          for (const [requestId, pending] of this.pending) if (pending.threadId === id) this.resolveRequest(requestId, s);
          this.releaseWorkerState(id, q);
          this.disconnectedQueue(s); t.session.status = 'disconnected';
          this.syncStatus(s, 'disconnected', abort.signal.reason instanceof Error && abort.signal.reason.name !== 'AbortError' && !worker.intentionalDisconnect ? safeError(abort.signal.reason) : disconnectDetail);
          if (worker.intentionalDisconnect && !this.recovering.has(id)) this.syncRecovery.cancel(id);
          this.changed();
        }
      })();
      await Promise.race([
        Promise.all([q.supportedModels(), identity]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Claude Desktop did not acknowledge this connection. Open Remote Control there and retry.')), 15_000); }),
      ]);
      if (this.active.get(id) !== worker || abort.signal.aborted || this.closing) throw new Error('Claude Desktop disconnected while attaching.');
      currentState(status ? await status() : metadata);
      this.syncStatus(s, 'connected');
      if (status) {
        let polling = false;
        poll = setInterval(() => {
          if (polling) return; polling = true;
          void status().then(state => { currentState(state); this.save(s); }).catch((error) => { disconnectDetail = safeError(error); abort.abort(); q.close(); })
            .finally(() => { polling = false; });
        }, 5000);
        poll.unref?.();
      }
    } catch (error) {
      disconnectDetail = safeError(error);
      inbox.close(); abort.abort(error); this.active.get(id)?.query.close();
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }
  /** Apply settings to the same CLI; a local title change never closes Desktop sharing. */
  private async ownedSettings(s: StoredThread, c: Row) {
    const t = s.thread;
    // Validate the whole selection before making any change, including the local title.
    const selection = c.modelSelection ? this.validateSelection(c.modelSelection) : t.modelSelection;
    const mode = ['approval-required', 'auto-accept-edits', 'full-access'].includes(c.runtimeMode) ? c.runtimeMode : t.runtimeMode;
    const interaction = ['default', 'plan'].includes(c.interactionMode) ? c.interactionMode : t.interactionMode;
    const worker = this.active.get(t.id);
    try {
      if (worker && selection.model !== t.modelSelection.model) await worker.query.setModel(selection.model);
      const previousEffort = t.modelSelection.options?.find((o: Row) => o.id === 'effort')?.value;
      const effort = selection.options?.find((o: Row) => o.id === 'effort')?.value;
      const resetEffort = c.modelSelection?.options?.some((o: Row) => ['effort', 'reasoningEffort'].includes(o.id) && o.value === 'auto');
      // Keep local state consistent with successfully applied controls if a later one fails.
      t.modelSelection = { ...t.modelSelection, model: selection.model };
      if (worker && (resetEffort || effort !== previousEffort)) await worker.query.applyFlagSettings({ effortLevel: effort ?? null });
      t.modelSelection = selection;
      if (worker && (mode !== t.runtimeMode || interaction !== t.interactionMode)) {
        const permission = interaction === 'plan' ? 'plan' : mode === 'full-access' ? 'bypassPermissions' : mode === 'auto-accept-edits' ? 'acceptEdits' : 'default';
        try { await worker.query.setPermissionMode(permission); }
        catch (error) {
          // Claude requires explicit launch consent for the first bypass transition.
          // Restart only this idle owned worker, retaining its native and Desktop IDs.
          if (permission !== 'bypassPermissions' || row(error).errorCode !== 'bypass_not_launched') throw error;
          await this.disconnectIdle(t.id);
          t.runtimeMode = mode; t.interactionMode = interaction;
          t.session = { ...t.session, runtimeMode: mode, interactionMode: interaction };
          await this.openWorker(s);
        }
      }
      t.runtimeMode = mode; t.interactionMode = interaction;
      t.session = { ...t.session, runtimeMode: mode, interactionMode: interaction };
    } finally { this.save(s); this.changed(); }
  }
  private async remoteSettings(s: StoredThread, c: Row) {
    const t = s.thread, worker = this.active.get(t.id);
    if (!worker || this.desktopState(s) !== 'connected') throw new TypeError('Reconnect this chat before changing its settings.');
    if (t.session.status === 'running') throw new TypeError('Finish or stop the task before changing settings.');
    if (c.modelSelection && (c.modelSelection.instanceId !== INSTANCE || !str(c.modelSelection.model) || str(c.modelSelection.model).length > 128)) throw new TypeError('Choose a Claude Code model.');
    const model = c.modelSelection?.model;
    const selected = c.modelSelection?.options?.find((o: Row) => ['effort', 'reasoningEffort'].includes(o.id))?.value;
    const effort = selected === 'auto' ? undefined : selected;
    if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new TypeError('Choose an available Claude effort level.');
    if (model && model !== t.modelSelection.model) { await worker.query.setModel(model); t.modelSelection = { ...t.modelSelection, model }; }
    if (selected === 'auto' || effort && effort !== t.modelSelection.options?.find((o: Row) => ['effort', 'reasoningEffort'].includes(o.id))?.value) {
      await worker.query.applyFlagSettings({ effortLevel: effort ?? null });
      t.modelSelection = { ...t.modelSelection, options: effort ? [{ id: 'effort', value: effort }] : [] };
    }
    const mode = ['approval-required', 'auto-accept-edits', 'full-access'].includes(c.runtimeMode) ? c.runtimeMode : t.runtimeMode;
    const interaction = ['default', 'plan'].includes(c.interactionMode) ? c.interactionMode : t.interactionMode;
    if (mode !== t.runtimeMode || interaction !== t.interactionMode) {
      await worker.query.setPermissionMode(interaction === 'plan' ? 'plan' : mode === 'full-access' ? 'bypassPermissions' : mode === 'auto-accept-edits' ? 'acceptEdits' : 'default');
      t.runtimeMode = mode; t.interactionMode = interaction; t.session = { ...t.session, runtimeMode: mode, interactionMode: interaction };
    }
    this.save(s); this.changed();
  }
  private async startRemoteTurn(s: StoredThread, c: Row, key: string, clientId: string, prepared?: StagedAndroidAttachments | null) {
    s.syncPaused = false;
    if (this.desktopState(s) !== 'connected' || !this.active.has(s.thread.id)) await this.openRemote(s);
    const t = s.thread; const worker = this.active.get(t.id);
    if (!worker || this.desktopState(s) !== 'connected') throw new TypeError('Reconnect this chat to Claude Desktop before sending.');
    if (t.session.status === 'running' || t.hasPendingApprovals || t.hasPendingUserInput) throw new TypeError('Finish or stop the current Desktop task before sending another prompt.');
    const message = row(c.message); const prompt = str(message.text);
    if (!prompt.trim() && !message.attachments?.length && !prepared?.stagedPaths.length) throw new TypeError('Enter a prompt or add an attachment.');
    const content = this.promptContent(message, clientId, prepared);
    await this.remoteSettings(s, c);
    // Send to the original worker without restarting or resuming a second process.
    const uuid = randomUUID(); const timestamp = now(); const turnId = randomUUID();
    t.latestTurn = { turnId, state: 'running', requestedAt: timestamp, startedAt: timestamp, completedAt: null, assistantMessageId: null };
    t.session = { ...t.session, status: 'running', activeTurnId: turnId, lastError: null, updatedAt: timestamp };
    t.latestUserMessageAt = timestamp; t.updatedAt = timestamp; worker.stopped = false; worker.awaitingStart = true; worker.sentAt = Date.now();
    const messageId = str(message.messageId) || str(message.id) || uuid;
    t.messages.push({ id: messageId, role: 'user', text: prompt, turnId, sequence: ++this.sequence, streaming: false, createdAt: timestamp, updatedAt: timestamp });
    const previousDelivery = { followUps: s.followUps, deliveries: s.deliveries, activePromptUuid: s.activePromptUuid, userUuids: s.userUuids };
    this.recordDelivery(s, uuid, messageId, turnId);
    s.userUuids = [...(s.userUuids ?? []), uuid].slice(-512);
    s.commands.push(key);
    try { this.save(s); }
    catch (error) {
      Object.assign(s, previousDelivery); s.commands = s.commands.filter(id => id !== key); t.messages.pop();
      worker.awaitingStart = false; this.finish(s, 'error', safeError(error)); throw error;
    }
    this.changed();
    try { worker.inbox.push({ type: 'user', uuid, session_id: s.nativeId, parent_tool_use_id: null, message: { role: 'user', content } }); }
    catch (error) { worker.awaitingStart = false; this.finish(s, 'error', safeError(error)); }

  }

  private async launchWorker(s: StoredThread) {
    const t = s.thread; const selection = t.modelSelection;
    const permissionMode = t.interactionMode === 'plan' ? 'plan' : t.runtimeMode === 'full-access' ? 'bypassPermissions' : t.runtimeMode === 'auto-accept-edits' ? 'acceptEdits' : 'default';
    const inbox = claudeInputQueue();
    try {
      const q = this.sdkQuery({ prompt: inbox,  options: { ...this.processOptions(), cwd: t.worktreePath, model: selection.model,
        effort: selection.options?.[0]?.value as EffortLevel | undefined, permissionMode, allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
        systemPrompt: { type: 'preset', preset: 'claude_code' }, settingSources: ['user', 'project', 'local'],
        extraArgs: { 'replay-user-messages': null, 'thinking-display': 'summarized' },
        settings: { remoteControlAtStartup: false, showThinkingSummaries: true, ...(s.permissionRules?.length ? { permissions: { allow: s.permissionRules } } : {}) }, includePartialMessages: true, enableFileCheckpointing: true,
        ...(s.resumed ? { resume: s.nativeId } : { sessionId: s.nativeId }),
        canUseTool: this.permissionHandler(s), onElicitation: this.elicitationHandler(s),
        onUserDialog: async (_request, options) => {
          // Unknown CLI dialogs must be cancelled, not left parked forever.
          // Desktop-owned sessions keep their native dialog handler instead.
          if (!options.signal.aborted) {
            this.activity(t, randomUUID(), 'session.notice', 'Claude dialog needs attention', {
              status: 'warning', detail: 'Claude requested a dialog that Remodex cannot display. It was cancelled. Continue in Claude Code on your PC if that step is needed.',
            }, 'info');
            this.save(s);
          }
          return { behavior: 'cancelled' };
        },
      } });
      const worker = { query: q, stopped: false, parked: false, intentionalDisconnect: false, backgroundTasks: 0, backgroundTaskIds: new Set<string>(), flushResult: undefined as (() => void) | undefined, persistent: this.desktopSync, inbox, done: undefined as Promise<void> | undefined };
      this.active.set(t.id, worker);
      worker.done = (async () => {
        let result: SDKMessage | null = null;
        const backgroundTasks = worker.backgroundTaskIds;
        const flushResult = () => {
          if (!result || backgroundTasks.size) return false;
          const terminal = result; result = null;
          this.event(s, terminal); this.save(s);
          return true;
        };
        worker.flushResult = flushResult;
        try {
          for await (const event of q) {
            if (event.type === 'system' && event.subtype === 'task_started' && !event.skip_transcript) backgroundTasks.add(event.task_id);
            if (event.type === 'system' && event.subtype === 'task_notification') backgroundTasks.delete(event.task_id);
            worker.backgroundTasks = backgroundTasks.size;
            if (event.type === 'result') {
              // Resuming can first flush an old background notification. Its
              // result is not acknowledgment or completion of this user's prompt.
              if (!event.origin || event.origin.kind === 'human') result = event;
            } else { this.event(s, event); if (event.type !== 'stream_event') this.save(s); }
            // Keep the CLI alive while its background tools run. Closing on the
            // foreground result would terminate those tools and lose their output.
            if (flushResult() && !worker.persistent && t.session.status !== 'running') break;
          }
          if (t.session.status === 'running') { this.disconnectedQueue(s); this.finish(s, 'interrupted', 'Claude Code disconnected. The prompt will not be replayed automatically.'); }
        }
        catch (error) { this.disconnectedQueue(s); if (worker.persistent) this.syncStatus(s, 'disconnected', safeError(error)); if (t.session.status === 'running') this.finish(s, 'error', safeError(error)); }
        finally {
          inbox.close(); this.denyPending(t.id); q.close(); this.releaseWorkerState(t.id, q);
          if (worker.persistent) {
            if (!worker.intentionalDisconnect && !worker.parked) {
              this.disconnectedQueue(s); this.recoverySlots.add(t.id);
            }
            this.syncStatus(s, worker.parked ? 'parked' : 'disconnected');
          }
          if (worker.intentionalDisconnect && !this.recovering.has(t.id)) this.syncRecovery.cancel(t.id);
          this.save(s); this.changed(); this.scheduleQueue(s);
        }
      })().catch(error => { this.finish(s, 'error', safeError(error)); });
      if (worker.persistent) {
        this.syncStatus(s, 'connecting');
        try {
          const bridgeId = await connectDesktop(q, s.previousNativeIds?.length ? `${t.title} (reconnected)` : t.title, s.bridgeId);
          if (this.active.get(t.id) !== worker) throw new Error('Claude disconnected while starting Desktop sync.');
          s.bridgeId = bridgeId; this.syncStatus(s, 'connected');
        } catch (error) { this.syncStatus(s, 'disconnected', safeError(error)); }
      }
      return worker;
    } catch (error) { inbox.close(); throw error; }
  }
  private finish(s: StoredThread, state: string, error: string | null = null) {
    const t = s.thread; const stopped = this.active.get(t.id)?.stopped;
    if (state === 'completed' && !stopped && this.pendingSteers(s).length) return;
    this.finishProgress(t, stopped || state === 'interrupted' ? 'stopped' : state === 'error' ? 'failed' : 'completed');
    t.latestTurn = { ...t.latestTurn, state: stopped ? 'interrupted' : state, completedAt: t.latestTurn?.completedAt ?? now() };
    // Keep the same duration after this turn is no longer latest. The phone
    // already reads these timestamps from work entries, including paged history.
    const duration = Date.parse(t.latestTurn.completedAt) - Date.parse(t.latestTurn.startedAt);
    if (Number.isFinite(duration) && duration >= 0) for (const activity of t.activities) {
      if (activity.turnId === t.latestTurn.turnId) activity.payload = { ...activity.payload,
        turnStartedAt: t.latestTurn.startedAt, turnCompletedAt: t.latestTurn.completedAt, turnDurationMs: duration };
    }
    t.session = { ...t.session, status: state === 'error' && !stopped ? 'error' : 'idle', activeTurnId: null, lastError: error, updatedAt: now() };
    if (stopped || state === 'interrupted' || state === 'error') {
      for (const activity of t.activities) {
        if (activity.turnId === t.latestTurn.turnId && activity.payload?.status === 'running' && activity.kind.startsWith('tool.')) {
          activity.kind = 'tool.completed';
          activity.payload = { ...activity.payload, status: stopped || state === 'interrupted' ? 'stopped' : 'failed' };
        }
      }
    }
    for (const activity of t.activities) if (activity.kind === 'context-compaction' && activity.payload?.status === 'inProgress') {
      activity.summary = stopped || state === 'interrupted' ? 'Context compaction stopped' : state === 'error' ? 'Context compaction failed' : 'Context compaction ended';
      activity.payload = { ...activity.payload, status: stopped || state === 'interrupted' ? 'stopped' : state === 'error' ? 'failed' : 'completed' };
    }
    for (const m of t.messages) m.streaming = false;
    const final = t.messages.findLast((m: Row) => m.role === 'assistant' && m.turnId === t.latestTurn.turnId);
    if (final) {
      final.phase = 'final_answer'; final.updatedAt = t.latestTurn.completedAt;
      t.latestTurn.assistantMessageId = final.id;
    }
    t.updatedAt = now();
    if (stopped || state !== 'completed') this.pauseQueue(s, stopped ? 'Queue paused because you stopped the task.' : 'Queue paused because the task did not complete.');
    this.save(s); this.changed();
    if (!stopped && state === 'completed') this.scheduleQueue(s);
  }
  private event(s: StoredThread, event: SDKMessage) {
    const e = event as unknown as Row; const t = s.thread;
    if (!s.external && e.type === 'user' && e.uuid && !e.parent_tool_use_id && !e.isSynthetic) {
      const content = e.message?.content;
      const text = claudeUserText(content);
      if (text && !isClaudeControlMessage(e, text) && !content?.some?.((b: Row) => b.type === 'tool_result') && !s.fileCheckpoints?.some(p => p.id === e.uuid))
        s.fileCheckpoints = [...(s.fileCheckpoints ?? []), { id: e.uuid, label: text.slice(0, 120) }].slice(-256);
    }
    this.consumePrompts(s, e);
    if (e.type === 'system' && ['thinking_tokens', 'api_retry'].includes(e.subtype)) {
      if (!e.user_message_uuid || !s.activePromptUuid || e.user_message_uuid === s.activePromptUuid) this.progress(t, e);
      return;
    }
    if (e.type === 'system' && e.subtype === 'bridge_state') {
      if (['failed', 'disconnected', 'policy_disabled'].includes(e.state)) this.syncStatus(s, 'disconnected', safeError(e.state === 'policy_disabled' ? 'Remote Control is disabled by policy.' : e.detail || 'Claude Desktop disconnected.'));
      else if (e.state === 'connected' && s.bridgeId && this.desktopState(s) !== 'connecting') this.syncStatus(s, 'connected');
      return;
    }
    if (e.type === 'system' && e.subtype === 'init') {
      const worker = this.active.get(t.id);
      if (worker) this.capabilityInit.set(t.id, { query: worker.query, value: { skills: e.skills, terminal_slash_commands: e.terminal_slash_commands, plugins: e.plugins } });
      s.resumed = true; this.save(s);
    }
    if (e.type === 'system' && ['init', 'status'].includes(e.subtype) && e.permissionMode) {
      t.interactionMode = e.permissionMode === 'plan' ? 'plan' : 'default';
      t.runtimeMode = e.permissionMode === 'bypassPermissions' ? 'full-access' : e.permissionMode === 'acceptEdits' ? 'auto-accept-edits' : 'approval-required';
      t.session = { ...t.session, runtimeMode: t.runtimeMode, interactionMode: t.interactionMode }; this.changed();
    }
    if (e.type === 'rate_limit_event') {
      const info = row(e.rate_limit_info);
      if (['allowed', 'allowed_warning', 'rejected'].includes(info.status)) {
        const id = `rate-limit-${t.id}-${str(info.rateLimitType) || 'subscription'}`;
        const previous = t.activities.find((a: Row) => a.id === id);
        if (info.status !== 'allowed' || previous) {
          this.activity(t, id, 'claude.rate-limit.updated', info.status === 'rejected' ? 'Claude usage limit reached' : info.status === 'allowed_warning' ? 'Claude usage limit approaching' : 'Claude usage limit cleared', {
            status: info.status === 'allowed' ? 'completed' : 'warning',
            rateLimitStatus: info.status,
            ...(Number.isFinite(info.resetsAt) && info.resetsAt > 0 ? { resetsAt: info.resetsAt } : {}),
          }, info.status === 'allowed' ? 'info' : 'warning');
        }
      }
    }
    if (e.type === 'system' && e.subtype === 'status' && e.status === 'compacting') {
      const live = t.activities.findLast((a: Row) => a.kind === 'context-compaction' && a.payload?.status === 'inProgress');
      this.activity(t, live?.id ?? `compaction-${randomUUID()}`, 'context-compaction', 'Compacting context', { itemType: 'context-compaction', status: 'inProgress' }, 'info');
    }
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      const compaction = t.activities.findLast((a: Row) => a.kind === 'context-compaction' && a.payload?.status === 'inProgress');
      this.activity(t, compaction?.id ?? `compaction-${str(e.uuid) || randomUUID()}`, 'context-compaction', 'Context compacted', { itemType: 'context-compaction', status: 'completed' }, 'info');
    }
    if (e.type === 'command_lifecycle' && e.state === 'started' && t.session.status !== 'running') {
      const timestamp = now(); const turnId = randomUUID();
      t.latestTurn = { turnId, state: 'running', requestedAt: timestamp, startedAt: timestamp, completedAt: null, assistantMessageId: null };
      t.session = { ...t.session, status: 'running', activeTurnId: turnId, lastError: null, updatedAt: timestamp };
      const worker = this.active.get(t.id); if (worker) worker.stopped = false;
      this.changed();
    }
    const message = row(e.message);
    const blocks: Row[] = Array.isArray(message.content) ? message.content : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [];
    if (e.type === 'user' && !e.parent_tool_use_id && !blocks.some(b => b.type === 'tool_result')) {
      const text = claudeUserText(message.content);
      const uuid = str(e.uuid);
      const interrupted = /^\[Request interrupted by user(?: for tool use)?\]$/.test(text);
      if (interrupted) { const worker = this.active.get(t.id); if (worker && !this.pendingSteers(s).length) worker.stopped = true; }
      else if (uuid && text && !isClaudeControlMessage(e, text) && !(s.userUuids ?? []).includes(uuid)) {
        s.userUuids = [...(s.userUuids ?? []), uuid].slice(-512); s.activePromptUuid = uuid;
        const timestamp = now(); const turnId = t.session.status === 'running' && !t.messages.some((m: Row) => m.role === 'user' && m.turnId === t.latestTurn?.turnId) ? t.latestTurn.turnId : randomUUID();
        const worker = this.active.get(t.id); if (worker) worker.stopped = false;
        t.latestTurn = { turnId, state: 'running', requestedAt: timestamp, startedAt: timestamp, completedAt: null, assistantMessageId: null };
        t.session = { ...t.session, status: 'running', activeTurnId: turnId, lastError: null, updatedAt: timestamp };
        t.latestUserMessageAt = timestamp; t.updatedAt = timestamp;
        t.messages.push({ id: uuid, role: 'user', text: text.slice(0, 512_000), turnId, sequence: ++this.sequence, streaming: false, createdAt: timestamp, updatedAt: timestamp });
        this.save(s); this.changed();
      }
    }
    if (e.type === 'command_lifecycle' && e.state === 'cancelled') {
      const delivery = s.deliveries?.find(d => d.uuid === e.command_uuid);
      if (delivery?.steer && delivery.state === 'offered') this.restoreSteer(s, delivery.uuid, false);
      else if (t.session.status === 'running' && !this.pendingSteers(s).length && (!e.command_uuid || !s.activePromptUuid || e.command_uuid === s.activePromptUuid)) {
        this.finish(s, 'interrupted'); this.save(s);
      }
    }
    const upsertText = (id: string, text: string, append: boolean, streaming: boolean) => {
      let m = t.messages.find((m: Row) => m.id === id);
      if (!m) { m = { id, role: 'assistant', text: '', turnId: t.latestTurn.turnId, streaming, sequence: ++this.sequence, createdAt: now(), updatedAt: now() }; t.messages.push(m); }
      m.text = append ? (m.text + text).slice(0, 512_000) : text.slice(0, 512_000); m.streaming = streaming; m.updatedAt = now(); this.changed();
    };
    if (e.type === 'stream_event') {
      const ev = row(e.event);
      if (ev.type === 'message_start') {
        this.streamMessageIds.set(t.id, str(ev.message?.id) || randomUUID());
        this.streamSummaryModels.set(t.id, str(ev.message?.model));
      }
      if (!e.parent_tool_use_id && ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' &&
          hasClaudeThinkingSummary(this.streamSummaryModels.get(t.id)) && str(ev.delta.thinking)) {
        const id = `claude-thinking-${this.streamMessageIds.get(t.id)}-${ev.index}`;
        const old = t.activities.find((a: Row) => a.id === id);
        const summary = (str(old?.payload?.detail) + str(ev.delta.thinking)).slice(0, 16_000);
        this.thinkingSummary(t, id, summary, 'running');
      }
      if (ev.type === 'content_block_stop') {
        const activity = t.activities.find((a: Row) => a.id === `claude-thinking-${this.streamMessageIds.get(t.id)}-${ev.index}`);
        if (activity) { activity.payload.status = 'completed'; this.changed(); }
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        if (!e.parent_tool_use_id) this.finishProgress(t);
        const id = this.streamMessageIds.get(t.id);
        if (id) upsertText(id, str(ev.delta.text), true, true);
      }
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        if (!e.parent_tool_use_id) this.finishProgress(t);
        this.tool(t, ev.content_block, false);
      }
    }
    if (e.type === 'assistant') {
      if (!e.parent_tool_use_id && blocks.some(b => ['text', 'tool_use'].includes(b.type)) && !e.error) this.finishProgress(t);
      const text = (message.content ?? []).filter((b: Row) => b.type === 'text').map((b: Row) => b.text).join('\n');
      if (text) {
        // The native transcript keys entries by UUID. Keep that identity after streaming
        // so loading history on reconnect cannot append the same answer a second time.
        if (s.external && e.uuid) {
          const streamed = t.messages.find((m: Row) => m.id === message.id);
          if (streamed && !t.messages.some((m: Row) => m.id === e.uuid)) streamed.id = e.uuid;
        }
        upsertText(s.external && e.uuid ? e.uuid : str(message.id) || str(e.uuid), text, false, false);
      }
      for (const block of message.content ?? []) if (block.type === 'tool_use') this.tool(t, block, false);
      if (!e.parent_tool_use_id) for (const [index, block] of blocks.entries()) {
        const summary = claudeThinkingSummary(message.model, block);
        if (summary) this.thinkingSummary(t, `claude-thinking-${str(message.id) || str(e.uuid)}-${index}`, summary, 'completed');
      }
    }
    if (e.type === 'user') for (const block of blocks) if (block.type === 'tool_result') {
      const old = t.activities.find((a: Row) => a.id === block.tool_use_id);
      if (old) {
        const name = str(old.payload?.data?.tool); const structured = blocks.filter(b => b.type === 'tool_result').length === 1 ? e.tool_use_result : undefined;
        if (row(structured).detachedToolCall === true) continue;
        const detail = claudeToolResult(name, block.content, structured);
        const denied = block.is_error && /user (?:denied|declined|rejected)|user doesn't want to proceed/.test(detail.toLowerCase());
        const status = ['declined', 'stopped'].includes(old.payload.status) ? old.payload.status
          : block.is_error && this.active.get(t.id)?.stopped ? 'stopped'
          : denied ? 'declined' : block.is_error ? 'failed' : 'completed';
        const change = status === 'completed' ? claudeFileChange(name, structured, t.worktreePath) : undefined;
        const toolImages = this.toolImages.capture(t.id, block.content);
        this.activity(t, old.id, 'tool.completed', old.summary, {
          ...old.payload, status, detail: status === 'declined' ? 'You declined this action.' : status === 'stopped' ? 'Stopped by you.' : detail,
          data: { ...old.payload.data, ...(toolImages.length ? { toolImages } : {}), ...(change ? { changes: [{ path: change.path }] } : {}) },
          ...(change ? { itemType: 'file_change', fileChanges: [change] } : {}),
        }, status === 'failed' ? 'error' : 'tool');
      }
    }
    if (e.type === 'tool_progress') {
      const old = t.activities.find((a: Row) => a.id === e.tool_use_id);
      if (old) this.activity(t, old.id, 'tool.updated', old.summary, { ...old.payload, elapsedSeconds: e.elapsed_time_seconds });
    }
    if (e.type === 'tool_use_summary' && !e.parent_tool_use_id && str(e.summary).trim()) {
      // This is the SDK's public tool summary, not a private thinking block.
      const summary = str(e.summary).trim().slice(0, 2000);
      this.activity(t, `claude-summary-${str(e.uuid) || randomUUID()}`, 'claude.tool-summary', summary.slice(0, 240), {
        status: 'completed', detail: summary, data: { providerName: INSTANCE },
      }, 'thinking');
    }
    if (e.type === 'system' && ['task_started', 'task_progress', 'task_notification'].includes(e.subtype)) {
      this.activity(t, str(e.task_id) || str(e.uuid), 'task.progress', str(e.description) || str(e.summary) || 'Subagent activity', { itemType: 'sub-agent-activity', status: e.status, detail: str(e.summary).slice(0, 16_000) }, 'info');
    }
    if (e.type === 'result') {
      // Priority input may finish the old native turn before starting its own.
      // Never drain the queue or close the worker in that handoff.
      const ids = consumedClaudePromptIds(e);
      if (!this.active.get(t.id)?.stopped && (this.pendingSteers(s).length || ids.length && s.activePromptUuid && !ids.includes(s.activePromptUuid))) return;
      s.resumed = true;
      const interrupted = ['aborted_streaming', 'aborted_tools'].includes(e.terminal_reason);
      if (interrupted) { const worker = this.active.get(t.id); if (worker) worker.stopped = true; }
      this.finish(s, interrupted ? 'interrupted' : e.is_error ? 'error' : 'completed', e.is_error && !interrupted ? safeError((e.errors ?? []).join('\n') || 'Claude Code could not complete this turn.') : null);
    }
  }
  private tool(t: Row, block: Row, completed: boolean) {
    const previous = t.activities.find((a: Row) => a.id === block.id);
    if (previous && ['completed', 'failed', 'declined', 'stopped'].includes(previous.payload?.status)) return;
    const name = str(block.name); const input = row(block.input);
    const presentation = toolPresentation(name, input);
    this.activity(t, str(block.id), completed ? 'tool.completed' : 'tool.started', name, {
      ...presentation, itemId: block.id,
      status: completed ? 'completed' : 'running', detail: (name === 'AskUserQuestion'
        ? (Array.isArray(input.questions) ? input.questions : []).map(q => str(q.question)).join('\n')
        : name === 'ExitPlanMode' ? approvalDetail(name, input) : claudeToolInput(name, input)).slice(0, 16_000), data: { ...presentation.data, toolCallId: block.id },
    });
  }
  private releaseWorkerState(id: string, query: Query) {
    for (const [token, preview] of this.restorePreviews) if (preview.query === query) this.restorePreviews.delete(token);
    if (this.capabilityReads.get(id)?.query === query) this.capabilityReads.delete(id);
    if (this.capabilityInit.get(id)?.query === query) this.capabilityInit.delete(id);
    if (this.active.get(id)?.query === query) {
      this.active.delete(id);
      this.streamMessageIds.delete(id); this.streamSummaryModels.delete(id);
      this.viewed.delete(id);
    }
  }
  async close() {
    this.closing = true; await this.syncRecovery.close(); for (const timer of this.queueTimers.values()) clearTimeout(timer); this.queueTimers.clear(); if (this.historyTimer) clearInterval(this.historyTimer); await this.restoring; await this.workerGate;
    for (const [id, active] of this.active) {
      if (!this.requireThread(id).external && this.requireThread(id).thread.session.status === 'running') {
        await this.interrupt(this.requireThread(id)).catch(() => {});
      }
      active.inbox.close(); active.abort?.abort(); active.query.close(); await active.done;
    }
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
  }
}
