import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import { execFile } from "node:child_process";
import type { CodexJsonRpcMessage } from "./codex-app-server";
import { desktopConversationModelSelectors, remodexRuntimeModelSelectors } from "./desktop-model-route";
import {
  createAndroidDesktopOwnershipStore,
  type AndroidDesktopOwnershipStore,
} from "./desktop-ownership-store";
import {
  canonicalUserMessageText,
  isPrivateTranscriptRole,
  sanitizePublicTranscriptText,
} from "./user-message-identity";
import {
  DESKTOP_HISTORY_PAGE_MAX_ITEMS,
  DESKTOP_HISTORY_PAGE_MAX_TURNS,
  DesktopHistoryPageStore,
  type DesktopBoundedHistoryPage,
  type DesktopContentChunk,
  type DesktopHistoryPageDirection,
  type DesktopJsonRecord,
} from "./desktop-history-page";

type JsonRecord = Record<string, unknown>;
type RequestId = string | number;
type Timer = ReturnType<typeof setTimeout>;

const FRAME_HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_BUFFER_BYTES = FRAME_HEADER_BYTES + MAX_FRAME_BYTES;
const SNAPSHOT_DEBOUNCE_MS = 75;
const RECONNECT_MS = 1_500;
const REQUEST_TIMEOUT_MS = 10_000;
const FOLLOW_CONFIRM_MS = 1_500;
const FOLLOW_MAX_ATTEMPTS = 3;
const FOLLOW_STATE_TIMEOUT_MS = 3_000;
const OWNER_REACQUIRE_TIMEOUT_MS = 1_500;
const FOLLOWER_MOUNT_BASELINE_DELAY_MS = 250;
const SIDEBAR_REFRESH_DELAY_MS = 1_200;
const INITIAL_HISTORY_RETRY_MS = 1_000;
const INITIAL_HISTORY_MAX_ATTEMPTS = 5;
const FOLLOWER_BASELINE_RETRY_MS = 1_000;
const FOLLOWER_BASELINE_MAX_RETRY_MS = 15_000;
const FOLLOWER_BASELINE_MAX_ATTEMPTS = 5;
const MAX_QUEUED_FOLLOWER_CHANGES = 300;
const MAX_PATCH_COUNT = 2_000;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_STREAM_TEXT_BYTES = 1024 * 1024;
/**
 * A Desktop renderer can publish its stream snapshot before it has registered
 * the follower request handler.  A router-level no-client-found is the one
 * pre-delivery failure that is safe to retry.  Keep this schedule centralized
 * so every follower mutation has identical delivery semantics.
 */
const FOLLOWER_OWNER_RETRY_DELAYS_MS = [0, 125, 350] as const;
const OWNER_REACTIVATION_DELAYS_MS = [0, 100, 250, 500, 1_000, 1_500] as const;
const OWNER_REACTIVATION_METHODS = new Set([
  "thread-follower-start-turn",
  "thread-follower-update-thread-settings",
  "thread-follower-steer-turn",
  "thread-follower-interrupt-turn",
  "thread-follower-edit-last-user-turn",
  "thread-follower-compact-thread",
  "thread-follower-rollback-thread",
  "thread-follower-set-model-and-reasoning",
  "thread-follower-set-collaboration-mode",
  "thread-follower-command-approval-decision",
  "thread-follower-file-approval-decision",
  "thread-follower-permissions-request-approval-response",
  "thread-follower-submit-user-input",
  "thread-follower-submit-mcp-server-elicitation-response",
]);
const THREAD_STREAM_STATE_CHANGED = "thread-stream-state-changed";
const THREAD_STREAM_FOLLOWING_CHANGED = "thread-stream-following-changed";
const CLIENT_STATUS_CHANGED = "client-status-changed";
const THREAD_ARCHIVED = "thread-archived";
/**
 * Metadata-only route probe.  This method must never cause a renderer to
 * materialize or broadcast conversation history; the router uses the
 * discovery response (and its handledByClientId) solely to identify the
 * current writer.
 */
export const DESKTOP_IPC_OWNER_DISCOVERY_METHOD = "thread-owner-discovery";
const THREAD_OWNER_DISCOVERY = DESKTOP_IPC_OWNER_DISCOVERY_METHOD;
const THREAD_FOLLOWER_LOAD_HISTORY_PAGE = "thread-follower-load-history-page";
const THREAD_FOLLOWER_READ_CONTENT_CHUNK = "thread-follower-read-content-chunk";
const HOST_ID = "local";
const OWNER_SOURCE = "opencodex-android-live-owner";

/**
 * Single source of truth for the private Codex Desktop IPC protocol.  The
 * Desktop renderer validates these versions before dispatching a request; a
 * stale version is a protocol error, never evidence that the thread writer was
 * released.
 */
export const DESKTOP_IPC_METHOD_VERSIONS = new Map<string, number>([
  ["initialize", 1],
  [CLIENT_STATUS_CHANGED, 1],
  [THREAD_STREAM_STATE_CHANGED, 11],
  [THREAD_STREAM_FOLLOWING_CHANGED, 1],
  ["thread-stream-following-status-requested", 1],
  [THREAD_OWNER_DISCOVERY, 1],
  [THREAD_FOLLOWER_LOAD_HISTORY_PAGE, 1],
  [THREAD_FOLLOWER_READ_CONTENT_CHUNK, 1],
  [THREAD_ARCHIVED, 2],
  ["thread-unarchived", 1],
  ["thread-read-state-changed", 2],
  ["thread-queued-followups-changed", 1],
  ["thread-follower-start-turn", 2],
  ["thread-follower-load-complete-history", 1],
  ["thread-follower-update-thread-settings", 2],
  ["thread-follower-compact-thread", 1],
  ["thread-follower-steer-turn", 1],
  ["thread-follower-interrupt-turn", 4],
  ["thread-follower-rollback-thread", 1],
  ["thread-follower-edit-last-user-turn", 2],
  ["thread-follower-set-model-and-reasoning", 1],
  ["thread-follower-set-collaboration-mode", 1],
  ["thread-follower-command-approval-decision", 1],
  ["thread-follower-file-approval-decision", 1],
  ["thread-follower-permissions-request-approval-response", 1],
  ["thread-follower-submit-user-input", 1],
  ["thread-follower-submit-mcp-server-elicitation-response", 1],
  ["thread-follower-set-queued-follow-ups-state", 1],
]);

/** Compatibility rule retained deliberately for old stop buttons. */
export function desktopIpcRequestVersion(method: string, params: unknown = {}): number {
  if (
    method === "thread-follower-interrupt-turn"
    && (!record(params)?.expectedTurnId && !record(params)?.expected_turn_id)
  ) {
    return 3;
  }
  return DESKTOP_IPC_METHOD_VERSIONS.get(method) ?? 1;
}

const FOLLOWER_METHODS = new Set([
  "thread-follower-start-turn",
  "thread-follower-load-complete-history",
  THREAD_FOLLOWER_LOAD_HISTORY_PAGE,
  THREAD_FOLLOWER_READ_CONTENT_CHUNK,
  "thread-follower-update-thread-settings",
  "thread-follower-compact-thread",
  "thread-follower-steer-turn",
  "thread-follower-interrupt-turn",
  "thread-follower-rollback-thread",
  "thread-follower-set-model-and-reasoning",
  "thread-follower-set-collaboration-mode",
  "thread-follower-command-approval-decision",
  "thread-follower-file-approval-decision",
  "thread-follower-permissions-request-approval-response",
  "thread-follower-submit-user-input",
  "thread-follower-submit-mcp-server-elicitation-response",
  "thread-follower-set-queued-follow-ups-state",
]);

const SERVER_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/fileRead/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "item/tool/requestMcpServerElicitation",
]);

const ALLOWED_TURN_START_KEYS = new Set([
  "threadId",
  "clientUserMessageId",
  "input",
  "cwd",
  "approvalPolicy",
  "approvalsReviewer",
  "sandboxPolicy",
  "model",
  "serviceTier",
  "effort",
  "summary",
  "personality",
  "outputSchema",
  "collaborationMode",
]);

export type DesktopIpcEnvelope = JsonRecord & {
  type?: string;
  method?: string;
  requestId?: RequestId;
  sourceClientId?: string;
  targetClientId?: string;
  targetClientIds?: string[];
  timeoutMs?: number;
  params?: JsonRecord;
};

export type DesktopIpcResponseSettled = {
  requestId: RequestId;
  method: string;
  threadId: string;
  commandId: string;
  localClientId: string;
  handledByClientId: string;
  targetClientId?: string;
  resultType: "success" | "error";
};

export type DesktopThreadOwnershipState = "unknown" | "desktop-owned" | "local-owned";

export type DesktopThreadOwnership = {
  state: DesktopThreadOwnershipState;
  /** Current Desktop renderer owner, when one has been observed. */
  ownerClientId: string | null;
  /** True once any authoritative Desktop state/response has named an owner. */
  everDesktopOwned: boolean;
};

export type DesktopIpcConnectionSnapshot = {
  connected: boolean;
  generation: number;
  localClientId: string;
};

export type DesktopIpcDiscoveryResult = {
  canHandle: boolean;
  handledByClientId?: string;
  timedOut?: boolean;
};

export interface AndroidDesktopIpcSync {
  start(): void;
  stop(): void;
  claimThread(input: {
    threadId: string;
    turnStartParams: JsonRecord;
    cwd?: string;
    title?: string;
  }): void;
  releaseThread(threadId: string): void;
  observeCodexMessage(message: CodexJsonRpcMessage): void;
  isThreadOwned(threadId: string): boolean;
  /**
   * Distinguishes the real app-server writer from this bridge's presentation
   * mirror.  Older test doubles may omit this optional method; callers then
   * conservatively derive local ownership from `isThreadOwned`.
   */
  threadOwnership?(threadId: string): DesktopThreadOwnership;
  desktopOwnerClientId?(threadId: string): string | null;
  hasObservedDesktopOwner?(threadId: string): boolean;
  /** Explicit, authoritative owner-release/local-adoption transition. */
  releaseDesktopOwnership?(threadId: string): void;
  /** Record that the private app-server has already mounted this thread. */
  adoptLocalThread?(threadId: string): void;
  /**
   * Ask Codex Desktop to perform an action on a task it already owns.
   * A missing Desktop handler is reported as an error so the caller can use
   * the normal local Codex connection instead.
   */
  requestFollowerAction?(method: string, params: JsonRecord): Promise<unknown>;
  readFollowerThreadState?(
    threadId: string,
    options?: { fresh?: boolean },
  ): Promise<JsonRecord | null>;
  /** Read one bounded recent/older/newer page without registering a follower. */
  readFollowerHistoryPage?(
    threadId: string,
    options?: {
      direction?: DesktopHistoryPageDirection;
      pageToken?: string | null;
    },
  ): Promise<JsonRecord | null>;
  /** Read one bounded opaque content chunk associated with a page handle. */
  readFollowerContentChunk?(
    threadId: string,
    input: { handle: string; sourceRevision: string; offset: number },
  ): Promise<DesktopContentChunk>;
  /**
   * Read-only route preflight used before a prompt is written to Desktop IPC.
   * `absent` means no Desktop owner handled the request, while `unhealthy`
   * means the route existed but could not publish a trustworthy state.
   */
  probeFollowerRoute?(
    threadId: string,
    options?: { refreshOwner?: boolean },
  ): Promise<"ready" | "absent" | "unhealthy">;
  /** Current owner discovery only; does not read or register conversation history. */
  hasLiveThreadOwner?(threadId: string): Promise<boolean | null>;
  /**
   * Reacquire the current renderer id for a remembered Desktop-owned task.
   * This is a read-only owner probe.  A caller must not send a follower
   * mutation until this resolves to a concrete client id.
   */
  reacquireDesktopOwner?(threadId: string): Promise<string | null>;
  /**
   * Non-sensitive connection metadata for route diagnostics. This never
   * includes prompt text, attachments, credentials, or raw IPC payloads.
   */
  connectionSnapshot?(): DesktopIpcConnectionSnapshot;
  /**
   * Bring a Desktop-owned task back into the live IPC owner set. Desktop may
   * release an idle task while its append-only transcript still contains a
   * pending question, so Android response delivery must be able to reattach it.
   */
  activateFollowerThread?(threadId: string): Promise<void>;
}

export type DesktopIpcSyncOptions = {
  platform?: NodeJS.Platform;
  socketPaths?: () => string[];
  now?: () => number;
  connect?: (path: string) => Socket;
  openUrl?: (url: string) => Promise<void>;
  readThread: (threadId: string) => Promise<JsonRecord | null>;
  /** Optional byte-bounded recent-page reader used during local hydration. */
  readThreadPage?: (threadId: string) => Promise<JsonRecord | null>;
  sendCodexRequest: (method: string, params: JsonRecord) => Promise<unknown>;
  respondToCodexRequest: (id: RequestId, result: JsonRecord) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  reconnectMs?: number;
  snapshotDebounceMs?: number;
  followConfirmMs?: number;
  followMaxAttempts?: number;
  initialHistoryRetryMs?: number;
  initialHistoryMaxAttempts?: number;
  followerBaselineRetryMs?: number;
  followerBaselineMaxRetryMs?: number;
  followerBaselineMaxAttempts?: number;
  followerStateTimeoutMs?: number;
  ownerReacquireTimeoutMs?: number;
  ownershipStore?: AndroidDesktopOwnershipStore;
  historyPageStore?: DesktopHistoryPageStore;
  transport?: DesktopIpcTransportLike;
};

export type CodexDesktopOpenCommand = {
  command: string;
  args: string[];
};

export interface DesktopIpcTransportLike {
  start(): void;
  stop(): void;
  sendBroadcast(method: string, params: JsonRecord): boolean;
  request(
    method: string,
    params: JsonRecord,
    options?: { targetClientId?: string },
  ): Promise<unknown>;
  /**
   * Read-only owner discovery through the router's public request path. The
   * discovery method itself returns no history or transcript state.
   */
  discover?(
    method: string,
    params: JsonRecord,
    options?: { targetClientId?: string; timeoutMs?: number },
  ): Promise<DesktopIpcDiscoveryResult>;
  reset?(reason?: string): void;
  setHandlers(handlers: DesktopIpcTransportHandlers): void;
  readonly connected: boolean;
  readonly localClientId?: string;
  readonly generation?: number;
}

type DesktopIpcTransportHandlers = {
  onConnected: () => void;
  onDisconnected?: () => void;
  onBroadcast: (envelope: DesktopIpcEnvelope) => void;
  canHandleRequest: (envelope: DesktopIpcEnvelope) => boolean;
  handleRequest: (envelope: DesktopIpcEnvelope) => Promise<unknown>;
};

type ConversationTurn = JsonRecord & {
  id: string;
  turnId: string;
  params: JsonRecord;
  items: JsonRecord[];
  status: unknown;
};

type ConversationState = JsonRecord & {
  id: string;
  hostId: string;
  turns: ConversationTurn[];
  requests: JsonRecord[];
  updatedAt: number;
};

type JsonPatch = {
  op: "add" | "remove" | "replace";
  path: Array<string | number>;
  value?: unknown;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function threadSettingsUpdateUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /method not found|unknown method|unsupported method|thread\/settings\/update.*(?:unsupported|unavailable)|experimental.*disabled|-32601/iu.test(message);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requestIdKey(value: unknown): string {
  if (typeof value === "string" && value) return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeToken(value: unknown): string {
  return stringValue(value).replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function threadIdFromParams(params: unknown): string {
  const row = record(params);
  const turn = record(row?.turn);
  const thread = record(row?.thread);
  return stringValue(row?.threadId)
    || stringValue(row?.thread_id)
    || stringValue(row?.conversationId)
    || stringValue(row?.conversation_id)
    || stringValue(turn?.threadId)
    || stringValue(thread?.id);
}

function commandIdFromParams(params: unknown): string {
  const row = record(params);
  const turnStart = record(row?.turnStart);
  const turnStartRequest = record(turnStart?.request);
  const turnStartParams = record(row?.turnStartParams) ?? record(row?.turn_start_params);
  const turnSteerParams = record(row?.turnSteerParams) ?? record(row?.turn_steer_params);
  return stringValue(row?.senderRequestId)
    || stringValue(row?.sender_request_id)
    || stringValue(row?.commandId)
    || stringValue(row?.command_id)
    || stringValue(row?.clientUserMessageId)
    || stringValue(row?.client_user_message_id)
    || stringValue(turnStartRequest?.clientUserMessageId)
    || stringValue(turnStartRequest?.client_user_message_id)
    || stringValue(turnStartParams?.clientUserMessageId)
    || stringValue(turnStartParams?.client_user_message_id)
    || stringValue(turnSteerParams?.clientUserMessageId)
    || stringValue(turnSteerParams?.client_user_message_id);
}

function diagnosticToken(value: unknown, maximum = 160): string {
  const normalized = stringValue(value)
    .replace(/[^a-z0-9._:/-]/giu, "_")
    .slice(0, maximum);
  return normalized || "-";
}

function desktopFollowerRouteIsAbsent(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no codex ipc client can handle|no-client-found|conversation-not-owned|thread not found|conversation not found|not connected/iu.test(
    message,
  );
}

function desktopFollowerNoClientFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Only router-level absence is retryable.  A timeout, socket close, protocol
  // mismatch, or Desktop application error may have happened after the write.
  return /no codex ipc client can handle|no-client-found/iu.test(message);
}

function desktopFollowerMethodUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:method|request).*(?:not found|unknown|unsupported|unavailable)|unknown method|unsupported method|-32601/iu.test(
    message,
  );
}

function desktopHistoryPageUnavailable(error: unknown): boolean {
  return desktopFollowerMethodUnsupported(error)
    || (error instanceof DesktopIpcOwnershipError
      && error.method === THREAD_FOLLOWER_LOAD_HISTORY_PAGE
      && error.reason === "no-client-found")
    || (error instanceof Error && /^(?:no-client-found|no codex ipc client can handle this request)$/iu.test(error.message.trim()));
}

export class DesktopIpcOwnershipError extends Error {
  constructor(
    message: string,
    readonly threadId: string,
    readonly method: string,
    readonly attempts: number,
    readonly reason: "no-client-found" | "owner-unavailable" | "ownership-conflict" = "ownership-conflict",
  ) {
    super(message);
    this.name = "DesktopIpcOwnershipError";
  }
}

function turnIdFromParams(params: unknown): string {
  const row = record(params);
  const turn = record(row?.turn);
  return stringValue(row?.turnId)
    || stringValue(row?.turn_id)
    || stringValue(turn?.id)
    || stringValue(turn?.turnId);
}

function timestampMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value < 10_000_000_000 ? value * 1_000 : value)
    : fallback;
}

