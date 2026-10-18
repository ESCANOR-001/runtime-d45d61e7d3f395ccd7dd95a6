import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { atomicWriteFile, hardenExistingSecret } from "../config";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";

type Row = Record<string, unknown>;
type Entry = { threadId: string; message: Row; attempted: boolean };
type State = { entries: Entry[]; receipts: string[] };
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 32;
const MAX_MESSAGE_BYTES = 256 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const uncertain = "Delivery could not be confirmed. Check the chat before removing or resending this message.";
const DESKTOP_PERMISSION_MODES: Record<string, Row> = {
  "read-only": { permissions: ":read-only", approvalPolicy: "on-request", approvalsReviewer: "user" },
  auto: { permissions: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "user" },
  "full-access": { permissions: ":danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" },
  "guardian-approvals": { permissions: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "guardian_subagent" },
  granular: { permissions: ":workspace", approvalPolicy: { granular: {
    sandbox_approval: false, rules: false, skill_approval: false, request_permissions: true, mcp_elicitations: true,
  } }, approvalsReviewer: "user" },
};
const row = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const key = (threadId: string, messageId: unknown): string => `${threadId}\0${messageId}`;

export interface DesktopFollowUpStore {
  read(): State;
  write(state: State): void;
}

/** Separate from the metadata-only mutation journal: accepted prompts must survive a restart. */
export function createDesktopFollowUpStore(root?: string): DesktopFollowUpStore {
  const path = root ? join(root, "android-remote-desktop-follow-ups.json") : null;
  let memory: State = { entries: [], receipts: [] };
  return {
    read() {
      if (!path || !existsSync(path)) return structuredClone(memory);
      if (statSync(path).size > MAX_BYTES) throw new Error("Desktop follow-up storage is too large");
      hardenExistingSecret(path);
      const parsed = JSON.parse(readFileSync(path, "utf8")) as State;
      if (!Array.isArray(parsed.entries) || !Array.isArray(parsed.receipts)
        || parsed.entries.length > MAX_MESSAGES || parsed.receipts.length > 1024
        || parsed.entries.some(entry => !ID.test(entry.threadId) || !row(entry.message)
          || typeof entry.message.id !== "string" || !ID.test(entry.message.id)
          || typeof entry.attempted !== "boolean")
        || parsed.receipts.some(receipt => typeof receipt !== "string")) {
        throw new Error("Desktop follow-up storage is invalid; queued messages were not discarded");
      }
      return parsed;
    },
    write(state) {
      const serialized = JSON.stringify(state);
      if (state.entries.length > MAX_MESSAGES || Buffer.byteLength(serialized) > MAX_BYTES) {
        throw new Error("Too many queued desktop messages. Remove one and try again.");
      }
      if (path && root) {
        assertNotRealHomeUnderTest(root);
        mkdirSync(root, { recursive: true, mode: 0o700 });
        try { chmodSync(root, 0o700); } catch { /* Windows uses the ACL below. */ }
        if (process.platform === "win32") hardenSecretDir(root, { required: false });
        atomicWriteFile(path, serialized);
        hardenExistingSecret(path);
      }
      memory = structuredClone(state);
    },
  };
}