function waitMs(delayMs: number): Promise<void> {
  // This timer is part of an awaited send, not background housekeeping.
  // Keep it alive so a reconnect retry can finish even with no live socket.
  return new Promise(resolve => setTimeout(resolve, Math.max(0, delayMs)));
}

export function desktopIpcSocketPaths(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "win32") return ["\\\\.\\pipe\\codex-ipc"];
  if (platform !== "darwin" && platform !== "linux") return [];
  const configuredHome = stringValue(environment.CODEX_HOME);
  const codexHome = configuredHome
    ? posix.normalize(configuredHome.replace(/\\/gu, "/"))
    : posix.join(homedir().replace(/\\/gu, "/"), ".codex");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return [
    posix.join(codexHome, "ipc", "ipc.sock"),
    posix.join(tmpdir().replace(/\\/gu, "/"), "codex-ipc", `ipc-${uid}.sock`),
  ];
}

export function encodeDesktopIpcFrame(envelope: DesktopIpcEnvelope): Buffer {
  const body = Buffer.from(JSON.stringify(envelope), "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new RangeError("Codex Desktop IPC frame exceeds the 64 MB limit");
  }
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class DesktopIpcFrameReader {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly onFrame: (envelope: DesktopIpcEnvelope) => void,
    private readonly onCorruption: (error: Error) => void = () => undefined,
  ) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (
      chunk.length > MAX_FRAME_BUFFER_BYTES
      || this.buffer.length > MAX_FRAME_BUFFER_BYTES - chunk.length
    ) {
      this.fail("Codex Desktop IPC receive buffer exceeded the 64 MB frame limit");
      return;
    }
    try {
      this.buffer = this.buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, chunk], this.buffer.length + chunk.length);
    } catch {
      this.fail("Codex Desktop IPC could not allocate its bounded receive buffer");
      return;
    }
    while (this.buffer.length >= FRAME_HEADER_BYTES) {
      const frameLength = this.buffer.readUInt32LE(0);
      if (frameLength > MAX_FRAME_BYTES) {
        this.fail("Codex Desktop IPC frame length exceeded the 64 MB limit");
        return;
      }
      if (this.buffer.length < FRAME_HEADER_BYTES + frameLength) return;
      const text = this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + frameLength).toString("utf8");
      this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES + frameLength);
      try {
        const envelope = record(JSON.parse(text));
        if (!envelope) {
          this.fail("Codex Desktop IPC frame did not contain an object envelope");
          return;
        }
        this.onFrame(envelope as DesktopIpcEnvelope);
      } catch {
        // A malformed body or throwing frame handler means this connection can
        // no longer be trusted. Reconnect instead of attempting to continue on
        // a potentially misaligned byte stream.
        this.fail("Codex Desktop IPC received a malformed frame");
        return;
      }
    }
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  private fail(message: string): void {
    this.buffer = Buffer.alloc(0);
    this.onCorruption(new Error(message));
  }
}

export class DesktopIpcTransport implements DesktopIpcTransportLike {
  private socket: Socket | null = null;
  private reader: DesktopIpcFrameReader | null = null;
  private connecting = false;
  private initialized = false;
  private clientId = "";
  private connectionGeneration = 0;
  private shouldReconnect = false;
  private reconnectTimer: Timer | null = null;
  private remainingPaths: string[] = [];
  private handlers: DesktopIpcTransportHandlers = {
    onConnected: () => undefined,
    onBroadcast: () => undefined,
    canHandleRequest: () => false,
    handleRequest: async () => null,
  };
  private readonly pending = new Map<string, {
    method: string;
    threadId: string;
    commandId: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: Timer;
    generation: number;
    targetClientId?: string;
  }>();
  private readonly pendingDiscoveries = new Map<string, {
    resolve: (result: DesktopIpcDiscoveryResult) => void;
    timer: Timer;
  }>();

  constructor(private readonly options: {
    paths: () => string[];
    connect: (path: string) => Socket;
    now: () => number;
    reconnectMs: number;
    requestTimeoutMs?: number;
    warn: (message: string) => void;
    onResponseSettled?: (response: DesktopIpcResponseSettled) => void;
  }) {}

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed && this.initialized);
  }

  get localClientId(): string {
    return this.clientId;
  }

  get generation(): number {
    return this.connectionGeneration;
  }

  setHandlers(handlers: DesktopIpcTransportHandlers): void {
    this.handlers = handlers;
  }

  start(): void {
    this.shouldReconnect = true;
    this.ensureConnected();
  }

  stop(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeSocket();
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Codex Desktop IPC stopped"));
    }
    this.pending.clear();
    for (const pending of this.pendingDiscoveries.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ canHandle: false, timedOut: true });
    }
    this.pendingDiscoveries.clear();
  }

  reset(reason = "Codex Desktop IPC connection was reset"): void {
    this.closeSocket(new Error(reason));
  }

  sendBroadcast(method: string, params: JsonRecord): boolean {
    this.ensureConnected();
    if (!this.connected) return false;
    return this.write({
      type: "broadcast",
      method,
      sourceClientId: this.clientId,
      version: desktopIpcRequestVersion(method, params),
      params,
    });
  }

  request(
    method: string,
    params: JsonRecord,
    options: { targetClientId?: string } = {},
  ): Promise<unknown> {
    this.ensureConnected();
    return this.sendRequest(method, params, false, undefined, options);
  }

  discover(
    method: string,
    params: JsonRecord,
    options: { targetClientId?: string; timeoutMs?: number } = {},
  ): Promise<DesktopIpcDiscoveryResult> {
    this.ensureConnected();
    const socket = this.socket;
    const generation = this.connectionGeneration;
    if (
      !socket
      || socket.destroyed
      || !this.isCurrentConnection(socket, generation)
    ) return Promise.resolve({ canHandle: false, timedOut: true });
    const requestId = `opencodex-discovery-${this.options.now().toString(36)}-${randomUUID()}`;
    const timeoutMs = Math.max(1, options.timeoutMs ?? OWNER_REACQUIRE_TIMEOUT_MS);
    return new Promise(resolvePromise => {
      const timer = setTimeout(() => {
        this.pendingDiscoveries.delete(requestId);
        resolvePromise({ canHandle: false, timedOut: true });
      }, timeoutMs);
      timer.unref?.();
      this.pendingDiscoveries.set(requestId, { resolve: resolvePromise, timer });
      // Clients send an ordinary request to the Desktop router. The router
      // creates its private client-discovery-request envelope when asking
      // renderer candidates whether they can handle this metadata-only method.
      // Sending that private envelope from here makes the router reject it as
      // an unexpected server-side message and every Stop/Steer probe times out.
      const sent = this.write({
        type: "request",
        requestId,
        sourceClientId: this.clientId || "opencodex-android-bridge",
        version: desktopIpcRequestVersion(method, params),
        method,
        params,
        timeoutMs,
        ...(stringValue(options.targetClientId)
          ? { targetClientId: stringValue(options.targetClientId) }
          : {}),
      }, socket, generation);
      if (!sent) {
        clearTimeout(timer);
        this.pendingDiscoveries.delete(requestId);
        resolvePromise({ canHandle: false, timedOut: true });
      }
    });
  }

  private ensureConnected(): void {
    if (!this.shouldReconnect || this.socket || this.connecting) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.remainingPaths = this.options.paths();
    this.connectNext();
  }

  private connectNext(): void {
    const path = this.remainingPaths.shift();
    if (!path) {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    this.connecting = true;
    let socket: Socket;
    try {
      socket = this.options.connect(path);
    } catch (error) {
      this.connecting = false;
      if (this.remainingPaths.length > 0) {
        this.connectNext();
      } else {
        this.scheduleReconnect();
      }
      this.options.warn(
        `Codex Desktop IPC connection failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return;
    }
    const generation = this.connectionGeneration + 1;
    this.connectionGeneration = generation;
    this.socket = socket;
    const reader = new DesktopIpcFrameReader(
      envelope => {
        if (!this.isCurrentConnection(socket, generation)) return;
        this.dispatch(envelope);
      },
      error => {
        if (!this.isCurrentConnection(socket, generation)) return;
        this.options.warn(error.message);
        this.closeSocket(error, socket, generation);
      },
    );
    this.reader = reader;
    socket.once("connect", () => {
      if (!this.isCurrentConnection(socket, generation)) return;
      this.connecting = false;
      void this.sendRequest(
        "initialize",
        { clientType: "opencodex-android-bridge" },
        true,
        { socket, generation },
      )
        .then(result => {
          if (!this.isCurrentConnection(socket, generation)) return;
          this.clientId = stringValue(record(result)?.clientId) || this.clientId;
          this.initialized = true;
          this.handlers.onConnected();
        })
        .catch(error => {
          if (!this.isCurrentConnection(socket, generation)) return;
          this.options.warn(`Codex Desktop IPC initialization failed: ${error instanceof Error ? error.message : "unknown error"}`);
          this.closeSocket(
            new Error("Codex Desktop IPC initialization failed"),
            socket,
            generation,
          );
        });
    });
    socket.on("data", chunk => {
      if (!this.isCurrentConnection(socket, generation)) return;
      try {
        reader.push(Buffer.from(chunk));
      } catch {
        const error = new Error("Codex Desktop IPC failed while reading a frame");
        this.options.warn(error.message);
        this.closeSocket(error, socket, generation);
      }
    });
    socket.once("close", () => this.handleClose(socket, generation));
    socket.once("error", error => {
      if (!this.isCurrentConnection(socket, generation)) return;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        if (this.remainingPaths.length > 0) {
          this.socket = null;
          this.reader = null;
          this.connecting = false;
          this.initialized = false;
          this.clientId = "";
          reader.reset();
          socket.destroy();
          this.connectNext();
        } else {
          this.closeSocket(
            new Error("Codex Desktop IPC endpoint is unavailable"),
            socket,
            generation,
          );
        }
        return;
      }
      if (code !== "ENOENT" && code !== "ECONNREFUSED") {
        this.options.warn(`Codex Desktop IPC connection failed: ${error.message}`);
        this.closeSocket(
          new Error("Codex Desktop IPC connection failed"),
          socket,
          generation,
        );
      }
    });
  }

  private sendRequest(
    method: string,
    params: JsonRecord,
    initializing = false,
    expected?: { socket: Socket; generation: number },
    options: { targetClientId?: string } = {},
  ): Promise<unknown> {
    const socket = expected?.socket ?? this.socket;
    const generation = expected?.generation ?? this.connectionGeneration;
    if (
      !socket
      || socket.destroyed
      || !this.isCurrentConnection(socket, generation)
    ) {
      return Promise.reject(new Error("Codex Desktop IPC is not connected"));
    }
    const requestId = `opencodex-${this.options.now().toString(36)}-${randomUUID()}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`Codex Desktop IPC request timed out: ${method}`);
        reject(error);
        if (initializing) {
          this.closeSocket(error, socket, generation);
          return;
        }
        // A thread-specific timeout is not proof that the whole Desktop IPC
        // connection is broken. Keep the connection and fail this request
        // without retrying it through another owner.
      }, this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(requestId, {
        method,
        threadId: threadIdFromParams(params),
        commandId: commandIdFromParams(params),
        resolve: resolvePromise,
        reject,
        timer,
        generation,
        ...(stringValue(options.targetClientId)
          ? { targetClientId: stringValue(options.targetClientId) }
          : {}),
      });
      const sent = this.write({
        type: "request",
        requestId,
        sourceClientId: initializing ? "initializing-client" : this.clientId || "opencodex-android-bridge",
        version: desktopIpcRequestVersion(method, params),
        method,
        params,
        ...(stringValue(options.targetClientId)
          ? { targetClientId: stringValue(options.targetClientId) }
          : {}),
      }, socket, generation);
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error("Codex Desktop IPC write failed"));
      }
    });
  }

  private dispatch(envelope: DesktopIpcEnvelope): void {
    if (envelope.type === "client-discovery-response") {
      const key = requestIdKey(envelope.requestId);
      const pending = key ? this.pendingDiscoveries.get(key) : null;
      if (!pending) return;
      this.pendingDiscoveries.delete(key);
      clearTimeout(pending.timer);
      const response = record(envelope.response) ?? {};
      const handledByClientId = stringValue(
        response.handledByClientId
        ?? response.handled_by_client_id
        ?? envelope.handledByClientId,
      );
      pending.resolve({
        canHandle: response.canHandle === true,
        ...(handledByClientId ? { handledByClientId } : {}),
      });
      return;
    }
    if (envelope.type === "response") {
      const key = requestIdKey(envelope.requestId);
      const discovery = key ? this.pendingDiscoveries.get(key) : null;
      if (discovery) {
        this.pendingDiscoveries.delete(key);
        clearTimeout(discovery.timer);
        const result = record(envelope.result);
        const handledByClientId = stringValue(
          envelope.handledByClientId
          ?? result?.handledByClientId
          ?? result?.handled_by_client_id,
        );
        if (envelope.resultType === "error") {
          const error = stringValue(envelope.error);
          discovery.resolve({
            canHandle: false,
            ...(!desktopFollowerNoClientFound(error) ? { timedOut: true } : {}),
          });
        } else {
          discovery.resolve({
            canHandle: Boolean(handledByClientId),
            ...(handledByClientId ? { handledByClientId } : { timedOut: true }),
          });
        }
        return;
      }
      const waiter = key ? this.pending.get(key) : null;
      if (!waiter) return;
      this.pending.delete(key);
      clearTimeout(waiter.timer);
      const responseMethod = stringValue(envelope.method);
      const methodMismatch = Boolean(responseMethod && responseMethod !== waiter.method);
      try {
        this.options.onResponseSettled?.({
          requestId: envelope.requestId ?? key,
          method: waiter.method,
          threadId: waiter.threadId,
          commandId: waiter.commandId,
          localClientId: this.clientId,
          handledByClientId: stringValue(envelope.handledByClientId),
          ...(stringValue(waiter.targetClientId)
            ? { targetClientId: stringValue(waiter.targetClientId) }
            : {}),
          resultType: envelope.resultType === "error" || methodMismatch ? "error" : "success",
        });
      } catch {
        // Diagnostics must never affect IPC delivery.
      }
      if (methodMismatch) {
        waiter.reject(new Error(
          `Codex Desktop IPC response method mismatch: expected ${waiter.method}, received ${responseMethod}`,
        ));
        return;
      }
      if (envelope.resultType === "error") {
        waiter.reject(new Error(stringValue(envelope.error) || `Codex Desktop IPC request failed: ${waiter.method}`));
      } else {
        waiter.resolve(envelope.result ?? null);
      }
      return;
    }
    if (envelope.type === "broadcast") {
      this.handlers.onBroadcast(envelope);
      return;
    }
    if (envelope.type === "client-discovery-request") {
      const request = record(envelope.request) ?? envelope;
      const canHandle = this.handlers.canHandleRequest(request as DesktopIpcEnvelope);
      this.write({
        type: "client-discovery-response",
        requestId: envelope.requestId,
        response: {
          canHandle,
          ...(canHandle
            ? { handledByClientId: this.clientId }
            : {}),
        },
      });
      return;
    }
    if (envelope.type === "request") {
      void this.handlers.handleRequest(envelope)
        .then(result => this.write({
          type: "response",
          requestId: envelope.requestId,
          resultType: "success",
          method: envelope.method,
          handledByClientId: this.clientId,
          result: result ?? null,
        }))
        .catch(error => this.write({
          type: "response",
          requestId: envelope.requestId,
          resultType: "error",
          method: envelope.method,
          handledByClientId: this.clientId,
          error: error instanceof Error ? error.message : "Remodex Desktop IPC request failed",
        }));
    }
  }

  private handleClose(
    socket: Socket,
    generation: number,
    error = new Error("Codex Desktop IPC connection closed"),
  ): void {
    if (!this.isCurrentConnection(socket, generation)) return;
    this.socket = null;
    this.reader = null;
    this.connecting = false;
    this.initialized = false;
    this.clientId = "";
    for (const [requestId, waiter] of this.pending) {
      if (waiter.generation !== generation) continue;
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.pending.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingDiscoveries) {
      clearTimeout(pending.timer);
      pending.resolve({ canHandle: false, timedOut: true });
      this.pendingDiscoveries.delete(requestId);
    }
    this.handlers.onDisconnected?.();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, this.options.reconnectMs);
    this.reconnectTimer.unref?.();
  }

  private closeSocket(
    error = new Error("Codex Desktop IPC connection closed"),
    expectedSocket = this.socket,
    expectedGeneration = this.connectionGeneration,
  ): void {
    const socket = expectedSocket;
    if (!socket) {
      this.reader?.reset();
      return;
    }
    if (!this.isCurrentConnection(socket, expectedGeneration)) return;
    this.reader?.reset();
    this.handleClose(socket, expectedGeneration, error);
    if (!socket.destroyed) socket.destroy();
  }

  private write(
    envelope: DesktopIpcEnvelope,
    expectedSocket = this.socket,
    expectedGeneration = this.connectionGeneration,
  ): boolean {
    const socket = expectedSocket;
    if (
      !socket
      || socket.destroyed
      || !this.isCurrentConnection(socket, expectedGeneration)
    ) return false;
    try {
      socket.write(encodeDesktopIpcFrame(envelope));
      return true;
    } catch {
      this.closeSocket(
        new Error("Codex Desktop IPC write failed"),
        socket,
        expectedGeneration,
      );
      return false;
    }
  }

  private isCurrentConnection(socket: Socket, generation: number): boolean {
    return this.socket === socket && this.connectionGeneration === generation;
  }
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function buildDesktopStatePatches(previous: unknown, current: unknown): JsonPatch[] | null {
  if (!isPlainRecord(previous) || !isPlainRecord(current)) return null;
  const patches: JsonPatch[] = [];
  if (!collectPatches(previous, current, [], patches)) return null;
  if (patches.length === 0) return patches;
  return Buffer.byteLength(JSON.stringify(patches), "utf8") <= MAX_PATCH_BYTES ? patches : null;
}

function collectPatches(
  previous: unknown,
  current: unknown,
  path: Array<string | number>,
  patches: JsonPatch[],
): boolean {
  if (previous === current) return true;
  if (patches.length >= MAX_PATCH_COUNT) return false;
  if (Array.isArray(previous) || Array.isArray(current)) {
    if (!Array.isArray(previous) || !Array.isArray(current)) {
      return pushPatch(patches, { op: "replace", path, value: clone(current) });
    }
    const shared = Math.min(previous.length, current.length);
    for (let index = 0; index < shared; index += 1) {
      if (!collectPatches(previous[index], current[index], [...path, index], patches)) return false;
    }
    for (let index = previous.length - 1; index >= current.length; index -= 1) {
      if (!pushPatch(patches, { op: "remove", path: [...path, index] })) return false;
    }
    for (let index = shared; index < current.length; index += 1) {
      if (!pushPatch(patches, { op: "add", path: [...path, index], value: clone(current[index]) })) return false;
    }
    return true;
  }
  if (isPlainRecord(previous) || isPlainRecord(current)) {
    if (!isPlainRecord(previous) || !isPlainRecord(current)) {
      return pushPatch(patches, { op: "replace", path, value: clone(current) });
    }
    for (const key of Object.keys(previous)) {
      if (!(key in current) && !pushPatch(patches, { op: "remove", path: [...path, key] })) return false;
    }
    for (const [key, value] of Object.entries(current)) {
      if (!(key in previous)) {
        if (!pushPatch(patches, { op: "add", path: [...path, key], value: clone(value) })) return false;
      } else if (!collectPatches(previous[key], value, [...path, key], patches)) {
        return false;
      }
    }
    return true;
  }
  return pushPatch(patches, { op: "replace", path, value: clone(current) });
}

function pushPatch(patches: JsonPatch[], patch: JsonPatch): boolean {
  if (patch.path.length === 0) return false;
  patches.push(patch);
  return patches.length <= MAX_PATCH_COUNT;
}

function followerStateChange(value: unknown): FollowerStateChange | null {
  const change = record(value);
  const type = normalizeToken(change?.type);
  const revision = finiteRevision(change?.revision);
  if (type === "snapshot") {
    const conversationState = record(change?.conversationState) ?? record(change?.conversation_state);
    return conversationState ? { type: "snapshot", revision, conversationState } : null;
  }
  if (type !== "patches") return null;
  const patches: JsonPatch[] = [];
  let patchBytes = 2; // JSON array delimiters
  if (Array.isArray(change?.patches)) {
    for (const candidate of change.patches) {
      const patch = record(candidate);
      const op = stringValue(patch?.op) as JsonPatch["op"];
      if ((op !== "add" && op !== "remove" && op !== "replace") || !Array.isArray(patch?.path)) continue;
      const path = patch.path.length <= 64 && patch.path.every(segment =>
        (typeof segment === "string" && Buffer.byteLength(segment, "utf8") <= 512)
        || (typeof segment === "number" && Number.isSafeInteger(segment)))
        ? patch.path as Array<string | number>
        : null;
      if (!path) continue;
      if (op === "remove") {
        const patchSize = Buffer.byteLength(JSON.stringify(path), "utf8") + 16;
        if (patchBytes + patchSize > MAX_PATCH_BYTES) break;
        patches.push({ op, path });
        patchBytes += patchSize;
      } else {
        const bounded = boundInboundPatchValue(patch?.value);
        const encoded = JSON.stringify(bounded);
        const pathBytes = Buffer.byteLength(JSON.stringify(path), "utf8");
        const patchSize = pathBytes + Buffer.byteLength(encoded, "utf8") + 32;
        if (patchBytes + patchSize > MAX_PATCH_BYTES) break;
        patches.push({ op, path, value: bounded });
        patchBytes += patchSize;
      }
      if (patches.length > MAX_PATCH_COUNT) break;
    }
  }
  if (patches.length > MAX_PATCH_COUNT || patchBytes > MAX_PATCH_BYTES) return null;
  return {
    type: "patches",
    revision,
    baseRevision: finiteRevision(change?.baseRevision ?? change?.base_revision),
    patches,
  };
}

const INBOUND_PATCH_MAX_INLINE_BYTES = 256 * 1024;
const INBOUND_PATCH_MAX_ENTRIES = 64;
const INBOUND_PATCH_MAX_DEPTH = 64;
// Retain enough turn shells for bounded older-page navigation, while the
// global item trim below keeps payload memory bounded.
const INBOUND_HISTORY_MAX_TURNS = 64;
const INBOUND_HISTORY_MAX_ITEMS_PER_TURN = 500;
const INBOUND_ITEM_MAX_LARGE_TEXT_BYTES = 64 * 1024 * 1024;

function boundInboundPatchValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  allowLargeText = false,
): unknown {
  if (typeof value === "string") {
    const rawBytes = Buffer.byteLength(value, "utf8");
    return rawBytes <= (allowLargeText ? INBOUND_ITEM_MAX_LARGE_TEXT_BYTES : INBOUND_PATCH_MAX_INLINE_BYTES)
      && (allowLargeText || Buffer.byteLength(JSON.stringify(value), "utf8") <= INBOUND_PATCH_MAX_INLINE_BYTES)
      ? value
      : { kind: "missing", reason: "not-retained" };
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object") return String(value);
  if (depth >= INBOUND_PATCH_MAX_DEPTH) return { kind: "missing", reason: "not-retained" };
  if (seen.has(value)) return { kind: "missing", reason: "not-retained" };
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > INBOUND_PATCH_MAX_ENTRIES) return { kind: "missing", reason: "not-retained" };
      return value.map(entry => boundInboundPatchValue(entry, seen, depth + 1, allowLargeText));
    }
    const output: JsonRecord = {};
    let entries = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      entries += 1;
      if (entries > INBOUND_PATCH_MAX_ENTRIES || Buffer.byteLength(key, "utf8") > 512) {
        return { kind: "missing", reason: "not-retained" };
      }
      output[key] = boundInboundPatchValue((value as JsonRecord)[key], seen, depth + 1, allowLargeText);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function finiteRevision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function applyDesktopStatePatches(previous: JsonRecord, patches: JsonPatch[]): JsonRecord | null {
  const next = clone(previous);
  for (const patch of patches) {
    if (patch.path.length === 0) return null;
    let parent: unknown = next;
    for (let index = 0; index < patch.path.length - 1; index += 1) {
      const segment = patch.path[index]!;
      if (typeof segment === "string" && isUnsafePatchSegment(segment)) return null;
      if (!parent || typeof parent !== "object") return null;
      parent = (parent as Record<string | number, unknown>)[segment];
    }
    const final = patch.path.at(-1)!;
    if (typeof final === "string" && isUnsafePatchSegment(final)) return null;
    if (Array.isArray(parent)) {
      if (typeof final !== "number" || final < 0 || final > parent.length) return null;
      if (patch.op === "remove") {
        if (final >= parent.length) return null;
        parent.splice(final, 1);
      } else if (patch.op === "add") {
        parent.splice(final, 0, clone(patch.value));
      } else {
        if (final >= parent.length) return null;
        parent[final] = clone(patch.value);
      }
      continue;
    }
    if (!isPlainRecord(parent) || typeof final !== "string") return null;
    if (patch.op === "remove") {
      if (!(final in parent)) return null;
      delete parent[final];
    } else {
      parent[final] = clone(patch.value);
    }
  }
  return next;
}

function isUnsafePatchSegment(segment: string): boolean {
  return segment === "__proto__" || segment === "prototype" || segment === "constructor";
}

function snapshotShowsActiveTurn(change: FollowerStateChange): boolean {
  const state = record(change.conversationState);
  const turns = Array.isArray(state?.turns) ? state.turns : [];
  return turns.some(candidate => {
    const status = normalizeToken(record(candidate)?.status);
    return status === "inprogress" || status === "running" || status === "active";
  });
}

const DESKTOP_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