/** Convert ordinary desktop composer context without silently dropping rich attachments. */
export function desktopFollowUpTurnParams(message: Row): Row {
  const context = row(message.context) ?? {};
  const options = row(message.submissionOptions) ?? {};
  const input: Row[] = [];
  const prompt = typeof context.prompt === "string" ? context.prompt : message.text;
  if (typeof prompt !== "string" || prompt.length > 120_000) throw new Error("Invalid desktop follow-up prompt");
  if (prompt) input.push({ type: "text", text: prompt, text_elements: [] });
  const knownContext = new Set([
    "prompt", "imageAttachments", "fileAttachments", "addedFiles", "messageThreadId",
    "turnTrigger", "requiresLocalPreparation", "ideContext", "workspaceRoots", "workPermissions",
  ]);
  const hasContent = (value: unknown): boolean => value != null && value !== false && value !== ""
    && (!Array.isArray(value) || value.length > 0);
  for (const [name, value] of Object.entries(context)) {
    if ((!knownContext.has(name) || name === "ideContext") && hasContent(value)) {
      throw new Error("This follow-up contains desktop-only context. Send it from Remodex or remove that context first.");
    }
  }
  if (hasContent(message.writingBlockAdditionalContext) || row(message.submission)?.editPosition != null) {
    throw new Error("Editing a queued desktop prompt with extra context is not supported by this connection yet.");
  }
  for (const name of ["imageAttachments", "fileAttachments", "addedFiles"]) {
    const attachments = context[name] ?? [];
    if (!Array.isArray(attachments) || attachments.length > 8) throw new Error("Invalid desktop follow-up attachments");
    for (const value of attachments) {
      const attachment = row(value);
      const path = typeof value === "string" ? value : attachment?.localPath ?? attachment?.path;
      if (name === "imageAttachments") {
        const src = path ?? attachment?.src;
        if (typeof src !== "string") throw new Error("Desktop image is not ready to send");
        if (isAbsolute(src) || /^[A-Za-z]:[\\/]/u.test(src)) input.push({ type: "localImage", path: src });
        else if (/^(https?:\/\/|data:image\/)/u.test(src)) input.push({ type: "image", url: src });
        else throw new Error("Desktop image is not ready to send");
      } else {
        if (typeof path !== "string" || !path) throw new Error("Desktop file is not ready to send");
        input.push({ type: "text", text: `File attached on this PC: ${path}`, text_elements: [] });
      }
    }
  }
  if (input.length === 0) throw new Error("Desktop follow-up cannot be empty");
  const clientId = message.clientUserMessageId ?? message.id;
  if (typeof clientId !== "string" || !ID.test(clientId)) throw new Error("Invalid desktop message id");
  if (options.executionHostId != null && options.executionHostId !== "local") {
    throw new Error("This connection can only send follow-ups to its local computer.");
  }
  const result: Row = { input, clientUserMessageId: clientId };
  for (const name of ["model", "effort", "serviceTier", "collaborationMode"]) {
    if (options[name] !== undefined) result[name] = options[name];
  }
  if (options.reasoningEffort !== undefined) result.effort = options.reasoningEffort;
  if (Array.isArray(context.workspaceRoots)) result.runtimeWorkspaceRoots = context.workspaceRoots;
  const permissions = row(row(context.workPermissions)?.resolvedPermissions);
  if (context.workPermissions != null && !permissions) throw new Error("Resolve this chat's desktop permissions before sending the follow-up.");
  if (permissions) {
    for (const name of ["approvalPolicy", "approvalsReviewer", "sandboxPolicy"]) {
      if (permissions[name] !== undefined) result[name] = permissions[name];
    }
    const profile = row(permissions.activePermissionProfile);
    if (profile) {
      if (typeof profile.id !== "string" || !profile.id) throw new Error("Invalid desktop permission profile");
      result.permissions = profile.id;
      delete result.sandboxPolicy;
      result.runtimeWorkspaceRoots = permissions.runtimeWorkspaceRoots ?? context.workspaceRoots ?? [];
    }
  } else {
    const selection = row(options.permissionSelection);
    if (selection?.kind === "profile" && typeof selection.profileId === "string" && selection.profileId) {
      result.permissions = selection.profileId;
    } else if (selection?.kind === "agent-mode" && typeof selection.agentMode === "string"
      && Object.hasOwn(DESKTOP_PERMISSION_MODES, selection.agentMode)) {
      Object.assign(result, structuredClone(DESKTOP_PERMISSION_MODES[selection.agentMode]));
    } else if (selection && selection.kind !== "server-default") {
      throw new Error("Resolve this chat's desktop permissions before sending the follow-up.");
    }
  }
  return result;
}

export class DesktopFollowUpQueue {
  private state: State;
  private loadError: unknown;
  private running = new Set<string>();
  private stopped = false;
  constructor(private readonly options: {
    store: DesktopFollowUpStore;
    isReady: (threadId: string) => boolean;
    send: (threadId: string, params: Row) => Promise<void>;
    publish: (threadId: string, messages: Row[]) => void;
    warn: (message: string) => void;
  }) {
    try { this.state = options.store.read(); }
    catch (error) {
      this.state = { entries: [], receipts: [] };
      this.loadError = error;
      options.warn("Desktop follow-up storage could not be read; existing messages were left untouched");
    }
  }

  messages(threadId: string): Row[] {
    return this.state.entries.filter(entry => entry.threadId === threadId).map(entry => ({
      ...structuredClone(entry.message),
      ...(entry.attempted ? { pausedReason: this.running.has(threadId) ? undefined : uncertain, submission: {
        ...row(entry.message.submission), hostId: "local", status: this.running.has(threadId) ? "sending" : "outcome-unknown",
      } } : {}),
    }));
  }
  publish(threadId: string): void {
    // An unreadable journal is not evidence that the follower's queue is empty.
    if (this.loadError) return;
    try { this.options.publish(threadId, this.messages(threadId)); }
    catch { this.options.warn("Desktop follow-up notification could not be sent; persisted messages were retained"); }
  }
  start(): void { this.stopped = false; }
  stop(): void { this.stopped = true; }