export function codexDesktopOpenCommands(
  url: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): CodexDesktopOpenCommand[] {
  if (platform === "win32") {
    return [{
      command: environment.SystemRoot
        ? win32.join(environment.SystemRoot, "System32", "rundll32.exe")
        : "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    }];
  }
  if (platform === "darwin") {
    return [
      { command: "/usr/bin/open", args: ["-b", "com.openai.codex", url] },
      { command: "/usr/bin/open", args: ["-a", "/Applications/Codex.app", url] },
    ];
  }
  if (platform === "linux") {
    return [
      { command: "xdg-open", args: [url] },
      { command: "gio", args: ["open", url] },
    ];
  }
  return [];
}

export async function openCodexDesktopThread(input: {
  threadId: string;
  platform?: NodeJS.Platform;
  activationToken?: string;
  run?: (command: string, args: string[]) => Promise<void>;
}): Promise<void> {
  const threadId = stringValue(input.threadId);
  if (!DESKTOP_THREAD_ID.test(threadId)) throw new Error("Codex task id is not valid");
  const token = encodeURIComponent(input.activationToken || randomUUID());
  const url = `codex://threads/${encodeURIComponent(threadId)}?opencodex-follow=${token}`;
  await openCodexDesktopUrl({ url, platform: input.platform, run: input.run });
}

/** Open a supported Codex Desktop deep link on the host operating system. */
export async function openCodexDesktopUrl(input: {
  url: string;
  platform?: NodeJS.Platform;
  run?: (command: string, args: string[]) => Promise<void>;
}): Promise<void> {
  const commands = codexDesktopOpenCommands(input.url, input.platform);
  if (commands.length === 0) throw new Error("Codex Desktop live follow is not supported on this operating system");
  const run = input.run ?? runDesktopOpenCommand;
  let lastError: unknown = null;
  for (const command of commands) {
    try {
      await run(command.command, command.args);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not open Codex Desktop");
}

function runDesktopOpenCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { timeout: 10_000, windowsHide: true }, error => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

type PendingTurnStart = {
  params: JsonRecord;
  fallbackTurnId: string;
};

type FollowerStateChange = {
  type: "snapshot" | "patches";
  revision?: number;
  baseRevision?: number;
  conversationState?: JsonRecord;
  patches?: JsonPatch[];
};

type FollowerRecoveryState = {
  attempts: number;
  timer: Timer | null;
  inFlight: boolean;
};

export class AndroidDesktopIpcLiveSync implements AndroidDesktopIpcSync {
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly readThread: DesktopIpcSyncOptions["readThread"];
  private readonly readThreadPage: DesktopIpcSyncOptions["readThreadPage"];
  private readonly sendCodexRequest: DesktopIpcSyncOptions["sendCodexRequest"];
  private readonly respondToCodexRequest: DesktopIpcSyncOptions["respondToCodexRequest"];
  private readonly openUrl: (url: string) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly warn: (message: string) => void;
  private readonly snapshotDebounceMs: number;
  private readonly followConfirmMs: number;
  private readonly followMaxAttempts: number;
  private readonly initialHistoryRetryMs: number;
  private readonly initialHistoryMaxAttempts: number;
  private readonly followerBaselineRetryMs: number;
  private readonly followerBaselineMaxRetryMs: number;
  private readonly followerBaselineMaxAttempts: number;
  private readonly followerStateTimeoutMs: number;
  private readonly ownerReacquireTimeoutMs: number;
  private readonly ownershipStore: AndroidDesktopOwnershipStore;
  private readonly transport: DesktopIpcTransportLike;
  /**
   * The current renderer that emitted authoritative state for each thread.
   * This map is intentionally separate from the local mirror ownership map.
   */
  private readonly desktopOwnerClientIds = new Map<string, string>();
  private readonly ownerReactivations = new Map<string, Promise<string | null>>();
  private ownerRecoveryGeneration = 0;
  /** Waiters used only while reacquiring a renderer id after reconnect. */
  private readonly desktopOwnerWaiters = new Map<string, Set<{
    resolve: (clientId: string | null) => void;
    timer: Timer;
  }>>();
  /**
   * Monotonic safety fact: once Desktop has been observed as the owner, a
   * missing handler or a disconnected socket can never authorize local resume.
   * It is cleared only by an explicit release/local-owner transition.
   */
  private readonly desktopOwnedThreadIds = new Set<string>();
  private readonly ownedThreadIds = new Set<string>();
  private readonly conversations = new Map<string, ConversationState>();
  private readonly revisions = new Map<string, number>();
  /** Last bounded wire state, never the unbounded in-memory conversation. */
  private readonly lastBroadcastStates = new Map<string, JsonRecord>();
  private readonly pendingTurnStarts = new Map<string, PendingTurnStart[]>();
  private readonly dirtyThreadIds = new Set<string>();
  private readonly followerClientIds = new Map<string, Set<string>>();
  /** Desktop-owned tasks that this Android bridge follows for live requests. */
  private readonly followedDesktopThreadIds = new Set<string>();
  private readonly followAttempts = new Map<string, number>();
  private readonly followTimers = new Map<string, Timer>();
  private readonly followerBaselineTimers = new Map<string, Timer>();
  private readonly sidebarTimers = new Map<string, Timer>();
  private readonly announcedSidebarThreadIds = new Set<string>();
  private readonly runtimeOverrides = new Map<string, JsonRecord>();
  private readonly hydrationPromises = new Map<string, Promise<boolean>>();
  private readonly threadsAwaitingInitialHistory = new Set<string>();
  private readonly initialHistoryAttempts = new Map<string, number>();
  private readonly initialHistoryTimers = new Map<string, Timer>();
  /** Connection-scoped baselines for tasks owned by another Desktop client. */
  private readonly followerStates = new Map<string, JsonRecord>();
  private readonly followerRevisions = new Map<string, number>();
  private readonly queuedFollowerChanges = new Map<string, FollowerStateChange[]>();
  private readonly followerRecovery = new Map<string, FollowerRecoveryState>();
  private readonly followerStateWaiters = new Map<string, Set<{
    resolve: (state: JsonRecord | null) => void;
    reject: (error: Error) => void;
    timer: Timer;
  }>>();
  /** Connection-local opaque page/content references for Desktop followers. */
  private readonly historyPages: DesktopHistoryPageStore;
  /** Capability is scoped to the current IPC connection generation. */
  private boundedHistoryUnsupportedGeneration: number | null = null;
  private snapshotTimer: Timer | null = null;

  constructor(options: DesktopIpcSyncOptions) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.readThread = options.readThread;
    this.readThreadPage = options.readThreadPage;
    this.sendCodexRequest = options.sendCodexRequest;
    this.respondToCodexRequest = options.respondToCodexRequest;
    this.log = options.log ?? (() => undefined);
    this.warn = options.warn ?? (() => undefined);
    this.snapshotDebounceMs = options.snapshotDebounceMs ?? SNAPSHOT_DEBOUNCE_MS;
    this.followConfirmMs = options.followConfirmMs ?? FOLLOW_CONFIRM_MS;
    this.followMaxAttempts = options.followMaxAttempts ?? FOLLOW_MAX_ATTEMPTS;
    this.initialHistoryRetryMs = options.initialHistoryRetryMs ?? INITIAL_HISTORY_RETRY_MS;
    this.initialHistoryMaxAttempts = options.initialHistoryMaxAttempts ?? INITIAL_HISTORY_MAX_ATTEMPTS;
    this.followerBaselineRetryMs = options.followerBaselineRetryMs ?? FOLLOWER_BASELINE_RETRY_MS;
    this.followerBaselineMaxRetryMs = options.followerBaselineMaxRetryMs ?? FOLLOWER_BASELINE_MAX_RETRY_MS;
    this.followerBaselineMaxAttempts = options.followerBaselineMaxAttempts ?? FOLLOWER_BASELINE_MAX_ATTEMPTS;
    this.followerStateTimeoutMs = options.followerStateTimeoutMs ?? FOLLOW_STATE_TIMEOUT_MS;
    this.ownerReacquireTimeoutMs = Math.max(1, options.ownerReacquireTimeoutMs ?? OWNER_REACQUIRE_TIMEOUT_MS);
    this.ownershipStore = options.ownershipStore ?? createAndroidDesktopOwnershipStore();
    this.historyPages = options.historyPageStore ?? new DesktopHistoryPageStore({ now: this.now });
    for (const threadId of this.ownershipStore.list()) this.desktopOwnedThreadIds.add(threadId);
    this.openUrl = options.openUrl ?? (url => openUrlWithPlatform(url, this.platform));
    this.transport = options.transport ?? new DesktopIpcTransport({
      paths: options.socketPaths ?? (() => desktopIpcSocketPaths(this.platform)),
      connect: options.connect ?? (path => createConnection(path)),
      now: this.now,
      reconnectMs: options.reconnectMs ?? RECONNECT_MS,
      warn: this.warn,
      onResponseSettled: response => {
        if (
          !response.method.startsWith("thread-follower-")
          && response.method !== THREAD_OWNER_DISCOVERY
        ) return;
        if (response.resultType === "success") {
          this.rememberDesktopOwner(
            response.threadId,
            response.handledByClientId,
          );
        }
        this.log(
          `Desktop IPC response method=${diagnosticToken(response.method)}`
          + ` thread=${diagnosticToken(response.threadId)}`
          + ` command=${diagnosticToken(response.commandId)}`
          + ` generation=${this.transport.generation ?? 0}`
          + ` localClient=${diagnosticToken(response.localClientId)}`
          + ` handledBy=${diagnosticToken(response.handledByClientId)}`
          + ` target=${diagnosticToken(response.targetClientId)}`
          + ` result=${response.resultType}`,
        );
      },
    });
    this.transport.setHandlers({
      onConnected: () => this.onConnected(),
      onDisconnected: () => this.onDisconnected(),
      onBroadcast: envelope => this.onBroadcast(envelope),
      canHandleRequest: envelope => this.canHandleRequest(envelope),
      handleRequest: envelope => this.handleRequest(envelope),
    });
  }

  start(): void {
    this.transport.start();
  }

  stop(): void {
    this.ownerRecoveryGeneration += 1;
    this.ownerReactivations.clear();
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    for (const timer of this.followTimers.values()) clearTimeout(timer);
    this.followTimers.clear();
    for (const timer of this.followerBaselineTimers.values()) clearTimeout(timer);
    this.followerBaselineTimers.clear();
    for (const timer of this.sidebarTimers.values()) clearTimeout(timer);
    this.sidebarTimers.clear();
    for (const timer of this.initialHistoryTimers.values()) clearTimeout(timer);
    this.initialHistoryTimers.clear();
    for (const recovery of this.followerRecovery.values()) {
      if (recovery.timer) clearTimeout(recovery.timer);
    }
    this.followerRecovery.clear();
    for (const threadId of [...this.followedDesktopThreadIds]) {
      // Desktop-owned tasks are observed through metadata discovery and their
      // bounded read path. They are not follower registrations; in particular
      // do not emit a later `following:false` when this bridge stops.
      if (this.desktopOwnedThreadIds.has(threadId) && !this.ownedThreadIds.has(threadId)) {
        this.followedDesktopThreadIds.delete(threadId);
        continue;
      }
      this.transport.sendBroadcast(THREAD_STREAM_FOLLOWING_CHANGED, {
        conversationId: threadId,
        hostId: HOST_ID,
        following: false,
      });
    }
    this.followedDesktopThreadIds.clear();
    this.transport.stop();
    this.boundedHistoryUnsupportedGeneration = null;
    const ownedBeforeStop = [...this.ownedThreadIds];
    this.ownedThreadIds.clear();
    this.desktopOwnerClientIds.clear();
    for (const waiters of this.desktopOwnerWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
    this.desktopOwnerWaiters.clear();
    this.conversations.clear();
    this.revisions.clear();
    this.lastBroadcastStates.clear();
    // Page tokens/handles are connection-local. Dropping them on stop keeps
    // an old Desktop renderer from replaying content after a new connection.
    for (const threadId of ownedBeforeStop) this.historyPages.clearThread(threadId);
    this.pendingTurnStarts.clear();
    this.dirtyThreadIds.clear();
    this.followerClientIds.clear();
    this.followAttempts.clear();
    this.announcedSidebarThreadIds.clear();
    this.runtimeOverrides.clear();
    this.hydrationPromises.clear();
    this.threadsAwaitingInitialHistory.clear();
    this.initialHistoryAttempts.clear();
    this.followerStates.clear();
    this.followerRevisions.clear();
    this.queuedFollowerChanges.clear();
    for (const waiters of this.followerStateWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Codex Desktop IPC stopped"));
      }
    }
    this.followerStateWaiters.clear();
  }

  isThreadOwned(threadId: string): boolean {
    return this.ownedThreadIds.has(stringValue(threadId));
  }

  threadOwnership(threadIdValue: string): DesktopThreadOwnership {
    const threadId = stringValue(threadIdValue);
    if (this.ownedThreadIds.has(threadId)) {
      return {
        state: "local-owned",
        ownerClientId: null,
        everDesktopOwned: this.desktopOwnedThreadIds.has(threadId),
      };
    }
    if (this.desktopOwnedThreadIds.has(threadId)) {
      return {
        state: "desktop-owned",
        ownerClientId: this.desktopOwnerClientIds.get(threadId) ?? null,
        everDesktopOwned: true,
      };
    }
    return { state: "unknown", ownerClientId: null, everDesktopOwned: false };
  }

  desktopOwnerClientId(threadIdValue: string): string | null {
    return this.desktopOwnerClientIds.get(stringValue(threadIdValue)) ?? null;
  }

  hasObservedDesktopOwner(threadIdValue: string): boolean {
    return this.desktopOwnedThreadIds.has(stringValue(threadIdValue));
  }

  async reacquireDesktopOwner(threadIdValue: string): Promise<string | null> {
    const threadId = stringValue(threadIdValue);
    if (!threadId || !this.desktopOwnedThreadIds.has(threadId)) return null;
    const current = this.desktopOwnerClientIds.get(threadId);
    if (current) return current;

    let waiter!: { resolve: (clientId: string | null) => void; timer: Timer };
    const owner = new Promise<string | null>(resolve => {
      const timer = setTimeout(() => {
        const waiters = this.desktopOwnerWaiters.get(threadId);
        if (waiters) {
          waiters.delete(waiter);
          if (waiters.size === 0) this.desktopOwnerWaiters.delete(threadId);
        }
        resolve(this.desktopOwnerClientIds.get(threadId) ?? null);
      }, this.ownerReacquireTimeoutMs);
      // This timeout settles an active caller. Keep it referenced even when
      // the Desktop socket has disappeared; stop() still clears pending waits.
      waiter = { resolve, timer };
      const waiters = this.desktopOwnerWaiters.get(threadId) ?? new Set();
      waiters.add(waiter);
      this.desktopOwnerWaiters.set(threadId, waiters);
    });

    // `start()` is intentionally non-blocking. If a reconnect is already in
    // progress, onConnected() below will issue the same metadata-only probe
    // and resolve this waiter without registering a transcript follower.
    this.transport.start();
    if (this.transport.connected) {
      const discovery = await this.discoverDesktopOwner(threadId);
      if (discovery.handledByClientId) {
        clearTimeout(waiter.timer);
        const waiters = this.desktopOwnerWaiters.get(threadId);
        if (waiters) {
          waiters.delete(waiter);
          if (waiters.size === 0) this.desktopOwnerWaiters.delete(threadId);
        }
        return this.desktopOwnerClientIds.get(threadId) ?? discovery.handledByClientId;
      }
    }
    return owner;
  }

  /**
   * Ask the IPC router which renderer owns a thread without invoking any
   * follower action.  `discover` is preferred because it stops at the
   * metadata-only canHandle path; the direct request fallback is retained for
   * older test/transport implementations and still returns an empty result,
   * never transcript state.
   */
  private async discoverDesktopOwner(threadId: string): Promise<DesktopIpcDiscoveryResult> {
    const params = { hostId: HOST_ID, conversationId: threadId };
    const discover = this.transport.discover;
    if (discover) {
      const result = await discover.call(
        this.transport,
        THREAD_OWNER_DISCOVERY,
        params,
        { timeoutMs: this.ownerReacquireTimeoutMs },
      );
      if (result.handledByClientId) {
        this.rememberDesktopOwner(threadId, result.handledByClientId);
      }
      return result;
    }
    try {
      const result = await this.transport.request(THREAD_OWNER_DISCOVERY, params);
      this.rememberDesktopOwnerFromResult(threadId, result);
      const handledByClientId = this.desktopOwnerClientIds.get(threadId) ?? undefined;
      return {
        canHandle: Boolean(handledByClientId),
        ...(handledByClientId ? { handledByClientId } : {}),
      };
    } catch (error) {
      return {
        canHandle: false,
        ...(desktopFollowerNoClientFound(error) ? {} : { timedOut: true }),
      };
    }
  }

  releaseDesktopOwnership(threadIdValue: string): void {
    const threadId = stringValue(threadIdValue);
    if (!threadId) return;
    this.desktopOwnerClientIds.delete(threadId);
    this.desktopOwnedThreadIds.delete(threadId);
    this.ownershipStore.release(threadId);
  }

  adoptLocalThread(threadIdValue: string): void {
    const threadId = stringValue(threadIdValue);
    if (!threadId) return;
    if (this.desktopOwnedThreadIds.has(threadId) && !this.ownedThreadIds.has(threadId)) {
      throw new DesktopIpcOwnershipError(
        `Codex Desktop still owns task ${threadId}; local adoption requires an explicit owner release`,
        threadId,
        "local-adopt",
        0,
      );
    }
    this.ownedThreadIds.add(threadId);
  }

  connectionSnapshot(): DesktopIpcConnectionSnapshot {
    return {
      connected: this.transport.connected,
      generation: this.transport.generation ?? 0,
      localClientId: stringValue(this.transport.localClientId),
    };
  }

  async requestFollowerAction(method: string, params: JsonRecord): Promise<unknown> {
    try {
      return await this.dispatchFollowerAction(method, params);
    } catch (error) {
      if (!(error instanceof DesktopIpcOwnershipError)
        || error.reason !== "owner-unavailable"
        || !OWNER_REACTIVATION_METHODS.has(method)
        || !await this.reactivateDesktopOwner(error.threadId)) throw error;
      return await this.dispatchFollowerAction(method, params);
    }
  }

  private async dispatchFollowerAction(method: string, params: JsonRecord): Promise<unknown> {
    const threadId = threadIdFromParams(params);
    let knownDesktopOwner = Boolean(
      threadId && this.desktopOwnedThreadIds.has(threadId),
    );
    let requestAttempts = 0;
    let ownerUnavailable = false;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < FOLLOWER_OWNER_RETRY_DELAYS_MS.length; attempt += 1) {
      const delayMs = FOLLOWER_OWNER_RETRY_DELAYS_MS[attempt] ?? 0;
      if (delayMs > 0) await waitMs(delayMs);
      knownDesktopOwner ||= Boolean(threadId && this.desktopOwnedThreadIds.has(threadId));
      let targetClientId = threadId ? this.desktopOwnerClientIds.get(threadId) ?? "" : "";
      if (knownDesktopOwner && threadId && !targetClientId) {
        targetClientId = await this.reacquireDesktopOwner(threadId) ?? "";
        ownerUnavailable = !targetClientId;
        if (ownerUnavailable) continue;
      }
      ownerUnavailable = false;
      try {
        requestAttempts += 1;
        const result = await this.transport.request(method, params, {
          ...(targetClientId ? { targetClientId } : {}),
        });
        this.rememberDesktopOwnerFromResult(threadId, result);
        return result;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!/^(?:no-client-found|no codex ipc client can handle this request)$/iu.test(message.trim())) {
          throw error;
        }
        // A targeted no-client-found is safe to retry, but never broaden it
        // into an untargeted request.  If the renderer was replaced, the next
        // attempt must first obtain the replacement sourceClientId.
        if (targetClientId) {
          // The router has conclusively rejected this connection-scoped
          // renderer id. Drop only that stale mapping while preserving the
          // monotonic Desktop-owned fact, then let the read-only discovery
          // path identify the replacement renderer before another mutation.
          this.removeDesktopOwnerClient(targetClientId);
        }
      }
    }
    if (knownDesktopOwner && threadId) {
      throw new DesktopIpcOwnershipError(
        ownerUnavailable
          ? `Codex Desktop still owns task ${threadId}; its current renderer owner could not be reacquired`
          : `Codex Desktop still owns task ${threadId}; its follower IPC handler could not be reached`,
        threadId,
        method,
        requestAttempts,
        ownerUnavailable ? "owner-unavailable" : "no-client-found",
      );
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Codex Desktop IPC request failed: ${method}`);
  }

  async activateFollowerThread(threadIdValue: string): Promise<void> {
    const threadId = stringValue(threadIdValue);
    if (!DESKTOP_THREAD_ID.test(threadId)) throw new Error("Codex task id is not valid");
    this.transport.start();
    // This task is owned by Desktop and Android is the follower. Reopening an
    // already-active route without changing its URL is a navigation no-op, so
    // the owner never re-registers after an IPC reconnect. A unique neutral
    // query value forces route activation without assigning the opposite
    // Remodex-owned "follow" role.
    const token = encodeURIComponent(randomUUID());
    await this.openUrl(
      `codex://threads/${encodeURIComponent(threadId)}?opencodex-reactivate=${token}`,
    );
  }

  private reactivateDesktopOwner(threadId: string): Promise<string | null> {
    const existing = this.ownerReactivations.get(threadId);
    if (existing) return existing;
    const generation = this.ownerRecoveryGeneration;
    const eligible = (): boolean => generation === this.ownerRecoveryGeneration
      && this.transport.connected
      && this.threadOwnership(threadId).state === "desktop-owned";
    const recover = async (): Promise<string | null> => {
      if (!eligible()) return null;
      const discovery = await this.discoverDesktopOwner(threadId);
      if (!eligible()) return null;
      if (discovery.handledByClientId) return discovery.handledByClientId;
      if (discovery.timedOut) return null;
      await this.activateFollowerThread(threadId);
      for (const delayMs of OWNER_REACTIVATION_DELAYS_MS) {
        if (delayMs > 0) await waitMs(delayMs);
        if (!eligible()) return null;
        const owner = this.desktopOwnerClientIds.get(threadId);
        if (owner) return owner;
        const refreshed = await this.discoverDesktopOwner(threadId);
        if (!eligible()) return null;
        if (refreshed.handledByClientId) return refreshed.handledByClientId;
        if (refreshed.timedOut) return null;
      }
      return null;
    };
    const flight = recover().catch(() => null).finally(() => {
      if (this.ownerReactivations.get(threadId) === flight) this.ownerReactivations.delete(threadId);
    });
    this.ownerReactivations.set(threadId, flight);
    return flight;
  }

  async readFollowerHistoryPage(
    threadIdValue: string,
    options: {
      direction?: DesktopHistoryPageDirection;
      pageToken?: string | null;
    } = {},
  ): Promise<JsonRecord | null> {
    const threadId = stringValue(threadIdValue);
    if (!threadId) return null;
    const direction = options.direction ?? "recent";
    if (this.boundedHistoryUnsupportedForCurrentConnection()) {
      return this.readFollowerHistoryPageFallback(threadId, direction, options.pageToken ?? null);
    }
    try {
      const result = await this.requestFollowerAction(THREAD_FOLLOWER_LOAD_HISTORY_PAGE, {
        hostId: HOST_ID,
        conversationId: threadId,
        direction,
        pageToken: options.pageToken ?? null,
      });
      const response = record(result);
      const state = record(response?.conversationState ?? response?.conversation_state ?? response?.state);
      if (state) {
        const publicState = sanitizeDesktopConversationState(state);
        return direction === "recent"
          ? clone(this.historyPages.recentPage(threadId, publicState).state)
          : clone(publicState);
      }
      return response ? clone(response) : null;
    } catch (error) {
      if (!desktopHistoryPageUnavailable(error)) throw error;
      this.markBoundedHistoryUnsupported();
      return this.readFollowerHistoryPageFallback(threadId, direction, options.pageToken ?? null);
    }
  }

  async readFollowerContentChunk(
    threadIdValue: string,
    input: { handle: string; sourceRevision: string; offset: number },
  ): Promise<DesktopContentChunk> {
    const threadId = stringValue(threadIdValue);
    if (!threadId) return { kind: "missing", reason: "source-missing" };
    // Handles created by the local compatibility page store never need to
    // cross the IPC boundary. This also makes a fallback page immediately
    // usable by clients that request its content chunks.
    const localChunk = this.historyPages.readContentChunk({
      threadId,
      sourceRevision: input.sourceRevision,
      handle: input.handle,
      offset: input.offset,
    });
    if (localChunk.kind === "chunk") return localChunk;
    if (this.boundedHistoryUnsupportedForCurrentConnection()) return localChunk;
    try {
      const result = await this.requestFollowerAction(THREAD_FOLLOWER_READ_CONTENT_CHUNK, {
        hostId: HOST_ID,
        conversationId: threadId,
        handle: input.handle,
        sourceRevision: input.sourceRevision,
        offset: input.offset,
      });
      const chunk = record(result);
      if (chunk?.kind === "chunk" || chunk?.kind === "missing") return chunk as unknown as DesktopContentChunk;
      return { kind: "missing", reason: "source-missing" };
    } catch (error) {
      if (!desktopFollowerMethodUnsupported(error)) throw error;
      this.markBoundedHistoryUnsupported();
      return { kind: "missing", reason: "not-retained" };
    }
  }

  async readFollowerThreadState(
    threadIdValue: string,
    options: { fresh?: boolean } = {},
  ): Promise<JsonRecord | null> {
    const threadId = stringValue(threadIdValue);
    if (!threadId) return null;
    const current = this.followerStates.get(threadId);
    if (current && !options.fresh) return sanitizeDesktopConversationState(current);
    if (this.boundedHistoryUnsupportedForCurrentConnection()) {
      return this.readFollowerThreadStateFallback(threadId);
    }
    let stateWaiter!: {
      resolve: (state: JsonRecord | null) => void;
      reject: (error: Error) => void;
      timer: Timer;
    };
    const state = new Promise<JsonRecord | null>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.followerStateWaiters.get(threadId);
        if (waiters) {
          for (const waiter of waiters) {
            if (waiter.resolve !== resolvePromise) continue;
            waiters.delete(waiter);
            break;
          }
          if (waiters.size === 0) this.followerStateWaiters.delete(threadId);
        }
        reject(new Error("Codex Desktop did not publish the requested task state"));
      }, this.followerStateTimeoutMs);
      timer.unref?.();
      const waiter = { resolve: resolvePromise, reject, timer };
      stateWaiter = waiter;
      const waiters = this.followerStateWaiters.get(threadId) ?? new Set();
      waiters.add(waiter);
      this.followerStateWaiters.set(threadId, waiters);
    });
    try {
      // A state read is a bounded recent-page request. It intentionally does
      // not register a stream follower: older Desktop builds respond to that
      // registration by broadcasting their complete materialized transcript.
      const action = this.requestFollowerAction(THREAD_FOLLOWER_LOAD_HISTORY_PAGE, {
        hostId: HOST_ID,
        conversationId: threadId,
        direction: "recent",
        pageToken: null,
      });
      const directState = action.then(result => {
        const response = record(result);
        const value = record(
          response?.conversationState
          ?? response?.conversation_state
          ?? response?.state,
        );
        if (!value) return null;
        const revision = finiteRevision(response?.revision) ?? 0;
        const redacted = sanitizeDesktopConversationState(value, true);
        const bounded = this.historyPages.recentPage(threadId, redacted).state;
        this.followerStates.set(threadId, clone(bounded));
        this.followerRevisions.set(threadId, revision);
        this.clearFollowerRecovery(threadId);
        this.resolveFollowerStateWaiters(threadId);
        return sanitizeDesktopConversationState(bounded);
      });
      // The publication waiter can win the race while the direct request is
      // still in flight. Attach a sink so a later unsupported-method rejection
      // cannot become an unhandled promise, while still allowing the race to
      // observe it when it is the first result.
      void directState.catch(error => {
        if (desktopHistoryPageUnavailable(error)) this.markBoundedHistoryUnsupported();
      });
      // Race the bounded page request against the state publication timeout.
      // A slow or lost Desktop response must not keep the gateway request
      // open for the full IPC timeout.
      const resolved = await Promise.race([
        directState,
        state,
      ]);
      return resolved ?? await state;
    } catch (error) {
      const waiters = this.followerStateWaiters.get(threadId);
      if (waiters && waiters.delete(stateWaiter)) {
        clearTimeout(stateWaiter.timer);
        if (waiters.size === 0) this.followerStateWaiters.delete(threadId);
      }
      if (desktopHistoryPageUnavailable(error)) {
        this.markBoundedHistoryUnsupported();
        return this.readFollowerThreadStateFallback(threadId);
      }
      throw error;
    }
  }

  private boundedHistoryGeneration(): number {
    return this.transport.generation ?? 0;
  }

  private boundedHistoryUnsupportedForCurrentConnection(): boolean {
    return this.boundedHistoryUnsupportedGeneration === this.boundedHistoryGeneration();
  }

  private markBoundedHistoryUnsupported(): void {
    this.boundedHistoryUnsupportedGeneration = this.boundedHistoryGeneration();
  }

  /**
   * Compatibility reader for Desktop builds that predate the bounded-page
   * follower methods. `readThreadPage` is backed by the bounded
   * thread/turns/list request in the default gateway integration; it never
   * asks the Desktop renderer to publish its complete transcript.
   */
  private async readFollowerThreadStateFallback(threadId: string): Promise<JsonRecord | null> {
    if (!this.readThreadPage) return null;
    const result = await this.readThreadPage(threadId);
    const state = record(result?.thread) ?? record(result);
    if (!state) return null;
    const redacted = sanitizeDesktopConversationState({ ...state, androidRemoteHistoryOnly: true }, true);
    const bounded = this.historyPages.recentPage(threadId, redacted).state;
    this.followerStates.set(threadId, clone(bounded));
    this.followerRevisions.set(threadId, this.followerRevisions.get(threadId) ?? 0);
    this.clearFollowerRecovery(threadId);
    this.resolveFollowerStateWaiters(threadId);
    return sanitizeDesktopConversationState(bounded);
  }

  private async readFollowerHistoryPageFallback(
    threadId: string,
    direction: Exclude<DesktopHistoryPageDirection, "recent"> | "recent",
    pageToken: string | null,
  ): Promise<JsonRecord | null> {
    let state = this.followerStates.get(threadId);
    if (!state || direction === "recent") {
      await this.readFollowerThreadStateFallback(threadId);
      state = this.followerStates.get(threadId);
    }
    if (!state) return null;
    if (direction === "recent") return sanitizeDesktopConversationState(state);
    if (!pageToken) throw new Error("A page token is required for older or newer history");
    const page = this.historyPages.page(threadId, state, direction, pageToken);
    return sanitizeDesktopConversationState(page.state);
  }

  private rememberDesktopOwner(threadIdValue: string, clientIdValue: string): void {
    const threadId = stringValue(threadIdValue);
    const clientId = stringValue(clientIdValue);
    const localClientId = stringValue(this.transport.localClientId);
    if (!threadId || !clientId || (localClientId && clientId === localClientId)) return;
    // A locally mounted writer is authoritative for this bridge.  Ignore its
    // own echoed snapshots/responses rather than converting the mirror into a
    // false Desktop owner.
    if (this.ownedThreadIds.has(threadId)) return;
    this.desktopOwnerClientIds.set(threadId, clientId);
    this.desktopOwnedThreadIds.add(threadId);
    this.ownershipStore.remember(threadId);
    const waiters = this.desktopOwnerWaiters.get(threadId);
    if (waiters) {
      this.desktopOwnerWaiters.delete(threadId);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(clientId);
      }
    }
  }

  private rememberDesktopOwnerFromResult(threadIdValue: string, result: unknown): void {
    const response = record(result);
    const handledByClientId = stringValue(
      response?.handledByClientId
      ?? response?.handled_by_client_id
      ?? record(response?.result)?.handledByClientId,
    );
    if (handledByClientId) this.rememberDesktopOwner(threadIdValue, handledByClientId);
  }

  private removeDesktopOwnerClient(clientIdValue: string): void {
    const clientId = stringValue(clientIdValue);
    if (!clientId) return;
    for (const [threadId, ownerClientId] of this.desktopOwnerClientIds) {
      if (ownerClientId === clientId) this.desktopOwnerClientIds.delete(threadId);
    }
  }

  async hasLiveThreadOwner(threadId: string): Promise<boolean | null> {
    if (!this.transport.connected) return null;
    const discovery = await this.discoverDesktopOwner(threadId);
    if (discovery.timedOut) return null;
    return Boolean(discovery.canHandle && discovery.handledByClientId
      && discovery.handledByClientId !== this.transport.localClientId);
  }

  async probeFollowerRoute(
    threadIdValue: string,
    options: { refreshOwner?: boolean } = {},
  ): Promise<"ready" | "absent" | "unhealthy"> {
    const threadId = stringValue(threadIdValue);
    if (!threadId) return "absent";
    // A writer rejection invalidates the remembered connection, not the fact
    // that Desktop owns the task. Discover its current renderer before retrying.
    if (options.refreshOwner) this.desktopOwnerClientIds.delete(threadId);
    const ownership = this.threadOwnership(threadId);
    if (ownership.state === "local-owned") return "absent";
    // A disconnected bus says nothing about the Desktop app-server writer.
    // Treat it as unhealthy so callers cannot adopt a competing local writer.
    if (!this.transport.connected) return "unhealthy";
    const discovery = await this.discoverDesktopOwner(threadId);
    if (discovery.canHandle && discovery.handledByClientId) return "ready";
    if (discovery.timedOut) return "unhealthy";
    return this.desktopOwnedThreadIds.has(threadId) ? "unhealthy" : "absent";
  }

  releaseThread(threadId: string): void {
    const id = stringValue(threadId);
    if (!id) return;
    this.ownedThreadIds.delete(id);
    this.conversations.delete(id);
    this.revisions.delete(id);
    this.lastBroadcastStates.delete(id);
    this.historyPages.clearThread(id);
    this.pendingTurnStarts.delete(id);
    this.dirtyThreadIds.delete(id);
    this.followerClientIds.delete(id);
    this.followedDesktopThreadIds.delete(id);
    this.followerStates.delete(id);
    this.followerRevisions.delete(id);
    this.queuedFollowerChanges.delete(id);
    this.clearFollowerRecovery(id);
    this.followAttempts.delete(id);
    this.runtimeOverrides.delete(id);
    this.stopAwaitingInitialHistory(id);
    const timer = this.followTimers.get(id);
    if (timer) clearTimeout(timer);
    this.followTimers.delete(id);
    const baselineTimer = this.followerBaselineTimers.get(id);
    if (baselineTimer) clearTimeout(baselineTimer);
    this.followerBaselineTimers.delete(id);
    const sidebarTimer = this.sidebarTimers.get(id);
    if (sidebarTimer) clearTimeout(sidebarTimer);
    this.sidebarTimers.delete(id);
    this.announcedSidebarThreadIds.delete(id);
    // `releaseThread` releases only this bridge's local mirror.  Do not erase
    // the monotonic Desktop-ownership fact: a transient handoff/reconnect must
    // not make a later Android prompt call private thread/resume.
  }

  claimThread(input: {
    threadId: string;
    turnStartParams: JsonRecord;
    cwd?: string;
    title?: string;
  }): void {
    const threadId = stringValue(input.threadId);
    if (!threadId || !DESKTOP_THREAD_ID.test(threadId)) return;
    if (this.desktopOwnedThreadIds.has(threadId) && !this.ownedThreadIds.has(threadId)) {
      throw new DesktopIpcOwnershipError(
        `Codex Desktop still owns task ${threadId}; local adoption requires an explicit owner release`,
        threadId,
        "local-claim",
        0,
      );
    }
    const needsInitialHistory = !this.ownedThreadIds.has(threadId)
      && !this.conversations.has(threadId)
      && !this.lastBroadcastStates.has(threadId);
    // Claiming is the local-owner transition.  The gateway performs the
    // explicit `releaseDesktopOwnership` step only after a definitive owner
    // release/no-owner result; this method itself never silently overrides a
    // remembered Desktop writer.
    this.ownedThreadIds.add(threadId);
    if (needsInitialHistory) this.threadsAwaitingInitialHistory.add(threadId);
    const conversation = this.ensureConversation(threadId, input.cwd);
    if (input.cwd) conversation.cwd = input.cwd;
    if (input.title) conversation.title = input.title;
    const params = sanitizeTurnStartParams({ ...input.turnStartParams, threadId });
    this.applyRuntimeMetadata(conversation, params);
    const fallbackTurnId = `opencodex-pending-${this.now()}-${randomUUID()}`;
    const queue = this.pendingTurnStarts.get(threadId) ?? [];
    queue.push({ params: clone(params), fallbackTurnId });
    this.pendingTurnStarts.set(threadId, queue);
    conversation.turns.push(createConversationTurn({
      id: fallbackTurnId,
      status: "inProgress",
      items: [],
    }, conversation, this.now, params));
    this.trimConversationHistory(conversation);
    conversation.updatedAt = this.now();
    this.markDirty(threadId);
    this.scheduleSidebarAnnouncement(threadId);
    this.transport.start();
    this.requestInitialHistoryBaseline(threadId);
    if (this.transport.connected) this.beginFollow(threadId);
  }

  observeCodexMessage(message: CodexJsonRpcMessage): void {
    const method = stringValue(message.method);
    if (!method) return;
    const params = record(message.params) ?? {};
    const threadId = threadIdFromMessage(method, params);
    if (!threadId || !this.ownedThreadIds.has(threadId)) return;
    const conversation = this.ensureConversation(threadId);
    let changed = false;
    let requiresAuthoritativeSnapshot = false;

    if (SERVER_REQUEST_METHODS.has(method) && message.id !== undefined) {
      upsertById(conversation.requests, {
        id: message.id,
        method,
        params: clone(params),
      });
      changed = true;
      requiresAuthoritativeSnapshot = true;
    } else if (method === "thread/started") {
      const thread = record(params.thread);
      if (thread) this.mergeThread(conversation, thread);
      changed = true;
    } else if (method === "thread/name/updated") {
      conversation.title = stringValue(params.threadName)
        || stringValue(params.name)
        || stringValue(params.title)
        || conversation.title;
      changed = true;
    } else if (method === "thread/status/changed") {
      conversation.threadRuntimeStatus = clone(params.status ?? null);
      changed = true;
    } else if (method === "thread/tokenUsage/updated") {
      conversation.latestTokenUsageInfo = clone(params.tokenUsage ?? params.usage ?? null);
      changed = true;
    } else if (method === "turn/started" || method === "turn/completed") {
      const rawTurn = record(params.turn);
      const explicitTurnId = turnIdFromParams(params) || stringValue(rawTurn?.id);
      const pending = method === "turn/started"
        ? this.shiftPendingTurn(threadId)
        : explicitTurnId && !findTurn(conversation, explicitTurnId)
          ? this.shiftPendingTurn(threadId)
          : null;
      const turnId = explicitTurnId || pending?.fallbackTurnId || this.activeTurnId(conversation);
      if (turnId) {
        const previousId = pending?.fallbackTurnId;
        const previous = previousId ? findTurn(conversation, previousId) : findTurn(conversation, turnId);
        const next = createConversationTurn({
          ...(rawTurn ?? {}),
          id: turnId,
          ...(method === "turn/completed" && rawTurn?.status == null ? { status: "completed" } : {}),
        }, conversation, this.now, pending?.params ?? previous?.params);
        if (previous) Object.assign(next, mergeTurnContinuity(previous, next));
        replaceTurn(conversation, previousId || turnId, next);
        if (pending) this.applyRuntimeMetadata(conversation, pending.params);
      }
      changed = true;
      if (method === "turn/completed") {
        requiresAuthoritativeSnapshot = true;
        this.announceSidebarThread(threadId, true);
      }
    } else if (method === "turn/diff/updated") {
      const turn = this.ensureTurn(conversation, turnIdFromParams(params));
      if (turn) turn.diff = typeof params.diff === "string" ? params.diff : "";
      changed = Boolean(turn);
      requiresAuthoritativeSnapshot = changed;
    } else if (method === "turn/plan/updated") {
      const turn = this.ensureTurn(conversation, turnIdFromParams(params));
      if (turn) upsertTurnItem(turn, {
        id: `todo-list-${turn.turnId}`,
        type: "todo-list",
        explanation: stringValue(params.explanation) || null,
        plan: Array.isArray(params.plan) ? clone(params.plan) : [],
      });
      changed = Boolean(turn);
    } else if (method === "item/started" || method === "item/completed") {
      const turn = this.ensureTurn(conversation, turnIdFromParams(params));
      const item = sanitizeDesktopItem(record(params.item));
      if (turn && item) {
        const duplicatesInitialInput = turn.items.every(isInitialTurnPrefixItem)
          && userMessageDuplicatesTurnInput(turn, item);
        if (!duplicatesInitialInput) upsertTurnItem(turn, item);
        if (item.type !== "userMessage") turn.firstTurnWorkItemStartedAtMs ||= this.now();
        if (item.type === "agentMessage") turn.finalAssistantStartedAtMs ||= this.now();
        if (item.type === "commandExecution") {
          (turn.commandExecutionStartedAtMsById as JsonRecord)[stringValue(item.id)] ||= this.now();
        }
        changed = true;
        if (method === "item/completed") requiresAuthoritativeSnapshot = true;
        if (item.type === "userMessage" && method === "item/completed") {
          this.announceSidebarThread(threadId, true);
        }
      }
    } else if (method === "item/agentMessage/delta") {
      changed = this.appendItemDelta(conversation, params, "agentMessage", "text");
    } else if (method === "item/plan/delta") {
      changed = this.appendItemDelta(conversation, params, "plan", "text");
    } else if (method === "item/reasoning/summaryTextDelta") {
      changed = this.appendReasoningSummary(conversation, params);
    } else if (method === "item/fileChange/patchUpdated") {
      const turn = this.ensureTurn(conversation, turnIdFromParams(params), false);
      const itemId = stringValue(params.itemId);
      if (turn && itemId) {
        const item = ensureItem(turn, itemId, () => ({ type: "fileChange", id: itemId, changes: [], status: "inProgress" }));
        item.changes = Array.isArray(params.changes) ? clone(params.changes) : [];
        changed = true;
      }
    } else if (method === "item/commandExecution/outputDelta") {
      changed = this.appendItemDelta(conversation, params, "commandExecution", "aggregatedOutput");
    } else if (method === "item/mcpToolCall/progress") {
      const turn = this.ensureTurn(conversation, turnIdFromParams(params));
      const itemId = stringValue(params.itemId);
      if (turn && itemId) {
        const item = ensureItem(turn, itemId, () => ({ type: "mcpToolCall", id: itemId, status: "inProgress" }));
        item.progress = stringValue(params.message).slice(0, 8192);
        changed = true;
      }
    } else if (method === "serverRequest/resolved") {
      const key = requestIdKey(params.requestId ?? params.request_id);
      conversation.requests = conversation.requests.filter(request => requestIdKey(request.id) !== key);
      changed = true;
      requiresAuthoritativeSnapshot = true;
    } else if (method === "error") {
      const turn = this.ensureTurn(conversation, turnIdFromParams(params));
      if (turn) {
        turn.error = clone(params.error ?? null);
        upsertTurnItem(turn, {
          id: `error-${this.now()}`,
          type: "error",
          message: stringValue(record(params.error)?.message) || "Codex error",
          willRetry: Boolean(params.willRetry),
        });
        changed = true;
        requiresAuthoritativeSnapshot = true;
      }
    }

    if (changed) {
      this.trimConversationHistory(conversation);
      conversation.updatedAt = this.now();
      this.markDirty(threadId);
      if (requiresAuthoritativeSnapshot) this.forceSnapshot(threadId);
    }
  }

  private onConnected(): void {
    // A remembered Desktop-owned task remains protected across a socket or
    // renderer restart. Reconnect is deliberately metadata-only: registering
    // a follower here can make older Desktop builds materialize and broadcast
    // their complete transcript.
    for (const threadId of [...this.followedDesktopThreadIds]) {
      // Re-registering a follower can make Desktop eagerly broadcast its
      // complete materialized snapshot.  That is precisely the unsafe path
      // this recovery code is designed to avoid for a remembered
      // Desktop-owned task.  State consumers explicitly request bounded
      // pages instead (see readFollowerThreadState), so reconnect itself is
      // metadata-only.
      if (this.desktopOwnedThreadIds.has(threadId) && !this.ownedThreadIds.has(threadId)) {
        this.followedDesktopThreadIds.delete(threadId);
        continue;
      }
      this.transport.sendBroadcast(THREAD_STREAM_FOLLOWING_CHANGED, {
        conversationId: threadId,
        hostId: HOST_ID,
        following: true,
      });
    }
    // A waiter may have started while the bus was disconnected. Resolve it
    // with the metadata-only owner probe; never ask Desktop to load history.
    for (const threadId of this.desktopOwnerWaiters.keys()) {
      void this.discoverDesktopOwner(threadId).catch(() => undefined);
    }
    for (const threadId of this.ownedThreadIds) {
      this.transport.sendBroadcast("thread-stream-following-status-requested", {
        hostId: HOST_ID,
        conversationId: threadId,
      });
      if (!this.shouldDelayInitialSnapshot(threadId)) this.forceSnapshot(threadId);
      this.beginFollow(threadId);
    }
  }

  private onDisconnected(): void {
    // Current renderer ids are connection-scoped.  Keep the monotonic
    // `desktopOwnedThreadIds` fact, but force the next mutation through the
    // router/discovery path (or a newly observed snapshot).
    this.desktopOwnerClientIds.clear();
    this.boundedHistoryUnsupportedGeneration = null;
    for (const waiters of this.desktopOwnerWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
    this.desktopOwnerWaiters.clear();
    this.followerClientIds.clear();
    this.followAttempts.clear();
    for (const timer of this.followTimers.values()) clearTimeout(timer);
    this.followTimers.clear();
    for (const timer of this.followerBaselineTimers.values()) clearTimeout(timer);
    this.followerBaselineTimers.clear();
    const followerThreadsBeforeDisconnect = [...this.followerStates.keys()];
    this.followerStates.clear();
    this.followerRevisions.clear();
    for (const threadId of followerThreadsBeforeDisconnect) this.historyPages.clearThread(threadId);
    this.queuedFollowerChanges.clear();
    for (const recovery of this.followerRecovery.values()) {
      if (recovery.timer) clearTimeout(recovery.timer);
    }
    this.followerRecovery.clear();
    for (const waiters of this.followerStateWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Codex Desktop IPC connection closed"));
      }
    }
    this.followerStateWaiters.clear();
  }

  private onBroadcast(envelope: DesktopIpcEnvelope): void {
    if (envelope.method === THREAD_ARCHIVED) {
      const params = record(envelope.params) ?? {};
      const threadId = threadIdFromParams(params);
      const ownerClientId = this.desktopOwnerClientIds.get(threadId);
      const sourceClientId = stringValue(envelope.sourceClientId);
      if (
        threadId
        && (params.ownerReleased === true || (ownerClientId && ownerClientId === sourceClientId))
      ) {
        this.releaseDesktopOwnership(threadId);
      }
      return;
    }
    if (envelope.method === THREAD_STREAM_STATE_CHANGED) {
      const params = record(envelope.params) ?? {};
      if (stringValue(params.opencodexOwnerSource) === OWNER_SOURCE) return;
      const threadId = threadIdFromParams(params);
      if (
        threadId
        && (params.desktopOwnerReleased === true || params.ownerReleased === true)
      ) {
        this.releaseDesktopOwnership(threadId);
        return;
      }
      const change = followerStateChange(params.change);
      if (!threadId || !change) return;
      const wasOwned = this.ownedThreadIds.has(threadId);
      if (wasOwned && change.type === "snapshot") {
        if (this.hasActiveLocalTurn(threadId) && !snapshotShowsActiveTurn(change)) {
          this.log(`Ignoring idle peer snapshot while local turn is active for ${threadId}`);
          return;
        }
        this.log(`Yielding IPC ownership of ${threadId} to peer snapshot revision ${change.revision ?? "unknown"}`);
        this.releaseThread(threadId);
      }
      // This broadcast is authoritative even when the snapshot is idle and
      // Android is not currently following the task.  Record the source before
      // any reconnect/handler race can make a later mutation look ownerless.
      this.rememberDesktopOwner(threadId, stringValue(envelope.sourceClientId));
      const interested = wasOwned
        || this.desktopOwnedThreadIds.has(threadId)
        || this.followedDesktopThreadIds.has(threadId)
        || this.followerStateWaiters.has(threadId);
      if (interested) this.applyFollowerStateChange(threadId, change);
      return;
    }
    if (envelope.method === THREAD_STREAM_FOLLOWING_CHANGED) {
      const params = record(envelope.params) ?? {};
      const threadId = threadIdFromParams(params);
      if (!this.ownedThreadIds.has(threadId)) return;
      const clientId = stringValue(envelope.sourceClientId) || stringValue(params.clientId);
      const followers = this.followerClientIds.get(threadId) ?? new Set<string>();
      if (params.following === false) followers.delete(clientId);
      else if (params.following === true && clientId) followers.add(clientId);
      this.followerClientIds.set(threadId, followers);
      if (params.following === true) {
        const timer = this.followTimers.get(threadId);
        if (timer) clearTimeout(timer);
        this.followTimers.delete(threadId);
        this.log(`Codex Desktop is following Android task ${threadId}`);
        this.forceSnapshot(threadId);
        this.scheduleFollowerMountBaseline(threadId);
      }
      return;
    }
    if (envelope.method === CLIENT_STATUS_CHANGED) {
      const params = record(envelope.params) ?? {};
      if (normalizeToken(params.status) === "disconnected") {
        const clientId = stringValue(params.clientId) || stringValue(envelope.sourceClientId);
        for (const followers of this.followerClientIds.values()) followers.delete(clientId);
        this.removeDesktopOwnerClient(clientId);
      } else {
        for (const threadId of this.ownedThreadIds) {
          this.transport.sendBroadcast("thread-stream-following-status-requested", {
            hostId: HOST_ID,
            conversationId: threadId,
          });
          if (!this.shouldDelayInitialSnapshot(threadId)) this.forceSnapshot(threadId);
        }
      }
    }
  }

  private applyFollowerStateChange(threadId: string, change: FollowerStateChange): void {
    if (change.type === "snapshot") {
      const state = record(change.conversationState);
      if (!state) return;
      // Desktop is allowed to have a much larger native transcript than the
      // bridge can safely retain. Bound an inbound snapshot before storing it
      // or resolving a pending-request read; otherwise one legacy renderer
      // broadcast could recreate the original 171 MB failure on this side.
      const redacted = sanitizeDesktopConversationState(state, true);
      const bounded = this.historyPages.recentPage(threadId, redacted).state;
      this.followerStates.set(threadId, clone(bounded));
      this.followerRevisions.set(threadId, change.revision ?? 0);
      this.clearFollowerRecovery(threadId);
      this.applyQueuedFollowerChanges(threadId);
      this.resolveFollowerStateWaiters(threadId);
      return;
    }

    const state = this.followerStates.get(threadId);
    const revision = this.followerRevisions.get(threadId);
    if (
      state
      && revision !== undefined
      && change.baseRevision === revision
      && change.revision !== undefined
      && Array.isArray(change.patches)
    ) {
      const next = applyDesktopStatePatches(state, change.patches);
      if (next) {
        this.followerStates.set(
          threadId,
          sanitizeDesktopConversationState(next, true),
        );
        this.followerRevisions.set(threadId, change.revision);
        this.resolveFollowerStateWaiters(threadId);
        return;
      }
    }

    this.queueFollowerChange(threadId, change);
    this.followerStates.delete(threadId);
    this.followerRevisions.delete(threadId);
    this.recoverFollowerBaseline(threadId);
  }

  private applyQueuedFollowerChanges(threadId: string): void {
    const queued = this.queuedFollowerChanges.get(threadId);
    if (!queued?.length) return;
    let state = this.followerStates.get(threadId);
    let revision = this.followerRevisions.get(threadId);
    if (!state || revision === undefined) return;
    const remaining: FollowerStateChange[] = [];
    for (const change of queued) {
      if (change.type === "snapshot") {
        const snapshot = record(change.conversationState);
        if (snapshot) {
          const redacted = sanitizeDesktopConversationState(snapshot, true);
          state = this.historyPages.recentPage(threadId, redacted).state;
          revision = change.revision ?? revision;
        }
        continue;
      }
      if (change.baseRevision !== undefined && change.baseRevision < revision) continue;
      if (
        change.baseRevision !== revision
        || change.revision === undefined
        || !Array.isArray(change.patches)
      ) {
        remaining.push(change);
        continue;
      }
      const next = applyDesktopStatePatches(state, change.patches);
      if (!next) {
        remaining.push(change);
        continue;
      }
      state = sanitizeDesktopConversationState(next, true);
      revision = change.revision;
    }
    this.followerStates.set(threadId, state);
    this.followerRevisions.set(threadId, revision);
    if (remaining.length > 0) {
      this.queuedFollowerChanges.set(threadId, remaining);
      this.recoverFollowerBaseline(threadId);
    } else {
      this.queuedFollowerChanges.delete(threadId);
    }
  }

  private queueFollowerChange(threadId: string, change: FollowerStateChange): void {
    const queued = this.queuedFollowerChanges.get(threadId) ?? [];
    queued.push(clone(change));
    if (queued.length > MAX_QUEUED_FOLLOWER_CHANGES) {
      queued.splice(0, queued.length - MAX_QUEUED_FOLLOWER_CHANGES);
    }
    this.queuedFollowerChanges.set(threadId, queued);
  }

  private recoverFollowerBaseline(threadId: string): void {
    if (!this.transport.connected) return;
    const recovery = this.followerRecovery.get(threadId) ?? { attempts: 0, timer: null, inFlight: false };
    if (recovery.inFlight || recovery.timer || recovery.attempts >= Math.max(1, this.followerBaselineMaxAttempts)) return;
    recovery.attempts += 1;
    recovery.inFlight = true;
    this.followerRecovery.set(threadId, recovery);
    void this.requestFollowerAction(THREAD_FOLLOWER_LOAD_HISTORY_PAGE, {
      hostId: HOST_ID,
      conversationId: threadId,
      direction: "recent",
      pageToken: null,
    }).then(result => {
      const response = record(result);
      const state = record(response?.conversationState ?? response?.conversation_state ?? response?.state);
      if (!state) return;
      const redacted = sanitizeDesktopConversationState(state, true);
      const bounded = this.historyPages.recentPage(threadId, redacted).state;
      this.followerStates.set(threadId, clone(bounded));
      this.followerRevisions.set(threadId, finiteRevision(response?.revision) ?? 0);
      this.clearFollowerRecovery(threadId);
      this.applyQueuedFollowerChanges(threadId);
      this.resolveFollowerStateWaiters(threadId);
    }).catch(error => {
      if (recovery.attempts === 1 || recovery.attempts === this.followerBaselineMaxAttempts) {
        this.warn(`Could not recover the Desktop stream baseline for ${threadId}: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }).finally(() => {
      const current = this.followerRecovery.get(threadId);
      if (!current || current !== recovery) return;
      current.inFlight = false;
      if (this.followerStates.has(threadId) || current.attempts >= Math.max(1, this.followerBaselineMaxAttempts)) return;
      const delay = Math.min(
        Math.max(0, this.followerBaselineMaxRetryMs),
        Math.max(0, this.followerBaselineRetryMs) * (2 ** Math.min(current.attempts - 1, 5)),
      );
      current.timer = setTimeout(() => {
        const latest = this.followerRecovery.get(threadId);
        if (latest) latest.timer = null;
        this.recoverFollowerBaseline(threadId);
      }, delay);
      current.timer.unref?.();
    });
  }

  private clearFollowerRecovery(threadId: string): void {
    const recovery = this.followerRecovery.get(threadId);
    if (recovery?.timer) clearTimeout(recovery.timer);
    this.followerRecovery.delete(threadId);
  }

  private resolveFollowerStateWaiters(threadId: string): void {
    const state = this.followerStates.get(threadId);
    const waiters = this.followerStateWaiters.get(threadId);
    if (!state || !waiters) return;
    this.followerStateWaiters.delete(threadId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(sanitizeDesktopConversationState(state));
    }
  }

  private hasActiveLocalTurn(threadId: string): boolean {
    if ((this.pendingTurnStarts.get(threadId)?.length ?? 0) > 0) return true;
    return (this.conversations.get(threadId)?.turns ?? []).some(turn => {
      const status = normalizeToken(turn.status);
      return !status || status === "inprogress" || status === "running" || status === "active";
    });
  }

  private canHandleRequest(envelope: DesktopIpcEnvelope): boolean {
    const method = stringValue(envelope.method);
    const params = record(envelope.params) ?? {};
    const threadId = threadIdFromParams(params);
    const sourceClientId = stringValue(envelope.sourceClientId);
    const localClientId = stringValue(this.transport.localClientId);
    if (sourceClientId && localClientId && sourceClientId === localClientId) {
      return false;
    }
    // Owner discovery is deliberately metadata-only.  It is part of the
    // router's route-probe protocol, not a request to hydrate or broadcast a
    // conversation.  Restrict it to the bridge's local writer so a stale
    // renderer cannot claim an arbitrary thread.
    if (method === THREAD_OWNER_DISCOVERY) {
      return stringValue(params.hostId) === HOST_ID
        && Boolean(threadId)
        && this.ownedThreadIds.has(threadId);
    }
    return FOLLOWER_METHODS.has(method) && this.ownedThreadIds.has(threadId);
  }

  private async handleRequest(envelope: DesktopIpcEnvelope): Promise<unknown> {
    const method = stringValue(envelope.method);
    const params = record(envelope.params) ?? {};
    const threadId = threadIdFromParams(params);
    if (!threadId || !this.ownedThreadIds.has(threadId)) throw new Error("conversation-not-owned");
    if (method === THREAD_OWNER_DISCOVERY) {
      // The response envelope carries handledByClientId.  Returning an empty
      // object is intentional: no turns, items, requests, or content cross
      // the IPC boundary during route discovery.
      return {};
    }
    if (method === THREAD_FOLLOWER_LOAD_HISTORY_PAGE) {
      const directionToken = normalizeToken(params.direction);
      const direction: DesktopHistoryPageDirection = directionToken === "older"
        ? "older"
        : directionToken === "newer"
          ? "newer"
          : "recent";
      const pageToken = stringValue(params.pageToken ?? params.page_token);
      let page: DesktopBoundedHistoryPage;
      const conversation = this.ensureConversation(threadId);
      if (direction === "recent") {
        page = this.historyPages.recentPage(threadId, conversation);
      } else {
        if (!pageToken) throw new Error("A page token is required for older or newer history");
        page = this.historyPages.page(threadId, conversation, direction, pageToken);
      }
      // Return the bounded page directly as well as publishing it. A direct
      // response lets a caller recover when it is not currently subscribed to
      // stream broadcasts, while the broadcast keeps existing followers in
      // sync. Both paths carry the same byte-bounded state.
      this.stopAwaitingInitialHistory(threadId);
      this.broadcastState(threadId, true);
      const revision = this.revisions.get(threadId) ?? 0;
      return {
        revision,
        conversationState: desktopConversationModelSelectors(page.state),
        historyPage: page.pageInfo,
      };
    }
    if (method === THREAD_FOLLOWER_READ_CONTENT_CHUNK) {
      const handle = stringValue(params.handle);
      const sourceRevision = stringValue(params.sourceRevision ?? params.source_revision);
      const offset = numberValue(params.offset) ?? 0;
      if (!handle || !sourceRevision || !Number.isSafeInteger(offset) || offset < 0) {
        throw new Error("A valid content handle, source revision, and offset are required");
      }
      return this.historyPages.readContentChunk({
        threadId,
        sourceRevision,
        handle,
        offset,
      });
    }
    if (method === "thread-follower-load-complete-history") {
      // Legacy Desktop clients may still send this method. Keep the method
      // available for compatibility, but make its response bounded; it must
      // never materialize a 64 MiB+ IPC frame.
      await this.hydrateThread(threadId);
      this.stopAwaitingInitialHistory(threadId);
      if (!this.broadcastState(threadId, true)) throw new Error("Codex Desktop is not connected");
      const bounded = this.historyPages.recentPage(threadId, this.ensureConversation(threadId));
      return {
        revision: this.revisions.get(threadId) ?? 0,
        conversationState: desktopConversationModelSelectors(bounded.state),
        historyPage: bounded.pageInfo,
      };
    }
    if (method === "thread-follower-start-turn") {
      const turnStart = record(params.turnStart);
      const raw = record(turnStart?.request)
        ?? record(params.turnStartParams)
        ?? record(params.turn_start_params)
        ?? params;
      const startParams = sanitizeTurnStartParams(remodexRuntimeModelSelectors({
        modelProvider: this.ensureConversation(threadId).modelProvider,
        ...this.withRuntimeOverrides(threadId, raw),
        threadId,
      }));
      this.rememberFollowerTurnStart(threadId, startParams);
      try {
        const result = await this.sendCodexRequest("turn/start", startParams);
        return { result: result ?? null };
      } catch (error) {
        this.removeLatestPendingTurn(threadId);
        throw error;
      }
    }
    if (method === "thread-follower-steer-turn") {
      const raw = record(params.turnSteerParams) ?? record(params.turn_steer_params) ?? params;
      const expectedTurnId = stringValue(raw.expectedTurnId)
        || stringValue(raw.expected_turn_id)
        || this.activeTurnId(this.ensureConversation(threadId));
      if (!expectedTurnId) throw new Error("The active Codex turn could not be found");
      return await this.sendCodexRequest("turn/steer", {
        threadId,
        ...(stringValue(raw.clientUserMessageId ?? raw.client_user_message_id)
          ? { clientUserMessageId: stringValue(raw.clientUserMessageId ?? raw.client_user_message_id) }
          : {}),
        input: Array.isArray(raw.input) ? raw.input : [],
        expectedTurnId,
      });
    }
    if (method === "thread-follower-interrupt-turn") {
      const turnId = stringValue(params.expectedTurnId)
        || stringValue(params.expected_turn_id)
        || stringValue(params.turnId)
        || stringValue(params.turn_id)
        || this.activeTurnId(this.ensureConversation(threadId));
      if (!turnId) throw new Error("The active Codex turn could not be found");
      return await this.sendCodexRequest("turn/interrupt", {
        threadId,
        turnId,
      });
    }
    if (method === "thread-follower-rollback-thread") {
      const numTurns = numberValue(params.numTurns ?? params.num_turns);
      if (numTurns === null || !Number.isInteger(numTurns) || numTurns < 1) {
        throw new Error("numTurns must be an integer greater than zero");
      }
      const response = record(await this.sendCodexRequest("thread/rollback", {
        threadId,
        numTurns,
      }));
      const rolledBackThread = record(response?.thread);
      if (rolledBackThread) {
        this.mergeThread(this.ensureConversation(threadId), rolledBackThread, true);
      } else {
        await this.hydrateThread(threadId);
      }
      this.pendingTurnStarts.delete(threadId);
      // A rollback removes an arbitrary suffix of turns. Publish the complete
      // replacement immediately so an already-open Codex Desktop follower
      // cannot keep rendering the removed prompt while Android starts the
      // edited turn. Ordinary patches are intentionally not used for this
      // non-append history rewrite.
      this.stopAwaitingInitialHistory(threadId);
      this.forceSnapshot(threadId);
      return { result: response ?? null };
    }
    if (method === "thread-follower-compact-thread") {
      return await this.sendCodexRequest("thread/compact/start", { threadId });
    }
    if (method === "thread-follower-set-model-and-reasoning") {
      await this.applyFollowerRuntimeSettings(threadId, params);
      return { ok: true };
    }
    if (method === "thread-follower-set-collaboration-mode") {
      await this.applyFollowerRuntimeSettings(threadId, { collaborationMode: params.collaborationMode });
      return { ok: true };
    }
    if (method === "thread-follower-update-thread-settings") {
      await this.applyFollowerRuntimeSettings(threadId, record(params.threadSettings) ?? {});
      return { ok: true };
    }
    const requestId = params.requestId ?? params.request_id;
    if (method === "thread-follower-command-approval-decision") {
      return this.respondToPendingRequest(threadId, requestId, { decision: params.decision });
    }
    if (method === "thread-follower-file-approval-decision") {
      return this.respondToPendingRequest(threadId, requestId, this.fileApprovalResult(threadId, requestId, params));
    }
    if (
      method === "thread-follower-permissions-request-approval-response"
      || method === "thread-follower-submit-user-input"
      || method === "thread-follower-submit-mcp-server-elicitation-response"
    ) {
      return this.respondToPendingRequest(threadId, requestId, record(params.response) ?? {});
    }
    throw new Error(`Unsupported Codex Desktop follower action: ${method}`);
  }

  private ensureConversation(threadId: string, cwd = ""): ConversationState {
    const existing = this.conversations.get(threadId);
    if (existing) return existing;
    const timestamp = this.now();
    const conversation: ConversationState = {
      id: threadId,
      hostId: HOST_ID,
      turns: [],
      requests: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      title: null,
      latestModel: "",
      latestReasoningEffort: null,
      latestServiceTier: null,
      previousTurnModel: null,
      latestCollaborationMode: {
        mode: "default",
        settings: { reasoning_effort: null, model: "", developer_instructions: null },
      },
      hasUnreadTurn: false,
      unreadMessageCount: 0,
      threadGoal: null,
      completedThreadGoal: null,
      threadRuntimeStatus: null,
      rolloutPath: "",
      cwd,
      gitInfo: null,
      resumeState: "resumed",
      latestTokenUsageInfo: null,
      workspaceKind: "project",
      workspaceBrowserRoot: null,
      projectlessOutputDirectory: null,
      currentPermissions: null,
    };
    this.conversations.set(threadId, conversation);
    return conversation;
  }

  private async hydrateThread(threadId: string): Promise<boolean> {
    const active = this.hydrationPromises.get(threadId);
    if (active) return active;
    const read = this.readThreadPage
      ? this.readThreadPage(threadId)
      : this.readThread(threadId);
    const hydration = read
      .then(result => {
        const thread = record(result?.thread) ?? record(result);
        if (!thread || stringValue(thread.id) !== threadId || !this.ownedThreadIds.has(threadId)) return false;
        this.mergeThread(this.ensureConversation(threadId), thread);
        this.markDirty(threadId);
        return true;
      })
      .catch(error => {
        this.warn(`Could not load Codex Desktop history for ${threadId}: ${error instanceof Error ? error.message : "unknown error"}`);
        return false;
      })
      .finally(() => this.hydrationPromises.delete(threadId));
    this.hydrationPromises.set(threadId, hydration);
    return hydration;
  }

  private requestInitialHistoryBaseline(threadId: string): void {
    if (!this.ownedThreadIds.has(threadId) || !this.threadsAwaitingInitialHistory.has(threadId)) return;
    if (this.hydrationPromises.has(threadId) || this.initialHistoryTimers.has(threadId)) return;
    const attempts = this.initialHistoryAttempts.get(threadId) ?? 0;
    if (attempts >= Math.max(1, this.initialHistoryMaxAttempts)) {
      this.warn(`Could not establish a complete Desktop history baseline for ${threadId}; releasing IPC ownership`);
      this.releaseThread(threadId);
      return;
    }
    this.initialHistoryAttempts.set(threadId, attempts + 1);
    void this.hydrateThread(threadId).then(success => {
      if (!this.ownedThreadIds.has(threadId) || !this.threadsAwaitingInitialHistory.has(threadId)) return;
      if (success) {
        this.stopAwaitingInitialHistory(threadId);
        this.markDirty(threadId);
        return;
      }
      const completedAttempts = this.initialHistoryAttempts.get(threadId) ?? attempts + 1;
      if (completedAttempts >= Math.max(1, this.initialHistoryMaxAttempts)) {
        this.warn(`Could not establish a complete Desktop history baseline for ${threadId}; releasing IPC ownership`);
        this.releaseThread(threadId);
        return;
      }
      const delay = Math.max(0, this.initialHistoryRetryMs) * (2 ** Math.min(completedAttempts - 1, 5));
      const timer = setTimeout(() => {
        this.initialHistoryTimers.delete(threadId);
        this.requestInitialHistoryBaseline(threadId);
      }, delay);
      timer.unref?.();
      this.initialHistoryTimers.set(threadId, timer);
    });
  }

  private stopAwaitingInitialHistory(threadId: string): void {
    this.threadsAwaitingInitialHistory.delete(threadId);
    this.initialHistoryAttempts.delete(threadId);
    const timer = this.initialHistoryTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.initialHistoryTimers.delete(threadId);
  }

  private shouldDelayInitialSnapshot(threadId: string): boolean {
    if (!this.threadsAwaitingInitialHistory.has(threadId)) return false;
    if (this.lastBroadcastStates.has(threadId)) {
      this.stopAwaitingInitialHistory(threadId);
      return false;
    }
    this.requestInitialHistoryBaseline(threadId);
    return this.ownedThreadIds.has(threadId) && this.threadsAwaitingInitialHistory.has(threadId);
  }

  private mergeThread(
    conversation: ConversationState,
    thread: JsonRecord,
    replaceMissingTurns = false,
  ): void {
    conversation.createdAt = timestampMs(thread.createdAt, Number(conversation.createdAt) || this.now());
    conversation.updatedAt = timestampMs(thread.updatedAt, this.now());
    conversation.title = stringValue(thread.name) || conversation.title;
    conversation.cwd = stringValue(thread.cwd) || conversation.cwd;
    conversation.rolloutPath = stringValue(thread.path) || conversation.rolloutPath;
    conversation.gitInfo = boundInboundPatchValue(thread.gitInfo ?? conversation.gitInfo ?? null) as JsonRecord | null;
    conversation.threadRuntimeStatus = boundInboundPatchValue(
      thread.status ?? conversation.threadRuntimeStatus ?? null,
    );
    const provider = stringValue(thread.modelProvider);
    if (provider) conversation.modelProvider = provider;
    const model = stringValue(thread.model);
    if (model) conversation.latestModel = model;
    if (Array.isArray(thread.turns)) {
      const currentById = new Map(conversation.turns.map(turn => [turn.turnId, turn]));
      const hydrated: ConversationTurn[] = [];
      const turns = thread.turns.slice(-INBOUND_HISTORY_MAX_TURNS);
      for (const candidate of turns) {
        const rawTurn = record(candidate);
        const turnId = stringValue(rawTurn?.id) || stringValue(rawTurn?.turnId);
        if (!rawTurn || !turnId) continue;
        const built = createConversationTurn(rawTurn, conversation, this.now, currentById.get(turnId)?.params);
        const previous = currentById.get(turnId);
        hydrated.push(previous ? mergeTurnContinuity(previous, built) : built);
        currentById.delete(turnId);
      }
      conversation.turns = replaceMissingTurns
        ? hydrated
        : [...hydrated, ...currentById.values()];
    }
    this.trimConversationHistory(conversation);
  }

  /** Keep the local owner mirror bounded even while a long turn stream grows. */
  private trimConversationHistory(conversation: ConversationState): void {
    if (conversation.turns.length > INBOUND_HISTORY_MAX_TURNS) {
      conversation.turns = conversation.turns.slice(-INBOUND_HISTORY_MAX_TURNS);
    }
    let remainingItems = DESKTOP_HISTORY_PAGE_MAX_ITEMS;
    for (let index = conversation.turns.length - 1; index >= 0; index -= 1) {
      const turn = conversation.turns[index]!;
      const items = Array.isArray(turn.items) ? turn.items : [];
      const keep = Math.min(remainingItems, items.length);
      turn.items = keep > 0 ? items.slice(-keep) : [];
      remainingItems = Math.max(0, remainingItems - keep);
    }
    if (conversation.requests.length > 64) conversation.requests = conversation.requests.slice(-64);
  }

  private shiftPendingTurn(threadId: string): PendingTurnStart | null {
    const queue = this.pendingTurnStarts.get(threadId);
    const pending = queue?.shift() ?? null;
    if (!queue || queue.length === 0) this.pendingTurnStarts.delete(threadId);
    return pending;
  }

  private rememberFollowerTurnStart(threadId: string, params: JsonRecord): void {
    const conversation = this.ensureConversation(threadId);
    const fallbackTurnId = `opencodex-pending-${this.now()}-${randomUUID()}`;
    const queue = this.pendingTurnStarts.get(threadId) ?? [];
    queue.push({ params: clone(params), fallbackTurnId });
    this.pendingTurnStarts.set(threadId, queue);
    conversation.turns.push(createConversationTurn({ id: fallbackTurnId, status: "inProgress", items: [] }, conversation, this.now, params));
    this.applyRuntimeMetadata(conversation, params);
    this.markDirty(threadId);
  }

  private removeLatestPendingTurn(threadId: string): void {
    const queue = this.pendingTurnStarts.get(threadId);
    const pending = queue?.pop();
    if (!queue || queue.length === 0) this.pendingTurnStarts.delete(threadId);
    if (pending) {
      const conversation = this.conversations.get(threadId);
      if (conversation) conversation.turns = conversation.turns.filter(turn => turn.turnId !== pending.fallbackTurnId);
      this.markDirty(threadId);
    }
  }

  private ensureTurn(conversation: ConversationState, turnId: string, allowLast = true): ConversationTurn | null {
    const id = stringValue(turnId) || (allowLast ? this.activeTurnId(conversation) : "");
    if (!id) return null;
    let turn = findTurn(conversation, id);
    if (!turn) {
      turn = createConversationTurn({ id, status: "inProgress", items: [] }, conversation, this.now);
      conversation.turns.push(turn);
    }
    return turn;
  }

  private activeTurnId(conversation: ConversationState): string {
    for (let index = conversation.turns.length - 1; index >= 0; index -= 1) {
      const turn = conversation.turns[index];
      const status = normalizeToken(turn.status);
      if (!status || status === "inprogress" || status === "running" || status === "active") return turn.turnId;
    }
    return conversation.turns.at(-1)?.turnId ?? "";
  }

  private appendItemDelta(
    conversation: ConversationState,
    params: JsonRecord,
    type: string,
    field: string,
  ): boolean {
    const itemId = stringValue(params.itemId) || stringValue(params.item_id);
    const delta = typeof params.delta === "string" ? params.delta : "";
    const turn = this.ensureTurn(conversation, turnIdFromParams(params));
    if (!turn || !itemId || !delta) return false;
    const item = ensureItem(turn, itemId, () => defaultDeltaItem(type, itemId, conversation.cwd as string));
    item[field] = `${typeof item[field] === "string" ? item[field] : ""}${delta}`.slice(-MAX_STREAM_TEXT_BYTES);
    turn.firstTurnWorkItemStartedAtMs ||= this.now();
    if (type === "agentMessage") turn.finalAssistantStartedAtMs ||= this.now();
    return true;
  }

  private appendReasoningSummary(conversation: ConversationState, params: JsonRecord): boolean {
    const itemId = stringValue(params.itemId) || stringValue(params.item_id);
    const delta = typeof params.delta === "string" ? params.delta : "";
    const turn = this.ensureTurn(conversation, turnIdFromParams(params));
    if (!turn || !itemId || !delta) return false;
    const item = ensureItem(turn, itemId, () => ({ type: "reasoning", id: itemId, summary: [], content: [] }));
    const index = typeof params.summaryIndex === "number" ? Math.max(0, Math.floor(params.summaryIndex)) : 0;
    const summary = Array.isArray(item.summary) ? item.summary as unknown[] : [];
    while (summary.length <= index) summary.push("");
    summary[index] = `${typeof summary[index] === "string" ? summary[index] : ""}${delta}`.slice(-MAX_STREAM_TEXT_BYTES);
    item.summary = summary;
    item.content = [];
    turn.firstTurnWorkItemStartedAtMs ||= this.now();
    return true;
  }

  private applyRuntimeMetadata(conversation: ConversationState, params: JsonRecord): void {
    const model = stringValue(params.model);
    if (model) {
      conversation.previousTurnModel = conversation.latestModel || null;
      conversation.latestModel = model;
    }
    if (typeof params.effort === "string") conversation.latestReasoningEffort = params.effort;
    if ("serviceTier" in params) conversation.latestServiceTier = params.serviceTier ?? null;
    if (record(params.collaborationMode)) conversation.latestCollaborationMode = clone(params.collaborationMode);
  }

  private async applyFollowerRuntimeSettings(threadId: string, params: JsonRecord): Promise<void> {
    params = remodexRuntimeModelSelectors({
      modelProvider: this.ensureConversation(threadId).modelProvider,
      ...params,
    });
    const current = this.runtimeOverrides.get(threadId) ?? {};
    const model = stringValue(params.model) || stringValue(record(record(params.collaborationMode)?.settings)?.model);
    if (model) current.model = model;
    if ("reasoningEffort" in params) current.effort = params.reasoningEffort;
    if ("effort" in params) current.effort = params.effort;
    if ("serviceTier" in params) current.serviceTier = params.serviceTier;
    if (record(params.collaborationMode)) current.collaborationMode = clone(params.collaborationMode);
    this.runtimeOverrides.set(threadId, current);
    this.applyRuntimeMetadata(this.ensureConversation(threadId), current);
    this.markDirty(threadId);
    const update: JsonRecord = { threadId };
    if (model) update.model = model;
    if ("reasoningEffort" in params) update.effort = params.reasoningEffort;
    else if ("effort" in params) update.effort = params.effort;
    if ("serviceTier" in params) update.serviceTier = params.serviceTier;
    if (record(params.collaborationMode)) update.collaborationMode = clone(params.collaborationMode);
    if (Object.keys(update).length === 1) return;
    try {
      await this.sendCodexRequest("thread/settings/update", update);
    } catch (error) {
      // Codex builds before thread/settings/update still use the in-memory
      // override on the next turn. Newer builds persist and notify all clients.
      if (!threadSettingsUpdateUnavailable(error)) throw error;
    }
  }

  private withRuntimeOverrides(threadId: string, params: JsonRecord): JsonRecord {
    const overrides = this.runtimeOverrides.get(threadId);
    if (!overrides) return params;
    const merged = { ...params };
    for (const key of ["model", "effort", "serviceTier", "collaborationMode"]) {
      if (merged[key] == null && overrides[key] != null) merged[key] = clone(overrides[key]);
    }
    return merged;
  }

  private respondToPendingRequest(threadId: string, requestId: unknown, result: JsonRecord): JsonRecord {
    const key = requestIdKey(requestId);
    if (!key) throw new Error("The pending Codex request could not be identified");
    const conversation = this.ensureConversation(threadId);
    const pending = conversation.requests.find(request => requestIdKey(request.id) === key);
    if (!pending) throw new Error("This Codex request is no longer waiting for a response");
    this.respondToCodexRequest(pending.id as RequestId, result);
    // Keep the request visible until app-server emits serverRequest/resolved.
    // A successful socket write is not authoritative completion, and removing
    // it here makes transient reconnects strand Desktop with no prompt to retry.
    return { ok: true };
  }

  private fileApprovalResult(threadId: string, requestId: unknown, params: JsonRecord): JsonRecord {
    const conversation = this.ensureConversation(threadId);
    const pending = conversation.requests.find(request => requestIdKey(request.id) === requestIdKey(requestId));
    if (stringValue(pending?.method) !== "item/permissions/requestApproval") {
      return { decision: params.decision };
    }
    const decision = stringValue(params.decision);
    const requested = record(record(pending!.params)?.permissions);
    return {
      permissions: decision === "accept" || decision === "acceptForSession" ? clone(requested ?? {}) : {},
      scope: decision === "acceptForSession" ? "session" : "turn",
    };
  }

  private markDirty(threadId: string): void {
    if (!this.ownedThreadIds.has(threadId)) return;
    this.dirtyThreadIds.add(threadId);
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      for (const pending of [...this.dirtyThreadIds]) {
        if (this.shouldDelayInitialSnapshot(pending)) continue;
        if (this.broadcastState(pending)) this.dirtyThreadIds.delete(pending);
      }
    }, Math.max(0, this.snapshotDebounceMs));
    this.snapshotTimer.unref?.();
  }

  private forceSnapshot(threadId: string): void {
    if (this.shouldDelayInitialSnapshot(threadId)) {
      this.dirtyThreadIds.add(threadId);
      return;
    }
    if (this.broadcastState(threadId, true)) this.dirtyThreadIds.delete(threadId);
    else this.dirtyThreadIds.add(threadId);
  }

  private broadcastState(threadId: string, forceSnapshot = false): boolean {
    const conversation = this.conversations.get(threadId);
    if (!conversation || !this.ownedThreadIds.has(threadId)) return true;
    if (this.shouldDelayInitialSnapshot(threadId)) return false;
    // Never put the retained full projection on the wire. The page builder
    // selects a recent tail, replaces oversized fields with opaque handles,
    // and enforces a serialized-byte budget before patches or snapshots are
    // encoded into a 64 MiB IPC frame.
    const bounded = desktopConversationModelSelectors(this.historyPages.recentPage(threadId, conversation).state);
    const revision = this.revisions.get(threadId) ?? 0;
    const previous = this.lastBroadcastStates.get(threadId);
    if (!forceSnapshot && previous) {
      const patches = buildDesktopStatePatches(previous, bounded);
      if (patches?.length === 0) return true;
      if (patches && this.transport.sendBroadcast(THREAD_STREAM_STATE_CHANGED, {
        conversationId: threadId,
        hostId: HOST_ID,
        version: DESKTOP_IPC_METHOD_VERSIONS.get(THREAD_STREAM_STATE_CHANGED) ?? 1,
        opencodexOwnerSource: OWNER_SOURCE,
        change: {
          type: "patches",
          baseRevision: revision,
          revision: revision + 1,
          patches,
        },
      })) {
        this.revisions.set(threadId, revision + 1);
        this.lastBroadcastStates.set(threadId, clone(bounded));
        this.log(`Published Desktop patches for ${threadId} at revision ${revision + 1}`);
        return true;
      }
    }
    if (!this.transport.sendBroadcast(THREAD_STREAM_STATE_CHANGED, {
      conversationId: threadId,
      hostId: HOST_ID,
      version: DESKTOP_IPC_METHOD_VERSIONS.get(THREAD_STREAM_STATE_CHANGED) ?? 1,
      opencodexOwnerSource: OWNER_SOURCE,
      change: {
        type: "snapshot",
        revision: revision + 1,
        conversationState: bounded,
      },
    })) return false;
    this.revisions.set(threadId, revision + 1);
    this.lastBroadcastStates.set(threadId, clone(bounded));
    this.log(`Published Desktop snapshot for ${threadId} at revision ${revision + 1}`);
    return true;
  }

  private beginFollow(threadId: string): void {
    if (!this.transport.connected || !this.ownedThreadIds.has(threadId)) return;
    if ((this.followerClientIds.get(threadId)?.size ?? 0) > 0) return;
    const attempt = (this.followAttempts.get(threadId) ?? 0) + 1;
    if (attempt > this.followMaxAttempts) return;
    this.followAttempts.set(threadId, attempt);
    this.transport.sendBroadcast("thread-stream-following-status-requested", {
      hostId: HOST_ID,
      conversationId: threadId,
    });
    const token = `${this.now()}-${attempt}-${randomUUID()}`;
    const url = `codex://threads/${encodeURIComponent(threadId)}?opencodex-follow=${encodeURIComponent(token)}`;
    void this.openUrl(url).catch(error => {
      this.warn(`Could not ask Codex Desktop to follow ${threadId}: ${error instanceof Error ? error.message : "unknown error"}`);
    });
    const previous = this.followTimers.get(threadId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.followTimers.delete(threadId);
      this.beginFollow(threadId);
    }, this.followConfirmMs);
    timer.unref?.();
    this.followTimers.set(threadId, timer);
  }

  private scheduleFollowerMountBaseline(threadId: string): void {
    const previous = this.followerBaselineTimers.get(threadId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.followerBaselineTimers.delete(threadId);
      if (this.ownedThreadIds.has(threadId) && (this.followerClientIds.get(threadId)?.size ?? 0) > 0) {
        this.forceSnapshot(threadId);
      }
    }, FOLLOWER_MOUNT_BASELINE_DELAY_MS);
    timer.unref?.();
    this.followerBaselineTimers.set(threadId, timer);
  }

  private scheduleSidebarAnnouncement(threadId: string): void {
    if (this.announcedSidebarThreadIds.has(threadId) || this.sidebarTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.sidebarTimers.delete(threadId);
      this.announceSidebarThread(threadId);
    }, SIDEBAR_REFRESH_DELAY_MS);
    timer.unref?.();
    this.sidebarTimers.set(threadId, timer);
  }

  private announceSidebarThread(threadId: string, replay = false): void {
    if (!this.ownedThreadIds.has(threadId)) return;
    if (!replay && this.announcedSidebarThreadIds.has(threadId)) return;
    const timer = this.sidebarTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.sidebarTimers.delete(threadId);
    if (this.transport.sendBroadcast("thread-unarchived", {
      hostId: HOST_ID,
      conversationId: threadId,
    })) {
      this.announcedSidebarThreadIds.add(threadId);
    } else {
      this.scheduleSidebarAnnouncement(threadId);
    }
  }
}

function openUrlWithPlatform(url: string, platform: NodeJS.Platform): Promise<void> {
  const commands = codexDesktopOpenCommands(url, platform);
  if (commands.length === 0) return Promise.reject(new Error("Unsupported operating system"));
  return runOpenCommands(commands);
}

async function runOpenCommands(commands: CodexDesktopOpenCommand[]): Promise<void> {
  let lastError: unknown = null;
  for (const command of commands) {
    try {
      await runDesktopOpenCommand(command.command, command.args);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not open Codex Desktop");
}

const PRIVATE_TRANSCRIPT_PLACEHOLDER_KEY = "_androidRemotePrivateTranscript";

function sanitizeTurnStartParams(
  params: JsonRecord,
  preservePrivateInputIndexes = false,
): JsonRecord {
  const sanitized: JsonRecord = {};
  for (const [key, value] of Object.entries(params)) {
    if (ALLOWED_TURN_START_KEYS.has(key) && value !== undefined) {
      sanitized[key] = boundInboundPatchValue(value);
    }
  }
  sanitized.input = sanitizeInputEntries(sanitized.input, preservePrivateInputIndexes);
  return sanitized;
}

function sanitizeInputEntries(value: unknown, preservePrivateIndexes = false): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(candidate => {
    const entry = record(candidate);
    if (!entry) return [clone(candidate)];
    const entryType = normalizeToken(entry.type);
    if (entryType === "imageurl") {
      const nested = record(entry.image_url) ?? record(entry.imageUrl);
      const url = stringValue(entry.url)
        || stringValue(nested?.url)
        || stringValue(entry.image_url)
        || stringValue(entry.imageUrl);
      return [url ? { type: "image", url } : clone(candidate)];
    }
    const transcriptFields = (["text", "value"] as const).filter(key =>
      typeof entry[key] === "string");
    if (transcriptFields.length === 0) return [clone(candidate)];
    if (!transcriptFields.some(key => Boolean(entry[key]))) {
      if (entry[PRIVATE_TRANSCRIPT_PLACEHOLDER_KEY] === true) {
        return preservePrivateIndexes ? [privateTranscriptInputPlaceholder(entry)] : [];
      }
      return [clone(candidate)];
    }
    const sanitized: JsonRecord = clone(entry);
    let hasPublicText = false;
    for (const key of transcriptFields) {
      const publicText = sanitizePublicTranscriptText(entry[key]);
      if (publicText === null || publicText.length === 0) delete sanitized[key];
      else {
        sanitized[key] = publicText;
        hasPublicText = true;
      }
    }
    if (!hasPublicText) {
      return preservePrivateIndexes ? [privateTranscriptInputPlaceholder(entry)] : [];
    }
    delete sanitized[PRIVATE_TRANSCRIPT_PLACEHOLDER_KEY];
    return [sanitized];
  });
}

function threadIdFromMessage(method: string, params: JsonRecord): string {
  if (method === "thread/started") return stringValue(record(params.thread)?.id);
  return threadIdFromParams(params);
}

function createConversationTurn(
  rawTurn: JsonRecord,
  conversation: ConversationState,
  now: () => number,
  suppliedParams?: JsonRecord,
): ConversationTurn {
  const turnId = stringValue(rawTurn.id) || stringValue(rawTurn.turnId) || stringValue(rawTurn.turn_id);
  const params = suppliedParams ? sanitizeTurnStartParams(suppliedParams) : defaultTurnParams(conversation);
  const rawItems = Array.isArray(rawTurn.items)
    ? rawTurn.items.slice(-INBOUND_HISTORY_MAX_ITEMS_PER_TURN)
    : [];
  const items: JsonRecord[] = [];
  let adoptedPrompt = Array.isArray(params.input) && params.input.length > 0;
  for (const candidate of rawItems) {
    const item = sanitizeDesktopItem(record(candidate));
    if (!item) continue;
    if (item.type === "userMessage" && !adoptedPrompt) {
      const prompt = userMessageInput(item);
      if (prompt.length > 0) {
        params.input = prompt;
        adoptedPrompt = true;
        continue;
      }
    }
    if (item.type === "userMessage" && sameVisibleInput(params.input, userMessageInput(item)) && !items.some(row => row.type === "userMessage")) {
      continue;
    }
    items.push(item);
  }
  return {
    id: turnId,
    turnId,
    params,
    turnStartedAtMs: timestampMs(rawTurn.startedAt, now()),
    durationMs: rawTurn.durationMs ?? null,
    firstTurnWorkItemStartedAtMs: null,
    finalAssistantStartedAtMs: null,
    status: rawTurn.status ?? "inProgress",
    error: boundInboundPatchValue(rawTurn.error ?? null),
    diff: typeof rawTurn.diff === "string"
      ? (() => {
          const bounded = boundInboundPatchValue(rawTurn.diff, new WeakSet(), 0, true);
          return typeof bounded === "string" ? bounded : null;
        })()
      : null,
    hookRuns: [],
    commandExecutionStartedAtMsById: {},
    items,
  };
}

function defaultTurnParams(conversation: ConversationState): JsonRecord {
  return {
    threadId: conversation.id,
    input: [],
    cwd: conversation.cwd || null,
    approvalPolicy: null,
    approvalsReviewer: null,
    sandboxPolicy: null,
    model: conversation.latestModel || null,
    serviceTier: conversation.latestServiceTier ?? null,
    effort: conversation.latestReasoningEffort ?? null,
    summary: "none",
    personality: null,
    outputSchema: null,
    collaborationMode: clone(conversation.latestCollaborationMode ?? null),
  };
}

function sanitizeDesktopItem(
  item: JsonRecord | null,
  preservePrivateContentIndexes = false,
): JsonRecord | null {
  if (!item) return null;
  const type = stringValue(item.type);
  if (!type || !stringValue(item.id)) return null;
  if (item[PRIVATE_TRANSCRIPT_PLACEHOLDER_KEY] === true && !transcriptText(item)) return null;
  const normalizedType = normalizeToken(type);
  const role = normalizeToken(item.role);
  if (
    normalizedType === "developermessage"
    || normalizedType === "systemmessage"
    || normalizedType === "toolmessage"
  ) return null;
  if (
    (normalizedType === "message" || normalizedType === "usermessage" || normalizedType === "agentmessage")
    && isPrivateTranscriptRole(role)
  ) return null;
  const transcriptRole = normalizedType === "usermessage"
    || (normalizedType === "message" && role === "user")
    ? "user"
    : normalizedType === "agentmessage"
      || (normalizedType === "message" && role === "assistant")
      ? "assistant"
      : null;
  const rawTranscriptText = transcriptRole ? transcriptText(item) : "";
  const publicTranscriptText = rawTranscriptText
    ? sanitizePublicTranscriptText(rawTranscriptText)
    : "";
  if (
    transcriptRole
    && (
      publicTranscriptText === null
      || (item[PRIVATE_TRANSCRIPT_PLACEHOLDER_KEY] === true && !publicTranscriptText)
    )
  ) return null;
  const safe: JsonRecord = {};
  let entries = 0;
  for (const key in item) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
    entries += 1;
    if (entries > INBOUND_PATCH_MAX_ENTRIES || Buffer.byteLength(key, "utf8") > 512) break;
    safe[key] = boundInboundPatchValue(item[key], new WeakSet(), 0, true);
  }
  // Keep the identity fields authoritative even if an untrusted input object
  // put them after a truncated collection of metadata keys.
  safe.type = type;
  safe.id = stringValue(item.id);
  if (transcriptRole) {
    delete safe[PRIVATE_TRANSCRIPT_PLACEHOLDER_KEY];
    if (typeof item.text === "string") {
      const publicText = sanitizePublicTranscriptText(item.text);
      if (publicText === null || publicText.length === 0) delete safe.text;
      else safe.text = publicText;
    }
    if (typeof item.message === "string") {
      const publicText = sanitizePublicTranscriptText(item.message);
      if (publicText === null || publicText.length === 0) delete safe.message;
      else safe.message = publicText;
    }
    if (Array.isArray(item.content)) {
      safe.content = sanitizeInputEntries(
        boundInboundPatchValue(item.content, new WeakSet(), 0, true),
        preservePrivateContentIndexes,
      );
    }

    // A bootstrap block can be followed by the real prompt in the same string.
    // Prefer that complete sanitized result if per-part normalization could not
    // recover any visible text, while leaving non-text attachment entries intact.
    if (publicTranscriptText && !transcriptText(safe)) {
      const attachments = Array.isArray(safe.content)
        ? safe.content.filter(candidate => {
            const entry = record(candidate);
            const entryType = normalizeToken(entry?.type);
            return entryType !== "text" && entryType !== "inputtext" && entryType !== "outputtext";
          })
        : [];
      if (transcriptRole === "assistant") safe.text = publicTranscriptText;
      else safe.content = [{ type: "text", text: publicTranscriptText }, ...attachments];
    }
    if (rawTranscriptText && !transcriptText(safe)) return null;
    if (normalizedType === "agentmessage" && typeof safe.text !== "string") {
      safe.text = transcriptText(safe);
    }
  }
  if (type === "reasoning") safe.content = [];
  return safe;
}