  accept(threadId: string, state: unknown, discarded: unknown = []): void {
    if (this.stopped) throw new Error("Desktop follow-up queue is stopped");
    if (this.loadError) throw new Error("Desktop follow-up storage is unavailable; your message was not accepted");
    const incoming = row(state)?.[threadId];
    if (!ID.test(threadId) || !Array.isArray(incoming) || incoming.length > MAX_MESSAGES
      || !Array.isArray(discarded) || discarded.some(id => typeof id !== "string" || !ID.test(id))) {
      throw new Error("Invalid desktop follow-up state");
    }
    const previous = this.state.entries.filter(entry => entry.threadId === threadId);
    const next: Entry[] = [];
    const seen = new Set<string>();
    for (const candidate of incoming) {
      const message = row(candidate);
      if (!message || typeof message.id !== "string" || !ID.test(message.id) || seen.has(message.id)
        || Buffer.byteLength(JSON.stringify(message)) > MAX_MESSAGE_BYTES) throw new Error("Invalid desktop queued message");
      seen.add(message.id);
      if (this.state.receipts.includes(key(threadId, message.id))) continue;
      const existing = previous.find(entry => entry.message.id === message.id);
      if (existing?.attempted) { next.push(existing); continue; }
      desktopFollowUpTurnParams(message); // Validate the entire update before acknowledging or executing any of it.
      const status = row(message.submission)?.status;
      next.push({ threadId, message: structuredClone(message), attempted: status === "sending" || status === "outcome-unknown" });
    }
    for (const entry of previous) {
      if (entry.attempted && !seen.has(entry.message.id as string) && !discarded.includes(entry.message.id)) next.push(entry);
    }
    this.commit({ ...this.state, entries: [...this.state.entries.filter(entry => entry.threadId !== threadId), ...next] });
    this.publish(threadId);
    this.wake(threadId);
  }

  remove(threadId: string, messageId: unknown): boolean {
    if (this.loadError) throw new Error("Desktop follow-up storage is unavailable");
    if (typeof messageId !== "string" || !ID.test(messageId)) throw new Error("Invalid queued message id");
    const entry = this.state.entries.find(entry => entry.threadId === threadId && entry.message.id === messageId);
    if (!entry) return false;
    if (entry.attempted && this.running.has(threadId)) throw new Error("This message is being sent; wait for its outcome before removing it.");
    this.commit({ ...this.state, entries: this.state.entries.filter(candidate => candidate !== entry) });
    this.publish(threadId);
    this.wake(threadId);
    return true;
  }

  clear(threadId: string): Row[] {
    if (this.loadError) throw new Error("Desktop follow-up storage is unavailable");
    const entries = this.state.entries.filter(entry => entry.threadId === threadId);
    if (entries.some(entry => entry.attempted) && this.running.has(threadId)) throw new Error("A message is being sent; wait for its outcome before clearing the queue.");
    this.commit({ ...this.state, entries: this.state.entries.filter(entry => entry.threadId !== threadId) });
    this.publish(threadId);
    return entries.map(entry => structuredClone(entry.message));
  }

  /** Exact durable user-message receipts can settle a response lost across a disconnect. */
  accepted(threadId: string, messageId: unknown): void {
    if (typeof messageId !== "string" || !messageId) return;
    const entry = this.state.entries.find(entry => entry.threadId === threadId
      && (entry.message.id === messageId || entry.message.clientUserMessageId === messageId));
    if (!entry) return;
    try {
      this.commit({
        entries: this.state.entries.filter(candidate => candidate !== entry),
        receipts: [...new Set([...this.state.receipts, key(threadId, entry.message.id)])].slice(-1024),
      });
      this.publish(threadId);
      this.wake(threadId);
    } catch {
      this.options.warn("Desktop follow-up receipt could not be saved; delivery will not be retried automatically");
    }
  }

  pause(threadId: string): void {
    if (this.loadError || !this.state.entries.some(entry => entry.threadId === threadId && !entry.attempted)) return;
    const next = { ...this.state, entries: this.state.entries.map(entry => entry.threadId === threadId && !entry.attempted
      ? { ...entry, message: { ...entry.message, pausedReason: "The previous turn was stopped. Remove and resend this follow-up when ready." } }
      : entry) };
    try { this.commit(next); }
    catch {
      // Keep the in-process stop effective even when disk is full. Fail closed until restart.
      this.state = next;
      this.stopped = true;
      this.options.warn("Desktop follow-up pause could not be saved; queue dispatch has been stopped");
    }
    this.publish(threadId);
  }

  wake(threadId: string): void {
    if (this.stopped || this.running.has(threadId) || !this.options.isReady(threadId)) return;
    const entry = this.state.entries.find(entry => entry.threadId === threadId);
    if (!entry || entry.attempted || entry.message.pausedReason) return;
    this.running.add(threadId);
    let delivered = false;
    // Dispatch after durable admission; recheck current state and ownership before sending.
    void Promise.resolve().then(async () => {
      if (this.stopped || !this.options.isReady(threadId)
        || this.state.entries.find(candidate => candidate.threadId === threadId) !== entry) return;
      const params = desktopFollowUpTurnParams(entry.message);
      const attempted = { ...entry, attempted: true };
      this.commit({ ...this.state, entries: this.state.entries.map(candidate => candidate === entry ? attempted : candidate) });
      this.publish(threadId);
      await this.options.send(threadId, params);
      this.accepted(threadId, entry.message.id);
      delivered = true;
    }).catch(() => {
      // No automatic replay after an ambiguous transport failure; retain the prompt for reconciliation.
      this.running.delete(threadId);
      this.options.warn("Desktop follow-up delivery paused; the queued message was retained");
      this.publish(threadId);
    }).finally(() => {
      this.running.delete(threadId);
      if (delivered) this.wake(threadId);
    });
  }

  private commit(next: State): void {
    this.options.store.write(next);
    this.state = next;
  }
}