function privateTranscriptShape(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (typeof value === "string") return "";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object") return String(value);
  if (depth >= INBOUND_PATCH_MAX_DEPTH || seen.has(value)) {
    return { kind: "missing", reason: "not-retained" };
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, INBOUND_PATCH_MAX_ENTRIES).map(entry =>
        privateTranscriptShape(entry, seen, depth + 1));
    }
    const output: JsonRecord = {};
    let entries = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      entries += 1;
      if (entries > INBOUND_PATCH_MAX_ENTRIES || Buffer.byteLength(key, "utf8") > 512) break;
      output[key] = privateTranscriptShape((value as JsonRecord)[key], seen, depth + 1);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function privateTranscriptInputPlaceholder(entry: JsonRecord): JsonRecord {
  const placeholder = record(privateTranscriptShape(entry)) ?? {};
  placeholder.type = stringValue(entry.type);
  placeholder[PRIVATE_TRANSCRIPT_PLACEHOLDER_KEY] = true;
  return placeholder;
}

function privateTranscriptPlaceholder(item: JsonRecord): JsonRecord {
  const placeholder = record(privateTranscriptShape(item)) ?? {};
  placeholder.type = stringValue(item.type);
  placeholder.id = stringValue(item.id);
  if (typeof item.role === "string") placeholder.role = item.role;
  placeholder[PRIVATE_TRANSCRIPT_PLACEHOLDER_KEY] = true;
  return placeholder;
}

/**
 * Sanitize a Desktop conversation without exposing its private transport
 * records. The retained patch baseline uses placeholders so array indexes stay
 * aligned with the Desktop renderer; public readers receive those rows removed.
 */
function sanitizeDesktopConversationState(
  state: JsonRecord,
  preservePrivateItemIndexes = false,
): JsonRecord {
  const safe: JsonRecord = {};
  let stateEntries = 0;
  for (const key in state) {
    if (!Object.prototype.hasOwnProperty.call(state, key) || key === "turns") continue;
    stateEntries += 1;
    if (stateEntries > INBOUND_PATCH_MAX_ENTRIES || Buffer.byteLength(key, "utf8") > 512) break;
    safe[key] = boundInboundPatchValue(state[key]);
  }
  if (typeof state.id === "string") safe.id = state.id;
  if (!Array.isArray(state.turns)) return safe;
  const rawTurns = state.turns.slice(-INBOUND_HISTORY_MAX_TURNS);
  safe.turns = rawTurns.map(candidate => {
    const turn = record(candidate);
    if (!turn) return boundInboundPatchValue(candidate);
    const next: JsonRecord = {};
    let turnEntries = 0;
    for (const key in turn) {
      if (!Object.prototype.hasOwnProperty.call(turn, key) || key === "params" || key === "items") continue;
      turnEntries += 1;
      if (turnEntries > INBOUND_PATCH_MAX_ENTRIES || Buffer.byteLength(key, "utf8") > 512) break;
      next[key] = boundInboundPatchValue(turn[key]);
    }
    if (typeof turn.id === "string") next.id = turn.id;
    if (typeof turn.turnId === "string") next.turnId = turn.turnId;
    const params = record(turn.params);
    if (params) next.params = sanitizeTurnStartParams(params, preservePrivateItemIndexes);
    if (Array.isArray(turn.items)) {
      const rawItems = turn.items.slice(-INBOUND_HISTORY_MAX_ITEMS_PER_TURN);
      next.items = rawItems.flatMap(itemValue => {
        const rawItem = record(itemValue);
        if (!rawItem) return [boundInboundPatchValue(itemValue)];
        const item = sanitizeDesktopItem(rawItem, preservePrivateItemIndexes);
        if (item) return [item];
        return preservePrivateItemIndexes ? [privateTranscriptPlaceholder(rawItem)] : [];
      });
    }
    return next;
  });
  return safe;
}

function userMessageInput(item: JsonRecord): unknown[] {
  const content = Array.isArray(item.content) ? item.content : [];
  if (content.length > 0) return sanitizeInputEntries(content);
  const text = visibleUserText(item);
  return text ? [{ type: "text", text }] : [];
}

function transcriptText(item: JsonRecord): string {
  const parts: string[] = [];
  if (typeof item.text === "string" && item.text) parts.push(item.text);
  if (typeof item.message === "string" && item.message) parts.push(item.message);
  if (Array.isArray(item.content)) {
    for (const candidate of item.content) {
      const row = record(candidate);
      const part = row && typeof row.text === "string"
        ? row.text
        : row && typeof row.value === "string"
          ? row.value
          : "";
      if (part) parts.push(part);
    }
  }
  return parts.join("\n");
}

function visibleUserText(item: JsonRecord): string {
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  if (!Array.isArray(item.content)) return "";
  return item.content.flatMap(candidate => {
    const row = record(candidate);
    const text = row && typeof row.text === "string"
      ? row.text
      : row && typeof row.value === "string"
        ? row.value
        : "";
    return text ? [text] : [];
  }).join("\n");
}

function visibleInputText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap(candidate => {
    const row = record(candidate);
    const text = row && typeof row.text === "string"
      ? row.text
      : row && typeof row.value === "string"
        ? row.value
        : "";
    return text ? [text.trim()] : [];
  }).filter(Boolean).join("\n");
}

function sameVisibleInput(left: unknown, right: unknown): boolean {
  const a = canonicalUserMessageText(visibleInputText(left));
  const b = canonicalUserMessageText(visibleInputText(right));
  return Boolean(a && b && a === b);
}

function mergeTurnContinuity(previous: ConversationTurn, current: ConversationTurn): ConversationTurn {
  const merged = {
    ...current,
    params: Array.isArray(previous.params.input) && previous.params.input.length > 0 ? clone(previous.params) : current.params,
    turnStartedAtMs: previous.turnStartedAtMs ?? current.turnStartedAtMs,
    firstTurnWorkItemStartedAtMs: previous.firstTurnWorkItemStartedAtMs ?? current.firstTurnWorkItemStartedAtMs,
    finalAssistantStartedAtMs: previous.finalAssistantStartedAtMs ?? current.finalAssistantStartedAtMs,
    diff: current.diff ?? previous.diff,
    hookRuns: Array.isArray(current.hookRuns) && current.hookRuns.length > 0 ? current.hookRuns : clone(previous.hookRuns),
    commandExecutionStartedAtMsById: {
      ...(record(previous.commandExecutionStartedAtMsById) ?? {}),
      ...(record(current.commandExecutionStartedAtMsById) ?? {}),
    },
    items: mergeItems(previous.items, current.items),
  };
  return {
    ...merged,
    items: removeDuplicateInitialUserMessage(merged, merged.items),
  };
}

function userMessageDuplicatesTurnInput(turn: ConversationTurn, item: JsonRecord): boolean {
  if (item.type !== "userMessage" || !Array.isArray(turn.params.input) || turn.params.input.length === 0) {
    return false;
  }
  const clientUserMessageId = stringValue(turn.params.clientUserMessageId);
  const itemClientId = stringValue(item.clientId) || stringValue(item.client_id);
  if (clientUserMessageId && itemClientId && clientUserMessageId === itemClientId) return true;
  return sameVisibleInput(turn.params.input, userMessageInput(item));
}

function isInitialTurnPrefixItem(item: JsonRecord): boolean {
  return item.type === "automaticApprovalReview"
    || item.type === "forkedFromConversation"
    || item.type === "modelChanged"
    || item.type === "modelRerouted"
    || item.type === "personalityChanged"
    || item.type === "remoteTaskCreated"
    || item.type === "worktreeInit";
}

function removeDuplicateInitialUserMessage(turn: ConversationTurn, items: JsonRecord[]): JsonRecord[] {
  let canMatchInitialInput = true;
  let removedInitialInput = false;
  return items.filter(item => {
    if (
      canMatchInitialInput
      && !removedInitialInput
      && userMessageDuplicatesTurnInput(turn, item)
    ) {
      removedInitialInput = true;
      canMatchInitialInput = false;
      return false;
    }
    if (!isInitialTurnPrefixItem(item)) canMatchInitialInput = false;
    return true;
  });
}

function mergeItems(previous: JsonRecord[], current: JsonRecord[]): JsonRecord[] {
  const next = previous.map(clone);
  for (const item of current) upsertById(next, item);
  return next;
}

function findTurn(conversation: ConversationState, turnId: string): ConversationTurn | null {
  return conversation.turns.find(turn => turn.turnId === turnId || turn.id === turnId) ?? null;
}

function replaceTurn(conversation: ConversationState, oldId: string, turn: ConversationTurn): void {
  const matchingIndexes: number[] = [];
  let merged = turn;
  conversation.turns.forEach((candidate, index) => {
    if (candidate.turnId !== oldId && candidate.turnId !== turn.turnId) return;
    matchingIndexes.push(index);
    merged = mergeTurnContinuity(candidate, merged);
  });
  if (matchingIndexes.length === 0) {
    conversation.turns.push(merged);
    return;
  }
  const insertionIndex = matchingIndexes[0]!;
  conversation.turns = conversation.turns.filter((_, index) => !matchingIndexes.includes(index));
  conversation.turns.splice(insertionIndex, 0, merged);
}

function upsertTurnItem(turn: ConversationTurn, item: JsonRecord): void {
  upsertById(turn.items, item);
}

function upsertById(rows: JsonRecord[], value: JsonRecord): void {
  const key = requestIdKey(value.id);
  if (!key) return;
  const index = rows.findIndex(candidate => requestIdKey(candidate.id) === key);
  if (index >= 0) rows[index] = { ...rows[index], ...clone(value) };
  else rows.push(clone(value));
}

function ensureItem(turn: ConversationTurn, itemId: string, create: () => JsonRecord): JsonRecord {
  let item = turn.items.find(candidate => stringValue(candidate.id) === itemId);
  if (!item) {
    item = create();
    turn.items.push(item);
  }
  return item;
}

function defaultDeltaItem(type: string, id: string, cwd: string): JsonRecord {
  if (type === "agentMessage") return { type, id, text: "", phase: null, memoryCitation: null };
  if (type === "plan") return { type, id, text: "" };
  if (type === "commandExecution") return {
    type,
    id,
    command: "",
    cwd: cwd || "/",
    processId: null,
    source: "exec",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: "",
    exitCode: null,
    durationMs: null,
  };
  return { type, id };
}
