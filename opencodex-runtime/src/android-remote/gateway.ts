import { codexAccountQuotaReport } from "./codex-account-usage";
import { projectedTurnWorkPage } from "./thread-work-page";
import { isPrivateLanIpv4 } from "./local-network";
import { desktopAnswerMessage, desktopAsyncQuestionItem, desktopQuestionReplyIds, readDesktopInteractions, type DesktopInteractions } from "./desktop-interactions";
import { DEFAULT_ANDROID_GATEWAY_PORT as DEFAULT_GATEWAY_PORT } from "./ports";
import { createDesktopUpdateRoutes } from "./desktop-updates";
import { createTaskActivityReader } from "../update/task-activity";
import { readUpdateTaskIds, readUpdateTaskPath } from "../update/task-inventory";
import { decodeNativeHistoryCursor, nativeHistoryCursor, nativeHistoryIsUnsupported, readNativeTurnsPage, nativeHistoryNeedsSessionRecovery } from "./native-turn-history";
import { createHash, randomUUID } from "node:crypto";
import { codexHasActiveWriter, WriterOwnershipUnavailableError } from "./writer-conflict";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { readWorkspaceTextFile } from "./file-preview";
import { homedir, networkInterfaces, hostname as readHostname } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { getConfigDir } from "../config";
import { getCodexHome } from "../codex/paths";
import { redactSecretString } from "../lib/redact";
import { commandInvocation } from "../lib/win-exec";
import type { ManagementModelRow } from "../server/management/model-rows";
import { replaceObservedNativeModelRows } from "../server/management/model-rows";
import { readObservedNativeCatalog, type ObservedNativeCatalog } from "../codex/catalog/observed-native";
import { modelSourceDisplayName } from "../model-sources";
import { routedSlug, slugEquals } from "../providers/slug-codec";
import { readDesktopDirectModelProvider } from "./desktop-model-route";
import {
  AndroidRemoteAuth,
  ANDROID_REMOTE_SCOPES,
  type AndroidRemoteClientMetadata,
  type AndroidRemotePairingInvitation,
} from "./auth";
import {
  AndroidCodexRuntime,
  AndroidCodexResponseTooLargeError,
  type AndroidCodexClient,
  type CodexJsonRpcMessage,
} from "./codex-app-server";
import {
  codexProposedPlanId,
  projectCodexContextWindowActivity,
  projectCodexNotificationItemLabel,
  projectProviderUsageActivity,
  projectCodexReadModel,
  projectCodexLiveTurnItem,
  projectCodexShellSnapshot,
  projectCodexThreadDetail,
} from "./projection";
import { canonicalUserMessageText } from "./user-message-identity";
import { codexRuntimeStatus, projectRuntimeStatus } from "./thread-runtime-status";
import {
  canonicalTurnActivitySnapshot,
  canonicalTurnId,
  canonicalTurnStatusIsActive,
  canonicalTurnStatusIsTerminal,
  canonicalTurnsNewestFirst,
  normalizedCanonicalTurnStatus,
  projectedTurnLifecycleWins,
} from "./turn-activity";
import {
  advanceProjectedThreadStream,
  mergeBoundedThreadDetail,
  createProjectedThreadStreamState,
  projectedThreadBoundedSnapshot,
  projectedThreadRecentPage,
  readProjectedOlderPage,
  projectedThreadStartCursor,
  replayProjectedThreadAfter,
  type ProjectedThreadStreamState,
} from "./thread-stream";
import {
  stageAndroidAttachments,
  sweepOldAndroidAttachments,
} from "./attachments";
import { AndroidRemoteAssetStore } from "./assets";
import { ANDROID_REMOTE_PROJECTLESS_ID } from "./store";
import type {
  AndroidRemoteSettings,
  AndroidRemoteStore,
  AndroidRemoteTaskSelection,
  AndroidRemoteThreadAlias,
} from "./store";
import {
  DesktopSessionStream,
  type AndroidDesktopSessionStream,
} from "./desktop-session-stream";
import {
  AndroidDesktopIpcLiveSync,
  DesktopIpcOwnershipError,
  type DesktopThreadOwnership,
  type DesktopThreadOwnershipState,
  type AndroidDesktopIpcSync,
} from "./desktop-ipc";
import {
  annotateDesktopTaskActivity,
  readBoundedDesktopTaskActivity,
  readDesktopWorkspaceSnapshot,
  type DesktopWorkspaceSnapshot,
} from "./desktop-workspace-state";
import {
  CodexDesktopProjectRegistrar,
  type AndroidDesktopProjectRegistrar,
} from "./desktop-project-registration";
import {
  AndroidRemoteSessionCommandRecovery,
  type AndroidRemoteCommandRecovery,
} from "./session-command-recovery";
import {
  canonicalizeCodexThreadCandidates,
  codexThreadSourcePaths,
  type CodexThreadListCandidate,
} from "./thread-reconciliation";
import { resolveThreadSourcePaths } from "./thread-source-paths";
import {
  DisabledAndroidRemoteCloudflareTunnel,
  normalizeNamedTunnelHostname,
  type AndroidRemoteCloudflareConfiguration,
  type AndroidRemoteCloudflareState,
  type AndroidRemoteCloudflareTunnel,
} from "./cloudflare-tunnel";
import {
  createAndroidRemoteMutationStore,
  type AndroidRemoteMutation,
  type AndroidRemoteMutationOwner,
  type AndroidRemoteMutationStore,
} from "./mutation-store";
import {
  createAndroidRemoteQueuedTurnStore,
  type AndroidRemoteQueuedTurnStore,
  type PersistedAndroidQueuedTurn,
} from "./queued-turn-store";
import { createAndroidDesktopOwnershipStore } from "./desktop-ownership-store";

// Forty MiB of attachments expands to about 53.4 MiB when encoded as base64.
// Leave bounded room for the JSON envelope, filenames, and media-type fields.
const MAX_HTTP_BODY_BYTES = 56 * 1024 * 1024;
const MAX_WS_MESSAGE_BYTES = 2 * 1024 * 1024;
const DISPATCH_DEDUP_TTL_MS = 10 * 60 * 1_000;
const MAX_DISPATCH_DEDUP_ENTRIES = 2_048;
const MAX_PROJECTED_USER_MESSAGE_ALIASES = 4_096;
const MAX_DURABLE_DESKTOP_USER_MESSAGES = 4_096;
const MAX_QUEUED_ANDROID_TURNS = 32;
const ANDROID_ATTACHMENT_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files without additional text. Respond using the conversation context and the attached file(s).]";
const THREAD_LIST_PAGE_SIZE = 100;
const THREAD_LIST_MAX_PAGES = 10;
const THREAD_LIST_QUICK_PAGE_SIZE = 10;
// Codex notifications drive the normal live path. This slower poll is only a
// safety net for changes made by another Codex process (for example Desktop).
// Reading and projecting an entire long task every second made the phone
// repeatedly reconcile the same large snapshot even when nothing changed.
const LIVE_POLL_MS = 5_000;
// Sequence-numbered deltas are small, so publish them on a frame-friendly
// cadence while still coalescing bursts of token notifications.
const LIVE_REFRESH_DEBOUNCE_MS = 80;
const LIVE_REFRESH_RETRY_DELAYS_MS = [250, 750, 1_500, 3_000] as const;
const SERVER_CONFIG_CACHE_MS = 30_000;
const GATEWAY_STOP_DEADLINE_MS = 1_000;
const THREAD_STREAM_CACHE_LIMIT = 6;
const THREAD_STREAM_CACHE_TTL_MS = 10 * 60 * 1_000;
const NATIVE_THREAD_METADATA_CACHE_LIMIT = 4_096;
const MAX_LIVE_NOTIFICATION_ACTIVITY_THREADS = 256;
const MAX_SHELL_ACTIVITY_WATCHES = 32;
// Codex Desktop can take several seconds to remount an idle task after an IPC
// reconnect or application resume. Keep the original request held inside the
// Android transport deadline instead of returning an active-writer error and
// forcing the phone to create a second command.
const DESKTOP_RESPONSE_REATTACH_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 3_500] as const;
// Atomic edits can safely fall back to the private rollback path after Desktop
// repeatedly proves that no follower handles the request. Do not reuse the
// longer writer-remount window here: it would hold an ordinary edit response
// beyond the phone's request budget even though no delivery is ambiguous.
const DESKTOP_ATOMIC_EDIT_REATTACH_DELAYS_MS = [100, 250, 500, 1_000] as const;
const PROJECTED_ACTIVE_FALLBACK_FRESH_MS = 15_000;
const PROJECTED_ACTIVE_RECONCILE_INTERVAL_MS = 15_000;
// Desktop can publish its active shell row a few milliseconds before the
// bounded turn-history entity carrying the canonical id. Retry only that
// narrow active-but-incomplete case; never turn a missing owner into an
// unbounded read or a private-writer fallback.
const DESKTOP_ACTIVE_TURN_PROBE_RETRY_DELAYS_MS = [0, 40, 120] as const;
const DESKTOP_ACTIVE_TURN_PROBE_CACHE_MS = 750;
// Android gives ordinary owner handoffs a longer delivery-aware mutation
// window. Keep steer confirmation below the phone's 45-second mutation
// deadline while allowing a long-running model to flush its session item at
// the next tool/turn boundary.
const STEER_DELIVERY_TIMEOUT_MS = 25_000;
const GIT_CLONE_TIMEOUT_MS = 120_000;
const MAX_GIT_DIAGNOSTIC_BYTES = 4_096;
const ANDROID_IMAGE_EXTENSIONS = new Set(["bmp", "gif", "jpeg", "jpg", "png", "webp"]);
const GATEWAY_START_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;

type JsonRecord = Record<string, unknown>;
type RequestId = string | number;
type SubscriptionKind = "shell" | "thread" | "config";

function normalizedAssistantImagePath(value: string): string | null {
  let target = value.trim().replace(/^<|>$/gu, "");
  if (/^https?:\/\//iu.test(target)) return null;
  if (target.slice(0, 7).toLowerCase() === "file://") target = target.slice(7);
  target = target.replace(/[?#].*$/u, "");
  if (!target || !isAbsolute(target)) return null;
  const normalized = resolve(target);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assistantMarkdownImagePaths(markdown: string): ReadonlySet<string> {
  const paths = new Set<string>();
  const pattern = /(!?)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+["'][^)\n]*["'])?\s*\)/gu;
  for (const match of markdown.matchAll(pattern)) {
    const rawTarget = match[3] ?? match[4] ?? "";
    const explicitImage = match[1] === "!";
    const extension = rawTarget.replace(/[?#].*$/u, "").split(".").at(-1)?.toLowerCase() ?? "";
    if (!explicitImage && !ANDROID_IMAGE_EXTENSIONS.has(extension)) continue;
    const normalized = normalizedAssistantImagePath(rawTarget);
    if (normalized) paths.add(normalized);
  }
  return paths;
}

function userMessageImagePaths(message: string): ReadonlySet<string> {
  const paths = new Set<string>();
  const remember = (value: string): void => {
    const normalized = normalizedAssistantImagePath(value);
    if (normalized) paths.add(normalized);
  };
  for (const match of message.matchAll(/\[Image:\s*([^\n]+?)\]/giu)) {
    remember(match[1] ?? "");
  }
  for (const match of message.matchAll(/<image\b([^>]*)>/giu)) {
    const attributes = match[1] ?? "";
    const path = /\bpath\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/iu.exec(attributes);
    remember(path?.[1] ?? path?.[2] ?? path?.[3] ?? "");
  }
  return paths;
}

type GatewayWsData = {
  clientId: string;
  subscription?: SubscriptionKind;
  requestId?: RequestId;
  threadId?: string;
  resumeAfterSequence?: number;
  fingerprint?: string;
};

type DraftProject = {
  id: string;
  title: string;
  cwd: string;
  createdAt: string;
};

type DraftThread = {
  id: string;
  projectId: string;
  projectTitle: string;
  workspaceKind?: "projectless";
  title: string;
  cwd: string;
  instanceId: string;
  model: string;
  modelOptions?: unknown;
  runtimeMode: AndroidRemoteThreadAlias["runtimeMode"];
  interactionMode: AndroidRemoteThreadAlias["interactionMode"];
  createdAt: string;
};

type DesktopThreadSettings = {
  model: string;
  modelProviderId: string;
  reasoningEffort: string;
  reasoningEffortPresent?: boolean;
  /** Canonical Android wire value (`priority`, `default`, or another advertised tier). */
  serviceTier: string;
  updatedAtMs: number;
};

type PendingNativeRequest = {
  publicRequestId: string;
  nativeRequestId: RequestId;
  method: string;
  nativeThreadId: string;
  remoteThreadId: string;
  turnId: string | null;
  createdAt: string;
  params: JsonRecord;
  activity: JsonRecord;
};

type PendingDesktopUserInput = {
  publicRequestId: string;
  nativeThreadId: string;
  remoteThreadId: string;
  itemId: string;
  callId: string;
  turnId: string | null;
  questions: JsonRecord[];
  activity: JsonRecord;
};

type QueuedAndroidTurn = PersistedAndroidQueuedTurn;

type PendingSteerDelivery = {
  expectedTurnId: string;
  resolve: (delivered: boolean) => void;
};

type DesktopActiveTurnProbe = {
  active: boolean | null;
  turnId: string;
  expiresAt: number;
};

type LiveCodexNotificationSource = "app-server" | "desktop-session" | "desktop-state" | "desktop-stop";

type LiveNotificationActivityItem = {
  label: string;
  order: number;
};

type LiveNotificationActivityState = {
  turnId: string | null;
  fallbackLabel: string;
  activeItems: Map<string, LiveNotificationActivityItem>;
};

export type AndroidRemoteGatewayLifecycleStatus = "stopped" | "starting" | "ready" | "error";

export type AndroidRemoteGatewayStatus = {
  status: AndroidRemoteGatewayLifecycleStatus;
  port: number;
  backgroundServer: "current-process";
  error?: string;
};

interface CodexRuntimeLike {
  start(): Promise<AndroidCodexClient>;
  stop(): Promise<void>;
  status?(): { connected: boolean; error?: string };
}

export type AndroidRemoteGatewayOptions = {
  port?: number;
  hostname?: string;
  networkInterfaces?: typeof networkInterfaces;
  runtime?: CodexRuntimeLike;
  now?: () => number;
  listModels?: () => Promise<readonly ManagementModelRow[]>;
  listModelProviderOrder?: () => readonly string[];
  isModelSourceVisible?: (provider: string) => boolean;
  /** Desktop's direct connection restricts shared tasks to that provider. */
  desktopDirectModelProvider?: () => string | null;
  nativeModelCatalog?: () => ObservedNativeCatalog | null;
  /**
   * Native ChatGPT mode keeps Android Remote available but must not leak
   * routed selectors from an app-server that still has an older model cache.
   */
  routedModelAccessEnabled?: () => boolean;
  listProviderQuotaReports?: () => Promise<readonly unknown[]>;
  desktopSessionStream?: AndroidDesktopSessionStream;
  desktopIpcSync?: AndroidDesktopIpcSync;
  /** Dependency seam for project registration; tests must never launch Desktop. */
  desktopProjectRegistrar?: AndroidDesktopProjectRegistrar;
  /** Dependency seam for reading Desktop's workspace registry in focused tests. */
  desktopWorkspaceReader?: (
    threads: readonly JsonRecord[],
  ) => Promise<DesktopWorkspaceSnapshot>;
  sessionCommandRecovery?: AndroidRemoteCommandRecovery;
  cloudflareTunnel?: AndroidRemoteCloudflareTunnel;
  steerDeliveryTimeoutMs?: number;
  mutationStore?: AndroidRemoteMutationStore;
  queuedTurnStore?: AndroidRemoteQueuedTurnStore;
  /** Optional test seam; production uses a Remodex-owned neutral Chats folder. */
  projectlessWorkspaceRoot?: string;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown, maximum = 4096): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

/**
 * Keep the lifecycle error actionable without echoing credentials or an
 * unbounded exception string through the management API.  Startup failures
 * are otherwise indistinguishable from a transient tunnel failure, which
 * makes `rmx onboard --verbose` misleading.
 */
function startupErrorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if ((typeof current === "object" || typeof current === "function") && current !== null) {
      if (seen.has(current)) break;
      seen.add(current);
    }
    if (current instanceof Error) {
      if (current.message.trim()) parts.push(current.message.trim());
      current = current.cause;
      continue;
    }
    const object = record(current);
    if (object) {
      if (typeof object.message === "string" && object.message.trim()) {
        parts.push(object.message.trim());
      }
      current = object.cause;
      continue;
    }
    const text = String(current).trim();
    if (text) parts.push(text);
    break;
  }
  return parts.filter((part, index) => index === 0 || part !== parts[index - 1]).join(": ");
}

function gatewayStartupError(error: unknown): string {
  const raw = startupErrorText(error);
  const safe = redactSecretString(raw)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
  const prefix = "Could not start the Android Remote gateway";
  // Runtime adapters may already use the public prefix. Strip any repeated
  // wrapper before adding one canonical, actionable message.
  let detail = safe;
  while (new RegExp(`^${prefix}(?::|\\s|$)`, "iu").test(detail)) {
    detail = detail.slice(prefix.length).replace(/^:\s*/u, "").trim();
  }
  return detail ? `${prefix}: ${detail}` : prefix;
}

function desktopConversationIsActive(value: unknown): boolean | null {
  const state = record(value);
  if (!state) return null;
  if (state.androidRemoteHistoryOnly === true) return null;
  const interactions = readDesktopInteractions(state, desktopConversationTurnRows(state));
  if (interactions.compaction?.active || interactions.activeTurnId) return true;
  const runtimeStatus = record(state.threadRuntimeStatus);
  const runtimeType = stringValue(runtimeStatus?.type ?? state.threadRuntimeStatus, 64)
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase();
  if (runtimeType === "idle" || runtimeType === "notloaded" || runtimeType === "inactive") {
    return false;
  }
  const thread = record(state.thread) ?? record(state.conversation);
  const latestTurn = [
    state.latestTurn,
    record(state.session)?.latestTurn,
    thread?.latestTurn,
  ].map(record).find((candidate): candidate is JsonRecord => candidate !== null);
  const latestStatus = latestTurn
    ? latestTurn.status ?? latestTurn.state ?? latestTurn.turnStatus ?? latestTurn.turn_status
    : undefined;
  const latestTerminal = latestTurn ? desktopStateStatusIsTerminal(latestStatus) : false;
  const runningRuntime = normalizedTurnStatus(runtimeStatus?.type ?? state.threadRuntimeStatus);
  const hasExplicitRunningRuntime = runningRuntime.includes("inprogress")
    || runningRuntime.includes("running")
    || runningRuntime.includes("pending")
    || runningRuntime.includes("started")
    || runningRuntime.includes("starting")
    || (
      Array.isArray(runtimeStatus?.activeFlags)
      && runtimeStatus.activeFlags.length > 0
    );
  if (
    latestTerminal
    && !hasExplicitRunningRuntime
    && (!Array.isArray(runtimeStatus?.activeFlags) || runtimeStatus.activeFlags.length === 0)
    && (!Array.isArray(state.requests) || state.requests.length === 0)
  ) {
    return false;
  }
  // A live/latest turn can be published before its id is available. Preserve
  // the running bit so callers do not mistake that narrow publication window
  // for an idle task and start a competing writer.
  if (latestTurn && !latestTerminal) return true;
  if (activeTurnIdFromDesktopState(state)) return true;
  const stateActivity = canonicalTurnActivitySnapshot(desktopConversationTurnRows(state));
  const threadActivity = thread
    ? canonicalTurnActivitySnapshot(desktopConversationTurnRows(thread))
    : null;
  if (stateActivity.active || threadActivity?.active === true) return true;
  if (Array.isArray(state.requests) && state.requests.length > 0) return true;
  if (Array.isArray(runtimeStatus?.activeFlags) && runtimeStatus.activeFlags.length > 0) {
    return true;
  }
  // This private Desktop snapshot can retain active after a turn completes;
  // unlike a public status event, that label alone needs turn evidence.
  if (runtimeType === "running" || runtimeType === "inprogress") return true;
  return false;
}

function normalizedTurnStatus(value: unknown): string {
  return normalizedCanonicalTurnStatus(value);
}

function turnStatusIsActive(value: unknown): boolean {
  return canonicalTurnStatusIsActive(value);
}

function nativeExpectedTurnId(value: unknown): string {
  const turnId = stringValue(value, 128);
  return turnId && !turnId.startsWith("opencodex-pending-") ? turnId : "";
}

function activeTurnIdFromRows(value: unknown, newestFirst = false): string {
  return canonicalTurnActivitySnapshot(value, newestFirst).activeTurnId;
}

function desktopStateStatusIsTerminal(value: unknown): boolean {
  return canonicalTurnStatusIsTerminal(value);
}

/**
 * Extract a canonical running-turn id from the bounded Desktop shell state.
 *
 * Desktop has shipped several state shapes over time. Prefer explicit
 * active/current-turn fields, then the latest active turn, then the bounded
 * turn-history entities. An explicit id is accepted only when a sibling
 * status does not conclusively say that the conversation is idle/terminal.
 */
function activeTurnIdFromDesktopState(value: unknown): string {
  const state = record(value);
  if (!state) return "";
  const interactions = readDesktopInteractions(state, desktopConversationTurnRows(state));
  const compaction = interactions.compaction;
  if (compaction?.active) return compaction.turnId;
  if (interactions.activeTurnId) return interactions.activeTurnId;
  const session = record(state.session);
  const runtime = record(state.runtimeStatus) ?? record(state.runtime);
  const thread = record(state.thread) ?? record(state.conversation);
  const threadSession = record(thread?.session);
  const threadRuntime = record(thread?.threadRuntimeStatus) ?? record(thread?.runtimeStatus);
  const statuses = [
    state.status,
    session?.status,
    runtime?.status,
    runtime?.type,
    state.threadRuntimeStatus,
    threadRuntime?.status,
    threadRuntime?.type,
    threadSession?.status,
  ];
  const hasTerminalStatus = statuses.some(desktopStateStatusIsTerminal);
  const hasRunningStatus = statuses.some(status => {
    const normalized = normalizedTurnStatus(status);
    return normalized.includes("inprogress")
      || normalized.includes("running")
      || normalized.includes("pending")
      || normalized.includes("started")
      || normalized.includes("starting");
  }) || (
    Array.isArray(record(state.threadRuntimeStatus)?.activeFlags)
    && (record(state.threadRuntimeStatus)?.activeFlags as unknown[]).length > 0
  );
  const latestTurn = [
    state.latestTurn,
    session?.latestTurn,
    thread?.latestTurn,
  ].map(record).find((candidate): candidate is JsonRecord => candidate !== null);
  const latestStatus = latestTurn
    ? latestTurn.status ?? latestTurn.state ?? latestTurn.turnStatus ?? latestTurn.turn_status
    : undefined;
  const latestTerminal = latestTurn ? desktopStateStatusIsTerminal(latestStatus) : false;
  if (latestTurn && !latestTerminal) {
    const latestTurnId = nativeExpectedTurnId(
      latestTurn.id ?? latestTurn.turnId ?? latestTurn.turn_id,
    );
    if (latestTurnId) return latestTurnId;
  }

  const stateActivity = canonicalTurnActivitySnapshot(desktopConversationTurnRows(state));
  const threadActivity = thread
    ? canonicalTurnActivitySnapshot(desktopConversationTurnRows(thread))
    : null;
  const canonicalTerminal = latestTerminal
    || (stateActivity.hasTurns && !stateActivity.active)
    || (threadActivity?.hasTurns === true && !threadActivity.active);
  if (stateActivity.activeTurnId && (!canonicalTerminal || hasRunningStatus)) {
    return stateActivity.activeTurnId;
  }
  if (threadActivity?.activeTurnId && (!canonicalTerminal || hasRunningStatus)) {
    return threadActivity.activeTurnId;
  }

  const acceptExplicitId = (candidate: unknown): string => {
    const id = nativeExpectedTurnId(candidate);
    if (
      !id
      || ((hasTerminalStatus || canonicalTerminal) && !hasRunningStatus)
    ) {
      return "";
    }
    return id;
  };

  const turnObjects = [
    state.currentTurn,
    state.current_turn,
    state.activeTurn,
    state.active_turn,
    session?.currentTurn,
    session?.current_turn,
    thread?.currentTurn,
    thread?.current_turn,
  ];
  for (const candidate of turnObjects) {
    const turn = record(candidate);
    if (!turn) continue;
    const status = turn.status ?? turn.state ?? turn.turnStatus ?? turn.turn_status;
    if (desktopStateStatusIsTerminal(status)) continue;
    if (canonicalTerminal && !hasRunningStatus) continue;
    const id = nativeExpectedTurnId(turn.id ?? turn.turnId ?? turn.turn_id);
    if (id) return id;
  }

  const explicitIds = [
    state.activeTurnId,
    state.active_turn_id,
    session?.activeTurnId,
    session?.active_turn_id,
    runtime?.activeTurnId,
    runtime?.active_turn_id,
    record(state.threadRuntimeStatus)?.activeTurnId,
    record(state.threadRuntimeStatus)?.active_turn_id,
    threadRuntime?.activeTurnId,
    threadRuntime?.active_turn_id,
    threadSession?.activeTurnId,
    threadSession?.active_turn_id,
  ];
  for (const candidate of explicitIds) {
    const id = acceptExplicitId(candidate);
    if (id) return id;
  }
  return "";
}

function desktopConversationTurnRows(value: unknown): JsonRecord[] {
  const state = record(value);
  if (!state) return [];
  const turnHistory = record(state.turnHistory) ?? record(state.turn_history);
  const history = record(turnHistory?.history);
  const entities = record(history?.entitiesByKey) ?? record(history?.entities_by_key);
  if (entities) {
    const orderedRows: JsonRecord[] = [];
    const seen = new Set<string>();
    for (const islandValue of Array.isArray(history?.islands) ? history.islands : []) {
      const island = record(islandValue);
      for (const entryValue of Array.isArray(island?.entries) ? island.entries : []) {
        const entry = record(entryValue);
        const key = typeof entryValue === "string"
          ? stringValue(entryValue, 256)
          : stringValue(entry?.key ?? entry?.value, 256);
        const turn = record(entities[key]);
        if (!turn) continue;
        const turnId = canonicalTurnId(turn);
        if (turnId && seen.has(turnId)) continue;
        if (turnId) seen.add(turnId);
        orderedRows.push(turn);
      }
    }
    if (
      orderedRows.length > 0
      && normalizedTurnStatus(turnHistory?.kind) === "canonical"
    ) {
      return orderedRows;
    }
  }
  const directRows = (Array.isArray(state.turns) ? state.turns : []).flatMap(candidate => {
    const turn = record(candidate);
    return turn ? [turn] : [];
  });
  if (directRows.length > 0) return directRows;
  return entities
    ? Object.entries(entities).flatMap(([key, candidate]) => {
        const turn = record(candidate);
        return turn && (
          key.startsWith("turn:")
          || canonicalTurnId(turn)
        ) ? [turn] : [];
      })
    : [];
}

function steerErrorCanHaveStaleTurnId(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /expected active turn|no active turn|not in progress|not running|invalid turn|turn not found|no such turn|not active|does not exist/iu.test(message);
}

function actualTurnIdFromSteerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /expected active turn id\s+[`'"]?[^`'"\s]+[`'"]?\s+but found\s+[`'"]?([^`'"\s]+)/iu.exec(message);
  return nativeExpectedTurnId(match?.[1]);
}

function confirmedSteerTurnId(value: unknown, remainingResultDepth = 4): string {
  const response = record(value);
  if (!response) return "";
  const directTurnId = nativeExpectedTurnId(response.turnId ?? response.turn_id);
  if (directTurnId) return directTurnId;
  const turn = record(response.turn);
  const nestedTurnId = nativeExpectedTurnId(turn?.id ?? turn?.turnId ?? turn?.turn_id);
  if (nestedTurnId) return nestedTurnId;
  if (remainingResultDepth <= 0 || !Object.hasOwn(response, "result")) return "";
  return confirmedSteerTurnId(response.result, remainingResultDepth - 1);
}

function requireCompatibleSteerTransport(value: unknown, expectedTurnId: string): void {
  const confirmedTurnId = confirmedSteerTurnId(value);
  if (confirmedTurnId && confirmedTurnId !== expectedTurnId) {
    throw new Error("Codex confirmed the steering message for a different turn");
  }
}

function steerTransportFailureMayHaveDelivered(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|connection (?:closed|lost|reset)|disconnected|broken pipe|socket (?:closed|hang up)|econnreset/iu.test(message);
}

function normalizedProjectedUserMessageText(value: unknown): string {
  return canonicalUserMessageText(value);
}

const ANDROID_PROVIDER_INSTANCE_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** Remodex provider instance ids are stricter than legacy provider ids (which may contain dots). */
function androidProviderInstanceId(provider: string): string {
  if (ANDROID_PROVIDER_INSTANCE_ID.test(provider)) return provider;
  const stem = provider
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^[^a-zA-Z]+/, "")
    .slice(0, 43) || "provider";
  const suffix = createHash("sha256").update(provider).digest("hex").slice(0, 10);
  return `ocx_${stem}_${suffix}`;
}

function openCodexProviderDisplayName(provider: string): string {
  if (provider === "openai") return "ChatGPT account";
  if (provider === "combo") return "Combinations";
  return modelSourceDisplayName(provider).replace(/\s+\(experimental\)$/iu, "");
}

const REASONING_EFFORT_LABELS: Record<string, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

type ProjectedServiceTier = {
  id: string;
  name: string;
  description?: string;
};

function normalizedServiceTierId(value: unknown): string {
  const id = stringValue(value, 64);
  if (id === "standard") return "default";
  return id === "fast" ? "priority" : id;
}

/** Codex Desktop's persisted picker uses `fast`; app-server/model metadata uses `priority`. */
function desktopServiceTierValue(value: unknown): string | null {
  const normalized = stringValue(value, 64);
  if (!normalized || normalized === "default") return null;
  return normalized === "priority" ? "fast" : normalized;
}

/**
 * Read modern service-tier evidence before its deprecated compatibility form,
 * preferring the provider's canonical row for routed models. A cached Codex
 * template must not add speeds the selected provider explicitly removed.
 * The catalog is presentation-safe metadata; no provider configuration or
 * credentials are copied into the Android payload.
 */
function projectedServiceTiers(
  model: JsonRecord,
  canonical?: ManagementModelRow,
): { tiers: ProjectedServiceTier[]; defaultId: string | null; explicit: boolean } {
  const canonicalRecord = canonical as unknown as JsonRecord | undefined;
  const sources = canonical && (canonical.nativeCatalogCurrent || (canonical.native !== true && canonical.provider !== "openai"))
    ? [canonicalRecord, model]
    : [model, canonicalRecord];
  const explicitArray = (
    candidates: ReadonlyArray<readonly [JsonRecord | undefined, string]>,
  ): unknown[] | undefined => {
    for (const [source, key] of candidates) {
      if (source && Object.hasOwn(source, key) && Array.isArray(source[key])) {
        return source[key] as unknown[];
      }
    }
    return undefined;
  };
  // Modern service-tier metadata is authoritative even when it is an explicit
  // empty array. In particular, never let deprecated `additionalSpeedTiers`
  // resurrect Fast for a model whose provider declared `serviceTiers: []`.
  const source = explicitArray(sources.flatMap(source => [
    [source, "serviceTiers"] as const, [source, "service_tiers"] as const,
  ])) ?? explicitArray(sources.flatMap(source => [
    [source, "additionalSpeedTiers"] as const, [source, "additional_speed_tiers"] as const,
  ]));
  const tiers: ProjectedServiceTier[] = [];
  const seen = new Set<string>();
  if (source) {
    for (const value of source) {
      const row = record(value);
      const rawId = row ? row.id ?? row.value : value;
      const id = normalizedServiceTierId(rawId);
      if (!id || seen.has(id)) continue;
      const rawName = row?.name ?? row?.display_name ?? row?.label;
      const name = stringValue(rawName, 128)
        || (id === "default"
          ? "Standard"
          : id === "priority"
            ? "Fast"
            : id === "ultrafast"
              ? "Ultrafast"
              : id);
      const description = stringValue(row?.description ?? row?.detail, 512);
      seen.add(id);
      tiers.push({ id, name, ...(description ? { description } : {}) });
    }
  }
  const defaultSources = sources.flatMap(source => [
    [source, "defaultServiceTier"] as const, [source, "default_service_tier"] as const,
  ]);
  let rawDefault: unknown;
  for (const [defaultSource, key] of defaultSources) {
    if (!defaultSource || !Object.hasOwn(defaultSource, key)) continue;
    rawDefault = defaultSource[key];
    break;
  }
  const defaultId = normalizedServiceTierId(rawDefault) || null;
  return { tiers, defaultId, explicit: source !== undefined };
}

function codexServiceTierDescriptor(
  model: JsonRecord,
  canonical?: ManagementModelRow,
): JsonRecord | null {
  const { tiers, defaultId: advertisedDefault } = projectedServiceTiers(model, canonical);
  const additionalTiers = tiers.filter((tier) => tier.id !== "default");
  if (additionalTiers.length === 0) return null;
  const hasResponseSpeed = additionalTiers.some(
    (tier) => tier.id === "priority" || tier.id === "ultrafast",
  );
  const defaultId = advertisedDefault && (
    advertisedDefault === "default" || additionalTiers.some((tier) => tier.id === advertisedDefault)
  ) ? advertisedDefault : "default";
  const options: JsonRecord[] = [
    {
      id: "default",
      label: "Standard",
      semantic: "standard",
      ...(defaultId === "default" ? { isDefault: true } : {}),
    },
    ...additionalTiers.map((tier) => ({
      id: tier.id,
      label: tier.id === "priority" ? "Fast" : tier.id === "ultrafast" ? "Ultrafast" : tier.name,
      ...(tier.description ? { description: tier.description } : {}),
      ...(tier.id === "priority" ? { semantic: "fast" } : {}),
      ...(tier.id === "ultrafast" ? { semantic: "ultrafast" } : {}),
      ...(defaultId === tier.id ? { isDefault: true } : {}),
    })),
  ];
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    ...(hasResponseSpeed ? { semantic: "responseSpeed" } : {}),
    options,
    currentValue: defaultId,
  };
}

/**
 * Project the Codex-facing capability ladder into Remodex's option contract. When Codex has
 * loaded the row, its live ladder/default wins so Desktop and Android render the same choices
 * (including compatibility levels such as `ultra`). The canonical Remodex row remains the
 * fallback for a newly added routed model that Codex's in-memory cache has not seen yet.
 */
function codexModelCapabilities(model: JsonRecord, canonical?: ManagementModelRow): JsonRecord | null {
  const reasoningControl = canonical?.reasoningControl;
  const serviceTierDescriptor = codexServiceTierDescriptor(model, canonical);
  if (reasoningControl?.kind === "toggle") {
    const currentValue = reasoningControl.defaultEnabled === undefined
      ? undefined
      : reasoningControl.defaultEnabled ? "high" : "none";
    return {
      reasoningControl,
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "none", label: "Off", ...(currentValue === "none" ? { isDefault: true } : {}) },
            { id: "high", label: "On", ...(currentValue === "high" ? { isDefault: true } : {}) },
          ],
          ...(currentValue ? { currentValue } : {}),
        },
        ...(serviceTierDescriptor ? [serviceTierDescriptor] : []),
      ],
    };
  }
  if (reasoningControl?.kind === "automatic") {
    return {
      reasoningControl,
      statusLabel: "Automatic reasoning",
      ...(serviceTierDescriptor ? { optionDescriptors: [serviceTierDescriptor] } : {}),
    };
  }
  if (reasoningControl?.kind === "unsupported" || reasoningControl?.kind === "unknown") {
    // A cached Desktop row can outlive a provider-catalog refresh. These two canonical states
    // are conclusive for presentation: neither may resurrect an old graded selector.
    return {
      reasoningControl,
      ...(serviceTierDescriptor ? { optionDescriptors: [serviceTierDescriptor] } : {}),
    };
  }
  const liveRows = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.flatMap(value => {
        const row = record(value);
        const effort = stringValue(row?.reasoningEffort, 64);
        return effort ? [{ effort, description: stringValue(row?.description, 512) }] : [];
      })
    : [];
  const liveByEffort = new Map(liveRows.map(row => [row.effort, row]));
  const canonicalEfforts = reasoningControl?.kind === "effort"
    ? reasoningControl.efforts.flatMap(value => stringValue(value, 64) ? [stringValue(value, 64)] : [])
    : Array.isArray(canonical?.reasoningEfforts)
      ? canonical.reasoningEfforts.flatMap(value => stringValue(value, 64) ? [stringValue(value, 64)] : [])
      : null;
  // Remodex is the capability authority. An explicit canonical empty ladder suppresses stale
  // Desktop rows left in an older in-memory model cache; Desktop metadata is only a cold-start
  // fallback when Runtime has not resolved this routed model yet.
  const effortIds = [...new Set(
    canonicalEfforts !== null ? canonicalEfforts : liveRows.map(row => row.effort),
  )];
  const defaultEffort = stringValue(
    reasoningControl?.kind === "effort" ? reasoningControl.defaultEffort : undefined,
    64,
  )
    || stringValue(canonical?.defaultReasoningEffort, 64)
    || stringValue(model.defaultReasoningEffort, 64);
  const efforts = effortIds.map(effort => {
    const description = liveByEffort.get(effort)?.description ?? "";
    return {
      id: effort,
      label: REASONING_EFFORT_LABELS[effort] ?? effort,
      ...(description ? { description } : {}),
      ...(effort === defaultEffort ? { isDefault: true } : {}),
    };
  });
  if (efforts.length === 0) {
    return serviceTierDescriptor ? { optionDescriptors: [serviceTierDescriptor] } : null;
  }
  return {
    ...(reasoningControl ? { reasoningControl } : {}),
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: efforts,
        ...(efforts.some(option => option.id === defaultEffort)
          ? { currentValue: defaultEffort }
          : {}),
      },
      ...(serviceTierDescriptor ? [serviceTierDescriptor] : []),
    ],
  };
}

function rawStringValue(value: unknown, maximum = 64 * 1024): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function desktopHasNoHandler(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no codex ipc client can handle|no-client-found|conversation-not-owned|thread not found|conversation not found|not connected|connection closed/i.test(message);
}

function desktopTurnStartDefinitelyNotDelivered(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no codex ipc client can handle|no-client-found|conversation-not-owned|codex desktop ipc is not connected/i.test(message);
}

function desktopTurnStartFailureClass(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (desktopTurnStartDefinitelyNotDelivered(error)) return "owner-absent";
  if (/timed out/iu.test(message)) return "timeout";
  if (/connection (?:closed|lost|reset)|disconnected|broken pipe|socket (?:closed|hang up)|econnreset/iu.test(message)) {
    return "connection-lost";
  }
  if (codexHasActiveWriter(error)) return "active-writer";
  return "owner-error";
}

function definitiveDesktopNoOwner(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no codex ipc client can handle|no-client-found|conversation-not-owned|no codex desktop owner published/iu.test(message);
}

function optionalDesktopSettingsHandlerUnavailable(error: unknown): boolean {
  if (
    error instanceof DesktopIpcOwnershipError
    && error.reason === "no-client-found"
    && error.method === "thread-follower-update-thread-settings"
  ) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /no codex ipc client can handle|no-client-found|method not found|unknown method|unsupported method|-32601/iu.test(
    message,
  );
}

function desktopOwnershipSafeError(threadId: string, detail = "Desktop IPC delivery failed"): Error {
  return new Error(
    `Codex Desktop owns task ${threadId}; ${detail}. Remodex will not start a competing writer`,
  );
}

function fallbackOwnershipState(sync: AndroidDesktopIpcSync, threadId: string): DesktopThreadOwnership {
  const explicit = sync.threadOwnership?.(threadId);
  if (explicit) return explicit;
  if (sync.isThreadOwned(threadId)) {
    return { state: "local-owned", ownerClientId: null, everDesktopOwned: false };
  }
  return {
    state: "unknown",
    ownerClientId: sync.desktopOwnerClientId?.(threadId) ?? null,
    everDesktopOwned: sync.hasObservedDesktopOwner?.(threadId) ?? false,
  };
}

/**
 * Once Desktop has been observed as the writer, the private app-server is no
 * longer a safe activity oracle.  Its read requests can sit behind Desktop's
 * writer lock until the 30-second request timeout, while Desktop's follower
 * snapshot is the authoritative source for this task.
 */
function desktopOwnershipIsAuthoritative(ownership: DesktopThreadOwnership): boolean {
  return ownership.state === "desktop-owned" || ownership.everDesktopOwned;
}


function codexSettingsUpdateUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /method not found|unknown method|unsupported method|thread\/settings\/update.*(?:unsupported|unavailable)|experimental.*disabled|-32601/iu.test(message);
}

function codexThreadNeedsResume(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread.*(?:not found|not loaded|is closed)|conversation.*(?:not found|not loaded)/iu.test(message);
}

function codexThreadReadIsMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread not found|task was not found|conversation not found|no such thread/iu.test(message);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function projectedRows(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.flatMap(candidate => record(candidate) ? [record(candidate)!] : [])
    : [];
}

function projectedRow(value: unknown, id: string): JsonRecord | null {
  return projectedRows(value).find(candidate => stringValue(candidate.id, 128) === id) ?? null;
}

function cloneLiveNotificationActivityState(
  current: LiveNotificationActivityState | undefined,
  turnId: string | null,
): LiveNotificationActivityState {
  if (current && (!turnId || !current.turnId || current.turnId === turnId)) {
    return {
      turnId: turnId || current.turnId,
      fallbackLabel: current.fallbackLabel,
      activeItems: new Map(current.activeItems),
    };
  }
  return {
    turnId,
    fallbackLabel: "Reasoning",
    activeItems: new Map(),
  };
}

function liveNotificationActivityLabel(
  state: LiveNotificationActivityState | undefined,
): string | null {
  if (!state) return null;
  let latest: LiveNotificationActivityItem | null = null;
  for (const item of state.activeItems.values()) {
    if (!latest || item.order > latest.order) latest = item;
  }
  return latest?.label ?? state.fallbackLabel;
}

function listedThreadHasActiveTurn(thread: JsonRecord): boolean {
  const projectedState = thread.androidRemoteLatestTurnState;
  if (
    projectedTurnLifecycleWins(thread.turns, {
      state: projectedState,
      turnId: thread.androidRemoteLatestTurnId,
      occurredAt: thread.androidRemoteLatestTurnAt,
      lastProgressAt: thread.androidRemoteActivityUnverified === true ? undefined : thread.androidRemoteLatestProgressAt,
      unverified: thread.androidRemoteActivityUnverified === true,
    })
  ) {
    return turnStatusIsActive(projectedState);
  }
  return canonicalTurnActivitySnapshot(thread.turns).active;
}

function userInputQuestions(value: unknown): JsonRecord[] {
  return (Array.isArray(value) ? value : []).flatMap(questionValue => {
    const question = record(questionValue);
    const id = stringValue(question?.id, 128);
    const prompt = stringValue(question?.question, 2048);
    if (!id || !prompt) return [];
    const options = (Array.isArray(question?.options) ? question.options : []).flatMap(optionValue => {
      const option = record(optionValue);
      const label = stringValue(option?.label, 256);
      if (!label) return [];
      return [{
        label,
        description: stringValue(option?.description, 1024) || label,
      }];
    });
    return [{
      id,
      header: stringValue(question?.header, 256) || "Question",
      question: prompt,
      options,
      multiSelect: false,
    }];
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function errorResponse(status: number, message: string, reason?: string): Response {
  return jsonResponse({ message, ...(reason ? { reason } : {}) }, status);
}

async function readBoundedText(req: Request, maximum = MAX_HTTP_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximum) throw new RangeError("request body too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new RangeError("request body too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function readJsonBody(req: Request): Promise<JsonRecord> {
  const text = await readBoundedText(req);
  const parsed = text ? JSON.parse(text) : {};
  const body = record(parsed);
  if (!body) throw new TypeError("request body must be an object");
  return body;
}

function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization")?.trim() ?? "");
  return match?.[1]?.trim() || null;
}

function frameText(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function safeSocketSend(ws: ServerWebSocket<GatewayWsData>, value: unknown): void {
  try { ws.send(JSON.stringify(value)); } catch { /* the close handler owns cleanup */ }
}

function socketResult(ws: ServerWebSocket<GatewayWsData>, id: RequestId, result: unknown): void {
  safeSocketSend(ws, { id, result });
}

function socketError(ws: ServerWebSocket<GatewayWsData>, id: RequestId, message: string): void {
  safeSocketSend(ws, { id, error: { code: -32000, message } });
}

function socketEvent(ws: ServerWebSocket<GatewayWsData>, id: RequestId, event: unknown): void {
  safeSocketSend(ws, { id, event });
}

function platformOs(): "darwin" | "linux" | "windows" | "unknown" {
  if (process.platform === "darwin" || process.platform === "linux") return process.platform;
  return process.platform === "win32" ? "windows" : "unknown";
}

function platformArch(): "arm64" | "x64" | "other" {
  return process.arch === "arm64" || process.arch === "x64" ? process.arch : "other";
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function androidRemoteGatewayUrls(
  port = DEFAULT_GATEWAY_PORT,
  interfaces = networkInterfaces(),
): string[] {
  return [`http://127.0.0.1:${port}`, ...androidRemotePairingUrls(port, interfaces)];
}

function isHostOnlyVirtualInterface(name: string): boolean {
  return /(?:^|[\s(])(?:vethernet|default switch|hyper-v|docker|wsl|vmware|virtualbox|host-only)(?:$|[\s)])/i
    .test(name);
}

/** Only the computer itself (including cloudflared) and private LAN peers. */
export function androidRemotePeerAllowed(address: string | undefined): boolean {
  const normalized = address?.replace(/^::ffff:/i, "") ?? "";
  return normalized === "::1" || normalized === "127.0.0.1"
    || isPrivateLanIpv4(normalized);
}

/** Addresses safe to place in a QR that will be scanned by another device. */
export function androidRemotePairingUrls(
  port = DEFAULT_GATEWAY_PORT,
  interfaces = networkInterfaces(),
): string[] {
  return [...new Set(Object.entries(interfaces).flatMap(([name, addresses]) =>
    isHostOnlyVirtualInterface(name) ? [] : (addresses ?? []).flatMap(address =>
      !address.internal && address.family === "IPv4" && isPrivateLanIpv4(address.address)
        ? [`http://${address.address}:${port}`] : [])))];
}

function runtimeConfig(mode: AndroidRemoteThreadAlias["runtimeMode"]): {
  approvalPolicy: "untrusted" | "on-request" | "never";
  approvalsReviewer: "user" | "auto_review";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  sandboxPolicy: { type: "readOnly" | "workspaceWrite" | "dangerFullAccess" };
} {
  if (mode === "approval-required") {
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      sandboxPolicy: { type: "workspaceWrite" },
    };
  }
  if (mode === "auto-accept-edits") {
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
      sandboxPolicy: { type: "workspaceWrite" },
    };
  }
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
    sandboxPolicy: { type: "dangerFullAccess" },
  };
}

function desktopAgentMode(
  mode: AndroidRemoteThreadAlias["runtimeMode"],
): "auto" | "guardian-approvals" | "full-access" {
  if (mode === "approval-required") return "auto";
  if (mode === "auto-accept-edits") return "guardian-approvals";
  return "full-access";
}

function promptEditReference(command: JsonRecord): {
  targetTurnId: string;
  turnCount: number;
} | null {
  const value = record(command.promptEdit);
  if (!value) return null;
  const targetTurnId = stringValue(value.targetTurnId, 128);
  const turnCount = finiteNumber(value.turnCount);
  if (!targetTurnId) throw new TypeError("edited prompt turn id is required");
  if (turnCount === null || !Number.isInteger(turnCount) || turnCount < 0) {
    throw new TypeError("edited prompt turn count must be a non-negative integer");
  }
  return { targetTurnId, turnCount };
}

function comparableWorkspaceRoot(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function projectRootFilesystemRoot(value: string): string {
  return resolve(parse(value).root);
}

function filesystemBrowsePathInput(
  value: unknown,
  field: "folder path" | "current project folder",
  optional = false,
): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new TypeError(`${field} is required`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (optional) return undefined;
    throw new TypeError(`${field} is required`);
  }
  if (trimmed.length > 512) throw new RangeError(`${field} is too long`);
  if ([...trimmed].some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  })) {
    throw new TypeError(`${field} contains an invalid control character`);
  }
  return trimmed;
}

function isWindowsFilesystemPath(value: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/u.test(value) || value.startsWith("\\\\");
}

function expandFilesystemHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function resolveFilesystemBrowseTarget(partialPath: string, cwd?: string): string {
  if (process.platform !== "win32" && isWindowsFilesystemPath(partialPath)) {
    throw new TypeError("Windows folder paths are available only when Remodex runs on Windows");
  }
  const expandedPath = expandFilesystemHomePath(partialPath);
  if (isAbsolute(expandedPath)) return resolve(expandedPath);
  if (!cwd) throw new TypeError("A current project folder is required for a relative path");
  if (process.platform !== "win32" && isWindowsFilesystemPath(cwd)) {
    throw new TypeError("Windows folder paths are available only when Remodex runs on Windows");
  }
  return resolve(expandFilesystemHomePath(cwd), expandedPath);
}

function sourceControlRemoteUrlInput(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("A Git clone URL is required");
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError("A Git clone URL is required");
  if (trimmed.length > 4096) throw new RangeError("The Git clone URL is too long");
  if ([...trimmed].some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || /\s/u.test(character);
  })) {
    throw new TypeError("The Git clone URL contains an invalid character");
  }
  if (
    !/^(?:https?|ssh|git):\/\/[^\s]+$/iu.test(trimmed)
    && !/^[^@\s/:]+@[^:\s]+:[^\s]+$/u.test(trimmed)
  ) {
    throw new TypeError("Enter an HTTPS or SSH Git clone URL");
  }
  return trimmed;
}

function sourceControlDestinationInput(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("A clone destination is required");
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError("A clone destination is required");
  if (trimmed.length > 4096) throw new RangeError("The clone destination path is too long");
  if ([...trimmed].some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  })) {
    throw new TypeError("The clone destination contains an invalid control character");
  }
  const expanded = expandFilesystemHomePath(trimmed);
  if (process.platform !== "win32" && isWindowsFilesystemPath(expanded)) {
    throw new TypeError("Windows folder paths are available only when Remodex runs on Windows");
  }
  const normalized = resolve(expanded);
  if (comparableWorkspaceRoot(normalized) === comparableWorkspaceRoot(projectRootFilesystemRoot(normalized))) {
    throw new TypeError("The filesystem root cannot be used as a clone destination");
  }
  return normalized;
}

async function readBoundedProcessText(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done || !next.value) break;
      if (total >= maximumBytes) continue;
      const remaining = maximumBytes - total;
      const chunk = next.value.byteLength <= remaining
        ? next.value
        : next.value.slice(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function safeGitDiagnostic(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/(https?:\/\/)[^\s@/]+:[^\s@/]+@/giu, "$1[credentials]@")
    .replace(/(?:https?|ssh|git):\/\/[^\s]+/giu, "[remote URL]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-MAX_GIT_DIAGNOSTIC_BYTES);
}

async function runGitClone(remoteUrl: string, parentPath: string, directoryName: string): Promise<void> {
  const invocation = commandInvocation("git", ["clone", remoteUrl, directoryName]);
  let processHandle: ReturnType<typeof Bun.spawn>;
  try {
    processHandle = Bun.spawn([invocation.file, ...invocation.args], {
      cwd: parentPath,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
      ...(invocation.options.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : {}),
    });
  } catch {
    throw new Error("Git is not installed or could not be started on the desktop");
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { processHandle.kill(); } catch { /* already exited */ }
  }, GIT_CLONE_TIMEOUT_MS);
  const stderr = processHandle.stderr;
  const diagnosticPromise = stderr && typeof stderr !== "number"
    ? readBoundedProcessText(stderr, MAX_GIT_DIAGNOSTIC_BYTES)
    : Promise.resolve("");
  let exitCode: number | null;
  try {
    exitCode = await processHandle.exited;
  } finally {
    clearTimeout(timer);
  }
  const diagnostic = safeGitDiagnostic(await diagnosticPromise);
  if (timedOut) throw new Error("Git clone timed out after two minutes");
  if (exitCode !== 0) {
    throw new Error(diagnostic ? `Git clone failed: ${diagnostic}` : "Git clone failed on the desktop");
  }
}

function projectRootInput(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("project folder is required");
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError("project folder is required");
  if (trimmed.length > 4096) throw new RangeError("project folder path is too long");
  if ([...trimmed].some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  })) {
    throw new TypeError("project folder path contains an invalid control character");
  }
  const expanded = trimmed === "~"
    ? homedir()
    : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? join(homedir(), trimmed.slice(2))
      : trimmed;
  const normalized = resolve(expanded);
  if (comparableWorkspaceRoot(normalized) === comparableWorkspaceRoot(projectRootFilesystemRoot(normalized))) {
    throw new TypeError("The filesystem root cannot be added as a project");
  }
  return normalized;
}

function visibleProjectEntryPath(value: string): boolean {
  const segments = value.split(/[\\/]+/).filter(Boolean);
  return !segments.some(segment =>
    segment === ".git" || segment === ".hg" || segment === ".svn" || segment === "node_modules");
}

function normalizedRuntimeMode(value: unknown): AndroidRemoteThreadAlias["runtimeMode"] {
  return value === "approval-required" || value === "auto-accept-edits" ? value : "full-access";
}

function normalizedInteractionMode(value: unknown): AndroidRemoteThreadAlias["interactionMode"] {
  return value === "plan" ? "plan" : "default";
}

function modelSelection(command: JsonRecord): { instanceId: string; model: string; options?: unknown } {
  const selection = record(command.modelSelection);
  return {
    instanceId: stringValue(selection?.instanceId, 64) || "openai",
    model: stringValue(selection?.model, 256) || "gpt-5.6-sol",
    ...(selection?.options !== undefined ? { options: selection.options } : {}),
  };
}

function optionValue(options: unknown, id: string): string | boolean | null {
  if (Array.isArray(options)) {
    for (const item of options) {
      const row = record(item);
      if (row?.id === id && (typeof row.value === "string" || typeof row.value === "boolean")) {
        return row.value;
      }
    }
    return null;
  }
  const row = record(options);
  const value = row?.[id];
  return typeof value === "string" || typeof value === "boolean" ? value : null;
}

function modelOptionsWithValue(options: unknown, id: string, value: string): unknown {
  if (Array.isArray(options)) {
    let replaced = false;
    const next = options.map(candidate => {
      const row = record(candidate);
      if (stringValue(row?.id, 64) !== id) return candidate;
      replaced = true;
      return { ...row, id, value };
    });
    return replaced ? next : [...next, { id, value }];
  }
  const objectOptions = record(options);
  if (objectOptions) return { ...objectOptions, [id]: value };
  return [{ id, value }];
}

function modelOptionsWithoutValues(options: unknown, ids: ReadonlySet<string>): unknown {
  if (Array.isArray(options)) {
    const next = options.filter(candidate => {
      const row = record(candidate);
      return !ids.has(stringValue(row?.id, 64));
    });
    return next.length > 0 ? next : undefined;
  }
  const objectOptions = record(options);
  if (!objectOptions) return undefined;
  const next = Object.fromEntries(
    Object.entries(objectOptions).filter(([id]) => !ids.has(id)),
  );
  return Object.keys(next).length > 0 ? next : undefined;
}

const REASONING_SELECTION_OPTION_IDS = new Set(["reasoningEffort", "effort"]);
const SERVICE_TIER_SELECTION_OPTION_IDS = new Set(["serviceTier"]);

function serviceTierSelectionEvidence(
  row: ManagementModelRow | undefined,
  liveModel: JsonRecord | undefined,
): { ids: Set<string>; explicit: boolean } {
  const { tiers, explicit } = projectedServiceTiers(liveModel ?? {}, row);
  return {
    ids: new Set(["default", ...tiers.map((tier) => tier.id)]),
    explicit,
  };
}

function modelCapabilityVersion(
  row: ManagementModelRow | undefined,
  liveModel: JsonRecord | undefined,
): string | undefined {
  if (!row && !liveModel) return undefined;
  const metadata = row as unknown as JsonRecord | undefined;
  return `model-v2-${createHash("sha256").update(JSON.stringify({
    provider: row?.provider ?? null,
    model: row?.namespaced ?? (stringValue(liveModel?.model, 256) || null),
    control: row?.reasoningControl ?? null,
    efforts: Array.isArray(row?.reasoningEfforts) ? row.reasoningEfforts : null,
    defaultEffort: row?.defaultReasoningEffort ?? null,
    required: row?.reasoningRequired ?? null,
    summaries: row?.supportsReasoningSummaries ?? null,
    canonicalServiceTiers: metadata?.serviceTiers ?? metadata?.service_tiers
      ?? metadata?.additionalSpeedTiers ?? metadata?.additional_speed_tiers ?? null,
    canonicalDefaultServiceTier: metadata?.defaultServiceTier
      ?? metadata?.default_service_tier ?? null,
    liveServiceTiers: liveModel?.serviceTiers ?? liveModel?.service_tiers
      ?? liveModel?.additionalSpeedTiers ?? liveModel?.additional_speed_tiers ?? null,
    liveDefaultServiceTier: liveModel?.defaultServiceTier
      ?? liveModel?.default_service_tier ?? null,
  })).digest("base64url").slice(0, 24)}`;
}

type TaskModelSelection = {
  instanceId: string;
  model: string;
  options?: unknown;
};

type ValidatedTaskModelSelection = {
  selection: TaskModelSelection;
  effort: string | null;
  serviceTier: string | null;
  capabilityVersion?: string;
  changed: boolean;
};

/**
 * Validate a persisted/UI reasoning choice against the current canonical model row.
 *
 * Unknown and optional models fall back to provider-owned Auto (no wire value). A model that
 * explicitly requires reasoning receives only its verified default or lowest supported rung.
 * No generic `medium` value is ever invented here.
 */
function validateTaskModelReasoning(
  selection: TaskModelSelection,
  row: ManagementModelRow | undefined,
  liveModel?: JsonRecord,
): ValidatedTaskModelSelection {
  const requested = optionValue(selection.options, "reasoningEffort")
    ?? optionValue(selection.options, "effort");
  const requestedEffort = typeof requested === "string" ? requested : null;
  let normalizedOptions = selection.options;
  let requestedServiceTier = optionValue(selection.options, "serviceTier");
  if (typeof requestedServiceTier === "string") {
    requestedServiceTier = normalizedServiceTierId(requestedServiceTier);
    normalizedOptions = modelOptionsWithValue(normalizedOptions, "serviceTier", requestedServiceTier);
  }
  const serviceTierEvidence = serviceTierSelectionEvidence(row, liveModel);
  if (serviceTierEvidence.explicit) {
    const validServiceTier = typeof requestedServiceTier === "string"
      && serviceTierEvidence.ids.has(requestedServiceTier)
      ? requestedServiceTier
      : null;
    normalizedOptions = modelOptionsWithoutValues(
      normalizedOptions,
      SERVICE_TIER_SELECTION_OPTION_IDS,
    );
    if (validServiceTier) {
      normalizedOptions = modelOptionsWithValue(
        normalizedOptions,
        "serviceTier",
        validServiceTier,
      );
    }
  }
  const serviceTier = typeof requestedServiceTier === "string"
    && (!serviceTierEvidence.explicit || serviceTierEvidence.ids.has(requestedServiceTier))
    ? requestedServiceTier
    : null;
  const capabilityVersion = modelCapabilityVersion(row, liveModel);
  // A transiently unavailable catalogue is not evidence that an existing explicit choice became
  // invalid. Live Codex model metadata may still conclusively validate its service tier, while an
  // omitted reasoning choice stays omitted instead of becoming a fabricated `medium` request.
  if (!row) {
    // A live native ladder can still reject an unsupported choice while the
    // management catalog is unavailable. Absence of both sources preserves it.
    let effort = requestedEffort;
    if (Array.isArray(liveModel?.supportedReasoningEfforts)) {
      const supported = liveModel.supportedReasoningEfforts.map(value => stringValue(record(value)?.reasoningEffort, 64));
      effort = requestedEffort && supported.includes(requestedEffort) ? requestedEffort : null;
      normalizedOptions = modelOptionsWithoutValues(normalizedOptions, REASONING_SELECTION_OPTION_IDS);
      if (effort) normalizedOptions = modelOptionsWithValue(normalizedOptions, "reasoningEffort", effort);
    }
    const normalized: TaskModelSelection = {
      instanceId: selection.instanceId,
      model: selection.model,
      ...(normalizedOptions !== undefined ? { options: normalizedOptions } : {}),
    };
    return {
      selection: normalized,
      effort,
      serviceTier,
      ...(capabilityVersion ? { capabilityVersion } : {}),
      changed: JSON.stringify(selection.options ?? null)
        !== JSON.stringify(normalizedOptions ?? null),
    };
  }
  const reasoningControl = row.reasoningControl;
  const declaredEfforts = reasoningControl?.kind === "effort" ? reasoningControl.efforts : row.reasoningEfforts;
  const efforts = Array.isArray(declaredEfforts)
    ? [...new Set(declaredEfforts.flatMap(value => stringValue(value, 64) ? [stringValue(value, 64)] : []))]
    : [];
  const required = reasoningControl?.kind === "effort" ? reasoningControl.required : row.reasoningRequired === true;
  if (reasoningControl?.kind === "toggle") {
    const effort = requestedEffort === "none"
      ? "none"
      : requestedEffort
        ? "high"
        : null;
    let options = modelOptionsWithoutValues(normalizedOptions, REASONING_SELECTION_OPTION_IDS);
    if (effort) options = modelOptionsWithValue(options, "reasoningEffort", effort);
    const normalized: TaskModelSelection = {
      instanceId: selection.instanceId,
      model: selection.model,
      ...(options !== undefined ? { options } : {}),
    };
    return {
      selection: normalized,
      effort,
      serviceTier,
      ...(capabilityVersion ? { capabilityVersion } : {}),
      changed: JSON.stringify(selection.options ?? null) !== JSON.stringify(options ?? null),
    };
  }
  if (reasoningControl?.kind === "automatic"
    || reasoningControl?.kind === "unsupported"
    || reasoningControl?.kind === "unknown") {
    const options = modelOptionsWithoutValues(normalizedOptions, REASONING_SELECTION_OPTION_IDS);
    const normalized: TaskModelSelection = {
      instanceId: selection.instanceId,
      model: selection.model,
      ...(options !== undefined ? { options } : {}),
    };
    return {
      selection: normalized,
      effort: null,
      serviceTier,
      ...(capabilityVersion ? { capabilityVersion } : {}),
      changed: JSON.stringify(selection.options ?? null) !== JSON.stringify(options ?? null),
    };
  }
  const configuredDefault = stringValue(
    reasoningControl?.kind === "effort" ? reasoningControl.defaultEffort : row.defaultReasoningEffort, 64,
  );
  const requiredDefault = configuredDefault && efforts.includes(configuredDefault)
    ? configuredDefault
    : efforts.find(effort => effort !== "none") ?? null;
  const effort = requestedEffort
    && efforts.includes(requestedEffort)
    && (!required || requestedEffort !== "none")
    ? requestedEffort
    : required
      ? requiredDefault
      : null;

  let options = modelOptionsWithoutValues(normalizedOptions, REASONING_SELECTION_OPTION_IDS);
  if (effort) options = modelOptionsWithValue(options, "reasoningEffort", effort);
  const normalized: TaskModelSelection = {
    instanceId: selection.instanceId,
    model: selection.model,
    ...(options !== undefined ? { options } : {}),
  };
  return {
    selection: normalized,
    effort,
    serviceTier,
    ...(capabilityVersion ? { capabilityVersion } : {}),
    changed: JSON.stringify(selection.options ?? null) !== JSON.stringify(options ?? null),
  };
}

function draftAsCodexThread(thread: DraftThread): JsonRecord {
  const seconds = Date.parse(thread.createdAt) / 1000;
  return {
    id: thread.id,
    sessionId: thread.id,
    preview: thread.title,
    modelProvider: "openai",
    createdAt: Number.isFinite(seconds) ? seconds : Date.now() / 1000,
    updatedAt: Number.isFinite(seconds) ? seconds : Date.now() / 1000,
    status: { type: "idle" },
    cwd: thread.cwd,
    name: thread.title,
    turns: [],
    androidRemoteProjectId: thread.projectId,
    androidRemoteProjectTitle: thread.projectTitle,
    ...(thread.workspaceKind ? { androidRemoteWorkspaceKind: thread.workspaceKind } : {}),
    androidRemoteTitle: thread.title,
    androidRemoteProviderInstanceId: thread.instanceId,
    androidRemoteModel: thread.model,
    androidRemoteModelOptions: thread.modelOptions,
    androidRemoteRuntimeMode: thread.runtimeMode,
    androidRemoteInteractionMode: thread.interactionMode,
  };
}

function fingerprints(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

type DurableMutationDescriptor = {
  mutationId: string;
  commandId: string;
  taskId: string;
  messageId?: string;
  kind: AndroidRemoteMutation["kind"];
  payloadFingerprint: string;
  visibleMessageFingerprint?: string;
  targetTurnId?: string;
};

function durableMutationDescriptor(command: JsonRecord): DurableMutationDescriptor | null {
  const type = stringValue(command.type, 128);
  const commandId = stringValue(command.commandId, 256);
  const taskId = stringValue(command.threadId, 256);
  if (!commandId || !taskId) return null;
  if (type === "thread.turn.start") {
    const message = record(command.message);
    const messageId = stringValue(message?.messageId, 256);
    const promptEdit = promptEditReference(command);
    const visibleText = canonicalUserMessageText(message?.text);
    return {
      mutationId: `command:${commandId}`,
      commandId,
      taskId,
      ...(messageId ? { messageId } : {}),
      kind: promptEdit ? "prompt-edit" : "turn-start",
      payloadFingerprint: fingerprints(command),
      ...(visibleText ? { visibleMessageFingerprint: fingerprints(visibleText) } : {}),
      ...(promptEdit ? { targetTurnId: promptEdit.targetTurnId } : {}),
    };
  }
  if (type === "thread.turn.queue.steer") {
    const messageId = stringValue(command.messageId, 256);
    return {
      mutationId: `command:${commandId}`,
      commandId,
      taskId,
      ...(messageId ? { messageId } : {}),
      kind: "queue-steer",
      payloadFingerprint: fingerprints(command),
    };
  }
  return null;
}

function mutationThreadId(command: JsonRecord): string | null {
  const type = stringValue(command.type, 128);
  if (
    type === "thread.turn.start"
    || type === "thread.turn.queue.steer"
    || type === "thread.turn.interrupt"
    || type === "thread.session.stop"
    || type === "thread.checkpoint.revert"
    || type === "thread.archive"
    || type === "thread.unarchive"
    || type === "thread.delete"
    || type === "thread.meta.update"
    || type === "thread.runtime-mode.set"
    || type === "thread.interaction-mode.set"
    || type === "thread.approval.respond"
    || type === "thread.user-input.respond"
    || type === "thread.mcp-elicitation.respond"
  ) {
    const threadId = stringValue(command.threadId, 256);
    return threadId || null;
  }
  return null;
}

function mutationFailureDefinitelyNotDelivered(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    desktopTurnStartDefinitelyNotDelivered(error)
    || codexHasActiveWriter(error)
    || /no running turn to steer|prompt exceeds|cannot be empty|not supported|is required|is not valid|no prompt to edit|no longer present|not found/iu.test(
      message,
    )
  );
}

const UNCERTAIN_MUTATION_MESSAGE =
  "The command delivery status is uncertain. Refresh this task; Remodex will reconcile it without replaying the message.";

function normalizedRecordType(value: unknown): string {
  return stringValue(value, 64).replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function userMessageTextFromRecord(value: JsonRecord): string {
  const direct = rawStringValue(value.text);
  if (direct) return canonicalUserMessageText(direct);
  const content = Array.isArray(value.content) ? value.content : [];
  return canonicalUserMessageText(
    content.flatMap(partValue => {
      const part = record(partValue);
      const text = rawStringValue(part?.text ?? part?.value);
      return text ? [text] : [];
    }).join("\n"),
  );
}

function mutationEvidence(value: unknown, mutation: AndroidRemoteMutation): {
  exactMessageId: boolean;
  matchingVisibleMessage: boolean;
  targetTurnPresent: boolean;
} {
  let exactMessageId = false;
  let matchingVisibleMessage = false;
  let targetTurnPresent = false;
  let visited = 0;
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (
      exactMessageId
      && (mutation.kind !== "prompt-edit" || (matchingVisibleMessage && targetTurnPresent))
    ) {
      return;
    }
    if (
      candidate === null
      || typeof candidate !== "object"
      || depth > 24
      || visited >= 100_000
      || seen.has(candidate)
    ) {
      return;
    }
    seen.add(candidate);
    visited += 1;
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child, depth + 1);
      return;
    }
    const row = candidate as JsonRecord;
    const rowId = stringValue(row.id ?? row.turnId ?? row.turn_id, 256);
    if (mutation.targetTurnId && rowId === mutation.targetTurnId) {
      targetTurnPresent = true;
    }
    const type = normalizedRecordType(row.type);
    const role = normalizedRecordType(row.role);
    const isUserMessage =
      type === "usermessage"
      || type === "inputmessage"
      || (type === "message" && role === "user");
    if (isUserMessage) {
      const identity = stringValue(
        row.clientId
        ?? row.client_id
        ?? row.clientUserMessageId
        ?? row.client_user_message_id
        ?? row.messageId
        ?? row.message_id
        ?? row.id,
        256,
      );
      if (mutation.messageId && identity === mutation.messageId) {
        exactMessageId = true;
      }
      const visibleText = userMessageTextFromRecord(row);
      if (
        visibleText
        && mutation.visibleMessageFingerprint
        && fingerprints(visibleText) === mutation.visibleMessageFingerprint
      ) {
        matchingVisibleMessage = true;
      }
    }
    const params = record(row.params);
    const turnIdentity = stringValue(
      params?.clientUserMessageId ?? params?.client_user_message_id,
      256,
    );
    if (
      mutation.messageId
      && turnIdentity === mutation.messageId
      && (Array.isArray(row.items) || row.status !== undefined)
    ) {
      exactMessageId = true;
    }
    for (const child of Object.values(row)) visit(child, depth + 1);
  };
  visit(value, 0);
  return { exactMessageId, matchingVisibleMessage, targetTurnPresent };
}

function projectedReasoningSignature(activity: JsonRecord): string | null {
  if (stringValue(activity.kind, 128) !== "task.progress") return null;
  const payload = record(activity.payload) ?? {};
  return JSON.stringify({
    turnId: stringValue(activity.turnId, 128) || null,
    summary: stringValue(activity.summary, 240),
    summaryParts: Array.isArray(payload.summaryParts)
      ? payload.summaryParts.flatMap(value => typeof value === "string" ? [value] : [])
      : [],
    summaryAvailable: payload.summaryAvailable === true,
  });
}

/**
 * Ignore delivery-only fields when deciding whether a subscription changed.
 *
 * `snapshotSequence` is minted for each read, and shell `updatedAt` describes
 * the read itself rather than a task mutation. Including either field made an
 * unchanged shell and an unchanged multi-megabyte task look new on every poll.
 */
export function androidRemoteSubscriptionFingerprint(value: unknown): string {
  const event = record(value);
  const snapshot = event?.kind === "snapshot" ? record(event.snapshot) : null;
  if (!event || !snapshot) return fingerprints(value);
  const stableSnapshot: JsonRecord = { ...snapshot };
  delete stableSnapshot.snapshotSequence;
  delete stableSnapshot.updatedAt;
  return fingerprints({ ...event, snapshot: stableSnapshot });
}

export class AndroidRemoteGatewayController {
  readonly auth: AndroidRemoteAuth;
  private readonly runtime: CodexRuntimeLike;
  private readonly now: () => number;
  private readonly listModels: (() => Promise<readonly ManagementModelRow[]>) | undefined;
  private readonly listModelProviderOrder: (() => readonly string[]) | undefined;
  private readonly isModelSourceVisible: (provider: string) => boolean;
  private readonly desktopDirectModelProvider: () => string | null;
  private catalogDesktopProvider: string | null | undefined;
  private readonly nativeModelCatalog: () => ObservedNativeCatalog | null;
  private nativeCatalogVersion: string | undefined;
  private readonly routedModelAccessEnabled: () => boolean;
  private readonly listProviderQuotaReports: (() => Promise<readonly unknown[]>) | undefined;
  private readonly configuredPort: number;
  private readonly bindHostname: string | undefined;
  private readonly readNetworkInterfaces: typeof networkInterfaces;
  private listeningOnLocalNetwork = false;
  private localAddressTimer: ReturnType<typeof setInterval> | null = null;
  private readonly projectlessWorkspaceRoot: string;
  private readonly cloudflareTunnel: AndroidRemoteCloudflareTunnel;
  private readonly desktopInstanceId: string;
  private readonly environmentId: string;
  private gatewayStatus: AndroidRemoteGatewayLifecycleStatus = "stopped";
  private statusError: string | undefined;
  private boundPort: number;
  private server: Server<GatewayWsData> | null = null;
  private codex: AndroidCodexClient | null = null;
  private unsubscribeCodex: (() => void) | null = null;
  /** All callers must await one physical gateway startup. */
  private startFlight: Promise<void> | null = null;
  private transition: Promise<void> = Promise.resolve();
  private readonly sockets = new Set<ServerWebSocket<GatewayWsData>>();
  private readonly socketsByClient = new Map<string, Set<ServerWebSocket<GatewayWsData>>>();
  private readonly projects = new Map<string, DraftProject>();
  private readonly drafts = new Map<string, DraftThread>();
  private readonly preferences = new Map<string, Partial<DraftThread>>();
  private readonly knownWorkspaceRoots = new Map<string, string>();
  private readonly pendingRequests = new Map<string, PendingNativeRequest>();
  private readonly pendingDesktopUserInputs = new Map<string, PendingDesktopUserInput>();
  /** Ordered ChatGPT-style follow-ups per task, retained across phone reconnects. */
  private readonly queuedTurns = new Map<string, QueuedAndroidTurn[]>();
  private readonly queuedTurnStarts = new Set<string>();
  private readonly queuedTurnStartFlights = new Map<string, Promise<void>>();
  private readonly writerRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly writerRecoveryAttempts = new Map<string, number>();
  private writerRecoveryStopped = true;
  /**
   * A completion can be observed through both Codex's app-server stream and
   * Desktop's append-only session stream. Remember the exact turn ids that
   * already advanced a queue so a replay cannot start two queued prompts.
   */
  private readonly queuedTurnCompletionKeys = new Set<string>();
  private readonly queuedSteerFlights = new Map<string, Promise<void>>();
  private readonly pendingSteerDeliveries = new Map<string, Set<PendingSteerDelivery>>();
  /**
   * Last turn id accepted for a task.  Desktop can temporarily withhold its
   * follower snapshot while its renderer reconnects; retaining the id from
   * the start acknowledgement lets a steer use that known live turn without
   * falling back to a private `thread/read` (which can block behind Desktop's
   * writer).
   */
  private readonly knownActiveTurnIds = new Map<string, string>();
  private readonly steerDeliveryTimeoutMs: number;
  /**
   * A Desktop session-file question can outlive the Desktop process that owned
   * its JSON-RPC request. Remember an injected answer until its continuation
   * turn starts so a phone retry never appends the same tool output twice.
   */
  private readonly injectedDesktopUserInputCallIds = new Set<string>();
  // Activities that Codex notifies live but does not retain as ThreadItems
  // (for example plan progress and resolved phone interactions) are kept here
  // so the next safety read does not make them disappear from Android.
  private readonly supplementalActivities = new Map<string, JsonRecord[]>();
  private readonly supplementalPlans = new Map<string, JsonRecord[]>();
  private readonly completedLiveMessageIds = new Map<string, Set<string>>();
  private readonly threadStreams = new Map<string, ProjectedThreadStreamState>();
  private readonly oversizedHistoryThreads = new Set<string>();
  private readonly desktopThreadSettings = new Map<string, DesktopThreadSettings>();
  private readonly nativeThreadModelProviders = new Map<string, string>();
  /**
   * Desktop session files are an excellent low-latency append stream, but an
   * edit/rollback rewrites the authoritative turn list instead of appending a
   * compensating record. Re-read only at these explicit boundaries so Android
   * can receive a replacement snapshot without rebuilding the task on every
   * token or safety poll.
   */
  private readonly authoritativeThreadRefreshes = new Set<string>();
  private readonly windowsHistoryBackfills = new Set<string>();
  private readonly windowsHistoryBackfillFlights = new Map<string, Promise<void>>();
  private readonly threadSourcePaths = new Map<string, string[]>();
  private readonly nativeThreadMetadata = new Map<string, JsonRecord>();
  private readonly missingNativeThreadIds = new Set<string>();
  private readonly desktopSessions: AndroidDesktopSessionStream;
  private readonly desktopIpc: AndroidDesktopIpcSync;
  private readonly desktopProjectRegistrar: AndroidDesktopProjectRegistrar;
  private readonly desktopWorkspaceReader: (
    threads: readonly JsonRecord[],
  ) => Promise<DesktopWorkspaceSnapshot>;
  private readonly sessionCommandRecovery: AndroidRemoteCommandRecovery;
  private readonly desktopSessionStarts = new Map<string, Promise<boolean>>();
  private readonly desktopSessionStartPaths = new Map<string, string>();
  private readonly desktopSessionSourcePaths = new Map<string, string>();
  private readonly desktopSessionInstallations = new Set<string>();
  /** Active Desktop rollouts followed only so shell notifications stay live. */
  private readonly shellActivityWatchIds = new Set<string>();
  /**
   * Fixed labels derived from the same item projection sent to Android chat.
   * No command text, paths, arguments, prompts, or tool output are retained.
   */
  private readonly liveNotificationActivities = new Map<string, LiveNotificationActivityState>();
  private liveNotificationActivityOrder = 0;
  /** Prevent delayed retries or double taps from starting a second turn. */
  private readonly recentDispatches = new Map<string, { result: { sequence: number }; expiresAt: number }>();
  private readonly inFlightDispatches = new Map<string, Promise<{ sequence: number }>>();
  /**
   * Mutations are serialized per logical task. This is deliberately separate
   * from transcript refreshes: reads may run concurrently, but two sends,
   * edits, or steer conversions for one task must never race owner selection.
   */
  private readonly threadMutationFlights = new Map<string, Promise<void>>();
  private readonly mutationStore: AndroidRemoteMutationStore;
  private readonly queuedTurnStore: AndroidRemoteQueuedTurnStore;
  /**
   * Codex can report one submitted prompt twice: first from app-server with
   * the phone's clientId, then from the Desktop session file with only the
   * native item id. Remember that exact native item -> visible id mapping so
   * both reports update one Android row.
   */
  private readonly projectedUserMessageIds = new Map<string, string>();
  /**
   * A Desktop session item is durable, but a private app-server thread/read
   * that started before the append can still finish afterwards. Retain the
   * exact client-id-addressed user row until an authoritative read absorbs it
   * so that stale refresh cannot erase one steer (or collapse two equal-text
   * steers) from the Android projection.
   */
  private readonly durableDesktopUserMessages = new Map<string, JsonRecord>();
  private readonly latestThreadTokenUsage = new Map<string, JsonRecord>();
  private readonly desktopThreadActivityCache = new Map<string, {
    active: boolean | null;
    expiresAt: number;
  }>();
  private readonly desktopThreadActivityReads = new Map<string, Promise<boolean | null>>();
  private readonly desktopInteractions = new Map<string, DesktopInteractions>();
  private readonly liveCompactionSources = new Map<string, LiveCodexNotificationSource>();
  private readonly desktopInteractionReads = new Map<string, Promise<void>>();
  private readonly desktopInteractionReadAt = new Map<string, number>();
  private readonly desktopInteractionObservedAt = new Map<string, number>();
  private readonly answeredDesktopQuestions = new Set<string>();
  private readonly completedDesktopTurns = new Map<string, string>();
  /**
   * One bounded Desktop probe supplies both the activity bit and the exact
   * turn id used by steer. This prevents `threadHasActiveTurn()` and
   * `activeTurnId()` from observing adjacent, differently shaped snapshots.
   */
  private readonly desktopActiveTurnProbes = new Map<string, DesktopActiveTurnProbe>();
  private readonly desktopActiveTurnProbeReads = new Map<
    string,
    Promise<DesktopActiveTurnProbe>
  >();
  private readonly projectedActivityReconciledAt = new Map<string, number>();
  private readonly assets: AndroidRemoteAssetStore;
  private shellCache: JsonRecord | null = null;
  private shellUpdatedAt = 0;
  private shellReadPending: Promise<JsonRecord> | null = null;
  private quickShellReadPending: Promise<JsonRecord> | null = null;
  private shellRefreshFailures = 0;
  // Sidebar lifecycle survives transcript eviction and never retains messages.
  private shellLifecycles = new Map<string, JsonRecord>();
  private updateActivityRevision = 0;
  readonly refreshUpdateActivity = createTaskActivityReader({
    list: cursor => this.listUpdateTasks(cursor),
    probe: async (id, row) => {
      if (row.updateLoadedLocally === true) {
        const result = record(await this.requireCodex().request("thread/read", { threadId: id, includeTurns: false }, 2000));
        const nativeStatus = record(record(result?.thread)?.status)?.type ?? record(result?.thread)?.status;
        if (nativeStatus === "active" || nativeStatus === "running" || nativeStatus === "inProgress") return true;
        if (nativeStatus !== "idle" && nativeStatus !== "notLoaded") return null;
        row = { ...row, status: nativeStatus };
      }
      const status = record(row.status)?.type ?? row.status;
      const owned = await this.desktopIpc.hasLiveThreadOwner?.(id);
      if (owned === null) return null;
      if (owned === false) return status === "idle" || status === "notLoaded" ? false : null;
      const active = await this.isDesktopThreadActive(id, { fresh: true, refreshOwner: true });
      if (active !== null || owned !== true) return active;
      // Some Windows renderers advertise ownership but lack the bounded state
      // handler. Read only that live owner's final 1 MiB, never all history.
      const path = await readUpdateTaskPath(getCodexHome(), id);
      if (!path) return null;
      const paths = await resolveThreadSourcePaths(id, [path], { now: this.now, discover: true });
      if (paths.length === 0 || paths.length > 4) return null;
      const activities = await Promise.all(paths.map(path => readBoundedDesktopTaskActivity(path)));
      if (activities.some(activity => activity === null)) return null;
      const latest = activities.filter(activity => activity !== null)
        .sort((a, b) => Date.parse(a.lastProgressAt ?? a.occurredAt) - Date.parse(b.lastProgressAt ?? b.occurredAt)).at(-1);
      if (!latest) return null;
      if (latest.state !== "running") return false;
      // A live owner plus a fresh start/progress marker confirms real work.
      // An old abandoned start is still uncertain, never permission to restart.
      const progressAt = Date.parse(latest.lastProgressAt ?? latest.occurredAt);
      return Number.isFinite(progressAt) && this.now() - progressAt < 30_000 ? true : null;
    },
    trackedIds: () => this.knownActiveTurnIds.keys(),
    revision: () => this.updateActivityRevision,
  });
  private async listUpdateTasks(cursor: string | null): Promise<unknown> {
    const ids = cursor === null ? await readUpdateTaskIds(getCodexHome()) : null;
    if (ids !== null) {
      // This in-memory endpoint stays responsive when history-backed thread/list
      // is blocked. Absence here only proves absence from our private runtime;
      // Desktop ownership is verified separately for every task.
      const response = record(await this.requireCodex().request("thread/loaded/list", {}, 2000));
      if (!Array.isArray(response?.data) || response.data.some(id => typeof id !== "string" || !id || id.length > 128)) {
        throw new Error("Loaded task status is unavailable");
      }
      const loaded = new Set<string>(response.data);
      return { data: [...new Set([...ids, ...loaded, ...this.knownActiveTurnIds.keys()])].map(id => ({
        id, status: loaded.has(id) ? "unknown" : "notLoaded", updateLoadedLocally: loaded.has(id),
      })), nextCursor: null };
    }
    return this.requireCodex().request("thread/list", {
      limit: 100, cursor, archived: false, modelProviders: [], sortKey: "recency_at", sortDirection: "desc",
    }, 5000);
  }
  private readonly desktopUpdateRoutes = createDesktopUpdateRoutes();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private shellRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private shellRefreshRunning = false;
  private shellRefreshPending = false;
  private refreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshRetryAttempt = 0;
  private refreshRunning = false;
  private refreshPending = false;
  private sequence = 0;
  private configCache: { expiresAt: number; value: JsonRecord } | null = null;
  private providerQuotaReports: readonly unknown[] = [];
  private managementModelRows: readonly ManagementModelRow[] = [];
  /** Latest bounded Codex model rows used to validate live service-tier choices. */
  private readonly liveCodexModelRows = new Map<string, JsonRecord>();
  private readonly desktopProjectFallbackTimestamp: string;
  private providerQuotaRefresh: Promise<void> | null = null;
  private providerQuotaRefreshAfter = 0;
  private nativeAccountQuota: JsonRecord | null = null;
  private nativeAccountQuotaRefresh: Promise<void> | null = null;
  private nativeAccountQuotaRefreshAfter = 0;
  private nativeAccountQuotaGeneration = 0;
  private mobileConnectionRevision = 0;
  private mobileConnectionUpdatedAt: string;

  constructor(
    readonly store: AndroidRemoteStore,
    options: AndroidRemoteGatewayOptions = {},
  ) {
    this.auth = new AndroidRemoteAuth(store, options.now);
    this.runtime = options.runtime ?? new AndroidCodexRuntime();
    this.now = options.now ?? Date.now;
    this.desktopProjectFallbackTimestamp = new Date(this.now()).toISOString();
    this.mutationStore = options.mutationStore
      ?? createAndroidRemoteMutationStore(store.stateRoot, this.now);
    this.queuedTurnStore = options.queuedTurnStore
      ?? createAndroidRemoteQueuedTurnStore(store.stateRoot);
    this.restoreQueuedTurns();
    this.assets = new AndroidRemoteAssetStore(this.now);
    this.listModels = options.listModels;
    this.listModelProviderOrder = options.listModelProviderOrder;
    this.isModelSourceVisible = options.isModelSourceVisible ?? (() => true);
    this.desktopDirectModelProvider = options.desktopDirectModelProvider ?? readDesktopDirectModelProvider;
    this.nativeModelCatalog = options.nativeModelCatalog ?? readObservedNativeCatalog;
    this.routedModelAccessEnabled = options.routedModelAccessEnabled ?? (() => true);
    this.listProviderQuotaReports = options.listProviderQuotaReports;
    this.steerDeliveryTimeoutMs = Math.max(
      50,
      Math.floor(options.steerDeliveryTimeoutMs ?? STEER_DELIVERY_TIMEOUT_MS),
    );
    this.configuredPort = options.port ?? DEFAULT_GATEWAY_PORT;
    this.boundPort = this.configuredPort;
    this.bindHostname = options.hostname;
    this.readNetworkInterfaces = options.networkInterfaces ?? networkInterfaces;
    this.cloudflareTunnel = options.cloudflareTunnel ?? new DisabledAndroidRemoteCloudflareTunnel();
    this.desktopInstanceId = randomUUID();
    const root = getConfigDir();
    this.projectlessWorkspaceRoot = resolve(
      options.projectlessWorkspaceRoot?.trim() || join(store.stateRoot ?? root, "android-remote-chats"),
    );
    this.environmentId = `opencodex-${createHash("sha256").update(`${readHostname()}\0${root}`).digest("hex").slice(0, 24)}`;
    this.mobileConnectionUpdatedAt = new Date(this.now()).toISOString();
    this.cloudflareTunnel.subscribe(() => {
      this.publishMobileConnectionChange();
    });
    this.desktopSessions = options.desktopSessionStream ?? new DesktopSessionStream();
    this.desktopProjectRegistrar = options.desktopProjectRegistrar ?? new CodexDesktopProjectRegistrar();
    this.desktopWorkspaceReader = options.desktopWorkspaceReader
      ?? (threads => readDesktopWorkspaceSnapshot(threads));
    this.sessionCommandRecovery = options.sessionCommandRecovery
      ?? new AndroidRemoteSessionCommandRecovery({ now: this.now });
    this.desktopIpc = options.desktopIpcSync ?? new AndroidDesktopIpcLiveSync({
      readThread: async threadId => {
        const result = record(await this.requireCodex().request("thread/read", {
          threadId,
          includeTurns: true,
        }));
        return record(result?.thread) ?? result;
      },
      readThreadPage: async threadId => {
        let metadata: JsonRecord | null = null;
        try {
          const result = record(await this.requireCodex().request("thread/read", {
            threadId,
            includeTurns: false,
          }));
          metadata = record(result?.thread) ?? result;
        } catch {
          // A concurrent Desktop writer may temporarily reject metadata reads;
          // the paged turns request below can still provide a safe tail.
        }
        const metadataOnly: JsonRecord = {};
        if (metadata) {
          let copiedKeys = 0;
          for (const key in metadata) {
            if (!Object.prototype.hasOwnProperty.call(metadata, key) || key === "turns") continue;
            copiedKeys += 1;
            if (copiedKeys > 128) break;
            metadataOnly[key] = metadata[key];
          }
        }
        try {
          const result = record(await this.requireCodex().request("thread/turns/list", {
            threadId,
            limit: 10,
            sortDirection: "desc",
          }));
          const rows = Array.isArray(result?.data)
            ? result.data
            : Array.isArray(result?.items)
              ? result.items
              : Array.isArray(result?.turns)
                ? result.turns
                : null;
          if (rows !== null) {
            // `thread/turns/list` is the compatibility-safe path: retain only
            // the bounded newest rows even if a server ignored
            // includeTurns:false on the metadata request.
            const turns = rows.filter(value => record(value)).slice(0, 10).reverse();
            return {
              ...metadataOnly,
              id: stringValue(metadata?.id) || threadId,
              turns,
              historyPage: {
                hasOlder: Boolean(stringValue(result?.nextCursor)),
                olderCursorAvailable: Boolean(stringValue(result?.nextCursor)),
              },
            };
          }
        } catch {
          // Fall back to the legacy full read only when this app-server does
          // not implement turns/list. The IPC page builder still bounds the
          // resulting Desktop frame before publication.
        }
        if (metadata) {
          // Last-resort compatibility fallback. Keep the metadata shell and a
          // shallow recent tail; the IPC page builder applies field-level
          // handles before anything is sent across Desktop IPC.
          const rawTurns = Array.isArray(metadata.turns) ? metadata.turns : [];
          return {
            ...metadataOnly,
            id: stringValue(metadata.id) || threadId,
            turns: rawTurns.slice(-10),
            historyPage: { hasOlder: rawTurns.length > 10 },
          };
        }
        return null;
      },
      sendCodexRequest: (method, params) => this.requireCodex().request(method, params),
      respondToCodexRequest: (id, result) => this.requireCodex().respond(id, result),
      ownershipStore: createAndroidDesktopOwnershipStore(store.stateRoot),
      log: message => {
        if (process.env.OPENCODEX_ANDROID_IPC_DEBUG === "1") console.log(`[remodex] ${message}`);
      },
      warn: message => console.warn(`[remodex] ${message}`),
    });
    this.hydrateStoredTaskSelections();
    this.rememberWorkspaceRoot(process.cwd());
    for (const alias of store.read().threadAliases) {
      // The neutral Chats directory is an internal launch location, not a
      // user project.  Do not make it browsable merely because its alias was
      // restored after a Windows service or tray restart.
      if (alias.workspaceKind !== "projectless") this.rememberWorkspaceRoot(alias.cwd);
    }
  }

  status(): AndroidRemoteGatewayStatus {
    const runtime = this.runtime.status?.();
    const disconnected = this.gatewayStatus === "ready" && runtime?.connected === false;
    return {
      status: disconnected ? "error" : this.gatewayStatus,
      port: this.boundPort,
      backgroundServer: "current-process",
      ...(disconnected
        ? { error: gatewayStartupError(runtime.error ?? "Codex disconnected. Reconnect Android to retry.") }
        : this.statusError ? { error: this.statusError } : {}),
    };
  }

  localUrls(): string[] {
    // Keep dashboard addresses aligned with pairing. The raw adapter list can
    // contain Windows link-local and host-only virtual addresses a phone
    // cannot reach.
    return this.pairingUrls();
  }

  /** Make a committed Remodex catalog mutation visible to connected phones now. */
  notifyModelCatalogChanged(): void {
    this.configCache = null;
    this.providerQuotaRefreshAfter = 0;
    this.scheduleRefresh();
  }

  pairingUrls(): string[] {
    return this.listeningOnLocalNetwork ? androidRemotePairingUrls(this.boundPort, this.readNetworkInterfaces()) : [`http://127.0.0.1:${this.boundPort}`];
  }

  onlineClientIds(): ReadonlySet<string> {
    return new Set([...this.socketsByClient].filter(([, sockets]) => sockets.size > 0).map(([id]) => id));
  }

  createPairingInvitation(desktopName = readHostname() || "Remodex Desktop", replaceClientId?: string): AndroidRemotePairingInvitation {
    if (this.gatewayStatus !== "ready") throw new Error("Android Remote gateway is not ready");
    const localUrls = this.pairingUrls();
    const settings = this.store.read().settings;
    const tunnel = this.cloudflareTunnel.state();
    const cloudflareUrl = tunnel.status === "ready" ? tunnel.publicUrl : null;
    if (settings.tunnelMode === "named" && !cloudflareUrl && !this.listeningOnLocalNetwork) {
      throw new Error("Named Tunnel is not ready yet. Wait for the custom domain to be verified, then generate a new QR code.");
    }
    if (localUrls.length === 0 && !cloudflareUrl) {
      throw new Error("No phone-reachable network address is available");
    }
    return this.auth.createInvitation({ desktopName, localUrls, cloudflareUrl, replaceClientId });
  }

  applySettings(settings: AndroidRemoteSettings): Promise<void> {
    this.transition = this.transition.catch(() => undefined).then(async () => {
      if (!settings.controlEnabled) {
        await this.stop();
        return;
      }
      const useLocalNetwork = settings.localNetworkEnabled === true
        && (!this.bindHostname || this.bindHostname === "0.0.0.0");
      if (this.codex && (this.gatewayStatus === "error"
        || this.listeningOnLocalNetwork !== useLocalNetwork)) {
        // Change only the listener. Keep the connector, pairing credentials,
        // Codex subscriptions and task state alive across a LAN preference change.
        this.server?.stop(true);
        this.server = null;
        this.listeningOnLocalNetwork = false;
        try {
          this.listen(settings.localNetworkEnabled === true, this.boundPort);
          this.gatewayStatus = "ready";
          this.statusError = undefined;
        } catch (error) {
          // Do not reopen LAN access after the user disabled it. Keep the
          // existing runtime available for a subsequent listener retry.
          this.gatewayStatus = "error";
          this.statusError = gatewayStartupError(error);
          this.publishMobileConnectionChange();
          throw error;
        }
        this.publishMobileConnectionChange();
      }
      await this.start();
      // The local QR must not wait for a public connector download or DNS.
      // The tunnel owns its retries and publishes verified address changes.
      await this.cloudflareTunnel.apply(this.cloudflareInput(settings));
    });
    return this.transition;
  }

  cloudflareState(): AndroidRemoteCloudflareState {
    return this.cloudflareTunnel.state();
  }

  cloudflareConfiguration(): Promise<AndroidRemoteCloudflareConfiguration> {
    return this.cloudflareTunnel.configuration(this.store.read().settings);
  }

  async configureCloudflareTunnel(input: {
    mode: "quick" | "named";
    namedHostname?: string;
    token?: string;
  }): Promise<void> {
    const namedHostname = input.mode === "named"
      ? normalizeNamedTunnelHostname(input.namedHostname ?? "")
      : undefined;
    if (input.token !== undefined) await this.cloudflareTunnel.configureToken(input.token);
    if (input.mode === "named" && input.token === undefined) {
      const configuration = await this.cloudflareTunnel.configuration(this.store.read().settings);
      if (!configuration.hasNamedTunnelToken) {
        throw new TypeError("A Cloudflare connector token is required for Named Tunnel.");
      }
    }
    const next = this.store.updateSettings({
      tunnelMode: input.mode,
      ...(namedHostname ? { namedTunnelHostname: namedHostname } : {}),
    });
    if (next.settings.controlEnabled) {
      await this.start();
      await this.cloudflareTunnel.retry(this.cloudflareInput(next.settings));
    } else {
      await this.cloudflareTunnel.stop();
      this.publishMobileConnectionChange();
    }
  }

  async retryCloudflareTunnel(): Promise<void> {
    const settings = this.store.read().settings;
    if (!settings.controlEnabled || this.gatewayStatus !== "ready") {
      throw new Error("Enable Android Remote before retrying the tunnel.");
    }
    await this.cloudflareTunnel.retry(this.cloudflareInput(settings));
  }

  async checkCloudflareTunnel(): Promise<void> {
    const settings = this.store.read().settings;
    if (!settings.controlEnabled || this.gatewayStatus !== "ready") {
      throw new Error("Enable Android Remote before checking the tunnel.");
    }
    await this.cloudflareTunnel.check(this.cloudflareInput(settings));
  }

  async removeCloudflareTunnelToken(): Promise<void> {
    await this.cloudflareTunnel.removeToken();
    const settings = this.store.read().settings;
    if (settings.tunnelMode === "named" && settings.controlEnabled) {
      await this.cloudflareTunnel.retry(this.cloudflareInput(settings));
    }
  }

  async disconnectCloudflareNamedTunnel(): Promise<void> {
    await this.cloudflareTunnel.removeToken();
    const next = this.store.updateSettings({
      tunnelMode: "quick",
      namedTunnelHostname: "",
    });
    if (next.settings.controlEnabled) {
      await this.start();
      await this.cloudflareTunnel.retry(this.cloudflareInput(next.settings));
    } else {
      await this.cloudflareTunnel.stop();
      this.publishMobileConnectionChange();
    }
  }

  revokeClient(clientId: string): void {
    this.auth.revokeClient(clientId);
    for (const socket of this.socketsByClient.get(clientId) ?? []) {
      try { socket.close(4003, "Phone access revoked"); } catch { /* already closed */ }
    }
  }

  async start(): Promise<void> {
    if (this.gatewayStatus === "ready") return;
    if (this.startFlight) return this.startFlight;

    const flight = this.startWithRetry();
    this.startFlight = flight;
    try {
      await flight;
    } finally {
      if (this.startFlight === flight) this.startFlight = null;
    }
  }

  private async startWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.startInternal();
        return;
      } catch (error) {
        lastError = error;
        const delay = GATEWAY_START_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw lastError;
        this.gatewayStatus = "starting";
        this.statusError = undefined;
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
    }
  }

  private listen(localNetworkEnabled: boolean, port = this.configuredPort): void {
    this.server = Bun.serve<GatewayWsData>({
      hostname: this.bindHostname ?? (localNetworkEnabled ? "0.0.0.0" : "127.0.0.1"),
      port,
      idleTimeout: 255,
      fetch: (req, server) => this.handleHttp(req, server),
      websocket: {
        open: ws => this.onSocketOpen(ws),
        message: (ws, message) => { void this.onSocketMessage(ws, message); },
        close: ws => this.onSocketClose(ws),
      },
    });
    this.boundPort = this.server.port ?? this.configuredPort;
    this.listeningOnLocalNetwork = localNetworkEnabled
      && (!this.bindHostname || this.bindHostname === "0.0.0.0");
  }

  private async startInternal(): Promise<void> {
    this.gatewayStatus = "starting";
    this.statusError = undefined;
    try {
      sweepOldAndroidAttachments();
      this.codex = await this.runtime.start();
      this.desktopIpc.start();
      this.unsubscribeCodex = this.codex.subscribe(message => this.onCodexMessage(message));
      this.listen(this.store.read().settings.localNetworkEnabled === true);
      this.gatewayStatus = "ready";
      this.writerRecoveryStopped = false;
      this.publishMobileConnectionChange();
      let advertisedLocalUrls = JSON.stringify(this.pairingUrls());
      this.localAddressTimer = setInterval(() => {
        const next = JSON.stringify(this.pairingUrls());
        if (next === advertisedLocalUrls) return;
        advertisedLocalUrls = next;
        this.publishMobileConnectionChange();
      }, 15_000);
      this.localAddressTimer.unref();
      for (const remoteThreadId of this.queuedTurns.keys()) {
        void this.startNextQueuedTurn(remoteThreadId).catch(() => undefined);
      }
    } catch (error) {
      this.gatewayStatus = "error";
      this.statusError = gatewayStartupError(error);
      await this.stopResources();
      throw new Error(this.statusError, { cause: error });
    }
  }

  async stop(): Promise<void> {
    const starting = this.startFlight;
    if (starting) await starting.catch(() => undefined);
    await this.stopResources();
    this.gatewayStatus = "stopped";
    this.statusError = undefined;
  }

  private async stopResources(): Promise<void> {
    this.updateActivityRevision++;
    for (const socket of this.sockets) {
      try { socket.close(1012, "Android Remote stopping"); } catch { /* already closed */ }
    }
    this.sockets.clear();
    this.socketsByClient.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      // Bun can wait indefinitely for a WebSocket close handshake on Windows.
      // Begin a force-stop, but never let one phone strand Remodex shutdown.
      await Promise.race([
        server.stop(true),
        new Promise<void>(resolve => setTimeout(resolve, GATEWAY_STOP_DEADLINE_MS)),
      ]);
    }
    if (this.localAddressTimer) clearInterval(this.localAddressTimer);
    this.localAddressTimer = null;
    this.listeningOnLocalNetwork = false;
    this.writerRecoveryStopped = true;
    for (const timer of this.writerRecoveryTimers.values()) clearTimeout(timer);
    this.writerRecoveryTimers.clear();
    this.writerRecoveryAttempts.clear();
    await this.cloudflareTunnel.stop();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (this.shellRefreshTimer) clearTimeout(this.shellRefreshTimer);
    this.shellRefreshTimer = null;
    this.shellRefreshRunning = false;
    this.shellRefreshPending = false;
    if (this.refreshRetryTimer) clearTimeout(this.refreshRetryTimer);
    this.refreshRetryTimer = null;
    this.refreshRetryAttempt = 0;
    this.refreshPending = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const pending of this.pendingRequests.values()) {
      try { this.codex?.reject(pending.nativeRequestId, -32000, "Android Remote stopped"); } catch { /* disconnected */ }
    }
    this.pendingRequests.clear();
    this.pendingDesktopUserInputs.clear();
    this.queuedTurnStarts.clear();
    this.queuedTurnStartFlights.clear();
    this.queuedTurnCompletionKeys.clear();
    this.queuedSteerFlights.clear();
    for (const deliveries of this.pendingSteerDeliveries.values()) {
      for (const delivery of deliveries) delivery.resolve(false);
    }
    this.pendingSteerDeliveries.clear();
    this.knownActiveTurnIds.clear();
    this.injectedDesktopUserInputCallIds.clear();
    this.supplementalActivities.clear();
    this.supplementalPlans.clear();
    this.completedLiveMessageIds.clear();
    this.threadStreams.clear();
    this.oversizedHistoryThreads.clear();
    this.shellLifecycles.clear();
    this.desktopThreadSettings.clear();
    this.nativeThreadModelProviders.clear();
    this.authoritativeThreadRefreshes.clear();
    this.windowsHistoryBackfills.clear();
    this.windowsHistoryBackfillFlights.clear();
    this.threadSourcePaths.clear();
    this.nativeThreadMetadata.clear();
    this.missingNativeThreadIds.clear();
    this.sessionCommandRecovery.clear();
    this.desktopIpc.stop();
    this.desktopSessions.close();
    this.desktopSessionStarts.clear();
    this.desktopSessionStartPaths.clear();
    this.desktopSessionSourcePaths.clear();
    this.desktopSessionInstallations.clear();
    this.shellActivityWatchIds.clear();
    this.liveNotificationActivities.clear();
    this.liveNotificationActivityOrder = 0;
    this.recentDispatches.clear();
    this.inFlightDispatches.clear();
    this.threadMutationFlights.clear();
    this.projectedUserMessageIds.clear();
    this.durableDesktopUserMessages.clear();
    this.latestThreadTokenUsage.clear();
    this.nativeAccountQuota = null;
    this.nativeAccountQuotaRefresh = null;
    this.nativeAccountQuotaRefreshAfter = 0;
    this.nativeAccountQuotaGeneration += 1;
    this.desktopThreadActivityCache.clear();
    this.desktopThreadActivityReads.clear();
    this.desktopInteractions.clear();
    this.liveCompactionSources.clear();
    this.desktopInteractionReadAt.clear();
    this.desktopInteractionObservedAt.clear();
    this.answeredDesktopQuestions.clear();
    this.completedDesktopTurns.clear();
    this.desktopActiveTurnProbes.clear();
    this.desktopActiveTurnProbeReads.clear();
    this.projectedActivityReconciledAt.clear();
    this.assets.clear();
    this.shellCache = null;
    this.unsubscribeCodex?.();
    this.unsubscribeCodex = null;
    this.codex = null;
    await this.runtime.stop();
  }

  private async handleHttp(req: Request, server: Server<GatewayWsData>): Promise<Response | undefined> {
    if (!androidRemotePeerAllowed(server.requestIP(req)?.address)) {
      return errorResponse(403, "Use the same Wi-Fi or your verified remote link");
    }
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
        },
      });
    }
    if (url.pathname === "/healthz" && req.method === "GET") {
      return jsonResponse({ status: this.status().status, service: "opencodex-android-remote" });
    }
    if (url.pathname === "/.well-known/t3/environment" && req.method === "GET") {
      return jsonResponse(this.environmentDescriptor());
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      return this.exchangeToken(req, server.requestIP(req)?.address);
    }
    if (url.pathname === "/api/auth/session" && req.method === "GET") {
      const auth = this.authenticate(req, server.requestIP(req)?.address);
      return jsonResponse(auth
        ? {
            authenticated: true,
            auth: this.authDescriptor(),
            scopes: auth.client.scopes,
            sessionMethod: "bearer-access-token",
            ...(auth.client.credentialExpiresAt ? { expiresAt: auth.client.credentialExpiresAt } : {}),
          }
        : { authenticated: false, auth: this.authDescriptor() });
    }
    if (url.pathname === "/ws" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const client = this.auth.consumeWebSocketTicket(url.searchParams.get("wsTicket") ?? "");
      if (!client) return errorResponse(401, "Invalid or expired WebSocket ticket", "invalid_credential");
      const requestedProtocols = req.headers.get("sec-websocket-protocol")?.split(",").map(row => row.trim()) ?? [];
      const headers = requestedProtocols.includes("opencodex-json-v1")
        ? { "Sec-WebSocket-Protocol": "opencodex-json-v1" }
        : undefined;
      if (server.upgrade(req, { data: { clientId: client.id }, ...(headers ? { headers } : {}) })) {
        return undefined;
      }
      return errorResponse(426, "WebSocket upgrade failed");
    }

    // Exact-file image capabilities are deliberately self-authenticating so
    // native Coil requests never receive the Android Remote bearer token.
    const assetResponse = await this.assets.thumbnailResponse(url.pathname, req.method)
      ?? this.assets.response(url.pathname, req.method);
    if (assetResponse) return assetResponse;

    const authenticated = this.authenticate(req, server.requestIP(req)?.address);
    if (!authenticated) return errorResponse(401, "Android phone token required", "invalid_credential");
    if (url.pathname.startsWith("/api/desktop-update/")) {
      if (req.method === "POST" && !authenticated.client.scopes.includes("terminal:operate")) {
        return errorResponse(403, "This phone cannot install desktop updates");
      }
      return this.desktopUpdateRoutes(req, () => this.refreshUpdateActivity());
    }
    if (url.pathname === "/api/auth/client-metadata" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const updated = this.auth.updateClientMetadata(authenticated.client.id, {
          label: stringValue(body.label, 160),
          deviceType: "mobile",
          os: stringValue(body.os, 64),
          installationId: stringValue(body.installationId, 160),
        });
        return jsonResponse({ updated: Boolean(updated) });
      } catch (error) {
        return this.bodyError(error);
      }
    }
    if (url.pathname === "/api/auth/websocket-ticket" && req.method === "POST") {
      return jsonResponse({
        ...this.auth.issueWebSocketTicket(authenticated.client.id),
        protocol: "opencodex-json-v1",
      });
    }
    if (url.pathname === "/api/auth/pairing-links/acknowledge" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const id = stringValue(body.id, 128);
        return jsonResponse({ revoked: id.length > 0 && !this.auth.hasInvitation(id) });
      } catch (error) {
        return this.bodyError(error);
      }
    }
    if (url.pathname === "/api/orchestration/snapshot" && req.method === "GET") {
      try { return jsonResponse(await this.readModel()); }
      catch { return errorResponse(503, "Codex task history is temporarily unavailable"); }
    }
    if (url.pathname === "/api/orchestration/dispatch" && req.method === "POST") {
      try {
        const command = await readJsonBody(req);
        return jsonResponse(await this.dispatch(authenticated.client.id, command));
      } catch (error) {
        return this.dispatchError(error);
      }
    }
    return errorResponse(404, "Unknown Android Remote endpoint");
  }

  private authenticate(req: Request, address?: string) {
    const token = bearerToken(req);
    return token ? this.auth.authenticateAccessToken(token, address) : null;
  }

  private async exchangeToken(req: Request, address?: string): Promise<Response> {
    try {
      const body = new URLSearchParams(await readBoundedText(req, 64 * 1024));
      if (body.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange"
        || body.get("subject_token_type") !== "urn:t3:params:oauth:token-type:environment-bootstrap"
        || body.get("requested_token_type") !== "urn:ietf:params:oauth:token-type:access_token") {
        return errorResponse(400, "Unsupported phone token exchange");
      }
      const exchanged = this.auth.exchangePairingToken({
        pairingToken: body.get("subject_token") ?? "",
        retryProof: body.get("client_pairing_proof") ?? undefined,
        metadata: {
          label: body.get("client_label") ?? undefined,
          deviceType: body.get("client_device_type") ?? undefined,
          os: body.get("client_os") ?? undefined,
          installationId: body.get("client_installation_id") ?? undefined,
        },
        address,
      });
      if (!exchanged) return errorResponse(401, "Pairing code is invalid or expired", "invalid_credential");
      for (const clientId of exchanged.replacedClientIds) this.revokeClient(clientId);
      const expiresIn = Math.max(0, Math.floor((Date.parse(exchanged.expiresAt) - this.now()) / 1000));
      return jsonResponse({
        access_token: exchanged.accessToken,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: expiresIn,
        scope: ANDROID_REMOTE_SCOPES.join(" "),
      });
    } catch (error) {
      return this.bodyError(error);
    }
  }

  private bodyError(error: unknown): Response {
    if (error instanceof RangeError) return errorResponse(413, error.message);
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return errorResponse(400, error instanceof Error ? error.message : "Invalid request body");
    }
    return errorResponse(500, "Android Remote request failed");
  }

  private dispatchError(error: unknown): Response {
    if (error instanceof RangeError) return errorResponse(413, error.message);
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return errorResponse(400, error instanceof Error ? error.message : "Invalid command");
    }
    return errorResponse(409, error instanceof Error ? error.message : "Codex could not accept this command");
  }

  private environmentDescriptor(): JsonRecord {
    return {
      environmentId: this.environmentId,
      label: readHostname() || "Remodex Desktop",
      platform: { os: platformOs(), arch: platformArch() },
      serverVersion: "1.0.0",
      capabilities: {
        repositoryIdentity: false,
        androidRemoteFileAttachments: true,
        androidRemoteOptimisticPromptAcknowledgement: true,
        androidRemoteAtomicPromptEdit: true,
        androidRemoteTurnDelivery: true,
      },
    };
  }

  private authDescriptor(): JsonRecord {
    return {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "ocx_android_session",
    };
  }

  private cloudflareInput(settings: AndroidRemoteSettings): {
    enabled: boolean;
    port: number;
    settings: AndroidRemoteSettings;
    expectedEnvironmentId: string;
  } {
    return {
      enabled: settings.controlEnabled && this.gatewayStatus === "ready",
      port: this.boundPort,
      settings,
      expectedEnvironmentId: this.environmentId,
    };
  }

  private mobileCloudflareState(): JsonRecord {
    const state = this.cloudflareTunnel.state();
    if (state.status === "starting") return { status: "starting" };
    if (state.status === "checking") {
      return {
        status: "checking",
        ...(state.phase ? { phase: state.phase } : {}),
        ...(state.publicUrl ? { url: state.publicUrl } : {}),
      };
    }
    if (state.status === "ready" && state.publicUrl) {
      return { status: "ready", url: state.publicUrl };
    }
    const reason = state.error === "cloudflared_unavailable"
      ? "cloudflared_unavailable"
      : state.error === "verification_failed"
        ? "verification_failed"
        : state.error === "tunnel_failed" || state.error === "named_tunnel_incomplete"
          ? "tunnel_failed"
          : "backend_unavailable";
    return {
      status: "unavailable",
      reason,
      ...(state.phase ? { phase: state.phase } : {}),
      ...(state.publicUrl ? { url: state.publicUrl } : {}),
    };
  }

  private mobileConnectionState(): JsonRecord {
    return {
      version: 1,
      desktopInstanceId: this.desktopInstanceId,
      revision: this.mobileConnectionRevision,
      localUrls: this.gatewayStatus === "ready" && this.listeningOnLocalNetwork ? this.pairingUrls() : [],
      cloudflare: this.mobileCloudflareState(),
      updatedAt: this.mobileConnectionUpdatedAt,
    };
  }

  private publishMobileConnectionChange(): void {
    this.mobileConnectionRevision += 1;
    this.mobileConnectionUpdatedAt = new Date(this.now()).toISOString();
    this.configCache = null;
    const event = {
      version: 1,
      type: "remodexMobileConnectionUpdated",
      payload: { connection: this.mobileConnectionState() },
    };
    for (const ws of this.sockets) {
      if (ws.data.subscription !== "config" || ws.data.requestId === undefined) continue;
      socketEvent(ws, ws.data.requestId, event);
    }
  }

  private onSocketOpen(ws: ServerWebSocket<GatewayWsData>): void {
    this.sockets.add(ws);
    const rows = this.socketsByClient.get(ws.data.clientId) ?? new Set();
    rows.add(ws);
    this.socketsByClient.set(ws.data.clientId, rows);
    this.ensurePoller();
  }

  private onSocketClose(ws: ServerWebSocket<GatewayWsData>): void {
    this.sockets.delete(ws);
    const rows = this.socketsByClient.get(ws.data.clientId);
    rows?.delete(ws);
    if (rows?.size === 0) this.socketsByClient.delete(ws.data.clientId);
    if (this.sockets.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async onSocketMessage(
    ws: ServerWebSocket<GatewayWsData>,
    raw: string | Buffer,
  ): Promise<void> {
    const text = frameText(raw);
    if (text.length > MAX_WS_MESSAGE_BYTES) {
      ws.close(1009, "Message too large");
      return;
    }
    let message: JsonRecord;
    try {
      message = record(JSON.parse(text)) ?? (() => { throw new TypeError("invalid message"); })();
    } catch {
      ws.close(1003, "Invalid JSON message");
      return;
    }
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
    const method = stringValue(message.method, 128);
    if (id === null || !method) {
      ws.close(1008, "Request id and method required");
      return;
    }
    const params = record(message.params) ?? {};
    try {
      if (method === "server.getConfig") {
        socketResult(ws, id, await this.serverConfig());
        return;
      }
      if (method === "subscribeServerConfig") {
        ws.data.subscription = "config";
        ws.data.requestId = id;
        socketEvent(ws, id, { version: 1, type: "snapshot", config: await this.serverConfig() });
        return;
      }
      if (method === "orchestration.subscribeShell") {
        ws.data.subscription = "shell";
        ws.data.requestId = id;
        // A fabricated empty cache must not complete first-pairing readiness.
        // Read the small first page, then fill the remaining rows independently
        // of any slow selected-transcript/configuration refresh.
        try {
          const cached = this.shellCache;
          const hasRows = cached && (
            (Array.isArray(cached.threads) && cached.threads.length > 0)
            || (Array.isArray(cached.projects) && cached.projects.length > 0));
          const snapshot = hasRows && params.refresh !== true ? cached : await this.shellSnapshot(true);
          this.publishSubscriptionEvent(ws, { kind: "snapshot", snapshot }, true);
        } catch (error) {
          // Report the actual failure before the phone's generic readiness
          // deadline. Keep the subscription registered for background retries.
          socketError(ws, id, error instanceof Error ? error.message : "Could not load chats from Codex.");
        }
        this.scheduleShellRefresh();
        return;
      }
      if (method === "orchestration.subscribeThread") {
        const threadId = stringValue(params.threadId, 128);
        if (!threadId) throw new TypeError("task id is required");
        ws.data.subscription = "thread";
        ws.data.requestId = id;
        ws.data.threadId = threadId;
        const afterSequence = finiteNumber(params.afterSequence);
        ws.data.resumeAfterSequence = params.forceSnapshot !== true && afterSequence !== null && afterSequence >= 0
          ? Math.floor(afterSequence)
          : undefined;
        await this.refreshSocket(ws, true);
        return;
      }
      if (method === "orchestration.getTurnWork") {
        const threadId = stringValue(params.threadId, 128);
        const turnId = stringValue(params.turnId, 128);
        if (!threadId || !turnId) throw new TypeError("Task and turn are required");
        let detail = (await this.ensureThreadStream(threadId)).detail;
        if (!projectedRows(record(detail.thread)?.messages).some(row => row.turnId === turnId)) {
          detail = await this.readFullThreadDetail(threadId, { savedHistory: true });
        }
        if (!projectedRows(record(detail.thread)?.messages).some(row => row.turnId === turnId)) {
          throw new Error("This response is no longer available in the task history.");
        }
        socketResult(ws, id, projectedTurnWorkPage(record(detail.thread)!, turnId, stringValue(params.cursor, 4096) || undefined));
        return;
      }
      if (method === "orchestration.getThreadPage") {
        const threadId = stringValue(params.threadId, 128);
        const cursor = stringValue(params.cursor, 4096);
        if (!threadId || !cursor) throw new TypeError("task id and older-message cursor are required");
        const promptLimit = Math.max(1, Math.min(10, Math.floor(finiteNumber(params.promptLimit) ?? 10)));
        const nativeCursor = decodeNativeHistoryCursor(threadId, cursor);
        if (nativeCursor !== null) {
          const nativeId = this.nativeThreadId(threadId);
          const page = await readNativeTurnsPage(this.requireCodex(), nativeId, nativeCursor, promptLimit);
          const native = this.annotateThread({
            ...(this.nativeThreadMetadata.get(nativeId) ?? {}),
            id: nativeId,
            turns: page.turns,
            historyPage: { olderCursor: nativeHistoryCursor(threadId, page.nextCursor) },
          });
          const detail = projectCodexThreadDetail(native, 0, { compactCompletedWork: true });
          // Retain fetched source rows for local prompt cursors and Work expansion.
          // This adds history only: it never advances the live event sequence.
          const state = await this.ensureThreadStream(threadId);
          const current = record(state.detail.thread)!;
          const older = record(detail.thread)!;
          const merge = (field: string): JsonRecord[] => {
            const currentRows = projectedRows(current[field]);
            const ids = new Set(currentRows.map(row => row.id));
            return [...projectedRows(older[field]).filter(row => !ids.has(row.id)), ...currentRows];
          };
          this.threadStreams.set(threadId, { ...state, detail: { ...state.detail, thread: {
            ...current, messages: merge("messages"), activities: merge("activities"), proposedPlans: merge("proposedPlans"),
            historyPage: older.historyPage,
          } } });
          socketResult(ws, id, projectedThreadRecentPage(detail, promptLimit));
        } else {
          await this.finishWindowsHistoryBackfill(threadId);
          const state = await this.ensureThreadStream(threadId);
          socketResult(ws, id, await readProjectedOlderPage(state, cursor,
            () => this.readFullThreadDetail(threadId, { savedHistory: true }), promptLimit));
        }
        return;
      }
      if (method === "filesystem.browse") {
        socketResult(ws, id, await this.browseFilesystem(params));
        return;
      }
      if (method === "sourceControl.cloneRepository") {
        socketResult(ws, id, await this.cloneSourceControlRepository(params));
        return;
      }
      if (method === "projects.searchEntries") {
        socketResult(ws, id, await this.searchProjectEntries(params));
        return;
      }
      if (method === "projects.listEntries") {
        socketResult(ws, id, await this.listProjectEntries(params));
        return;
      }
      if (method === "filesystem.readTextFile") {
        const client = this.store.read().clients.find(candidate => candidate.id === ws.data.clientId);
        if (!client || !client.scopes.includes("orchestration:read")) {
          throw new TypeError("This device is not authorized to preview task files.");
        }
        const threadId = stringValue(params.threadId, 128);
        const path = stringValue(params.path, 4097);
        if (!threadId) throw new TypeError("A task id is required for file previews.");
        socketResult(ws, id, await readWorkspaceTextFile(await this.taskWorkspaceRoot(threadId), path));
        return;
      }
      if (method === "assets.createUrl") {
        socketResult(ws, id, await this.createAssetUrl(params));
        return;
      }
      if (method === "orchestration.dispatchCommand") {
        socketResult(ws, id, await this.dispatch(ws.data.clientId, params));
        return;
      }
      // Payment proof updates are handled by the authenticated connection
      // boundary. Never answer this method with a hard-coded "not required"
      // result: that would let a client clear the payment gate without a
      // verified signed proof. Older clients receive the normal unsupported
      // method error and must reconnect through the protected path.
      socketError(ws, id, "This Remodex Android method is not available");
    } catch (error) {
      socketError(ws, id, error instanceof Error ? error.message : "Android Remote request failed");
    }
  }

  private ensurePoller(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.scheduleShellRefresh();
      this.scheduleRefresh();
    }, LIVE_POLL_MS);
    this.pollTimer.unref?.();
  }

  private async refreshDesktopInteractions(remoteThreadId: string): Promise<void> {
    const read = this.desktopIpc.readFollowerThreadState;
    const nativeThreadId = this.nativeThreadId(remoteThreadId);
    if (!read || this.drafts.has(remoteThreadId)
      || fallbackOwnershipState(this.desktopIpc, nativeThreadId).state === "local-owned") return;
    const current = this.desktopInteractionReads.get(remoteThreadId);
    if (current) return current;
    if (this.now() - (this.desktopInteractionReadAt.get(remoteThreadId) ?? -Infinity) < 2000) return;
    const pending = (async () => {
      const state = await read.call(this.desktopIpc, nativeThreadId, { fresh: true });
      if (!state) return;
      const next = readDesktopInteractions(state, desktopConversationTurnRows(state));
      const previous = this.desktopInteractions.get(remoteThreadId);
      if (state.androidRemoteHistoryOnly === true && previous?.compaction?.active
        && this.liveCompactionSources.has(remoteThreadId)) {
        next.compaction = previous.compaction;
        next.activeTurnId = previous.activeTurnId;
      }
      const completedTurnId = this.completedDesktopTurns.get(remoteThreadId);
      if (completedTurnId && next.activeTurnId === completedTurnId) next.activeTurnId = null;
      if (completedTurnId && next.compaction?.turnId === completedTurnId) next.compaction.active = false;
      if (!next.compaction?.active) this.liveCompactionSources.delete(remoteThreadId);
      this.desktopInteractions.set(remoteThreadId, next);
      this.desktopInteractionObservedAt.set(remoteThreadId, this.now());
      while (this.desktopInteractions.size > 128) {
        const oldest = this.desktopInteractions.keys().next().value!;
        this.desktopInteractions.delete(oldest);
        this.liveCompactionSources.delete(oldest);
        this.desktopInteractionReadAt.delete(oldest);
        this.desktopInteractionObservedAt.delete(oldest);
      }
      for (const id of next.answeredIds) this.answeredDesktopQuestions.add(id);
      while (this.answeredDesktopQuestions.size > 2048) {
        this.answeredDesktopQuestions.delete(this.answeredDesktopQuestions.values().next().value!);
      }
      for (const group of next.questions) {
        const questions = group.questions.filter(question => !this.answeredDesktopQuestions.has(question.id));
        if (!questions.length) continue;
        const pending = this.rememberDesktopPendingUserInput({
          nativeThreadId, remoteThreadId, itemId: group.itemId, callId: group.itemId,
          turnId: group.turnId, requestedAt: group.requestedAt, sequence: group.sequence, questions,
        });
        this.rememberSupplementalActivity(remoteThreadId, pending.activity);
      }
      for (const [requestId, question] of this.pendingDesktopUserInputs) {
        if (question.remoteThreadId !== remoteThreadId || !this.isAsyncDesktopQuestion(question)) continue;
        if (!question.questions.every(row => this.answeredDesktopQuestions.has(stringValue(row.id, 128)))) continue;
        this.forgetDesktopPendingUserInput(requestId);
        this.rememberSupplementalActivity(remoteThreadId, {
          id: `resolved-${requestId}`, kind: "user-input.resolved", tone: "info",
          summary: "User input submitted", payload: { requestId }, turnId: question.turnId,
          sequence: ++this.sequence, createdAt: new Date(this.now()).toISOString(),
        });
      }
      const compaction = next.compaction;
      // Desktop's private mounted-view status can lag a completed canonical
      // turn. Normalize this separately from public app-server notifications.
      const ownerActive = desktopConversationIsActive(state);
      const ownerStatus = codexRuntimeStatus(state.threadRuntimeStatus);
      const runtimeStatus = ownerActive === null ? null
        : ownerStatus?.type === "active" && !ownerActive
          ? codexRuntimeStatus({ type: "idle" }) : ownerStatus;
      const knownQuestions = next.questions.flatMap(group => group.questions);
      const questionsRemain = knownQuestions.some(question => !this.answeredDesktopQuestions.has(question.id));
      const acknowledgedCurrentQuestions = (this.supplementalActivities.get(remoteThreadId) ?? []).some(activity =>
        activity.kind === "user-input.resolved" && activity.turnId === next.activeTurnId
        && Object.keys(record(record(activity.payload)?.answers) ?? {}).some(id => next.answeredIds.includes(id)));
      const synchronousQuestionPending = [...this.pendingRequests.values()].some(request =>
        request.remoteThreadId === remoteThreadId && request.method === "item/tool/requestUserInput")
        || [...this.pendingDesktopUserInputs.values()].some(request =>
          request.remoteThreadId === remoteThreadId && !this.isAsyncDesktopQuestion(request))
        || (Array.isArray(state.requests) ? state.requests : []).some(request =>
          record(request)?.method === "item/tool/requestUserInput");
      // The mounted-view waiting flag can lag the acknowledged answer. Only
      // clear it with request-specific evidence, never just an empty history page.
      const allKnownQuestionsAnswered = !questionsRemain && !synchronousQuestionPending
        && (knownQuestions.length > 0 || acknowledgedCurrentQuestions);
      const runtimeWireStatus = runtimeStatus ? {
        type: runtimeStatus.type,
        activeFlags: [
          ...(runtimeStatus.waitingOnApproval ? ["waitingOnApproval"] : []),
          ...((questionsRemain || (runtimeStatus.waitingOnUserInput && !allKnownQuestionsAnswered))
            ? ["waitingOnUserInput"] : []),
        ],
      } : null;
      if (runtimeStatus) {
        const visible = record(this.threadStreams.get(remoteThreadId)?.detail.thread)
          ?? this.shellLifecycles.get(remoteThreadId) ?? { id: remoteThreadId };
        const runtimeProjection = projectRuntimeStatus(visible, remoteThreadId, runtimeWireStatus, new Date(this.now()).toISOString());
        const priorSession = record(visible.session);
        const nextSession = record(runtimeProjection?.session);
        if (priorSession?.status !== nextSession?.status
          || priorSession?.statusConfidence !== nextSession?.statusConfidence
          || visible.hasPendingApprovals !== runtimeProjection?.hasPendingApprovals
          || visible.hasPendingUserInput !== runtimeProjection?.hasPendingUserInput) {
          this.applyLiveCodexNotification({ method: "thread/status/changed", params: {
            threadId: nativeThreadId, status: runtimeWireStatus,
          } }, true, "desktop-state");
        }
        const latest = canonicalTurnsNewestFirst(desktopConversationTurnRows(state))[0];
        const latestId = canonicalTurnId(latest);
        const latestStatus = normalizedTurnStatus(latest?.status ?? latest?.state);
        const terminalStatus = latestStatus === "completed" ? "completed"
          : latestStatus === "interrupted" || latestStatus === "cancelled" ? "interrupted"
          : latestStatus === "failed" || latestStatus === "error" ? "failed" : null;
        const visibleTurn = record(visible.latestTurn);
        const terminalState = terminalStatus === "failed" ? "error" : terminalStatus;
        if (runtimeStatus.type !== "active" && terminalStatus && latestId
          && (!priorSession?.activeTurnId || priorSession.activeTurnId === latestId)
          && (visibleTurn?.turnId !== latestId || visibleTurn?.state !== terminalState
            || priorSession?.statusConfidence === "unknown")) {
          this.applyLiveCodexNotification({ method: "turn/completed", params: {
            threadId: nativeThreadId, turn: { id: latestId, status: terminalStatus, error: latest?.error },
          } }, true, "desktop-state");
        }
      }
      const changed = JSON.stringify(previous?.compaction) !== JSON.stringify(compaction);
      const activeTurnId = compaction?.active ? compaction.turnId : next.activeTurnId;
      if (activeTurnId && (changed || previous?.activeTurnId !== activeTurnId || !this.projectedThreadIsActive(remoteThreadId))) {
        this.applyLiveCodexNotification({ method: "turn/started", params: {
          threadId: nativeThreadId, turnId: activeTurnId,
          turn: { id: activeTurnId, status: "inProgress" },
        } }, true, "desktop-state");
      }
      const projectedCompaction = compaction ?? (previous?.compaction ? { ...previous.compaction, active: false } : null);
      if (changed && projectedCompaction) {
        this.applyLiveCodexNotification({
          method: projectedCompaction.active ? "item/started" : "item/completed",
          params: { threadId: nativeThreadId, turnId: projectedCompaction.turnId,
            item: { type: "contextCompaction", id: projectedCompaction.id,
              status: projectedCompaction.active ? "inProgress" : "completed" } },
        }, true, "desktop-state");
      }
      if (JSON.stringify(previous?.questions) !== JSON.stringify(next.questions)
        || JSON.stringify(previous?.answeredIds) !== JSON.stringify(next.answeredIds)) {
        this.authoritativeThreadRefreshes.add(remoteThreadId);
      }
    })().catch(() => undefined).finally(() => {
      this.desktopInteractionReadAt.set(remoteThreadId, this.now());
      this.desktopInteractionReads.delete(remoteThreadId);
    });
    this.desktopInteractionReads.set(remoteThreadId, pending);
    return pending;
  }

  private isAsyncDesktopQuestion(input: PendingDesktopUserInput): boolean {
    return input.questions.length > 0 && input.questions.every(question =>
      stringValue(question.id, 128).startsWith('["request_user_input_async",'));
  }

  private scheduleRefresh(): void {
    if (this.sockets.size === 0) return;
    this.scheduleShellRefresh();
    if (this.refreshRunning) {
      // A notification received during a slow history read must not be lost.
      // Run one more coalesced pass after the current pass finishes.
      this.refreshPending = true;
      return;
    }
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshAllSockets().catch(() => {
        console.warn("[remodex] Android Remote subscription refresh failed; retrying");
        this.scheduleRefreshRetry();
      });
    }, LIVE_REFRESH_DEBOUNCE_MS);
    this.refreshTimer.unref?.();
  }

  private scheduleRefreshRetry(): void {
    if (
      this.sockets.size === 0
      || this.refreshRetryTimer
      || this.refreshRetryAttempt >= LIVE_REFRESH_RETRY_DELAYS_MS.length
    ) return;
    const delay = LIVE_REFRESH_RETRY_DELAYS_MS[this.refreshRetryAttempt]!;
    this.refreshRetryAttempt += 1;
    this.refreshRetryTimer = setTimeout(() => {
      this.refreshRetryTimer = null;
      void this.refreshAllSockets().catch(() => {
        console.warn("[remodex] Android Remote subscription retry failed");
        this.scheduleRefreshRetry();
      });
    }, delay);
    this.refreshRetryTimer.unref?.();
  }

  private clearRefreshRetry(): void {
    if (this.refreshRetryTimer) clearTimeout(this.refreshRetryTimer);
    this.refreshRetryTimer = null;
    this.refreshRetryAttempt = 0;
  }

  private async refreshAllSockets(): Promise<void> {
    if (this.refreshRunning) {
      this.refreshPending = true;
      return;
    }
    this.refreshRunning = true;
    try {
      // One Android connection uses separate sockets for shell, selected task,
      // and server settings. Reconnect overlap can briefly create more. Group
      // equal subscriptions so one Codex read serves every matching socket.
      const groups = new Map<string, ServerWebSocket<GatewayWsData>[]>();
      for (const ws of this.sockets) {
        if (ws.data.subscription === "shell") continue;
        const key = this.subscriptionKey(ws);
        if (!key) continue;
        const rows = groups.get(key) ?? [];
        rows.push(ws);
        groups.set(key, rows);
      }
      const results = await Promise.allSettled([...groups.values()].map(async rows => {
        const first = rows[0];
        if (!first) return;
        const events = await this.subscriptionEvents(first, false);
        for (const ws of rows) {
          for (const event of events) this.publishSubscriptionEvent(ws, event, false);
        }
      }));
      const failures = results.filter(result => result.status === "rejected").length;
      if (failures > 0) {
        console.warn(
          `[remodex] Android Remote could not refresh ${failures} subscription group${failures === 1 ? "" : "s"}; retrying`,
        );
        this.scheduleRefreshRetry();
      } else {
        this.clearRefreshRetry();
      }
    } finally {
      this.refreshRunning = false;
      if (this.refreshPending) {
        this.refreshPending = false;
        this.scheduleRefresh();
      }
    }
  }

  /**
   * Activity labels in the shell are maintained from the live notification
   * cache. Refresh only shell subscribers when that cache changes; a full
   * subscription pass would reread the selected task transcript for every
   * command-output or reasoning fragment.
   */
  private scheduleShellRefresh(delay = LIVE_REFRESH_DEBOUNCE_MS): void {
    if (this.sockets.size === 0) return;
    if (this.shellRefreshRunning) {
      this.shellRefreshPending = true;
      return;
    }
    if (this.shellRefreshTimer) return;
    this.shellRefreshTimer = setTimeout(() => {
      this.shellRefreshTimer = null;
      void this.refreshShellSockets().catch(() => {
        // The regular five-second poll will retry a failed shell read. Do not
        // escalate a transient activity-label refresh into a task transcript
        // reread while a turn is streaming.
      });
    }, delay);
    this.shellRefreshTimer.unref?.();
  }

  private async refreshShellSockets(): Promise<void> {
    if (this.shellRefreshRunning) {
      this.shellRefreshPending = true;
      return;
    }
    this.shellRefreshRunning = true;
    try {
      const liveThreads = [...new Set([
        ...[...this.sockets].flatMap(ws => ws.data.threadId ? [ws.data.threadId] : []),
        ...[...this.knownActiveTurnIds.keys()].map(id => this.remoteThreadId(id)),
      ])].slice(0, 16);
      for (let offset = 0; offset < liveThreads.length; offset += 4) {
        await Promise.all(liveThreads.slice(offset, offset + 4).map(id => this.refreshDesktopInteractions(id)));
      }
      const rows = [...this.sockets].filter(ws => ws.data.subscription === "shell");
      const groups = new Map<string, ServerWebSocket<GatewayWsData>[]>();
      for (const ws of rows) {
        const key = this.subscriptionKey(ws);
        if (!key) continue;
        const group = groups.get(key) ?? [];
        group.push(ws);
        groups.set(key, group);
      }
      const results = await Promise.allSettled([...groups.values()].map(async group => {
        const first = group[0];
        if (!first) return;
        // `initial=true` selects the full shell snapshot without scheduling a
        // follow-up all-subscriptions refresh for a cache miss.
        const events = await this.subscriptionEvents(first, true);
        for (const ws of group) {
          for (const event of events) this.publishSubscriptionEvent(ws, event, false);
        }
      }));
      if (results.some(result => result.status === "rejected")) {
        this.shellRefreshFailures += 1;
        this.shellRefreshPending = true;
      } else {
        this.shellRefreshFailures = 0;
      }
    } finally {
      this.shellRefreshRunning = false;
      if (this.shellRefreshPending) {
        this.shellRefreshPending = false;
        this.scheduleShellRefresh(this.shellRefreshFailures > 0
          ? LIVE_REFRESH_RETRY_DELAYS_MS[Math.min(this.shellRefreshFailures - 1, LIVE_REFRESH_RETRY_DELAYS_MS.length - 1)]!
          : LIVE_REFRESH_DEBOUNCE_MS);
      }
    }
  }

  private async refreshSocket(ws: ServerWebSocket<GatewayWsData>, force: boolean): Promise<void> {
    const events = await this.subscriptionEvents(ws, force);
    for (const event of events) this.publishSubscriptionEvent(ws, event, force);
    if (ws.data.subscription === "thread" && ws.data.threadId) {
      // Publish the recent messages before beginning any full saved-file scan.
      void this.finishWindowsHistoryBackfill(ws.data.threadId).catch(() => this.scheduleRefresh());
    }
  }

  private subscriptionKey(ws: ServerWebSocket<GatewayWsData>): string | null {
    if (ws.data.subscription === "thread") return `thread:${ws.data.threadId ?? ""}`;
    return ws.data.subscription ?? null;
  }

  private async subscriptionEvents(
    ws: ServerWebSocket<GatewayWsData>,
    initial: boolean,
  ): Promise<unknown[]> {
    const id = ws.data.requestId;
    if (id === undefined || !ws.data.subscription) return [];
    if (ws.data.subscription === "shell") {
      const quick = !initial && this.shellCache === null;
      const snapshot = await this.shellSnapshot(quick);
      if (quick) this.scheduleRefresh();
      return [{ kind: "snapshot", snapshot }];
    }
    if (ws.data.subscription === "thread") {
      this.refreshNativeAccountQuota();
      const threadId = ws.data.threadId ?? "";
      if (!initial && this.windowsHistoryBackfills.has(threadId)) {
        await this.finishWindowsHistoryBackfill(threadId);
        return [];
      }
      await this.refreshDesktopInteractions(threadId);
      if (initial) {
        const state = await this.ensureThreadStream(threadId);
        if ((this.queuedTurns.get(threadId)?.length ?? 0) > 0) {
          void this.startNextQueuedTurn(threadId).catch(() => undefined);
        }
        const afterSequence = ws.data.resumeAfterSequence;
        ws.data.resumeAfterSequence = undefined;
        if (afterSequence !== undefined) {
          const replay = replayProjectedThreadAfter(state, afterSequence);
          if (replay && replay.length > 0) return replay;
        }
        const status = stringValue(record(record(state.detail.thread)?.session)?.status);
        return [projectedThreadBoundedSnapshot(state, turnStatusIsActive(status) ? 1 : 10)];
      }
      // Desktop-owned turns are mirrored from their append-only session file.
      // Avoid replacing that precise ordered stream with a stale app-server
      // snapshot every five seconds. A terminal/start boundary explicitly
      // opts into one authoritative read because rollback/edit operations are
      // history rewrites and cannot be represented by that append-only tail.
      const watchingDesktopSession = this.desktopSessions.isWatching(threadId);
      if (
        watchingDesktopSession
        && this.projectedThreadIsActive(threadId)
        && !this.projectedThreadActivityIsFresh(threadId)
      ) {
        const lastReconciledAt = this.projectedActivityReconciledAt.get(threadId) ?? 0;
        if (this.now() - lastReconciledAt >= PROJECTED_ACTIVE_RECONCILE_INTERVAL_MS) {
          this.projectedActivityReconciledAt.set(threadId, this.now());
          this.authoritativeThreadRefreshes.add(threadId);
        }
      }
      if (watchingDesktopSession && !this.authoritativeThreadRefreshes.has(threadId)) {
        if ((this.queuedTurns.get(threadId)?.length ?? 0) > 0) {
          void this.startNextQueuedTurn(threadId).catch(() => undefined);
        }
        return [];
      }
      const current = await this.ensureThreadStream(threadId);
      const detail = await this.readFullThreadDetail(threadId, { boundedInitial: true });
      const latest = this.threadStreams.get(threadId) ?? current;
      const advanced = advanceProjectedThreadStream(latest, detail, this.now());
      this.threadStreams.set(threadId, advanced.state);
      this.authoritativeThreadRefreshes.delete(threadId);
      this.pruneThreadStreams();
      if ((this.queuedTurns.get(threadId)?.length ?? 0) > 0) {
        void this.startNextQueuedTurn(threadId).catch(() => undefined);
      }
      return advanced.items;
    }
    return [{ version: 1, type: "snapshot", config: await this.serverConfig() }];
  }

  private publishSubscriptionEvent(
    ws: ServerWebSocket<GatewayWsData>,
    event: unknown,
    force: boolean,
  ): void {
    const id = ws.data.requestId;
    if (id === undefined) return;
    const fingerprint = androidRemoteSubscriptionFingerprint(event);
    if (!force && fingerprint === ws.data.fingerprint) return;
    ws.data.fingerprint = fingerprint;
    socketEvent(ws, id, event);
  }

  private requireCodex(): AndroidCodexClient {
    if (!this.codex) throw new Error("Codex task service is not connected");
    return this.codex;
  }

  private rememberWorkspaceRoot(value: string): void {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 4096) return;
    try {
      const normalized = resolve(trimmed);
      this.knownWorkspaceRoots.set(comparableWorkspaceRoot(normalized), normalized);
    } catch {
      // Ignore malformed paths received from stale task history.
    }
  }

  private requireKnownWorkspaceRoot(value: unknown): string {
    const cwd = stringValue(value, 4096).trim();
    if (!cwd) throw new TypeError("The selected Codex task has no project folder");
    let key: string;
    try {
      key = comparableWorkspaceRoot(cwd);
    } catch {
      throw new TypeError("The selected Codex project folder is invalid");
    }
    const known = this.knownWorkspaceRoots.get(key);
    if (!known) throw new TypeError("This folder is not part of a Codex task visible on this phone");
    return known;
  }

  private async taskWorkspaceRoot(remoteThreadId: string): Promise<string> {
    const draft = this.drafts.get(remoteThreadId);
    if (draft?.cwd) return draft.cwd;
    const alias = this.store.read().threadAliases.find(row => row.remoteThreadId === remoteThreadId);
    if (alias?.cwd) return alias.cwd;

    const result = record(await this.requireCodex().request("thread/read", {
      threadId: this.nativeThreadId(remoteThreadId),
      includeTurns: false,
    }));
    const thread = record(result?.thread);
    const cwd = stringValue(thread?.cwd, 4096);
    if (!cwd) throw new TypeError("The selected Codex task has no project folder");
    this.rememberWorkspaceRoot(cwd);
    return cwd;
  }

  private async createAssetUrl(params: JsonRecord): Promise<JsonRecord> {
    const resource = record(params.resource);
    if (resource?._tag !== "workspace-file") {
      throw new TypeError("Remodex Android supports workspace image previews only");
    }
    const threadId = stringValue(resource.threadId, 128);
    const path = stringValue(resource.path, 32 * 1024);
    if (!threadId || !path) throw new TypeError("Task id and image path are required");
    try {
      return await this.assets.issueWorkspaceImage({
        workspaceRoot: await this.taskWorkspaceRoot(threadId),
        path,
      });
    } catch (workspaceError) {
      const normalizedPath = normalizedAssistantImagePath(path);
      if (!normalizedPath) throw workspaceError;
      // The older-page RPC and the visible Android timeline both come from the
      // retained stream detail. A fresh Codex `thread/read` can temporarily be
      // shorter (for example after Desktop refresh/reconnect), so authorizing
      // only against that new read made an already-visible historical image
      // impossible to open. Keep an exact-path visible-message boundary,
      // but check the same authoritative history that produced the phone row.
      const visibleMessageReferencesPath = (detail: JsonRecord | undefined): boolean => {
        const projectedThread = record(detail?.thread);
        if (projectedRows(projectedThread?.activities).some(activity => {
          const data = record(record(activity.payload)?.data);
          return data?.type === "imageGeneration" && Array.isArray(data.generatedImages)
            && data.generatedImages.some(image => normalizedAssistantImagePath(typeof image === "string" ? image : "") === normalizedPath);
        })) return true;
        return projectedRows(projectedThread?.messages).some(message => {
          const messageText = stringValue(message.text, 2 * 1024 * 1024);
          return message.role === "assistant"
            ? assistantMarkdownImagePaths(messageText).has(normalizedPath)
            : message.role === "user" && userMessageImagePaths(messageText).has(normalizedPath);
        });
      };
      let visiblyReferenced = visibleMessageReferencesPath(this.threadStreams.get(threadId)?.detail);
      if (!visiblyReferenced) {
        visiblyReferenced = visibleMessageReferencesPath(await this.readFullThreadDetail(threadId));
      }
      if (!visiblyReferenced) {
        throw new TypeError(
          "An image outside the project can be opened only when this task explicitly referenced it",
        );
      }
      return this.assets.issueAssistantReferencedImage(path);
    }
  }

  private projectEntry(value: unknown): { path: string; kind: "file" | "directory" } | null {
    const row = record(value);
    const path = stringValue(row?.path, 4096).trim();
    if (!path || !visibleProjectEntryPath(path)) return null;
    return {
      path,
      kind: row?.match_type === "directory" ? "directory" : "file",
    };
  }

  private async browseFilesystem(params: JsonRecord): Promise<JsonRecord> {
    const partialPath = filesystemBrowsePathInput(params.partialPath, "folder path")!;
    const cwd = filesystemBrowsePathInput(params.cwd, "current project folder", true);
    const resolvedInputPath = resolveFilesystemBrowseTarget(partialPath, cwd);
    const endsWithSeparator = /[\\/]$/u.test(partialPath) || partialPath === "~";
    const parentPath = endsWithSeparator ? resolvedInputPath : dirname(resolvedInputPath);
    const prefix = endsWithSeparator ? "" : basename(resolvedInputPath);

    let rows: Dirent[];
    try {
      rows = await readdir(parentPath, { withFileTypes: true });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
      if (code === "EACCES" || code === "EPERM") return { parentPath, entries: [] };
      throw new TypeError(`The folder '${parentPath}' could not be read`);
    }

    const showHidden = endsWithSeparator || prefix.startsWith(".");
    const lowerPrefix = prefix.toLowerCase();
    const entries: Array<{ name: string; fullPath: string }> = [];
    for (const row of rows) {
      if (
        row.isDirectory()
        && row.name.toLowerCase().startsWith(lowerPrefix)
        && (showHidden || !row.name.startsWith("."))
      ) {
        entries.push({ name: row.name, fullPath: join(parentPath, row.name) });
      }
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return { parentPath, entries };
  }

  private async cloneSourceControlRepository(params: JsonRecord): Promise<JsonRecord> {
    const remoteUrl = sourceControlRemoteUrlInput(params.remoteUrl);
    const destinationPath = sourceControlDestinationInput(params.destinationPath);
    const parentPath = dirname(destinationPath);
    const directoryName = basename(destinationPath);

    try {
      const details = await stat(destinationPath);
      if (!details.isDirectory()) {
        throw new TypeError("The clone destination already exists and is not a folder");
      }
      const entries = await readdir(destinationPath);
      if (entries.length > 0) {
        throw new TypeError("The clone destination already exists and is not empty");
      }
    } catch (error) {
      if (error instanceof TypeError) throw error;
      const code = error && typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
      if (code !== "ENOENT") {
        throw new TypeError("The clone destination could not be inspected");
      }
      try {
        await mkdir(parentPath, { recursive: true });
      } catch {
        throw new TypeError("The clone destination could not be prepared");
      }
    }

    await runGitClone(remoteUrl, parentPath, directoryName);
    let canonicalCwd: string;
    try {
      canonicalCwd = await realpath(destinationPath);
    } catch {
      throw new Error("Git reported success, but the cloned folder could not be read");
    }
    return { cwd: canonicalCwd, remoteUrl, repository: null };
  }

  private async searchProjectEntries(params: JsonRecord): Promise<JsonRecord> {
    const cwd = this.requireKnownWorkspaceRoot(params.cwd);
    const query = stringValue(params.query, 257).trim();
    if (!query) throw new TypeError("Type part of a file name after @ to search this project");
    if (query.length > 256) throw new RangeError("File search is limited to 256 characters");
    const requestedLimit = finiteNumber(params.limit) ?? 80;
    const limit = Math.max(1, Math.min(200, Math.floor(requestedLimit)));
    const response = record(await this.requireCodex().request("fuzzyFileSearch", {
      query,
      roots: [cwd],
      cancellationToken: null,
    }));
    const files = Array.isArray(response?.files) ? response.files : [];
    const entries = files
      .map(value => this.projectEntry(value))
      .filter((value): value is { path: string; kind: "file" | "directory" } => value !== null)
      .slice(0, limit);
    return { entries, truncated: files.length > entries.length };
  }

  private async listProjectEntries(params: JsonRecord): Promise<JsonRecord> {
    const cwd = this.requireKnownWorkspaceRoot(params.cwd);
    const response = record(await this.requireCodex().request("fs/readDirectory", { path: cwd }));
    const rows = Array.isArray(response?.entries) ? response.entries : [];
    const entries: Array<{ path: string; kind: "file" | "directory" }> = [];
    for (const value of rows) {
      const row = record(value);
      const fileName = stringValue(row?.fileName, 1024).trim();
      if (!fileName || fileName === "." || fileName === ".." || /[\\/]/.test(fileName)) continue;
      if (!visibleProjectEntryPath(fileName)) continue;
      if (row?.isDirectory === true) entries.push({ path: fileName, kind: "directory" });
      else if (row?.isFile === true) entries.push({ path: fileName, kind: "file" });
    }
    entries.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.path.localeCompare(right.path);
    });
    return { entries: entries.slice(0, 200), truncated: entries.length > 200 };
  }

  private async listCodexThreads(options: { quick?: boolean } = {}): Promise<JsonRecord[]> {
    const client = this.requireCodex();
    const candidates: CodexThreadListCandidate[] = [];
    const projectlessNativeThreadIds = new Set(
      this.store.read().threadAliases.flatMap(alias =>
        alias.workspaceKind === "projectless" ? [alias.nativeThreadId] : []),
    );
    const archiveStates = options.quick ? [false] : [false, true];
    for (const archived of archiveStates) {
      let cursor: string | null = null;
      const maxPages = options.quick ? 1 : THREAD_LIST_MAX_PAGES;
      for (let page = 0; page < maxPages; page += 1) {
        const result = record(await client.request("thread/list", {
          limit: options.quick ? THREAD_LIST_QUICK_PAGE_SIZE : THREAD_LIST_PAGE_SIZE,
          cursor,
          sortKey: "recency_at",
          sortDirection: "desc",
          archived,
          // Current Codex app-server builds default an omitted filter to the
          // active provider. An explicit empty list means every provider,
          // including Desktop tasks created before Remodex was selected.
          modelProviders: [],
        }, options.quick ? 10_000 : undefined));
        const rows = Array.isArray(result?.data) ? result.data : [];
        for (const value of rows) {
          const thread = record(value);
          const nativeId = stringValue(thread?.id, 128);
          if (thread && nativeId && !this.missingNativeThreadIds.has(nativeId)) {
            if (!projectlessNativeThreadIds.has(nativeId)) {
              this.rememberWorkspaceRoot(stringValue(thread.cwd, 4096));
            }
            candidates.push({ thread, archived });
          }
        }
        cursor = stringValue(result?.nextCursor, 4096) || null;
        if (!cursor) break;
      }
    }
    // Desktop can register a newly-created task in session_index before the
    // private app-server exposes it through thread/list. Include those recent
    // IDs as a bounded fallback so Android sees new Desktop tasks promptly.
    if (!options.quick) try {
      const indexText = await readFile(join(getCodexHome(), "session_index.jsonl"), "utf8");
      const indexedIds = indexText.split("\n").slice(-200).flatMap(line => {
        try {
          const row = record(JSON.parse(line));
          const id = stringValue(row?.id, 128);
          return id ? [id] : [];
        } catch { return []; }
      });
      const knownIds = new Set(candidates.map(candidate => stringValue(candidate.thread.id, 128)));
      for (const nativeId of indexedIds) {
        if (knownIds.has(nativeId) || this.missingNativeThreadIds.has(nativeId)) continue;
        try {
          const result = record(await client.request("thread/read", { threadId: nativeId, includeTurns: false }));
          const thread = record(result?.thread);
          if (thread) {
            candidates.push({ thread, archived: false });
            knownIds.add(nativeId);
          }
        } catch { /* index entries may belong to another Codex host */ }
      }
    } catch { /* session index is optional on older Codex builds */ }
    const combined: JsonRecord[] = [];
    for (const candidate of canonicalizeCodexThreadCandidates(candidates)) {
      const nativeId = stringValue(candidate.thread.id, 128);
      const discoveredPaths = nativeId
        ? await resolveThreadSourcePaths(
            nativeId,
            codexThreadSourcePaths(candidate.thread),
            { now: this.now, discover: false },
          )
        : [];
      const canonicalThread =
        discoveredPaths.length > 0
          ? {
              ...candidate.thread,
              androidRemoteNativeSourcePath: stringValue(candidate.thread.path, 32 * 1024),
              path: discoveredPaths.at(-1),
              androidRemoteSourcePaths: discoveredPaths,
            }
          : candidate.thread;
      this.rememberNativeThreadMetadata(canonicalThread);
      const annotated = this.annotateThread(canonicalThread, candidate.archived);
      const remoteId = stringValue(annotated.id, 128);
      if (remoteId && discoveredPaths.length > 0) {
        this.threadSourcePaths.set(remoteId, discoveredPaths);
      }
      combined.push(annotated);
    }
    const nativeIds = new Set(combined.map(thread => this.nativeThreadIdForAnnotated(thread)));
    for (const draft of this.drafts.values()) {
      if (!nativeIds.has(this.nativeThreadId(draft.id))) combined.push(draftAsCodexThread(draft));
    }
    return combined;
  }

  private rememberNativeThreadMetadata(thread: JsonRecord): void {
    const nativeId = stringValue(thread.id, 128);
    if (!nativeId) return;
    const { turns: _turns, ...metadata } = thread;
    this.nativeThreadMetadata.delete(nativeId);
    this.nativeThreadMetadata.set(nativeId, metadata);
    while (this.nativeThreadMetadata.size > NATIVE_THREAD_METADATA_CACHE_LIMIT) {
      const oldestId = this.nativeThreadMetadata.keys().next().value;
      if (typeof oldestId !== "string") break;
      this.nativeThreadMetadata.delete(oldestId);
    }
  }

  private sourcePathsForThread(remoteThreadId: string, thread?: JsonRecord): string[] {
    const paths = new Set(this.threadSourcePaths.get(remoteThreadId) ?? []);
    if (thread) {
      for (const path of codexThreadSourcePaths(thread)) paths.add(path);
    }
    return [...paths];
  }

  private primarySourcePath(remoteThreadId: string, thread?: JsonRecord): string {
    const paths = this.sourcePathsForThread(remoteThreadId, thread);
    return paths.at(-1) ?? stringValue(thread?.path, 32 * 1024);
  }

  /**
   * Reconcile cached/listed rollout paths with any newer physical continuation.
   *
   * A shell row can keep the original rollout path after Codex continues the
   * same logical task in a sibling JSONL file. Treating that existing path as
   * sufficient leaves the watcher on an old unfinished turn, which in turn
   * keeps Android Working, queues ordinary sends, and delays notifications
   * until a slower full-detail refresh happens to discover the continuation.
   */
  private async latestSourcePathsForThread(
    remoteThreadId: string,
    thread?: JsonRecord,
  ): Promise<string[]> {
    const knownPaths = this.sourcePathsForThread(remoteThreadId, thread);
    const latestListedThread = this.nativeThreadMetadata.get(this.nativeThreadId(remoteThreadId));
    for (const path of codexThreadSourcePaths(latestListedThread ?? {})) {
      // A fresh thread/list result can point at a continuation before a full
      // thread/read replaces the selected-task cache. Keep that newest path at
      // the end so the watcher moves to the current rollout immediately.
      const previousIndex = knownPaths.indexOf(path);
      if (previousIndex >= 0) knownPaths.splice(previousIndex, 1);
      knownPaths.push(path);
    }
    const resolvedPaths = await resolveThreadSourcePaths(
      this.nativeThreadId(remoteThreadId),
      knownPaths,
      {
        now: this.now,
        discover: true,
      },
    );
    if (resolvedPaths.length > 0) {
      this.threadSourcePaths.set(remoteThreadId, resolvedPaths);
      return resolvedPaths;
    }
    return knownPaths;
  }

  private nativeThreadIdForAnnotated(thread: JsonRecord): string {
    return stringValue(thread.androidRemoteNativeThreadId, 128) || stringValue(thread.id, 128);
  }

  private annotateThread(thread: JsonRecord, archived = false): JsonRecord {
    const nativeId = stringValue(thread.id, 128);
    const alias = this.store.read().threadAliases.find(row => row.nativeThreadId === nativeId);
    const remoteId = alias?.remoteThreadId ?? nativeId;
    const preference = this.preferences.get(remoteId);
    const nativeProvider = stringValue(thread.modelProvider, 64);
    if (nativeProvider) this.nativeThreadModelProviders.set(remoteId, nativeProvider);
    let taskSelection = this.storedTaskSelection(remoteId, nativeId);
    // Repair old Desktop-origin ledger entries using the task's actual provider,
    // without reassigning a provider explicitly selected on Android.
    if (taskSelection && nativeProvider
      && (taskSelection.source === "desktop" || taskSelection.source === "migration")) {
      const providerInstanceId = this.desktopProviderInstanceId({
        model: taskSelection.model,
        modelProviderId: this.desktopThreadSettings.get(remoteId)?.modelProviderId || nativeProvider,
        reasoningEffort: "",
        serviceTier: "",
        updatedAtMs: 0,
      }, taskSelection.providerInstanceId);
      const normalized = this.normalizedTaskModelSelection({
        instanceId: providerInstanceId,
        model: taskSelection.model,
      });
      if (providerInstanceId !== taskSelection.providerInstanceId || normalized.model !== taskSelection.model) {
        taskSelection = this.commitTaskSelection({
          ...taskSelection,
          providerInstanceId,
          model: normalized.model,
          updateId: `provider-identity-${taskSelection.revision}-${providerInstanceId}`,
          expectedRevision: taskSelection.revision,
        }).selection;
      }
    }
    return {
      ...thread,
      id: remoteId,
      androidRemoteNativeThreadId: nativeId,
      ...(alias ? {
        androidRemoteProjectId: alias.projectId,
        ...(alias.workspaceKind ? { androidRemoteWorkspaceKind: alias.workspaceKind } : {}),
        androidRemoteTitle: alias.title,
        ...(alias.instanceId ? { androidRemoteProviderInstanceId: alias.instanceId } : {}),
        androidRemoteModel: alias.model,
        androidRemoteRuntimeMode: alias.runtimeMode,
        androidRemoteInteractionMode: alias.interactionMode,
      } : {}),
      ...(preference?.title ? { androidRemoteTitle: preference.title } : {}),
      ...(preference?.instanceId ? { androidRemoteProviderInstanceId: preference.instanceId } : {}),
      ...(preference?.model ? { androidRemoteModel: preference.model } : {}),
      ...(preference?.modelOptions ? { androidRemoteModelOptions: preference.modelOptions } : {}),
      ...(taskSelection ? {
        androidRemoteProviderInstanceId: taskSelection.providerInstanceId,
        androidRemoteModel: taskSelection.model,
        ...(taskSelection.options !== undefined ? { androidRemoteModelOptions: taskSelection.options } : {}),
        androidRemoteModelSelectionRevision: taskSelection.revision,
        androidRemoteModelSelectionUpdatedAt: taskSelection.updatedAt,
      } : {}),
      ...(preference?.runtimeMode ? { androidRemoteRuntimeMode: preference.runtimeMode } : {}),
      ...(preference?.interactionMode ? { androidRemoteInteractionMode: preference.interactionMode } : {}),
      ...(archived ? { androidRemoteArchivedAt: new Date((finiteNumber(thread.updatedAt) ?? this.now() / 1000) * 1000).toISOString() } : {}),
    };
  }

  private nativeThreadId(remoteThreadId: string): string {
    return this.store.read().threadAliases.find(row => row.remoteThreadId === remoteThreadId)?.nativeThreadId
      ?? remoteThreadId;
  }

  private remoteThreadId(nativeThreadId: string): string {
    return this.store.read().threadAliases.find(row => row.nativeThreadId === nativeThreadId)?.remoteThreadId
      ?? nativeThreadId;
  }

  private storedTaskSelection(remoteThreadId: string, nativeThreadId = this.nativeThreadId(remoteThreadId)):
    AndroidRemoteTaskSelection | null {
    return this.store.read().taskSelections.find(row =>
      row.remoteThreadId === remoteThreadId || row.nativeThreadId === nativeThreadId) ?? null;
  }

  private applyTaskSelectionPreference(selection: AndroidRemoteTaskSelection): void {
    const current = this.preferences.get(selection.remoteThreadId) ?? {};
    this.preferences.set(selection.remoteThreadId, {
      ...current,
      instanceId: selection.providerInstanceId,
      model: selection.model,
      // An absent option set is meaningful: catalog revalidation may have reset a stale
      // reasoning choice to provider-owned Auto, so do not retain the previous options.
      modelOptions: selection.options,
    });
  }

  private managementRowForTaskSelection(selection: TaskModelSelection): ManagementModelRow | undefined {
    const rows = this.managementModelRows.filter(row =>
      androidProviderInstanceId(row.provider) === selection.instanceId);
    const exact = rows.find(row => row.namespaced === selection.model);
    if (exact) return exact;
    return rows.find(row => row.id === selection.model
      || slugEquals(selection.model, row.provider, row.id));
  }

  private normalizedTaskModelSelection(selection: TaskModelSelection): TaskModelSelection {
    const row = this.managementRowForTaskSelection(selection);
    if (row) return { ...selection, model: row.namespaced };
    const provider = this.managementModelRows.find(candidate =>
      androidProviderInstanceId(candidate.provider) === selection.instanceId)?.provider
      ?? selection.instanceId;
    if (provider === "openai" || provider === "opencodex"
      || selection.model.startsWith(`${provider}/`)) return selection;
    return { ...selection, model: routedSlug(provider, selection.model) };
  }

  private desktopTaskModel(selection: TaskModelSelection, remoteThreadId?: string): string {
    const configuredProvider = this.desktopDirectModelProvider();
    const directProvider = configuredProvider && remoteThreadId
      ? this.nativeThreadModelProviders.get(remoteThreadId) || configuredProvider
      : configuredProvider;
    if (!directProvider) return selection.model;
    if (androidProviderInstanceId(directProvider) !== selection.instanceId) {
      throw new Error(`Codex Desktop uses ${modelSourceDisplayName(directProvider)}. Select a model from that provider for this task.`);
    }
    const row = this.managementRowForTaskSelection(selection);
    if (row) return row.id;
    const prefix = `${directProvider}/`;
    return selection.model.startsWith(prefix) ? selection.model.slice(prefix.length) : selection.model;
  }

  private assertTaskModelRoute(selection: TaskModelSelection, remoteThreadId?: string): void {
    // A selector and its visible connection must describe the same destination.
    const route = this.managementModelRows.find(row => row.namespaced === selection.model);
    if (route && androidProviderInstanceId(route.provider) !== selection.instanceId) {
      throw new Error("The model and connection do not match. Refresh the model list and select the model again.");
    }
    if (route?.disabled) throw new Error("This model is disabled. Select an available model for this task.");
    // Check before creating a private task too, not only after Desktop owns it.
    this.desktopTaskModel(selection, remoteThreadId);
  }

  private assertPrivateTaskModelRoute(selection: TaskModelSelection): void {
    const provider = this.requireCodex().directModelProvider;
    if (provider && androidProviderInstanceId(provider) !== selection.instanceId) {
      throw new Error("The local task connection uses a different provider. Restart the Remodex server to load the updated connection before sending.");
    }
  }

  private validatedTaskModelSelection(selection: TaskModelSelection): ValidatedTaskModelSelection {
    const normalized = this.normalizedTaskModelSelection(selection);
    return validateTaskModelReasoning(
      normalized,
      this.managementRowForTaskSelection(normalized),
      this.liveCodexModelRows.get(normalized.model),
    );
  }

  private hydrateStoredTaskSelections(): void {
    const state = this.store.read();
    for (const selection of state.taskSelections) this.applyTaskSelectionPreference(selection);
    for (const alias of state.threadAliases) {
      if (state.taskSelections.some(selection =>
        selection.remoteThreadId === alias.remoteThreadId || selection.nativeThreadId === alias.nativeThreadId)) {
        continue;
      }
      const migrated = this.store.upsertTaskSelection({
        nativeThreadId: alias.nativeThreadId,
        remoteThreadId: alias.remoteThreadId,
        providerInstanceId: alias.instanceId || "openai",
        model: alias.model,
        source: "migration",
        updateId: `migration-${alias.nativeThreadId}`,
        updatedAt: alias.updatedAt,
        expectedRevision: 0,
      });
      this.applyTaskSelectionPreference(migrated.selection);
    }
  }

  private commitTaskSelection(input: {
    remoteThreadId: string;
    nativeThreadId?: string;
    providerInstanceId: string;
    model: string;
    options?: unknown;
    capabilityVersion?: string;
    source: AndroidRemoteTaskSelection["source"];
    updateId: string;
    expectedRevision?: number;
    updatedAt?: string;
  }): ReturnType<AndroidRemoteStore["upsertTaskSelection"]> {
    const result = this.store.upsertTaskSelection({
      nativeThreadId: input.nativeThreadId ?? this.nativeThreadId(input.remoteThreadId),
      remoteThreadId: input.remoteThreadId,
      providerInstanceId: input.providerInstanceId,
      model: input.model,
      ...(input.options !== undefined ? { options: input.options } : {}),
      ...(input.capabilityVersion ? { capabilityVersion: input.capabilityVersion } : {}),
      source: input.source,
      updateId: input.updateId,
      updatedAt: input.updatedAt ?? new Date(this.now()).toISOString(),
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    });
    this.applyTaskSelectionPreference(result.selection);
    return result;
  }

  private selectedTaskModel(remoteThreadId: string, command: JsonRecord): {
    instanceId: string;
    model: string;
    options?: unknown;
  } {
    // Send is the commit boundary for Android's local model/options draft.
    // Queued commands retain this same snapshot, even if another client or a
    // later send changes the task's ledger before the queue reaches this turn.
    if (record(command.modelSelection)) {
      return this.validatedTaskModelSelection(modelSelection(command)).selection;
    }
    const stored = this.storedTaskSelection(remoteThreadId);
    if (stored) {
      return this.validatedTaskModelSelection({
        instanceId: stored.providerInstanceId,
        model: stored.model,
        ...(stored.options !== undefined ? { options: stored.options } : {}),
      }).selection;
    }
    return this.validatedTaskModelSelection(modelSelection(command)).selection;
  }

  private nextLiveNotificationActivityState(
    remoteThreadId: string,
    message: CodexJsonRpcMessage,
  ): LiveNotificationActivityState | null | undefined {
    const method = stringValue(message.method, 128);
    const params = record(message.params) ?? {};
    const turn = record(params.turn);
    const turnId = stringValue(params.turnId, 128)
      || stringValue(turn?.id, 128)
      || this.liveNotificationActivities.get(remoteThreadId)?.turnId
      || null;

    if (method === "turn/completed") return null;
    if (method === "turn/started") {
      return {
        turnId,
        fallbackLabel: "Reasoning",
        activeItems: new Map(),
      };
    }

    const current = this.liveNotificationActivities.get(remoteThreadId);
    const next = cloneLiveNotificationActivityState(current, turnId);
    const replacedItemId = stringValue(params.replacesItemId, 128);
    if (replacedItemId) next.activeItems.delete(replacedItemId);
    const setActiveItem = (itemId: string, label: string): void => {
      if (!itemId || !label) return;
      next.activeItems.delete(itemId);
      next.activeItems.set(itemId, {
        label,
        order: ++this.liveNotificationActivityOrder,
      });
    };

    if (method === "item/started") {
      const item = record(params.item);
      const itemId = stringValue(item?.id, 128);
      if (!item) return undefined;
      const tool = stringValue(item.tool, 128).replace(/[^a-z0-9_]/giu, "").toLowerCase();
      const label = tool === "request_user_input"
        ? "Requires your input"
        : projectCodexNotificationItemLabel(item);
      if (label === "Requires your input") {
        next.activeItems.clear();
        next.fallbackLabel = label;
      } else if (label) {
        setActiveItem(itemId, label);
        next.fallbackLabel = "Reasoning";
      } else {
        next.fallbackLabel = "Reasoning";
      }
      return next;
    }

    if (method === "item/completed") {
      const item = record(params.item);
      const itemId = stringValue(item?.id, 128);
      const completedLabel = (
        (itemId ? next.activeItems.get(itemId)?.label : null)
        ?? (item ? projectCodexNotificationItemLabel(item) : null)
      );
      if (itemId) next.activeItems.delete(itemId);
      // Keep the latest activity aligned with Android's visible timeline until
      // Codex publishes the next real activity. Guessing "Reasoning" here can
      // erase short tools before the notification refresh runs and can make
      // the notification move ahead of the in-app thread.
      if (next.activeItems.size === 0) {
        next.fallbackLabel = completedLabel === "Requires your input" || completedLabel === "Compacting context"
          ? "Reasoning"
          : completedLabel ?? next.fallbackLabel;
      }
      return next;
    }

    if (method === "item/fileChange/patchUpdated") {
      setActiveItem(stringValue(params.itemId, 128), "File change");
      return next;
    }
    if (method === "item/mcpToolCall/progress") {
      setActiveItem(stringValue(params.itemId, 128), "MCP tool");
      return next;
    }
    if (
      method === "item/commandExecution/outputDelta"
      || method === "item/commandExecution/terminalInteraction"
    ) {
      const itemId = stringValue(params.itemId, 128);
      if (itemId) setActiveItem(itemId, "Command");
      else if (next.activeItems.size === 0) next.fallbackLabel = "Command";
      return next;
    }
    if (method === "item/fileChange/outputDelta" || method === "turn/diff/updated") {
      const itemId = stringValue(params.itemId, 128);
      if (itemId) setActiveItem(itemId, "File change");
      else if (next.activeItems.size === 0) next.fallbackLabel = "File change";
      return next;
    }
    if (method === "turn/plan/updated" || method === "item/plan/delta") {
      if (next.activeItems.size === 0) next.fallbackLabel = "Plan";
      return next;
    }
    if (
      method === "item/agentMessage/delta"
      || method === "item/reasoning/summaryPartAdded"
      || method === "item/reasoning/summaryTextDelta"
      || method === "item/reasoning/textDelta"
    ) {
      if (next.activeItems.size === 0) next.fallbackLabel = "Reasoning";
      return next;
    }
    return undefined;
  }

  private commitLiveNotificationActivityState(
    remoteThreadId: string,
    next: LiveNotificationActivityState | null | undefined,
  ): void {
    if (next === undefined) return;
    const previous = this.liveNotificationActivities.get(remoteThreadId);
    const previousLabel = liveNotificationActivityLabel(previous);
    const previousTurnId = previous?.turnId ?? null;
    if (next === null) {
      this.liveNotificationActivities.delete(remoteThreadId);
    } else {
      this.liveNotificationActivities.delete(remoteThreadId);
      this.liveNotificationActivities.set(remoteThreadId, next);
      while (this.liveNotificationActivities.size > MAX_LIVE_NOTIFICATION_ACTIVITY_THREADS) {
        const oldest = this.liveNotificationActivities.keys().next().value;
        if (typeof oldest !== "string") break;
        this.liveNotificationActivities.delete(oldest);
      }
    }
    const current = this.liveNotificationActivities.get(remoteThreadId);
    if (
      previousLabel === liveNotificationActivityLabel(current)
      && previousTurnId === (current?.turnId ?? null)
    ) {
      if (!this.publishCachedLiveThreadToShell(remoteThreadId)) {
        this.scheduleShellRefresh();
      }
      return;
    }
    if (!this.publishCachedLiveThreadToShell(remoteThreadId)) {
      this.scheduleShellRefresh();
    }
  }

  private setLiveNotificationFallback(
    remoteThreadId: string,
    turnId: string | null,
    label: string,
    clearActiveItems = false,
  ): void {
    const next = cloneLiveNotificationActivityState(
      this.liveNotificationActivities.get(remoteThreadId),
      turnId,
    );
    if (clearActiveItems) next.activeItems.clear();
    next.fallbackLabel = label;
    this.commitLiveNotificationActivityState(remoteThreadId, next);
  }

  private applyLiveNotificationActivitiesToShell(snapshot: JsonRecord): void {
    if (!Array.isArray(snapshot.threads)) return;
    snapshot.threads = snapshot.threads.map(value => {
      const thread = record(value);
      if (!thread) return value;
      const session = record(thread.session);
      const latestTurn = record(thread.latestTurn);
      const running =
        turnStatusIsActive(session?.status)
        || turnStatusIsActive(latestTurn?.state);
      const next: JsonRecord = { ...thread };
      delete next.currentActivity;
      const threadId = stringValue(thread.id, 128);
      if (!running || !threadId) {
        if (threadId) this.liveNotificationActivities.delete(threadId);
        return next;
      }
      if (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true) {
        next.currentActivity = "Requires your input";
        return next;
      }
      const activity = this.liveNotificationActivities.get(threadId);
      const shellTurnId = stringValue(session?.activeTurnId, 128)
        || stringValue(latestTurn?.turnId, 128);
      if (activity?.turnId && shellTurnId && activity.turnId !== shellTurnId) return next;
      const label = liveNotificationActivityLabel(activity);
      if (label) next.currentActivity = label;
      return next;
    });
  }

  private liveThreadLifecycleEvidence(value: JsonRecord): number {
    const session = record(value.session);
    const latestTurn = record(value.latestTurn);
    const timestamps = [
      session?.updatedAt,
      latestTurn?.completedAt,
      latestTurn?.startedAt,
      latestTurn?.requestedAt,
    ].map(value => Date.parse(stringValue(value, 64)))
      .filter(Number.isFinite);
    return timestamps.length > 0 ? Math.max(...timestamps) : Number.NEGATIVE_INFINITY;
  }

  /**
   * Merge the selected-task stream's same-turn lifecycle into a shell row.
   *
   * Desktop's catalogue read can lag a just-published turn/completed event.
   * Keeping the stale running shell row alive is what made Android show
   * Working, Queue, and the foreground notification for another minute or
   * two after Desktop had already finished.
   */
  private applyLiveThreadLifecycleToShell(snapshot: JsonRecord): void {
    if (!Array.isArray(snapshot.threads)) return;
    snapshot.threads = snapshot.threads.map(value => {
      const shellThread = record(value);
      const remoteThreadId = stringValue(shellThread?.id, 128);
      const streamedThread = record(this.threadStreams.get(remoteThreadId)?.detail.thread);
      const lifecycle = this.shellLifecycles.get(remoteThreadId);
      const liveThread = lifecycle && (!streamedThread
        || this.liveThreadLifecycleEvidence(lifecycle) >= this.liveThreadLifecycleEvidence(streamedThread))
        ? lifecycle : streamedThread;
      if (!shellThread || !remoteThreadId || !liveThread) return value;
      const shellLatestTurn = record(shellThread.latestTurn);
      const liveLatestTurn = record(liveThread.latestTurn);
      const shellSession = record(shellThread.session);
      const liveSession = record(liveThread.session);
      if (shellSession?.status === "error" && shellSession.activeTurnId && shellThread.latestTurn === null
        && turnStatusIsActive(liveSession?.status)
        && this.now() - Date.parse(stringValue(liveSession?.updatedAt, 64)) > PROJECTED_ACTIVE_FALLBACK_FRESH_MS) return value;
      const shellTurnId = stringValue(shellLatestTurn?.turnId, 128)
        || stringValue(shellSession?.activeTurnId, 128);
      const liveTurnId = stringValue(liveLatestTurn?.turnId, 128)
        || stringValue(liveSession?.activeTurnId, 128);
      if (!liveTurnId && !liveSession?.statusConfidence) return value;
      if (shellTurnId && shellTurnId !== liveTurnId
        && this.liveThreadLifecycleEvidence(liveThread) < this.liveThreadLifecycleEvidence(shellThread)) return value;
      if (
        this.liveThreadLifecycleEvidence(liveThread)
        < this.liveThreadLifecycleEvidence(shellThread)
      ) {
        return value;
      }
      const nextLatestTurn = liveThread.latestTurn === undefined ? shellThread.latestTurn : liveThread.latestTurn;
      const nextSession = liveThread.session ?? shellThread.session;
      if (
        JSON.stringify(nextLatestTurn) === JSON.stringify(shellThread.latestTurn)
        && JSON.stringify(nextSession) === JSON.stringify(shellThread.session)
        && (typeof liveThread.hasPendingUserInput !== "boolean"
          || liveThread.hasPendingUserInput === shellThread.hasPendingUserInput)
        && (typeof liveThread.hasPendingApprovals !== "boolean"
          || liveThread.hasPendingApprovals === shellThread.hasPendingApprovals)
      ) {
        return value;
      }
      return {
        ...shellThread,
        latestTurn: nextLatestTurn,
        session: nextSession,
        ...(typeof liveThread.hasPendingApprovals === "boolean"
          ? { hasPendingApprovals: liveThread.hasPendingApprovals } : {}),
        ...(typeof liveThread.hasPendingUserInput === "boolean"
          ? { hasPendingUserInput: liveThread.hasPendingUserInput } : {}),
        ...(record(nextSession)?.activeTurnId === null
          && !turnStatusIsActive(record(nextSession)?.status)
          && record(nextSession)?.statusConfidence !== "unknown"
          ? { hasPendingApprovals: false, hasPendingUserInput: false } : {}),
        updatedAt:
          stringValue(liveThread.updatedAt, 64) > stringValue(shellThread.updatedAt, 64)
            ? liveThread.updatedAt
            : shellThread.updatedAt,
      };
    });
  }

  /**
   * Publish a small cached shell replacement from the lifecycle event already
   * applied to the selected-task stream. A full Desktop workspace reread still
   * runs as a fallback when no cache row exists.
   */
  private publishCachedLiveThreadToShell(remoteThreadId: string): boolean {
    const cached = this.shellCache;
    if (!cached || !Array.isArray(cached.threads)) return false;
    const existing = cached.threads.find(value =>
      stringValue(record(value)?.id, 128) === remoteThreadId);
    if (!existing) return false;

    const next: JsonRecord = {
      ...cached,
      threads: [...cached.threads],
    };
    this.applyLiveThreadLifecycleToShell(next);
    this.applyLiveNotificationActivitiesToShell(next);
    const updated = (next.threads as unknown[]).find(value =>
      stringValue(record(value)?.id, 128) === remoteThreadId);
    if (JSON.stringify(existing) === JSON.stringify(updated)) return true;

    const nowIso = new Date(this.now()).toISOString();
    next.snapshotSequence = ++this.sequence;
    next.updatedAt = nowIso;
    this.shellCache = next;
    for (const ws of this.sockets) {
      if (ws.data.subscription !== "shell") continue;
      this.publishSubscriptionEvent(ws, { kind: "snapshot", snapshot: next }, false);
    }
    return true;
  }

  private async shellSnapshot(quick = false): Promise<JsonRecord> {
    // A first-page request must not join a slow full-history read already in flight.
    const key = quick ? "quickShellReadPending" : "shellReadPending";
    if (this[key]) return this[key];
    const pending = this.buildShellSnapshot(quick);
    this[key] = pending;
    try { return await pending; }
    finally { if (this[key] === pending) this[key] = null; }
  }

  private async buildShellSnapshot(quick: boolean): Promise<JsonRecord> {
    const desktopWorkspace = await this.desktopWorkspaceReader(
      await this.listCodexThreads({ quick }),
    );
    const initiallyAnnotatedThreads = await annotateDesktopTaskActivity(
      desktopWorkspace.threads,
      undefined,
      {
        now: this.now,
        isThreadActive: threadId => this.verifyStaleTaskOwnerActivity(threadId),
      },
    );
    const threads = await this.synchronizeShellActivityWatches(initiallyAnnotatedThreads);
    const snapshot = projectCodexShellSnapshot(threads, ++this.sequence);
    const projects = new Map(
      (Array.isArray(snapshot.projects) ? snapshot.projects : []).flatMap(value => {
        const project = record(value);
        const id = stringValue(project?.id, 128);
        return project && id ? [[id, project] as const] : [];
      }),
    );
    // Desktop's registry is authoritative for explicit projects, including
    // folders that do not have a task yet. Seed those rows before merging the
    // Android mirror so an empty project survives a runtime restart.
    for (const project of desktopWorkspace.projects) {
      const id = stringValue(project.id, 128);
      const workspaceRoot = stringValue(project.workspaceRoot, 4096);
      if (!id || !workspaceRoot) continue;
      const createdAt = stringValue(project.createdAt, 64) || this.desktopProjectFallbackTimestamp;
      const existing = projects.get(id);
      projects.set(id, {
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
        ...existing,
        id,
        title: stringValue(project.title, 256) || basename(workspaceRoot),
        workspaceRoot,
      });
    }
    // A project created by an older runtime may still be keyed by its Android
    // id while Desktop has already assigned the same folder its own project
    // id. Prefer Desktop's canonical id so the two rows cannot appear twice.
    const desktopProjectIdByRoot = new Map<string, string>();
    for (const project of desktopWorkspace.projects) {
      desktopProjectIdByRoot.set(comparableWorkspaceRoot(project.workspaceRoot), project.id);
    }
    const projectIdAliases = new Map<string, string>();
    for (const project of this.projects.values()) {
      const canonicalDesktopId = desktopProjectIdByRoot.get(comparableWorkspaceRoot(project.cwd));
      const projectId = canonicalDesktopId ?? project.id;
      if (projectId !== project.id) projectIdAliases.set(project.id, projectId);
      const projected = projects.get(projectId);
      projects.set(projectId, {
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: project.createdAt,
        updatedAt: project.createdAt,
        ...projected,
        id: projectId,
        title: project.title,
        workspaceRoot: project.cwd,
      });
    }
    if (projectIdAliases.size > 0 && Array.isArray(snapshot.threads)) {
      snapshot.threads = snapshot.threads.map(value => {
        const thread = record(value);
        if (!thread) return value;
        const projectId = stringValue(thread.projectId, 128);
        const replacement = projectIdAliases.get(projectId);
        return replacement ? { ...thread, projectId: replacement } : value;
      });
    }
    snapshot.projects = [...projects.values()];
    const pendingByThreadId = new Map<string, {
      approval: boolean;
      userInput: boolean;
    }>();
    for (const pending of this.pendingRequests.values()) {
      const current = pendingByThreadId.get(pending.remoteThreadId) ?? {
        approval: false,
        userInput: false,
      };
      if (pending.activity.kind === "approval.requested") current.approval = true;
      if (pending.activity.kind === "user-input.requested") current.userInput = true;
      pendingByThreadId.set(pending.remoteThreadId, current);
    }
    if (Array.isArray(snapshot.threads)) {
      snapshot.threads = snapshot.threads.map(value => {
        const thread = record(value);
        if (!thread) return value;
        const pending = pendingByThreadId.get(stringValue(thread.id, 128));
        if (!pending) return value;
        return {
          ...thread,
          hasPendingApprovals: thread.hasPendingApprovals === true || pending.approval,
          hasPendingUserInput: thread.hasPendingUserInput === true || pending.userInput,
        };
      });
    }
    this.applyLiveThreadLifecycleToShell(snapshot);
    this.applyLiveNotificationActivitiesToShell(snapshot);
    if (quick && this.shellCache) {
      // Reconnecting must not temporarily remove older rows from a populated
      // sidebar. The following full refresh remains authoritative for removals.
      for (const key of ["threads", "projects"] as const) {
        const fresh = Array.isArray(snapshot[key]) ? snapshot[key] as JsonRecord[] : [];
        const seen = new Set(fresh.map(row => row.id));
        const cached = Array.isArray(this.shellCache[key]) ? this.shellCache[key] as JsonRecord[] : [];
        snapshot[key] = [...fresh, ...cached.filter(row => !seen.has(row.id))];
      }
    }
    this.shellCache = snapshot;
    this.shellUpdatedAt = this.now();
    return snapshot;
  }

  private async readFullThreadDetail(
    remoteThreadId: string,
    options: { readonly boundedInitial?: boolean; readonly savedHistory?: boolean; readonly allowEmptyHistory?: boolean } = {},
  ): Promise<JsonRecord> {
    this.refreshProviderQuotaReports();
    this.refreshNativeAccountQuota();
    let boundedInitial = options.boundedInitial === true;
    const draft = this.drafts.get(remoteThreadId);
    const nativeId = this.nativeThreadId(remoteThreadId);
    let thread: JsonRecord;
    if (draft && nativeId === remoteThreadId) {
      thread = draftAsCodexThread(draft);
    } else {
      const cachedNative = this.nativeThreadMetadata.get(nativeId);
      let native: JsonRecord | null = null;
      let readCompleted = false;
      let readFound = false;
      let readFailure: unknown = null;
      let emptyNativePage = false;
      let recoverSavedHistory = options.savedHistory === true || this.oversizedHistoryThreads.has(nativeId);
      if (recoverSavedHistory) boundedInitial = false;
      try {
        const result = record(await this.requireCodex().request("thread/read", {
          threadId: nativeId,
          includeTurns: !boundedInitial && !recoverSavedHistory,
        }));
        readCompleted = true;
        native = record(result?.thread);
        readFound = native !== null;
      } catch (error) {
        readFailure = error;
      }
      if (boundedInitial && native !== null) {
        try {
          const active = codexRuntimeStatus(native.status)?.type === "active"
            || this.projectedThreadIsActive(remoteThreadId)
            || Boolean(this.desktopInteractions.get(remoteThreadId)?.activeTurnId);
          const page = await readNativeTurnsPage(this.requireCodex(), nativeId, undefined, active ? 1 : 10);
          native = {
            ...native,
            turns: page.turns,
            historyPage: { olderCursor: nativeHistoryCursor(remoteThreadId, page.nextCursor) },
          };
          if (page.turns.length === 0) {
            boundedInitial = false;
            emptyNativePage = true;
            native.historyPage = undefined;
          }
        } catch (error) {
          if (error instanceof AndroidCodexResponseTooLargeError || nativeHistoryNeedsSessionRecovery(error)) {
            // Do not retry Codex's broken lineage with a larger thread/read.
            // Recover only verified files for this task, then use local paging.
            recoverSavedHistory = true;
            if (error instanceof AndroidCodexResponseTooLargeError) {
              this.oversizedHistoryThreads.add(nativeId);
              if (this.oversizedHistoryThreads.size > 256) {
                this.oversizedHistoryThreads.delete(this.oversizedHistoryThreads.values().next().value!);
              }
            }
            boundedInitial = false;
            native = { ...native, turns: [], historyPage: undefined };
          } else {
            // Only old servers may use the legacy read. A timeout must not start
            // an even larger read or silently send a message-only transcript.
            if (!nativeHistoryIsUnsupported(error)) throw error;
            boundedInitial = false;
            try {
              const result = record(await this.requireCodex().request("thread/read", {
                threadId: nativeId,
                includeTurns: true,
              }));
              native = record(result?.thread);
              readCompleted = true;
              readFound = native !== null;
            } catch (error) {
              native = null;
              readFailure = error;
              readFound = false;
            }
          }
        }
      }
      const alias = this.store.read().threadAliases.find(row => row.nativeThreadId === nativeId);
      const recoverySeed: JsonRecord = native
        ? { ...(cachedNative ?? {}), ...native }
        : {
            ...(cachedNative ?? {}),
            id: nativeId,
            ...(alias?.cwd ? { cwd: alias.cwd } : {}),
            ...(alias?.workspaceKind ? { androidRemoteWorkspaceKind: alias.workspaceKind } : {}),
            ...(alias?.workspaceKind ? { androidRemoteProjectId: alias.projectId } : {}),
            ...(alias?.workspaceKind ? { androidRemoteProjectTitle: "Chats" } : {}),
            ...(alias?.title ? { name: alias.title, preview: alias.title } : {}),
            turns: [],
          };
      let sourcePaths = this.sourcePathsForThread(remoteThreadId, recoverySeed);
      let verifiedSourcePaths: string[] | undefined;
      if (boundedInitial && native !== null) {
        // A successful native page can still contain only the original rollout.
        // Verify sibling ownership before trusting its "no more history" claim.
        verifiedSourcePaths = await (this.sessionCommandRecovery.resolveSourcePaths?.(nativeId, sourcePaths)
          ?? resolveThreadSourcePaths(nativeId, sourcePaths, { now: this.now }));
        const normalizeSourcePath = (path: string): string => process.platform === "win32"
          ? path.replaceAll("\\", "/").toLowerCase()
          : path;
        const nativePath = normalizeSourcePath(stringValue(native.path, 32 * 1024));
        const newestPath = verifiedSourcePaths.at(-1);
        if (verifiedSourcePaths.length > 1 || (newestPath && normalizeSourcePath(newestPath) !== nativePath)) {
          boundedInitial = false;
          // Retain native items in the merge, but page the combined transcript
          // locally so an obsolete native cursor cannot hide the continuation.
          recoverySeed.historyPage = undefined;
        }
      }
      if (boundedInitial && native !== null) {
        // Complete recent items already contain public work history. Keep the
        // full session-file recovery off the initial page's critical path.
        this.missingNativeThreadIds.delete(nativeId);
        this.rememberNativeThreadMetadata(native);
        thread = this.annotateThread(native);
      } else {
        verifiedSourcePaths ??= await resolveThreadSourcePaths(nativeId, sourcePaths, {
          now: this.now,
        });
        if (verifiedSourcePaths.length > 0) {
          sourcePaths = verifiedSourcePaths;
          this.threadSourcePaths.set(remoteThreadId, verifiedSourcePaths);
        }
        if (sourcePaths.length > 0) {
          recoverySeed.androidRemoteSourcePaths = sourcePaths;
          if (!stringValue(recoverySeed.path, 32 * 1024)) {
            recoverySeed.androidRemoteNativeSourcePath = "";
            recoverySeed.path = sourcePaths.at(-1);
          }
        }
        const recent = process.platform === "win32" && options.boundedInitial === true
          && !this.threadStreams.has(remoteThreadId)
          ? await this.sessionCommandRecovery.enrichRecentThread?.(recoverySeed, sourcePaths)
          : null;
        native = recent?.thread ?? await this.sessionCommandRecovery.enrichThread(recoverySeed, sourcePaths);
        const recoveryError = stringValue(native.androidRemoteHistoryRecoveryError);
        if (recoveryError.includes("could not be verified")) {
          throw new Error(`${recoveryError} Keeping any messages already loaded; please retry history.`);
        }
        if (recent?.hasOlder) this.windowsHistoryBackfills.add(remoteThreadId);
        const recoveredTurns = Array.isArray(native.turns) ? native.turns : [];
        const previousThread = record(this.threadStreams.get(remoteThreadId)?.detail.thread);
        if (emptyNativePage && !options.allowEmptyHistory && recoveredTurns.length === 0
          && projectedRows(previousThread?.messages).length > 0) {
          throw new Error("Codex returned an empty history update. Keeping the messages already loaded while retrying.");
        }
        if (recoverSavedHistory && !recoveredTurns.some(turn => {
          const items = record(turn)?.items;
          return Array.isArray(items) && items.length > 0;
        })) {
          // Metadata alone is not a recovered transcript. Keep the task in the
          // sidebar and report the history failure instead of an empty success.
          throw new Error("Codex could not read this task's history, and no readable saved history was found. Open the task in Codex on this PC, then try again.");
        }
        const conclusivelyMissing = (readCompleted && !readFound)
          || codexThreadReadIsMissing(readFailure);
        const recoverable = readFound
          || recoveredTurns.length > 0
          || (!conclusivelyMissing && (
            sourcePaths.length > 0
            || cachedNative !== undefined
            || alias !== undefined
          ));
        if (!recoverable) {
          if (conclusivelyMissing) {
            this.missingNativeThreadIds.add(nativeId);
            this.nativeThreadMetadata.delete(nativeId);
            this.threadSourcePaths.delete(remoteThreadId);
            if (alias) {
              this.store.removeThreadAlias(remoteThreadId);
              this.store.removeTaskSelection(nativeId);
              this.preferences.delete(remoteThreadId);
            }
            this.shellCache = null;
            this.scheduleRefresh();
          }
          if (readFailure instanceof Error) throw readFailure;
          throw new Error("Codex task was not found");
        }
        this.missingNativeThreadIds.delete(nativeId);
        this.rememberNativeThreadMetadata(native);
        if (alias?.workspaceKind !== "projectless") {
          this.rememberWorkspaceRoot(stringValue(native.cwd, 4096));
        }
        thread = this.annotateThread(native);
        const recoveredSourcePaths = this.sourcePathsForThread(remoteThreadId, native);
        if (recoveredSourcePaths.length > 0) {
          this.threadSourcePaths.set(remoteThreadId, recoveredSourcePaths);
        }
      }
    }
    thread = (await annotateDesktopTaskActivity([thread], 1, {
      now: this.now,
      isThreadActive: threadId => this.verifyStaleTaskOwnerActivity(threadId),
    }))[0] ?? thread;
    const readTokenUsage = record(thread.latestTokenUsageInfo);
    if (readTokenUsage) {
      this.latestThreadTokenUsage.set(remoteThreadId, readTokenUsage);
    } else {
      const cachedTokenUsage = this.latestThreadTokenUsage.get(remoteThreadId);
      if (cachedTokenUsage) thread = { ...thread, latestTokenUsageInfo: cachedTokenUsage };
    }
    const detail = projectCodexThreadDetail(thread, ++this.sequence, { compactCompletedWork: true });
    const projected = record(detail.thread);
    if (!projected) return detail;
    const desktopInteraction = this.liveCompactionSources.has(remoteThreadId)
      || this.now() - (this.desktopInteractionObservedAt.get(remoteThreadId) ?? -Infinity) < 20_000
      ? this.desktopInteractions.get(remoteThreadId) : undefined;
    const desktopCompaction = desktopInteraction?.compaction;
    const desktopActiveTurnId = desktopCompaction?.active ? desktopCompaction.turnId
      : desktopInteraction?.activeTurnId;
    if (desktopActiveTurnId) {
      Object.assign(projected, this.projectLiveTurnLifecycle(projected, remoteThreadId, "turn/started", {
        turnId: desktopActiveTurnId, turn: { id: desktopActiveTurnId, status: "inProgress" },
      }));
    }
    if (desktopCompaction) {
      const existingCompaction = projectedRow(projected.activities, desktopCompaction.id)
        ?? this.supplementalActivities.get(remoteThreadId)?.find(row => row.id === desktopCompaction.id);
      const activity = projectCodexLiveTurnItem({
        threadId: remoteThreadId, turnId: desktopCompaction.turnId,
        item: { type: "contextCompaction", id: desktopCompaction.id, status: desktopCompaction.active ? "inProgress" : "completed" },
        completed: !desktopCompaction.active,
        sequence: finiteNumber(existingCompaction?.sequence) ?? this.nextProjectedTurnSequence(projected, desktopCompaction.turnId),
        createdAtMs: desktopCompaction.startedAt ?? this.now(),
      }).activity;
      if (activity) this.rememberSupplementalActivity(remoteThreadId, activity);
    }
    const liveProjectedThread = record(this.threadStreams.get(remoteThreadId)?.detail.thread);
    const liveProjectedSession = record(liveProjectedThread?.session);
    const liveProjectedLatestTurn = record(liveProjectedThread?.latestTurn);
    const authoritativeSession = record(projected.session);
    const authoritativeLatestTurn = record(projected.latestTurn);
    const authoritativeStillActive =
      turnStatusIsActive(authoritativeSession?.status)
      || turnStatusIsActive(authoritativeLatestTurn?.state);
    const authoritativeLatestTurnId = stringValue(authoritativeLatestTurn?.turnId, 128);
    const liveProjectedActiveTurnId = stringValue(liveProjectedSession?.activeTurnId, 128);
    const liveProjectedLatestTurnId = stringValue(liveProjectedLatestTurn?.turnId, 128);
    const authoritativeLifecycleAt = this.liveThreadLifecycleEvidence(projected);
    const liveLifecycleAt = liveProjectedThread
      ? this.liveThreadLifecycleEvidence(liveProjectedThread)
      : Number.NEGATIVE_INFINITY;
    const authoritativeTurns = canonicalTurnsNewestFirst(thread.turns);
    const liveTurnIds = new Set([
      liveProjectedActiveTurnId,
      liveProjectedLatestTurnId,
    ].filter(Boolean));
    const liveTurnIsOlderInAuthoritativeHistory = authoritativeTurns.some((turn, index) =>
      index > 0 && liveTurnIds.has(canonicalTurnId(turn)));
    const liveUpdatedAt = Date.parse(stringValue(liveProjectedThread?.updatedAt, 64));
    const liveProjectionIsFresh = Number.isFinite(liveUpdatedAt)
      && this.now() - liveUpdatedAt <= PROJECTED_ACTIVE_FALLBACK_FRESH_MS;
    // Windows' secondary reader can call a Desktop-owned turn interrupted
    // without observing a stop. Fresh work from that exact open rollout wins;
    // a dated terminal record or a newer turn still wins over the live cache.
    const liveProgressSupersedesInterruptedRead = liveProjectionIsFresh
      && !liveTurnIsOlderInAuthoritativeHistory
      && authoritativeLatestTurnId === liveProjectedActiveTurnId
      && authoritativeLatestTurn?.state === "interrupted"
      && !authoritativeLatestTurn.completedAt
      && this.desktopSessions.isWatching(remoteThreadId)
      && this.desktopSessions.activeTurnId?.(remoteThreadId) === liveProjectedActiveTurnId;
    const authoritativeTerminalSupersedesLive =
      authoritativeLatestTurnId.length > 0
      && desktopStateStatusIsTerminal(authoritativeLatestTurn?.state)
      && !liveProgressSupersedesInterruptedRead
      && (
        authoritativeLatestTurnId === liveProjectedActiveTurnId
        || authoritativeLatestTurnId === liveProjectedLatestTurnId
        || liveTurnIsOlderInAuthoritativeHistory
        || (
          Number.isFinite(authoritativeLifecycleAt)
          && authoritativeLifecycleAt >= liveLifecycleAt
        )
      );
    let desktopStillActive = false;
    if (
      this.desktopSessions.isWatching(remoteThreadId)
      && turnStatusIsActive(liveProjectedSession?.status)
      && !authoritativeStillActive
      && !authoritativeTerminalSupersedesLive
      && !liveProjectionIsFresh
    ) {
      desktopStillActive = await this.isDesktopThreadActive(nativeId, { fresh: true }) === true;
    }
    if (
      this.desktopSessions.isWatching(remoteThreadId)
      && turnStatusIsActive(liveProjectedSession?.status)
      && thread.androidRemoteActivityUnverified !== true
      && !authoritativeTerminalSupersedesLive
      && (
        authoritativeStillActive
        || liveProjectionIsFresh
        || desktopStillActive
      )
    ) {
      // A Desktop-owned running turn exists only in Desktop's app-server and
      // append-only session stream. The private app-server can still return an
      // idle disk snapshot at this boundary. Keep a recent or independently
      // confirmed live ownership state while accepting authoritative history
      // replacements such as Edit and Resend. An old unconfirmed running
      // projection must not survive a terminal session-file marker forever,
      // and a durable terminal marker for the same turn wins immediately.
      projected.session = {
        ...(record(projected.session) ?? {}),
        ...liveProjectedSession,
        threadId: remoteThreadId,
      };
      if (turnStatusIsActive(liveProjectedLatestTurn?.state)) {
        projected.latestTurn = {
          ...(record(projected.latestTurn) ?? {}),
          ...liveProjectedLatestTurn,
        };
      }
    }
    const providerUsage = this.providerUsageActivity(thread, remoteThreadId, stringValue(projected.updatedAt));
    if (providerUsage) {
      projected.activities = this.upsertProjectedActivity(projected.activities, providerUsage);
    }
    const completedMessageIds = this.completedLiveMessageIds.get(remoteThreadId);
    if (completedMessageIds) {
      projected.messages = projectedRows(projected.messages).map(message =>
        completedMessageIds.has(stringValue(message.id, 128))
          ? { ...message, streaming: false }
          : message);
      if (stringValue(record(projected.session)?.status, 64) !== "running") {
        this.completedLiveMessageIds.delete(remoteThreadId);
      }
    }
    const recoveredInteractions = readDesktopInteractions(thread);
    for (const id of recoveredInteractions.answeredIds) this.answeredDesktopQuestions.add(id);
    for (const group of recoveredInteractions.questions) {
      const questions = group.questions.filter(question => !this.answeredDesktopQuestions.has(question.id));
      if (questions.length) this.rememberDesktopPendingUserInput({
        nativeThreadId: this.nativeThreadId(remoteThreadId), remoteThreadId,
        itemId: group.itemId, callId: group.itemId, turnId: group.turnId,
        requestedAt: group.requestedAt, sequence: group.sequence, questions,
      });
    }
    for (const [requestId, input] of this.pendingDesktopUserInputs) {
      if (input.remoteThreadId !== remoteThreadId || !this.isAsyncDesktopQuestion(input)) continue;
      if (!input.questions.every(question => this.answeredDesktopQuestions.has(stringValue(question.id, 128)))) continue;
      this.forgetDesktopPendingUserInput(requestId);
      this.forgetSupplementalActivity(remoteThreadId, stringValue(input.activity.id, 128));
    }
    const recoveredDesktopInput = this.rememberDesktopPendingUserInputFromThread(thread, remoteThreadId);
    const pending = [...this.pendingRequests.values()]
      .filter(row => row.remoteThreadId === remoteThreadId)
      .map(row => row.activity);
    pending.push(...[...this.pendingDesktopUserInputs.values()]
      .filter(row => row.remoteThreadId === remoteThreadId && this.isAsyncDesktopQuestion(row))
      .map(row => row.activity));
    if (
      recoveredDesktopInput
      && !pending.some(activity => activity.kind === "user-input.requested")
    ) {
      pending.push(recoveredDesktopInput.activity);
    }
    const supplemental = this.supplementalActivities.get(remoteThreadId) ?? [];
    const activities = Array.isArray(projected.activities) ? projected.activities : [];
    let mergedActivities: unknown = activities;
    for (const activity of [...pending, ...supplemental]) {
      mergedActivities = this.upsertProjectedActivity(mergedActivities, activity);
    }
    projected.activities = mergedActivities;
    let mergedPlans: unknown = projected.proposedPlans;
    const finalizedPlanSourceItemIds = new Set<string>();
    for (const plan of this.supplementalPlans.get(remoteThreadId) ?? []) {
      const sourceItemId = stringValue(plan._androidRemoteSourceItemId, 128);
      if (sourceItemId) finalizedPlanSourceItemIds.add(sourceItemId);
      const publicPlan = { ...plan };
      delete publicPlan._androidRemoteSourceItemId;
      mergedPlans = this.upsertProjectedRow(mergedPlans, publicPlan);
    }
    if (finalizedPlanSourceItemIds.size > 0) {
      projected.messages = projectedRows(projected.messages).filter(message =>
        !finalizedPlanSourceItemIds.has(stringValue(message.id, 128)));
    }
    projected.proposedPlans = mergedPlans;
    projected.hasActionableProposedPlan = projectedRows(mergedPlans).some(plan =>
      plan.implementedAt === null);
    projected.messages = this.mergeDurableDesktopUserMessages(
      projected.messages,
      remoteThreadId,
      stringValue(record(projected.latestTurn)?.turnId, 128)
        || stringValue(liveProjectedLatestTurn?.turnId, 128),
    );
    projected.messages = this.messagesWithQueuedTurns(projected.messages, remoteThreadId);
    projected.hasPendingApprovals = pending.some(row => row.kind === "approval.requested");
    projected.hasPendingUserInput = this.hasUnresolvedUserInput([...pending, ...supplemental]);
    if (options.boundedInitial && this.windowsHistoryBackfills.has(remoteThreadId)) {
      projected.historyPage = { olderCursor: projectedThreadStartCursor(detail) };
    }
    const previous = this.threadStreams.get(remoteThreadId)?.detail;
    return options.boundedInitial && !options.allowEmptyHistory && previous
      ? mergeBoundedThreadDetail(previous, detail) : detail;
  }

  private async finishWindowsHistoryBackfill(threadId: string): Promise<void> {
    const existing = this.windowsHistoryBackfillFlights.get(threadId);
    if (existing) return existing;
    if (!this.windowsHistoryBackfills.has(threadId) || !this.threadStreams.has(threadId)) return;
    const flight = (async () => {
      const detail = await this.readFullThreadDetail(threadId, { savedHistory: true });
      const current = this.threadStreams.get(threadId);
      if (!current || !this.windowsHistoryBackfills.has(threadId)) return;
      const advanced = advanceProjectedThreadStream(current, detail, this.now());
      this.threadStreams.set(threadId, advanced.state);
      this.windowsHistoryBackfills.delete(threadId);
      for (const ws of this.sockets) {
        if (ws.data.subscription !== "thread" || ws.data.threadId !== threadId) continue;
        // Keep the delivered page small; older work remains available by cursor.
        this.publishSubscriptionEvent(ws, projectedThreadBoundedSnapshot(advanced.state), true);
      }
    })();
    this.windowsHistoryBackfillFlights.set(threadId, flight);
    try { await flight; }
    finally { this.windowsHistoryBackfillFlights.delete(threadId); }
  }

  private async ensureThreadStream(remoteThreadId: string): Promise<ProjectedThreadStreamState> {
    const existing = this.threadStreams.get(remoteThreadId);
    if (existing) {
      const touched = { ...existing, touchedAt: this.now() };
      this.threadStreams.set(remoteThreadId, touched);
      const sourcePath = (await this.latestSourcePathsForThread(
        remoteThreadId,
        record(touched.detail.thread) ?? undefined,
      )).at(-1) ?? "";
      if (sourcePath) {
        await this.ensureDesktopSessionWatch(remoteThreadId, sourcePath);
      }
      // Starting a watcher can replay the unfinished Desktop turn. Return the
      // state after that replay, never the older state captured above.
      return this.threadStreams.get(remoteThreadId) ?? touched;
    }
    const detail = await this.readFullThreadDetail(remoteThreadId, { boundedInitial: true });
    const created = createProjectedThreadStreamState(detail, this.now());
    this.threadStreams.set(remoteThreadId, created);
    const sourcePath = (await this.latestSourcePathsForThread(
      remoteThreadId,
      record(created.detail.thread) ?? undefined,
    )).at(-1) ?? "";
    if (sourcePath) {
      await this.ensureDesktopSessionWatch(remoteThreadId, sourcePath);
    }
    this.pruneThreadStreams();
    // activeTail() may have replayed a running Desktop turn while the watcher
    // was being installed. The first Android snapshot must include it.
    return this.threadStreams.get(remoteThreadId) ?? created;
  }

  private async ensureDesktopSessionWatch(remoteThreadId: string, sourcePath: string): Promise<boolean> {
    const normalizedSourcePath = sourcePath.trim();
    if (!normalizedSourcePath) return false;
    const nativeThreadId = this.nativeThreadId(remoteThreadId);
    const previousSourcePath = this.desktopSessionSourcePaths.get(remoteThreadId);
    const sourceChanged =
      previousSourcePath !== undefined
      && previousSourcePath !== normalizedSourcePath;
    if (sourceChanged) {
      // A continuation/rollback can move the logical task to a new physical
      // rollout. Do not let the old rollout's active id, probe cache, or
      // notification label survive that move while the new tail is replayed.
      this.forgetKnownActiveTurn(nativeThreadId);
      this.desktopActiveTurnProbes.delete(nativeThreadId);
      this.desktopThreadActivityCache.delete(nativeThreadId);
      this.projectedActivityReconciledAt.delete(remoteThreadId);
    }
    const current = this.desktopSessionStarts.get(remoteThreadId);
    if (current) {
      if (this.desktopSessionStartPaths.get(remoteThreadId) === normalizedSourcePath) {
        const watching = await current;
        if (watching) this.syncKnownActiveTurnFromDesktopSession(remoteThreadId);
        return watching;
      }
      await current.catch(() => false);
      return this.ensureDesktopSessionWatch(remoteThreadId, normalizedSourcePath);
    }
    if (
      this.desktopSessions.isWatching(remoteThreadId)
      && this.desktopSessionSourcePaths.get(remoteThreadId) === normalizedSourcePath
    ) {
      // The detailed projected stream may have been evicted while the same
      // watcher stayed alive for shell/background notifications. Restore the
      // canonical turn id from the watcher's bounded projector before any
      // steer/stop probe runs; do not reread the rollout or private writer.
      this.syncKnownActiveTurnFromDesktopSession(remoteThreadId);
      return true;
    }
    this.desktopSessionInstallations.add(remoteThreadId);
    this.desktopSessionStartPaths.set(remoteThreadId, normalizedSourcePath);
    const started = this.desktopSessions.watchThread({
      threadId: remoteThreadId,
      sourcePath: normalizedSourcePath,
      onMessage: message => this.onDesktopSessionMessage(message),
    });
    this.desktopSessionStarts.set(remoteThreadId, started);
    try {
      const watching = await started;
      if (watching) {
        this.desktopSessionSourcePaths.set(remoteThreadId, normalizedSourcePath);
        const orderedPaths = await resolveThreadSourcePaths(
          nativeThreadId,
          [
            ...(this.threadSourcePaths.get(remoteThreadId) ?? []),
            normalizedSourcePath,
          ],
          { now: this.now, discover: false },
        );
        this.threadSourcePaths.set(
          remoteThreadId,
          orderedPaths.length > 0
            ? orderedPaths
            : [
                ...(this.threadSourcePaths.get(remoteThreadId) ?? [])
                  .filter(path => path !== normalizedSourcePath),
                normalizedSourcePath,
              ],
        );
        this.syncKnownActiveTurnFromDesktopSession(remoteThreadId);
        if (sourceChanged) {
          this.shellCache = null;
          this.scheduleShellRefresh();
          if (this.threadStreams.has(remoteThreadId)) {
            this.requestAuthoritativeThreadRefresh(remoteThreadId);
          }
        }
      }
      return watching;
    } finally {
      this.desktopSessionStarts.delete(remoteThreadId);
      this.desktopSessionStartPaths.delete(remoteThreadId);
      this.desktopSessionInstallations.delete(remoteThreadId);
    }
  }

  private syncKnownActiveTurnFromDesktopSession(remoteThreadId: string): void {
    const activeTurnId = this.desktopSessions.activeTurnId?.(remoteThreadId);
    // Compatibility streams supplied by older callers/tests do not expose a
    // projector snapshot. Leave their existing knowledge untouched.
    if (activeTurnId === undefined) return;
    const nativeThreadId = this.nativeThreadId(remoteThreadId);
    if (activeTurnId) {
      this.rememberKnownActiveTurn(nativeThreadId, activeTurnId);
    } else {
      this.forgetKnownActiveTurn(nativeThreadId);
    }
  }

  /**
   * Ensure a selected task has a watcher before probing activity or resolving
   * a Stop/Steer turn id. The watcher is the only source that can observe a
   * Desktop-owned rollout without asking the private writer to reread its
   * (possibly locked) transcript.
   */
  private async ensureDesktopSessionWatchForThread(remoteThreadId: string): Promise<boolean> {
    const thread = record(this.threadStreams.get(remoteThreadId)?.detail.thread);
    const sourcePath = (await this.latestSourcePathsForThread(
      remoteThreadId,
      thread ?? undefined,
    )).at(-1) ?? "";
    if (!sourcePath) return false;
    return this.ensureDesktopSessionWatch(remoteThreadId, sourcePath);
  }

  /**
   * Follow active Desktop rollouts even when their chat is not selected on the
   * phone. The append stream is the same source used for the Android timeline,
   * so background notification labels do not come from a separate poll or UI
   * guess.
   */
  private async synchronizeShellActivityWatches(
    threads: readonly JsonRecord[],
  ): Promise<JsonRecord[]> {
    const sourceReconciliationIds = new Set(
      threads
        .filter(thread =>
          !stringValue(thread.androidRemoteArchivedAt, 64)
          && listedThreadHasActiveTurn(thread))
        .slice(0, MAX_SHELL_ACTIVITY_WATCHES)
        .map(thread => stringValue(thread.id, 128))
        .filter(Boolean),
    );
    const reconciledThreads = await Promise.all(threads.map(async thread => {
      const threadId = stringValue(thread.id, 128);
      if (!sourceReconciliationIds.has(threadId)) return thread;
      const sourcePaths = await this.latestSourcePathsForThread(threadId, thread);
      if (sourcePaths.length === 0) return thread;
      const sourcedThread: JsonRecord = {
        ...thread,
        path: sourcePaths.at(-1),
        androidRemoteSourcePaths: sourcePaths,
      };
      // The first annotation used only paths returned by thread/list. Re-run
      // this one candidate after sibling discovery so a continuation's
      // task_complete marker corrects the same shell snapshot immediately,
      // rather than waiting for the minute-scale safety refresh.
      return (await annotateDesktopTaskActivity([sourcedThread], 1, {
        now: this.now,
        isThreadActive: nativeThreadId => this.verifyStaleTaskOwnerActivity(nativeThreadId),
      }))[0] ?? sourcedThread;
    }));

    const activeThreadIds = new Set<string>();
    const candidates: Array<{ threadId: string; thread: JsonRecord }> = [];
    for (const thread of reconciledThreads) {
      const threadId = stringValue(thread.id, 128);
      if (
        !threadId
        || stringValue(thread.androidRemoteArchivedAt, 64)
        || !listedThreadHasActiveTurn(thread)
      ) {
        continue;
      }
      activeThreadIds.add(threadId);
      if (candidates.length < MAX_SHELL_ACTIVITY_WATCHES) {
        candidates.push({ threadId, thread });
      }
    }

    const installed = await Promise.all(candidates.map(async candidate => {
      const sourcePath = this.primarySourcePath(candidate.threadId, candidate.thread);
      return {
        threadId: candidate.threadId,
        watching: sourcePath
          ? await this.ensureDesktopSessionWatch(candidate.threadId, sourcePath)
          : false,
      };
    }));
    const nextWatchIds = new Set(
      installed.flatMap(result => result.watching ? [result.threadId] : []),
    );
    for (const threadId of this.shellActivityWatchIds) {
      if (nextWatchIds.has(threadId)) continue;
      this.shellActivityWatchIds.delete(threadId);
      if (!this.threadStreams.has(threadId)) this.desktopSessions.unwatchThread(threadId);
    }
    for (const threadId of nextWatchIds) this.shellActivityWatchIds.add(threadId);

    // A terminal shell row is authoritative even if a final duplicate event
    // was missed while Desktop or the filesystem watcher was reconnecting.
    for (const threadId of this.liveNotificationActivities.keys()) {
      if (!activeThreadIds.has(threadId)) this.liveNotificationActivities.delete(threadId);
    }
    return reconciledThreads;
  }

  private evictThreadStream(threadId: string): void {
    const keepDesktopSessionWatch = this.shellActivityWatchIds.has(threadId)
      && this.desktopSessions.isWatching(threadId);
    this.threadStreams.delete(threadId);
    this.desktopThreadSettings.delete(threadId);
    this.nativeThreadModelProviders.delete(threadId);
    this.forgetDurableDesktopUserMessages(threadId);
    this.desktopSessionStartPaths.delete(threadId);
    this.projectedActivityReconciledAt.delete(threadId);
    if (keepDesktopSessionWatch) {
      // Shell-only watchers remain the live source for notifications and Stop/
      // Steer probes. Retain their canonical rollout path and active turn
      // knowledge when the selected-task stream is evicted.
      if (!this.threadSourcePaths.has(threadId)) {
        const sourcePath = this.desktopSessionSourcePaths.get(threadId);
        if (sourcePath) this.threadSourcePaths.set(threadId, [sourcePath]);
      }
      this.syncKnownActiveTurnFromDesktopSession(threadId);
    } else {
      this.threadSourcePaths.delete(threadId);
      this.knownActiveTurnIds.delete(this.nativeThreadId(threadId));
      this.desktopActiveTurnProbes.delete(this.nativeThreadId(threadId));
      this.desktopActiveTurnProbeReads.delete(this.nativeThreadId(threadId));
      this.desktopSessionSourcePaths.delete(threadId);
      this.desktopSessions.unwatchThread(threadId);
    }
  }

  private pruneThreadStreams(): void {
    const now = this.now();
    const activeThreadIds = new Set(
      [...this.sockets]
        .filter(ws => ws.data.subscription === "thread" && ws.data.threadId)
        .map(ws => ws.data.threadId!),
    );
    for (const [threadId, state] of this.threadStreams) {
      if (
        !activeThreadIds.has(threadId) &&
        now - state.touchedAt > THREAD_STREAM_CACHE_TTL_MS
      ) {
        this.evictThreadStream(threadId);
      }
    }
    if (this.threadStreams.size <= THREAD_STREAM_CACHE_LIMIT) return;
    const removable = [...this.threadStreams.entries()]
      .filter(([threadId]) => !activeThreadIds.has(threadId))
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt);
    for (const [threadId] of removable) {
      if (this.threadStreams.size <= THREAD_STREAM_CACHE_LIMIT) break;
      this.evictThreadStream(threadId);
    }
  }

  private async readModel(): Promise<JsonRecord> {
    const desktopWorkspace = await this.desktopWorkspaceReader(await this.listCodexThreads());
    const threads = await annotateDesktopTaskActivity(
      desktopWorkspace.threads,
      undefined,
      {
        now: this.now,
        isThreadActive: threadId => this.verifyStaleTaskOwnerActivity(threadId),
      },
    );
    return projectCodexReadModel(threads, ++this.sequence);
  }

  /**
   * Read one bounded Desktop state and derive both activity and the canonical
   * running-turn id from that same response. Desktop may publish the activity
   * shell before its turn entity, so retry only while the response is
   * explicitly active but still lacks an id.
   */
  private async readDesktopActiveTurn(
    nativeThreadId: string,
    options: { fresh?: boolean } = {},
  ): Promise<DesktopActiveTurnProbe> {
    const cached = this.desktopActiveTurnProbes.get(nativeThreadId);
    if (!options.fresh && cached && cached.expiresAt > this.now()) return cached;
    const inFlight = this.desktopActiveTurnProbeReads.get(nativeThreadId);
    if (inFlight) return inFlight;
    const readFollowerThreadState = this.desktopIpc.readFollowerThreadState;
    if (!readFollowerThreadState) {
      return { active: null, turnId: "", expiresAt: this.now() + 100 };
    }

    const read = (async (): Promise<DesktopActiveTurnProbe> => {
      let latest: DesktopActiveTurnProbe = {
        active: null,
        turnId: "",
        expiresAt: this.now() + 100,
      };
      for (let attempt = 0; attempt < DESKTOP_ACTIVE_TURN_PROBE_RETRY_DELAYS_MS.length; attempt += 1) {
        if (attempt > 0) {
          const delay = DESKTOP_ACTIVE_TURN_PROBE_RETRY_DELAYS_MS[attempt] ?? 0;
          if (delay > 0) await new Promise<void>(resolvePromise => setTimeout(resolvePromise, delay));
        }
        try {
          const state = await readFollowerThreadState.call(
            this.desktopIpc,
            nativeThreadId,
            options.fresh || attempt > 0 ? { fresh: true } : undefined,
          );
          if (!state) {
            latest = { active: null, turnId: "", expiresAt: this.now() + 100 };
            break;
          }
          const turnId = state.androidRemoteHistoryOnly === true ? "" : activeTurnIdFromDesktopState(state);
          const active = turnId ? true : desktopConversationIsActive(state);
          latest = {
            active,
            turnId,
            expiresAt: this.now() + (
              active === true
                ? DESKTOP_ACTIVE_TURN_PROBE_CACHE_MS
                : active === false
                  ? 250
                  : 100
            ),
          };
          if (turnId || active !== true) break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          latest = {
            // A router-level no-client result proves that the Desktop route
            // is absent. A missing published snapshot does not: the renderer
            // may still own the writer while remounting, so preserve `null`
            // and let the existing ownership/known-turn fallback decide.
            active: /(?:no-client-found|conversation-not-owned)/iu.test(message)
              ? false
              : null,
            turnId: "",
            expiresAt: this.now() + 100,
          };
          break;
        }
      }
      this.desktopActiveTurnProbes.set(nativeThreadId, latest);
      return latest;
    })().finally(() => {
      this.desktopActiveTurnProbeReads.delete(nativeThreadId);
    });
    this.desktopActiveTurnProbeReads.set(nativeThreadId, read);
    return read;
  }

  private async verifyStaleTaskOwnerActivity(threadId: string): Promise<boolean | null> {
    // Called only after rollout progress is stale. The append watcher replays
    // that same rollout, so its open turn cannot independently verify the old
    // task_started record (an abandoned Windows task otherwise lives forever).
    const ownership = fallbackOwnershipState(this.desktopIpc, threadId);
    if (ownership.state === "local-owned") return this.codexThreadIsActive(threadId);
    return this.isDesktopThreadActive(threadId, { refreshOwner: true });
  }

  private async isOwningRuntimeThreadActive(threadId: string): Promise<boolean | null> {
    const remoteThreadId = this.remoteThreadId(threadId);
    if (this.desktopSessions.isWatching(remoteThreadId)) {
      const watchedTurnId = this.desktopSessions.activeTurnId?.(remoteThreadId);
      // Use the same start/stop evidence as Stop and message routing. Silence
      // during a long command is not an interruption, and Windows' secondary
      // reader cannot verify a turn owned by the Desktop process.
      if (watchedTurnId !== undefined) return Boolean(watchedTurnId);
    }
    const ownership = fallbackOwnershipState(this.desktopIpc, threadId);
    if (ownership.state === "local-owned") return this.codexThreadIsActive(threadId);
    return this.isDesktopThreadActive(threadId);
  }

  private async isDesktopThreadActive(
    threadId: string,
    options: { fresh?: boolean; refreshOwner?: boolean } = {},
  ): Promise<boolean | null> {
    const remoteThreadId = this.remoteThreadId(threadId);
    if (this.liveCompactionSources.has(remoteThreadId)
      && this.desktopInteractions.get(remoteThreadId)?.compaction?.active) return true;
    const cached = this.desktopThreadActivityCache.get(threadId);
    if (!options.fresh && cached && cached.expiresAt > this.now()) return cached.active;
    const inFlight = this.desktopThreadActivityReads.get(threadId);
    if (inFlight) return inFlight;
    const readFollowerThreadState = this.desktopIpc.readFollowerThreadState;
    if (!readFollowerThreadState) return null;
    const read = (async (): Promise<boolean | null> => {
      let active: boolean | null;
      try {
        active = desktopConversationIsActive(
          await readFollowerThreadState.call(
            this.desktopIpc,
            threadId,
            options.fresh || options.refreshOwner ? { fresh: true } : undefined,
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        active = /(?:no-client-found|conversation-not-owned)/iu.test(message) ? false : null;
      }
      const cacheMs = active === false ? 30_000 : active === true ? 10_000 : 2_000;
      this.desktopThreadActivityCache.set(threadId, {
        active,
        expiresAt: this.now() + cacheMs,
      });
      return active;
    })().finally(() => this.desktopThreadActivityReads.delete(threadId));
    this.desktopThreadActivityReads.set(threadId, read);
    return read;
  }

  private async serverConfig(): Promise<JsonRecord> {
    const nativeCatalog = this.nativeModelCatalog();
    if (nativeCatalog?.version !== this.nativeCatalogVersion) {
      this.nativeCatalogVersion = nativeCatalog?.version;
      this.configCache = null;
    }
    const directProvider = this.desktopDirectModelProvider();
    if (directProvider !== this.catalogDesktopProvider) {
      this.catalogDesktopProvider = directProvider;
      this.configCache = null;
    }
    if (this.configCache && this.configCache.expiresAt > this.now()) return this.configCache.value;
    const client = this.requireCodex();
    let routedModelAccessEnabled = false;
    try {
      routedModelAccessEnabled = this.routedModelAccessEnabled();
    } catch {
      // An unreadable desired-state config must fail toward native-only, never
      // expose stale routed selectors from the app-server cache.
    }
    const codexModels: JsonRecord[] = [];
    let catalogRefreshFailed = false;
    const catalogRowsPromise = this.listModels
      ? this.listModels().catch(error => {
          catalogRefreshFailed = true;
          console.warn(`[remodex] Android Remote could not refresh the Remodex model catalog: ${error instanceof Error ? error.message : String(error)}`);
          // Keep the last known catalog during a transient desktop/network
          // restart. Publishing [] makes Android hide every provider even
          // though the previous catalog is still valid.
          return this.managementModelRows;
        })
      : Promise.resolve([] as readonly ManagementModelRow[]);
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const response = record(await client.request("model/list", { limit: 100, cursor, includeHidden: false }));
      for (const raw of Array.isArray(response?.data) ? response.data : []) {
        const model = record(raw);
        if (!model || !stringValue(model.model, 256)) continue;
        codexModels.push(model);
      }
      cursor = stringValue(response?.nextCursor, 4096) || null;
      if (!cursor) break;
    }
    const cwd = process.cwd();
    const [skills, plugins, listedCatalogRows] = await Promise.all([
      this.readCodexSkills(client, cwd),
      this.readCodexPlugins(client, cwd),
      catalogRowsPromise,
    ]);
    const catalogRows = replaceObservedNativeModelRows(listedCatalogRows, nativeCatalog);
    const nativeListProvider = client.directModelProvider === undefined ? directProvider : client.directModelProvider;
    this.liveCodexModelRows.clear();
    for (const model of codexModels) {
      const selector = stringValue(model.model, 256);
      const qualified = nativeListProvider && nativeListProvider !== "openai" && !selector.includes("/")
        ? routedSlug(nativeListProvider, selector) : selector;
      if (selector) this.liveCodexModelRows.set(qualified, model);
    }
    this.managementModelRows = catalogRows;
    this.revalidateStoredTaskSelectionsAfterModelCatalogRefresh();
    this.reapplyDesktopThreadSettingsAfterModelCatalogRefresh();
    // Later canonical rows win selector collisions. This preserves Remodex routing
    // precedence (for example a combo intentionally taking over a native bare slug).
    const canonicalBySelector = new Map<string, ManagementModelRow>();
    for (const row of catalogRows) {
      const selector = stringValue(row.namespaced, 256);
      if (selector) canonicalBySelector.set(selector, row);
    }
    const projectedBySelector = new Map<string, { provider: string; model: JsonRecord; row?: ManagementModelRow }>();
    for (const model of codexModels) {
      const selector = stringValue(model.model, 256);
      // Bare native IDs describe the active Desktop provider, not necessarily ChatGPT.
      // Match its provider first when both connections offer the same model name.
      const row = nativeListProvider && !selector.includes("/")
        ? catalogRows.find(candidate => candidate.provider === nativeListProvider && candidate.id === selector)
        : canonicalBySelector.get(selector);
      if (nativeCatalog && !row && (!nativeListProvider || nativeListProvider === "openai") && !selector.includes("/")) continue;
      const provider = stringValue(row?.provider, 64) || nativeListProvider || "openai";
      if (directProvider && provider !== directProvider) continue;
      if (!this.isModelSourceVisible(provider)) continue;
      if (!selector || row?.disabled || row?.sourceVisible === false || projectedBySelector.has(selector)) continue;
      if (
        !routedModelAccessEnabled
        && row?.native !== true
        && !(/^gpt-/iu.test(selector) && !selector.includes("/"))
      ) continue;
      const qualifiedSelector = row?.namespaced || (provider !== "openai" && !selector.includes("/") ? routedSlug(provider, selector) : selector);
      projectedBySelector.set(qualifiedSelector, {
        provider,
        model,
        ...(row ? { row } : {}),
      });
    }
    // The canonical list covers newly configured/custom models even when the private
    // Codex app-server still has an older in-memory model list.
    for (const row of catalogRows) {
      const selector = stringValue(row.namespaced, 256);
      if (directProvider && row.provider !== directProvider) continue;
      if (!this.isModelSourceVisible(row.provider)) continue;
      if (!selector || row.disabled || row.sourceVisible === false || projectedBySelector.has(selector)) continue;
      if (!routedModelAccessEnabled && row.native !== true) continue;
      projectedBySelector.set(selector, {
        provider: stringValue(row.provider, 64) || "openai",
        model: {},
        row,
      });
    }
    const modelsByProvider = new Map<string, JsonRecord[]>();
    for (const [selector, projected] of projectedBySelector) {
      const rows = modelsByProvider.get(projected.provider) ?? [];
      rows.push({
        slug: selector,
        name: stringValue(projected.row?.pickerDisplayName, 256)
          || stringValue(projected.model.displayName, 256)
          || stringValue(projected.row?.displayName, 256)
          || stringValue(projected.row?.id, 256)
          || selector,
        isCustom: projected.row?.custom === true,
        capabilities: codexModelCapabilities(projected.model, projected.row),
      });
      modelsByProvider.set(projected.provider, rows);
    }
    const configuredProviderOrder = this.listModelProviderOrder?.() ?? [];
    const configuredProviderRanks = new Map(
      configuredProviderOrder.map((provider, index) => [provider, index] as const),
    );
    const orderedProviderRows = [...modelsByProvider.entries()]
      .map(([provider, models], firstSeenOrder) => ({ provider, models, firstSeenOrder }))
      .sort((left, right) => {
        if (left.provider === "openai" || right.provider === "openai") {
          return left.provider === "openai" ? -1 : 1;
        }
        const leftRank = configuredProviderRanks.get(left.provider) ?? Number.MAX_SAFE_INTEGER;
        const rightRank = configuredProviderRanks.get(right.provider) ?? Number.MAX_SAFE_INTEGER;
        return leftRank - rightRank || left.firstSeenOrder - right.firstSeenOrder;
      });
    const now = new Date(this.now()).toISOString();
    const providers = orderedProviderRows.map(({ provider, models }) => ({
      instanceId: androidProviderInstanceId(provider),
      driver: "codex",
      displayName: openCodexProviderDisplayName(provider),
      showInteractionModeToggle: true,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "unknown", type: "Codex" },
      message: "Model list loaded. Account access is checked when a request is sent.",
      checkedAt: now,
      availability: "available",
      models,
      slashCommands: [],
      skills,
      plugins,
    }));
    const providerInstances = Object.fromEntries(orderedProviderRows.map(({ provider }) => [
      androidProviderInstanceId(provider),
      {
        driver: "codex",
        displayName: openCodexProviderDisplayName(provider),
        enabled: true,
      },
    ]));
    const value: JsonRecord = {
      environment: this.environmentDescriptor(),
      auth: this.authDescriptor(),
      cwd,
      keybindingsConfigPath: join(cwd, ".codex", "keybindings.json"),
      keybindings: [],
      issues: [],
      providers,
      availableEditors: [],
      observability: {
        logsDirectoryPath: join(getConfigDir(), "logs"),
        localTracingEnabled: false,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      },
      settings: {
        addProjectBaseDirectory: cwd,
        providerInstances,
        providers: {
          codex: { enabled: true },
        },
      },
      remodexMobileConnection: this.mobileConnectionState(),
    };
    // An empty cold-start result is not a warm catalog. Let subscription polls
    // and phone recovery requests retry promptly after discovery's cooldown.
    const cacheMs = providers.length === 0 || catalogRefreshFailed ? 1500 : SERVER_CONFIG_CACHE_MS;
    this.configCache = { expiresAt: this.now() + cacheMs, value };
    return value;
  }

  /** Read the same skill/plugin-backed entries that Codex Desktop exposes to its composer. */
  private async readCodexSkills(client: AndroidCodexClient, cwd: string): Promise<JsonRecord[]> {
    try {
      const response = record(await client.request("skills/list", { cwds: [cwd] }));
      const entries = Array.isArray(response?.data) ? response.data : [];
      const matching = entries.find(entry => record(entry)?.cwd === cwd);
      const matchingSkills = matching ? record(matching)?.skills : undefined;
      const rawSkills: unknown[] = Array.isArray(matchingSkills)
        ? matchingSkills
        : entries.flatMap(entry => {
            const row = record(entry);
            return Array.isArray(row?.skills) ? row.skills : [];
          });
      return rawSkills.flatMap(raw => {
        const skill = record(raw);
        const name = stringValue(skill?.name, 256);
        const path = stringValue(skill?.path, 4096);
        if (!name || !path) return [];
        const result: JsonRecord = {
          name,
          path,
          enabled: skill?.enabled !== false,
        };
        const skillInterface = record(skill?.interface);
        for (const [source, target] of [
          ["description", "description"],
          ["scope", "scope"],
        ] as const) {
          const value = stringValue(skill?.[source], 2_000);
          if (value) result[target] = value;
        }
        const displayName =
          stringValue(skill?.displayName, 2_000) || stringValue(skillInterface?.displayName, 2_000);
        const shortDescription =
          stringValue(skill?.shortDescription, 2_000) ||
          stringValue(skillInterface?.shortDescription, 2_000);
        if (displayName) result.displayName = displayName;
        if (shortDescription) result.shortDescription = shortDescription;
        return [result];
      });
    } catch {
      // Older Codex app-server builds may not implement skills/list. The rest
      // of the composer must still work in that case.
      return [];
    }
  }

  /** Read every installed Codex plugin, including plugins that have no skill file. */
  private async readCodexPlugins(client: AndroidCodexClient, cwd: string): Promise<JsonRecord[]> {
    try {
      let rawResponse: unknown;
      try {
        rawResponse = await client.request("plugin/installed", { cwds: [cwd] });
      } catch {
        rawResponse = await client.request("plugin/list", { cwds: [cwd] });
      }
      const response = record(rawResponse);
      const marketplaces = Array.isArray(response?.marketplaces) ? response.marketplaces : [];
      return marketplaces.flatMap((rawMarketplace) => {
        const marketplace = record(rawMarketplace);
        const marketplaceName = stringValue(marketplace?.name, 256);
        const plugins = Array.isArray(marketplace?.plugins) ? marketplace.plugins : [];
        return plugins.flatMap((rawPlugin) => {
          const plugin = record(rawPlugin);
          if (plugin?.installed !== true) return [];
          const id = stringValue(plugin?.id, 512) || stringValue(plugin?.name, 512);
          const name = stringValue(plugin?.name, 512);
          if (!id || !name) return [];
          const pluginInterface = record(plugin?.interface);
          const description =
            stringValue(pluginInterface?.shortDescription, 2_000) ||
            stringValue(pluginInterface?.description, 2_000);
          const source = record(plugin?.source);
          const skills = Array.isArray(plugin?.skills) ? plugin.skills.length : 0;
          const apps = Array.isArray(plugin?.apps) ? plugin.apps.length : 0;
          const mcpServers = Array.isArray(plugin?.mcpServers) ? plugin.mcpServers.length : 0;
          const hooks = Array.isArray(plugin?.hooks) ? plugin.hooks.length : 0;
          return [{
            id,
            name,
            ...(stringValue(pluginInterface?.displayName, 2_000)
              ? { displayName: stringValue(pluginInterface?.displayName, 2_000) }
              : {}),
            ...(description ? { description } : {}),
            ...(marketplaceName ? { marketplace: marketplaceName } : {}),
            ...(stringValue(source?.path, 4_096) ? { sourcePath: stringValue(source?.path, 4_096) } : {}),
            version: stringValue(plugin?.localVersion, 256) || null,
            enabled: plugin?.enabled !== false,
            installed: plugin?.installed === true,
            skillsCount: skills,
            appsCount: apps,
            mcpServersCount: mcpServers,
            hooksCount: hooks,
          }];
        });
      });
    } catch {
      // Older Codex app-server builds may not implement either plugin method.
      return [];
    }
  }

  private async dispatch(clientId: string, command: JsonRecord): Promise<{ sequence: number }> {
    const type = stringValue(command.type, 128);
    if (!type) throw new TypeError("command type is required");
    const durableMutation = durableMutationDescriptor(command);
    const deduplicationKey = this.dispatchDeduplicationKey(command);
    if (deduplicationKey) {
      this.pruneDispatchDeduplication();
      const recent = this.recentDispatches.get(deduplicationKey);
      if (recent && recent.expiresAt > this.now()) return recent.result;
      const inFlight = this.inFlightDispatches.get(deduplicationKey);
      if (inFlight) return inFlight;
    }
    const operation = durableMutation
      ? this.withThreadMutationLock(
          durableMutation.taskId,
          () => this.dispatchDurableMutation(clientId, command, durableMutation),
        )
      : (() => {
          const threadId = mutationThreadId(command);
          return threadId
            ? this.withThreadMutationLock(threadId, () => this.dispatchOnce(clientId, command))
            : this.dispatchOnce(clientId, command);
        })();
    if (!deduplicationKey) return operation;
    this.inFlightDispatches.set(deduplicationKey, operation);
    try {
      const result = await operation;
      this.recentDispatches.set(deduplicationKey, {
        result,
        expiresAt: this.now() + DISPATCH_DEDUP_TTL_MS,
      });
      this.pruneDispatchDeduplication();
      return result;
    } finally {
      this.inFlightDispatches.delete(deduplicationKey);
    }
  }

  private withThreadMutationLock<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.threadMutationFlights.get(taskId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.threadMutationFlights.set(taskId, tail);
    void tail.finally(() => {
      if (this.threadMutationFlights.get(taskId) === tail) {
        this.threadMutationFlights.delete(taskId);
      }
    });
    return current;
  }

  private async dispatchDurableMutation(
    clientId: string,
    command: JsonRecord,
    descriptor: DurableMutationDescriptor,
  ): Promise<{ sequence: number }> {
    const existing = this.mutationStore.get(descriptor.mutationId);
    if (
      existing
      && (
        existing.commandId !== descriptor.commandId
        || existing.payloadFingerprint !== descriptor.payloadFingerprint
      )
    ) {
      throw new Error("Android command id was reused with different content");
    }
    if (existing?.status === "accepted") {
      const sequence = existing.resultSequence ?? ++this.sequence;
      this.sequence = Math.max(this.sequence, sequence);
      if (existing.resultSequence === undefined) {
        this.mutationStore.update(existing.mutationId, { resultSequence: sequence });
      }
      return { sequence };
    }
    if (existing?.status === "failed") {
      throw new Error("This Android command already failed and will not be replayed automatically");
    }
    if (existing && (existing.status === "pending" || existing.status === "uncertain")) {
      if (await this.reconcileDurableMutation(existing)) {
        const sequence = existing.resultSequence ?? ++this.sequence;
        this.mutationStore.update(existing.mutationId, {
          status: "accepted",
          resultSequence: sequence,
        });
        return { sequence };
      }
      // A session-file item can arrive while the authoritative read above is
      // still in flight. The observer records that exact delivery directly in
      // the mutation journal; do not overwrite that late acceptance with an
      // uncertain retry result.
      const observed = this.mutationStore.get(existing.mutationId);
      if (observed?.status === "accepted") {
        const sequence = observed.resultSequence ?? ++this.sequence;
        this.sequence = Math.max(this.sequence, sequence);
        if (observed.resultSequence === undefined) {
          this.mutationStore.update(observed.mutationId, { resultSequence: sequence });
        }
        return { sequence };
      }
      this.mutationStore.update(existing.mutationId, { status: "uncertain" });
      throw new Error(UNCERTAIN_MUTATION_MESSAGE);
    }

    const started = this.mutationStore.put({
      ...descriptor,
      nativeThreadId: this.nativeThreadId(descriptor.taskId),
      status: "pending",
    });
    try {
      const result = await this.dispatchOnce(clientId, command);
      this.mutationStore.update(started.mutationId, {
        status: "accepted",
        nativeThreadId: this.nativeThreadId(descriptor.taskId),
        resultSequence: result.sequence,
      });
      return result;
    } catch (error) {
      if (await this.reconcileDurableMutation(
        this.mutationStore.get(started.mutationId) ?? started,
      )) {
        const result = { sequence: ++this.sequence };
        this.mutationStore.update(started.mutationId, {
          status: "accepted",
          nativeThreadId: this.nativeThreadId(descriptor.taskId),
          resultSequence: result.sequence,
        });
        return result;
      }
      // The authoritative session event may have won the race after the
      // failed transport and before the reconciliation read completed. Keep
      // its exact acceptance instead of downgrading the journal to uncertain.
      const observed = this.mutationStore.get(started.mutationId);
      if (observed?.status === "accepted") {
        const sequence = observed.resultSequence ?? ++this.sequence;
        this.sequence = Math.max(this.sequence, sequence);
        if (observed.resultSequence === undefined) {
          this.mutationStore.update(observed.mutationId, { resultSequence: sequence });
        }
        return { sequence };
      }
      this.mutationStore.update(started.mutationId, {
        status: mutationFailureDefinitelyNotDelivered(error) ? "failed" : "uncertain",
        nativeThreadId: this.nativeThreadId(descriptor.taskId),
      });
      throw error;
    }
  }

  private markDurableMutationOwner(
    command: JsonRecord,
    owner: AndroidRemoteMutationOwner,
    nativeThreadId?: string,
  ): void {
    const descriptor = durableMutationDescriptor(command);
    if (!descriptor) return;
    this.mutationStore.update(descriptor.mutationId, {
      owner,
      ...(nativeThreadId ? { nativeThreadId } : {}),
    });
  }

  private async reconcileDurableMutation(
    mutation: AndroidRemoteMutation,
  ): Promise<boolean> {
    if (
      mutation.owner === "queue"
      && mutation.messageId
      && (this.queuedTurns.get(mutation.taskId) ?? []).some(
        queued => queued.messageId === mutation.messageId,
      )
    ) {
      return true;
    }
    const nativeThreadId =
      mutation.nativeThreadId
      || this.nativeThreadId(mutation.taskId);
    const ownership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
    // `owner` is persisted as delivery evidence, not as a lease.  After a
    // runtime restart the old Desktop owner may be gone; requiring a follower
    // snapshot solely because the mutation was once routed through Desktop
    // would make an already-durable private transcript impossible to
    // reconcile.  Only a currently observed Desktop owner is authoritative.
    const desktopAuthoritative = desktopOwnershipIsAuthoritative(ownership);
    const readFollowerThreadState = this.desktopIpc.readFollowerThreadState;

    // A Desktop-owned mutation must be reconciled against Desktop first.  A
    // private `thread/read` can remain blocked behind Desktop's writer lock;
    // waiting for it here would turn a fast follower acknowledgement into a
    // 30-second (or repeated) Android timeout.  Do not use the private writer
    // as a fallback while Desktop ownership is still authoritative.
    if (desktopAuthoritative && readFollowerThreadState) {
      try {
        const follower = await readFollowerThreadState.call(
          this.desktopIpc,
          nativeThreadId,
          { fresh: true },
        );
        return follower ? mutationEvidence(follower, mutation).exactMessageId : false;
      } catch {
        return false;
      }
    }

    let authoritativeThread: JsonRecord | null = null;
    try {
      const result = record(await this.requireCodex().request("thread/read", {
        threadId: nativeThreadId,
        includeTurns: true,
      }));
      authoritativeThread = record(result?.thread) ?? result;
    } catch {
      // A reconnect can temporarily make the private app-server unavailable.
      // Desktop state below may still prove exact delivery.
    }
    if (authoritativeThread) {
      const evidence = mutationEvidence(authoritativeThread, mutation);
      if (evidence.exactMessageId) return true;
      if (
        mutation.kind === "prompt-edit"
        && mutation.targetTurnId
        && mutation.visibleMessageFingerprint
        && evidence.matchingVisibleMessage
        && !evidence.targetTurnPresent
      ) {
        return true;
      }
    }
    if (!readFollowerThreadState) return false;
    try {
      const follower = await readFollowerThreadState.call(
        this.desktopIpc,
        nativeThreadId,
        { fresh: true },
      );
      return follower ? mutationEvidence(follower, mutation).exactMessageId : false;
    } catch {
      return false;
    }
  }

  private dispatchDeduplicationKey(command: JsonRecord): string | null {
    const commandId = stringValue(command.commandId, 256);
    if (commandId) return `command:${commandId}`;
    const type = stringValue(command.type, 128);
    const threadId = stringValue(command.threadId, 128);
    if (type === "thread.turn.queue.steer") {
      const messageId = stringValue(command.messageId, 256);
      return threadId && messageId ? `queue-steer:${threadId}:${messageId}` : null;
    }
    if (type !== "thread.turn.start") return null;
    const message = record(command.message);
    const messageId = stringValue(message?.messageId, 256);
    return threadId && messageId ? `turn:${threadId}:${messageId}` : null;
  }

  private pruneDispatchDeduplication(): void {
    const now = this.now();
    for (const [key, entry] of this.recentDispatches) {
      if (entry.expiresAt <= now) this.recentDispatches.delete(key);
    }
    if (this.recentDispatches.size <= MAX_DISPATCH_DEDUP_ENTRIES) return;
    const removeCount = this.recentDispatches.size - MAX_DISPATCH_DEDUP_ENTRIES;
    for (const [key] of [...this.recentDispatches.entries()]
      .toSorted(([, left], [, right]) => left.expiresAt - right.expiresAt)
      .slice(0, removeCount)) {
      this.recentDispatches.delete(key);
    }
  }

  private async validateProjectCreate(command: JsonRecord): Promise<{
    readonly id: string;
    readonly cwd: string;
  }> {
    const id = stringValue(command.projectId, 128);
    if (!id) throw new TypeError("project id and folder are required");
    const cwd = projectRootInput(command.workspaceRoot);
    const createIfMissing = command.createWorkspaceRootIfMissing === true;
    try {
      await stat(cwd);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
      if (code !== "ENOENT" || !createIfMissing) {
        throw new TypeError("The selected project folder does not exist");
      }
      try {
        await mkdir(cwd, { recursive: true });
      } catch {
        throw new TypeError("The selected project folder could not be created");
      }
    }
    let canonicalCwd: string;
    try {
      const details = await stat(cwd);
      if (!details.isDirectory()) throw new TypeError("The selected project path is not a folder");
      canonicalCwd = await realpath(cwd);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw new TypeError("The selected project folder could not be read");
    }
    const existing = this.projects.get(id);
    if (existing) {
      throw new Error(`Project '${existing.title}' already exists`);
    }
    const duplicate = [...this.projects.values()].find(
      project => comparableWorkspaceRoot(project.cwd) === comparableWorkspaceRoot(canonicalCwd),
    );
    if (duplicate) {
      throw new Error(`The folder is already registered as project '${duplicate.title}'`);
    }
    return { id, cwd: canonicalCwd };
  }

  private async dispatchOnce(clientId: string, command: JsonRecord): Promise<{ sequence: number }> {
    const type = stringValue(command.type, 128);
    if (!type) throw new TypeError("command type is required");
    if (type === "project.create") {
      const { id, cwd } = await this.validateProjectCreate(command);
      // Register with Desktop first. If its route or registry confirmation
      // fails, do not expose a project that exists only in the Android mirror.
      const registration = await this.desktopProjectRegistrar.registerProject({
        workspaceRoot: cwd,
        requestedProjectId: id,
        requestedTitle: stringValue(command.title, 256) || undefined,
      });
      const registeredId = stringValue(registration.projectId, 128) || id;
      const registeredTitle = stringValue(registration.title, 256);
      this.projects.set(registeredId, {
        id: registeredId,
        cwd,
        title: stringValue(command.title, 256) || registeredTitle || cwd,
        createdAt: stringValue(command.createdAt, 64) || new Date(this.now()).toISOString(),
      });
      this.rememberWorkspaceRoot(cwd);
    } else if (type === "project.meta.update") {
      const id = stringValue(command.projectId, 128);
      const current = this.projects.get(id);
      if (current) this.projects.set(id, {
        ...current,
        ...(stringValue(command.title, 256) ? { title: stringValue(command.title, 256) } : {}),
        ...(stringValue(command.workspaceRoot, 4096) ? { cwd: stringValue(command.workspaceRoot, 4096) } : {}),
      });
      this.rememberWorkspaceRoot(stringValue(command.workspaceRoot, 4096));
    } else if (type === "project.delete") {
      this.projects.delete(stringValue(command.projectId, 128));
    } else if (type === "thread.create") {
      this.createDraft(command);
    } else if (type === "thread.turn.start") {
      await this.startTurn(clientId, command);
    } else if (type === "thread.turn.queue.update") {
      this.updateQueuedTurn(command);
    } else if (type === "thread.turn.queue.cancel") {
      this.cancelQueuedTurn(command);
    } else if (type === "thread.turn.queue.move") {
      this.moveQueuedTurn(command);
    } else if (type === "thread.turn.queue.steer") {
      await this.steerQueuedTurn(command);
    } else if (type === "thread.turn.interrupt" || type === "thread.session.stop") {
      await this.interruptTurn(command);
    } else if (type === "thread.checkpoint.revert") {
      await this.rollbackThread(command);
    } else if (type === "thread.archive" || type === "thread.unarchive" || type === "thread.delete") {
      await this.mutateThread(type, command);
    } else if (type === "thread.meta.update") {
      await this.updateThreadMetadata(command);
    } else if (type === "thread.runtime-mode.set" || type === "thread.interaction-mode.set") {
      this.updatePreferences(command);
    } else if (type === "thread.approval.respond") {
      await this.respondToApproval(command);
    } else if (type === "thread.user-input.respond") {
      await this.respondToUserInput(clientId, command);
    } else if (type === "thread.mcp-elicitation.respond") {
      await this.respondToMcpElicitation(command);
    } else if (type === "thread.user-input.draft.update") {
      // Draft typing/selection is phone-local. Refreshing Codex here can race
      // the live request with its session-file replay and replace the request
      // id while the answer card is still open. Submit performs the one
      // authoritative server mutation and refresh.
      return { sequence: this.sequence };
    } else {
      throw new TypeError("This Android task command is not supported yet");
    }
    this.scheduleRefresh();
    return { sequence: ++this.sequence };
  }

  /**
   * Guard a mutation for which the private app-server has no Desktop follower
   * equivalent (archive/delete/rename, for example).  A missing IPC route is
   * not a writer-release signal, so an existing task may use the private
   * app-server only after a definitive never-owned probe.
   */
  private async requirePrivateMutationRoute(
    nativeThreadId: string,
    operation: string,
    options: { probeIfUnknown?: boolean } = {},
  ): Promise<void> {
    const ownership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
    if (ownership.state === "local-owned") return;
    if (ownership.state === "desktop-owned" || ownership.everDesktopOwned) {
      throw desktopOwnershipSafeError(nativeThreadId, `${operation} is not available through Desktop IPC`);
    }
    if (options.probeIfUnknown === false) return;
    const probe = this.desktopIpc.probeFollowerRoute;
    if (!probe) {
      throw desktopOwnershipSafeError(nativeThreadId, `${operation} ownership could not be verified`);
    }
    const route = await probe.call(this.desktopIpc, nativeThreadId);
    if (route !== "absent") {
      throw desktopOwnershipSafeError(
        nativeThreadId,
        route === "ready"
          ? `${operation} has no safe Desktop follower route`
          : `${operation} ownership is ambiguous`,
      );
    }
    const afterProbe = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
    if (afterProbe.state === "desktop-owned" || afterProbe.everDesktopOwned) {
      throw desktopOwnershipSafeError(nativeThreadId, `${operation} ownership is ambiguous`);
    }
  }

  private createDraft(command: JsonRecord): void {
    const id = stringValue(command.threadId, 128);
    const projectId = stringValue(command.projectId, 128);
    if (!id || !projectId) throw new TypeError("task and project ids are required");
    const workspaceKind = command.workspaceKind === "projectless" ? "projectless" as const : undefined;
    const effectiveProjectId = workspaceKind ? ANDROID_REMOTE_PROJECTLESS_ID : projectId;
    const project = this.projects.get(effectiveProjectId);
    const worktreePath = stringValue(command.worktreePath, 4096);
    const validatedSelection = this.validatedTaskModelSelection(modelSelection(command));
    const selection = validatedSelection.selection;
    this.assertTaskModelRoute(selection);
    const createdAt = stringValue(command.createdAt, 64) || new Date(this.now()).toISOString();
    this.drafts.set(id, {
      id,
      projectId: effectiveProjectId,
      projectTitle: workspaceKind ? "Chats" : project?.title ?? "Codex workspace",
      ...(workspaceKind ? { workspaceKind } : {}),
      title: stringValue(command.title, 256) || "New task",
      // Never inherit a project cwd for a general Chat.  The neutral folder is
      // created on first use and is owned by Remodex, not by any user project.
      cwd: workspaceKind ? this.projectlessWorkspaceRoot : worktreePath || project?.cwd || process.cwd(),
      instanceId: selection.instanceId,
      model: selection.model,
      ...(selection.options !== undefined ? { modelOptions: selection.options } : {}),
      runtimeMode: normalizedRuntimeMode(command.runtimeMode),
      interactionMode: normalizedInteractionMode(command.interactionMode),
      createdAt,
    });
    this.commitTaskSelection({
      nativeThreadId: id,
      remoteThreadId: id,
      providerInstanceId: selection.instanceId,
      model: selection.model,
      ...(selection.options !== undefined ? { options: selection.options } : {}),
      ...(validatedSelection.capabilityVersion
        ? { capabilityVersion: validatedSelection.capabilityVersion }
        : {}),
      source: "android",
      updateId: stringValue(command.commandId, 128) || `draft-${id}`,
      updatedAt: createdAt,
    });
    if (!workspaceKind) {
      this.rememberWorkspaceRoot(worktreePath || project?.cwd || process.cwd());
    }
  }

  private queuedTurnMessages(remoteThreadId: string): JsonRecord[] {
    return (this.queuedTurns.get(remoteThreadId) ?? []).map((queued, queuePosition) => ({
      id: queued.messageId,
      role: "user",
      text: queued.displayText,
      attachments: [],
      turnId: null,
      phase: "queued",
      queuePosition,
      streaming: false,
      createdAt: queued.createdAt,
      updatedAt: queued.updatedAt,
    }));
  }

  private messagesWithQueuedTurns(value: unknown, remoteThreadId: string): JsonRecord[] {
    const messages = projectedRows(value).filter(message => message.phase !== "queued");
    const durableMessageIds = new Set(messages.map(message => stringValue(message.id, 128)));
    return [
      ...messages,
      ...this.queuedTurnMessages(remoteThreadId).filter(message =>
        !durableMessageIds.has(stringValue(message.id, 128))),
    ];
  }

  private durableDesktopUserMessageKey(remoteThreadId: string, messageId: string): string {
    return `${remoteThreadId}\u0000${messageId}`;
  }

  private rememberProjectedUserMessageAlias(
    remoteThreadId: string,
    nativeItemId: string,
    stableMessageId: string,
  ): void {
    if (!remoteThreadId || !nativeItemId || !stableMessageId) return;
    const key = `${remoteThreadId}\u0000${nativeItemId}`;
    this.projectedUserMessageIds.delete(key);
    this.projectedUserMessageIds.set(key, stableMessageId);
    while (this.projectedUserMessageIds.size > MAX_PROJECTED_USER_MESSAGE_ALIASES) {
      const oldestKey = this.projectedUserMessageIds.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.projectedUserMessageIds.delete(oldestKey);
    }
  }

  private rememberDurableDesktopUserMessage(
    remoteThreadId: string,
    message: JsonRecord,
  ): void {
    const messageId = stringValue(message.id, 128);
    if (!remoteThreadId || !messageId || message.role !== "user") return;
    const key = this.durableDesktopUserMessageKey(remoteThreadId, messageId);
    // Refresh insertion order as well as the row so the global bound removes
    // the least recently observed durable item first.
    this.durableDesktopUserMessages.delete(key);
    this.durableDesktopUserMessages.set(key, message);
    while (this.durableDesktopUserMessages.size > MAX_DURABLE_DESKTOP_USER_MESSAGES) {
      const oldestKey = this.durableDesktopUserMessages.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.durableDesktopUserMessages.delete(oldestKey);
    }
  }

  private mergeDurableDesktopUserMessages(
    value: unknown,
    remoteThreadId: string,
    latestTurnId: string,
  ): JsonRecord[] {
    // A session-file event preserves Android's client message id, while a
    // later thread/read commonly exposes only Codex's native response-item id.
    // Reapply the remembered native -> client alias before comparing the
    // durable overlay, otherwise every refresh recreates two rows for one
    // prompt.
    let messages = projectedRows(value).map(message => {
      if (message.role !== "user") return message;
      const nativeItemId = stringValue(message.id, 128);
      const stableMessageId = nativeItemId
        ? this.projectedUserMessageIds.get(`${remoteThreadId}\u0000${nativeItemId}`)
        : undefined;
      return stableMessageId && stableMessageId !== nativeItemId
        ? { ...message, id: stableMessageId }
        : message;
    });
    const projectedIds = new Set(messages.map(message => stringValue(message.id, 128)));
    const claimedProjectedIndexes = new Set<number>();
    const prefix = `${remoteThreadId}\u0000`;
    for (const [key, message] of this.durableDesktopUserMessages) {
      if (!key.startsWith(prefix)) continue;
      const messageId = stringValue(message.id, 128);
      if (!messageId) {
        this.durableDesktopUserMessages.delete(key);
        continue;
      }
      if (projectedIds.has(messageId)) {
        // The ordinary projection now contains the exact durable identity, so
        // future reads no longer need the race overlay.
        const exactIndex = messages.findIndex(candidate =>
          stringValue(candidate.id, 128) === messageId);
        if (exactIndex >= 0) claimedProjectedIndexes.add(exactIndex);
        this.durableDesktopUserMessages.delete(key);
        continue;
      }
      const messageTurnId = stringValue(message.turnId, 128);
      if (messageTurnId && messageTurnId !== latestTurnId) {
        // A later history replacement moved past this turn without retaining
        // the row. Respect that rollback/edit instead of resurrecting it.
        this.durableDesktopUserMessages.delete(key);
        continue;
      }

      // Older/current Codex thread/read responses can omit clientId even
      // though the session file already joined it to the native response item.
      // Claim at most one same-turn native row for each durable client row so
      // two intentionally repeated prompts remain two logical messages.
      const normalizedText = normalizedProjectedUserMessageText(message.text);
      const matchingIndex = messageTurnId && normalizedText
        ? messages.findIndex((candidate, index) =>
            !claimedProjectedIndexes.has(index)
            && candidate.role === "user"
            && stringValue(candidate.turnId, 128) === messageTurnId
            && normalizedProjectedUserMessageText(candidate.text) === normalizedText)
        : -1;
      if (matchingIndex >= 0) {
        const nativeMessage = messages[matchingIndex]!;
        const nativeItemId = stringValue(nativeMessage.id, 128);
        if (nativeItemId) {
          this.rememberProjectedUserMessageAlias(
            remoteThreadId,
            nativeItemId,
            messageId,
          );
          projectedIds.delete(nativeItemId);
        }
        messages[matchingIndex] = {
          ...message,
          ...nativeMessage,
          id: messageId,
          updatedAt:
            stringValue(message.updatedAt, 64) > stringValue(nativeMessage.updatedAt, 64)
              ? message.updatedAt
              : nativeMessage.updatedAt,
        };
        claimedProjectedIndexes.add(matchingIndex);
        projectedIds.add(messageId);
        this.durableDesktopUserMessages.delete(key);
        continue;
      }
      messages = this.upsertProjectedRow(messages, message);
      projectedIds.add(messageId);
      claimedProjectedIndexes.add(messages.length - 1);
    }
    return messages;
  }

  private forgetDurableDesktopUserMessages(remoteThreadId: string): void {
    const prefix = `${remoteThreadId}\u0000`;
    for (const key of this.durableDesktopUserMessages.keys()) {
      if (key.startsWith(prefix)) this.durableDesktopUserMessages.delete(key);
    }
  }

  private queuedTurnCount(): number {
    let count = 0;
    for (const queued of this.queuedTurns.values()) count += queued.length;
    return count;
  }

  private restoreQueuedTurns(): void {
    for (const turn of this.queuedTurnStore.list()) {
      const queued = this.queuedTurns.get(turn.taskId) ?? [];
      if (queued.some(candidate => candidate.messageId === turn.messageId)) continue;
      this.queuedTurns.set(turn.taskId, [...queued, turn]);
    }
  }

  private persistQueuedTurns(): void {
    this.queuedTurnStore.replace([...this.queuedTurns.values()].flat());
  }

  private replaceQueuedTurns(remoteThreadId: string, queued: QueuedAndroidTurn[]): void {
    if (queued.length === 0) {
      this.queuedTurns.delete(remoteThreadId);
      const timer = this.writerRecoveryTimers.get(remoteThreadId);
      if (timer) clearTimeout(timer);
      this.writerRecoveryTimers.delete(remoteThreadId);
      this.writerRecoveryAttempts.delete(remoteThreadId);
    } else {
      this.queuedTurns.set(remoteThreadId, queued);
    }
    this.persistQueuedTurns();
  }

  private publishQueuedTurnState(remoteThreadId: string): void {
    const current = this.threadStreams.get(remoteThreadId);
    if (!current) {
      this.requestAuthoritativeThreadRefresh(remoteThreadId);
      return;
    }
    const thread = record(current.detail.thread);
    if (!thread) return;
    const nowIso = new Date(this.now()).toISOString();
    const advanced = advanceProjectedThreadStream(
      current,
      {
        ...current.detail,
        thread: {
          ...thread,
          updatedAt: nowIso,
          messages: this.messagesWithQueuedTurns(thread.messages, remoteThreadId),
        },
      },
      this.now(),
    );
    this.threadStreams.set(remoteThreadId, advanced.state);
    for (const ws of this.sockets) {
      if (ws.data.subscription !== "thread" || ws.data.threadId !== remoteThreadId) continue;
      for (const item of advanced.items) this.publishSubscriptionEvent(ws, item, false);
    }
  }

  private queueTurn(
    clientId: string,
    command: JsonRecord,
    options: { startIfAlreadyIdle?: boolean } = {},
  ): void {
    const remoteThreadId = stringValue(command.threadId, 128);
    const message = record(command.message);
    const messageId = stringValue(message?.messageId, 128);
    if (!remoteThreadId || !message || !messageId) {
      throw new TypeError("task and queued message are required");
    }
    const text = typeof message.text === "string" ? message.text : "";
    if (text.length > 120_000) throw new RangeError("prompt exceeds the 120,000 character limit");
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    if (!text && attachments.length === 0) throw new TypeError("queued message cannot be empty");

    const queued = this.queuedTurns.get(remoteThreadId) ?? [];
    const existingIndex = queued.findIndex(candidate => candidate.messageId === messageId);
    const existing = existingIndex >= 0 ? queued[existingIndex] : undefined;
    if (!existing && this.queuedTurnCount() >= MAX_QUEUED_ANDROID_TURNS) {
      throw new Error("Too many queued messages. Cancel one and try again.");
    }
    const stagedAttachments = existing?.stagedAttachments
      ?? (attachments.length > 0
        ? stageAndroidAttachments({ clientId, attachments })
        : { codexInputs: [], referencedFiles: [], stagedPaths: [] });
    const preparedCommand: JsonRecord = {
      ...command,
      deliveryMode: "normal",
      message: {
        ...message,
        // Android's command envelope may omit the presentation-only role.
        // The durable queue journal requires the normalized user role so an
        // accepted prompt can be restored after a gateway restart.
        role: "user",
        // Upload bytes are staged before queue acknowledgement. Persisting
        // only protected local paths keeps accepted queue entries recoverable
        // without writing large base64 payloads into the queue journal.
        attachments: [],
      },
    };

    const requestedDisplayText = typeof command.queueDisplayText === "string"
      ? command.queueDisplayText
      : text === ANDROID_ATTACHMENT_ONLY_BOOTSTRAP_PROMPT ? "" : text;
    const nowIso = new Date(this.now()).toISOString();
    const nextQueuedTurn: QueuedAndroidTurn = {
      taskId: remoteThreadId,
      clientId,
      command: preparedCommand,
      messageId,
      displayText: requestedDisplayText.slice(0, 120_000),
      stagedAttachments,
      createdAt: existing?.createdAt ?? (stringValue(command.createdAt, 64) || nowIso),
      updatedAt: nowIso,
    };
    this.replaceQueuedTurns(
      remoteThreadId,
      existingIndex >= 0
        ? queued.map((candidate, index) => index === existingIndex ? nextQueuedTurn : candidate)
        : [...queued, nextQueuedTurn],
    );
    this.markDurableMutationOwner(
      command,
      "queue",
      this.nativeThreadId(remoteThreadId),
    );
    this.publishQueuedTurnState(remoteThreadId);
    // The phone can submit against a stale running snapshot just as Desktop
    // finishes. Recheck server-side so an already-idle task never leaves this
    // message stranded waiting for a completion event that already happened.
    if (options.startIfAlreadyIdle !== false) {
      void this.startNextQueuedTurn(remoteThreadId).catch(() => undefined);
    }
  }

  private updateQueuedTurn(command: JsonRecord): void {
    const remoteThreadId = stringValue(command.threadId, 128);
    const messageId = stringValue(command.messageId, 128);
    const queued = this.queuedTurns.get(remoteThreadId) ?? [];
    const queuedIndex = queued.findIndex(candidate => candidate.messageId === messageId);
    const queuedTurn = queuedIndex >= 0 ? queued[queuedIndex] : undefined;
    if (!remoteThreadId || !messageId || !queuedTurn) {
      throw new Error("This queued message is no longer available");
    }
    const displayText = typeof command.text === "string" ? command.text : "";
    if (displayText.length > 120_000) {
      throw new RangeError("prompt exceeds the 120,000 character limit");
    }
    const queuedMessage = record(queuedTurn.command.message) ?? {};
    if (!displayText && queuedTurn.stagedAttachments.stagedPaths.length === 0) {
      throw new TypeError("queued message cannot be empty");
    }
    const updatedAt = new Date(this.now()).toISOString();
    this.replaceQueuedTurns(
      remoteThreadId,
      queued.map((candidate, index) =>
        index === queuedIndex
          ? {
              ...queuedTurn,
              command: {
                ...queuedTurn.command,
                message: {
                  ...queuedMessage,
                  text: displayText || ANDROID_ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
                },
                queueDisplayText: displayText,
                titleSeed: displayText.slice(0, 90) || queuedTurn.command.titleSeed,
              },
              displayText,
              updatedAt,
            }
          : candidate,
      ),
    );
    this.publishQueuedTurnState(remoteThreadId);
  }

  private cancelQueuedTurn(command: JsonRecord): void {
    const remoteThreadId = stringValue(command.threadId, 128);
    const messageId = stringValue(command.messageId, 128);
    const queued = this.queuedTurns.get(remoteThreadId) ?? [];
    const queuedIndex = queued.findIndex(candidate => candidate.messageId === messageId);
    if (!remoteThreadId || !messageId || queuedIndex < 0) {
      throw new Error("This queued message is no longer available");
    }
    this.replaceQueuedTurns(
      remoteThreadId,
      queued.filter((_candidate, index) => index !== queuedIndex),
    );
    this.publishQueuedTurnState(remoteThreadId);
  }

  private moveQueuedTurn(command: JsonRecord): void {
    const remoteThreadId = stringValue(command.threadId, 128);
    const messageId = stringValue(command.messageId, 128);
    const direction = stringValue(command.direction, 8);
    if (direction !== "up" && direction !== "down") {
      throw new TypeError("queued message direction must be up or down");
    }
    const queued = this.queuedTurns.get(remoteThreadId) ?? [];
    const queuedIndex = queued.findIndex(candidate => candidate.messageId === messageId);
    if (!remoteThreadId || !messageId || queuedIndex < 0) {
      throw new Error("This queued message is no longer available");
    }
    const targetIndex = queuedIndex + (direction === "up" ? -1 : 1);
    if (targetIndex < 0 || targetIndex >= queued.length) return;
    const reordered = [...queued];
    const [moved] = reordered.splice(queuedIndex, 1);
    reordered.splice(targetIndex, 0, moved!);
    this.replaceQueuedTurns(remoteThreadId, reordered);
    this.publishQueuedTurnState(remoteThreadId);
  }

  private projectedThreadIsActive(remoteThreadId: string): boolean {
    const thread = record(this.threadStreams.get(remoteThreadId)?.detail.thread);
    const sessionStatus = stringValue(record(thread?.session)?.status, 64)
      .replace(/[^a-z0-9]/giu, "")
      .toLowerCase();
    if (sessionStatus === "running" || sessionStatus === "starting" || sessionStatus === "active") {
      return true;
    }
    const latestState = stringValue(record(thread?.latestTurn)?.state, 64)
      .replace(/[^a-z0-9]/giu, "")
      .toLowerCase();
    return latestState === "running" || latestState === "starting" || latestState === "active";
  }

  private projectedThreadActivityIsFresh(remoteThreadId: string): boolean {
    const thread = record(this.threadStreams.get(remoteThreadId)?.detail.thread);
    const updatedAt = Date.parse(stringValue(thread?.updatedAt, 64));
    return Number.isFinite(updatedAt)
      && this.now() - updatedAt <= PROJECTED_ACTIVE_FALLBACK_FRESH_MS;
  }

  private async codexThreadIsActive(nativeThreadId: string): Promise<boolean | null> {
    try {
      const result = record(await this.requireCodex().request("thread/read", {
        threadId: nativeThreadId,
        includeTurns: true,
      }));
      const thread = record(result?.thread);
      if (!thread) return null;
      const runtimeStatus = codexRuntimeStatus(thread.status);
      if (runtimeStatus?.type === "active") return true;
      if (runtimeStatus?.type === "notLoaded") return null;
      return canonicalTurnActivitySnapshot(thread.turns).active;
    } catch {
      return null;
    }
  }

  private rememberKnownActiveTurn(nativeThreadId: string, turnId: unknown): void {
    const normalized = nativeExpectedTurnId(turnId);
    if (nativeThreadId && normalized) this.knownActiveTurnIds.set(nativeThreadId, normalized);
  }

  private forgetKnownActiveTurn(nativeThreadId: string, turnId?: unknown): void {
    const current = this.knownActiveTurnIds.get(nativeThreadId);
    if (!current) return;
    const normalized = nativeExpectedTurnId(turnId);
    if (!normalized || normalized === current) this.knownActiveTurnIds.delete(nativeThreadId);
  }

  private async threadHasActiveTurn(remoteThreadId: string): Promise<boolean> {
    // Install/refresh the append watcher before consulting Desktop IPC. The
    // watcher carries the canonical active turn for Desktop-owned tasks and
    // avoids a private thread/read that can block behind Desktop's writer.
    await this.ensureDesktopSessionWatchForThread(remoteThreadId).catch(() => false);
    if (this.desktopSessions.isWatching(remoteThreadId)) {
      const watchedTurnId = this.desktopSessions.activeTurnId?.(remoteThreadId);
      if (watchedTurnId !== undefined) {
        const nativeThreadId = this.nativeThreadId(remoteThreadId);
        if (watchedTurnId) {
          this.rememberKnownActiveTurn(nativeThreadId, watchedTurnId);
          return true;
        }
        this.forgetKnownActiveTurn(nativeThreadId);
        this.desktopActiveTurnProbes.delete(nativeThreadId);
        return false;
      }
    }
    const projectedActive = this.projectedThreadIsActive(remoteThreadId);
    const nativeThreadId = this.nativeThreadId(remoteThreadId);
    const ownership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
    // An explicit local-owner transition supersedes the historical Desktop
    // ownership marker.  The monotonic marker still blocks unknown-owner
    // fallthrough, but it must not prevent a confirmed local writer from
    // reading its own active turn.
    const desktopAuthoritative = ownership.state !== "local-owned"
      && desktopOwnershipIsAuthoritative(ownership);

    // A Desktop-owned task must be checked through Desktop first.  Asking the
    // private app-server before this check can block behind Desktop's writer
    // lock for its full request timeout, delaying the follower steer itself.
    if (ownership.state !== "local-owned") {
      const desktopProbe = await this.readDesktopActiveTurn(nativeThreadId, { fresh: true });
      if (desktopProbe.active !== null) {
        if (desktopProbe.turnId) this.rememberKnownActiveTurn(nativeThreadId, desktopProbe.turnId);
        if (!desktopProbe.active) this.forgetKnownActiveTurn(nativeThreadId);
        return desktopProbe.active;
      }
      if (desktopAuthoritative) {
        // A remembered Desktop owner remains authoritative even when its
        // snapshot is temporarily unavailable.  Use only the bounded local
        // projection as a fallback; never probe the competing private writer.
        if (projectedActive && this.projectedThreadActivityIsFresh(remoteThreadId)) return true;
        if (this.knownActiveTurnIds.has(nativeThreadId)) return true;
        if (projectedActive) this.requestAuthoritativeThreadRefresh(remoteThreadId);
        return false;
      }
    }

    // Unknown/local ownership may still be backed by the private app-server,
    // so retain the native activity probe for those routes.
    const codexActive = await this.codexThreadIsActive(nativeThreadId);
    if (codexActive === true) return true;
    if (codexActive === false) {
      this.forgetKnownActiveTurn(nativeThreadId);
      return false;
    }
    if (this.knownActiveTurnIds.has(nativeThreadId)) return true;
    if (!projectedActive) return false;
    if (this.projectedThreadActivityIsFresh(remoteThreadId)) return true;
    this.requestAuthoritativeThreadRefresh(remoteThreadId);
    return false;
  }

  private async activeTurnId(remoteThreadId: string, fresh = false): Promise<string> {
    const nativeThreadId = this.nativeThreadId(remoteThreadId);

    // A Desktop session watcher is a bounded, append-only source of truth for
    // the current turn. Consult it before any cached id, owner IPC, or private
    // app-server read so a rotated rollout cannot inherit a stale turn.
    await this.ensureDesktopSessionWatchForThread(remoteThreadId).catch(() => false);
    if (this.desktopSessions.isWatching(remoteThreadId)) {
      const watchedTurnId = this.desktopSessions.activeTurnId?.(remoteThreadId);
      if (watchedTurnId !== undefined) {
        if (watchedTurnId) {
          this.rememberKnownActiveTurn(nativeThreadId, watchedTurnId);
          return watchedTurnId;
        }
        this.forgetKnownActiveTurn(nativeThreadId);
        this.desktopActiveTurnProbes.delete(nativeThreadId);
        return "";
      }
    }

    if (!fresh) {
      const thread = record(this.threadStreams.get(remoteThreadId)?.detail.thread);
      const sessionTurnId = nativeExpectedTurnId(record(thread?.session)?.activeTurnId);
      if (sessionTurnId) return sessionTurnId;
      const latestTurn = record(thread?.latestTurn);
      if (turnStatusIsActive(latestTurn?.state)) {
        const latestTurnId = nativeExpectedTurnId(latestTurn?.turnId);
        if (latestTurnId) {
          this.rememberKnownActiveTurn(nativeThreadId, latestTurnId);
          return latestTurnId;
        }
      }
      const knownTurnId = this.knownActiveTurnIds.get(nativeThreadId);
      if (knownTurnId) return knownTurnId;
    }

    const ownership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
    const desktopAuthoritative = ownership.state !== "local-owned"
      && desktopOwnershipIsAuthoritative(ownership);
    if (!this.drafts.has(remoteThreadId) && this.desktopIpc.readFollowerThreadState) {
      const desktopProbe = await this.readDesktopActiveTurn(nativeThreadId, { fresh });
      if (desktopProbe.turnId) {
        this.rememberKnownActiveTurn(nativeThreadId, desktopProbe.turnId);
        return desktopProbe.turnId;
      }
      if (desktopProbe.active === false) this.forgetKnownActiveTurn(nativeThreadId);
      if (desktopAuthoritative) {
        // An active-but-incomplete bounded state was retried by the shared
        // probe above. Without a canonical id, fail closed rather than
        // steering a guessed/stale turn or probing the private writer.
        return "";
      }
    }

    if (desktopAuthoritative) return "";

    try {
      const result = record(await this.requireCodex().request("thread/turns/list", {
        threadId: nativeThreadId,
        limit: 10,
        sortDirection: "desc",
      }));
      const pagedTurnId = activeTurnIdFromRows(
        result?.data ?? result?.items ?? result?.turns,
        true,
      );
      if (pagedTurnId) {
        this.rememberKnownActiveTurn(nativeThreadId, pagedTurnId);
        return pagedTurnId;
      }
    } catch {
      // Older Codex runtimes do not expose paged turns. Fall back to thread/read.
    }

    const result = record(await this.requireCodex().request("thread/read", {
      threadId: nativeThreadId,
      includeTurns: true,
    }));
    const threadTurnId = activeTurnIdFromRows(record(result?.thread)?.turns);
    if (threadTurnId) this.rememberKnownActiveTurn(nativeThreadId, threadTurnId);
    return threadTurnId;
  }

  private steerDeliveryKey(nativeThreadId: string, clientUserMessageId: string): string {
    return `${nativeThreadId}\u0000${clientUserMessageId}`;
  }

  private registerSteerDelivery(
    nativeThreadId: string,
    expectedTurnId: string,
    clientUserMessageId: string,
  ): { promise: Promise<boolean>; cancel: () => void } {
    const key = this.steerDeliveryKey(nativeThreadId, clientUserMessageId);
    let settled = false;
    let resolvePromise!: (delivered: boolean) => void;
    const promise = new Promise<boolean>(resolve => {
      resolvePromise = resolve;
    });
    const delivery: PendingSteerDelivery = {
      expectedTurnId,
      resolve: delivered => {
        if (settled) return;
        settled = true;
        const deliveries = this.pendingSteerDeliveries.get(key);
        deliveries?.delete(delivery);
        if (deliveries?.size === 0) this.pendingSteerDeliveries.delete(key);
        resolvePromise(delivered);
      },
    };
    const deliveries = this.pendingSteerDeliveries.get(key) ?? new Set<PendingSteerDelivery>();
    deliveries.add(delivery);
    this.pendingSteerDeliveries.set(key, deliveries);
    if (process.env.OPENCODEX_ANDROID_IPC_DEBUG === "1") {
      console.log(`[remodex] waiting for durable steer ${JSON.stringify({ nativeThreadId, expectedTurnId, clientUserMessageId })}`);
    }
    return {
      promise,
      cancel: () => delivery.resolve(false),
    };
  }

  private observeAuthoritativeSteerDelivery(message: CodexJsonRpcMessage): void {
    if (message.method !== "item/completed") return;
    const params = record(message.params) ?? {};
    const item = record(params.item);
    const itemType = stringValue(item?.type, 64)
      .replace(/[^a-z0-9]/giu, "")
      .toLowerCase();
    const role = stringValue(item?.role, 32).toLowerCase();
    if (itemType !== "usermessage" && !(itemType === "message" && role === "user")) return;
    const nativeThreadId = stringValue(params.threadId, 128);
    const turnId = nativeExpectedTurnId(
      params.turnId
      ?? params.turn_id
      ?? record(params.turn)?.id,
    );
    const clientUserMessageId = stringValue(
      item?.clientId
      ?? item?.client_id
      ?? item?.clientUserMessageId
      ?? item?.client_user_message_id,
      128,
    );
    if (!nativeThreadId || !turnId || !clientUserMessageId) return;
    const deliveries = this.pendingSteerDeliveries.get(
      this.steerDeliveryKey(nativeThreadId, clientUserMessageId),
    );
    if (process.env.OPENCODEX_ANDROID_IPC_DEBUG === "1") {
      console.log(`[remodex] observed durable steer ${JSON.stringify({
        nativeThreadId,
        turnId,
        clientUserMessageId,
        waiterCount: deliveries?.size ?? 0,
      })}`);
    }
    let matchedDelivery = !deliveries;
    for (const delivery of deliveries ?? []) {
      if (delivery.expectedTurnId !== turnId) continue;
      matchedDelivery = true;
      delivery.resolve(true);
    }
    if (matchedDelivery) {
      this.reconcileObservedSteerDelivery(
        nativeThreadId,
        this.remoteThreadId(nativeThreadId),
        clientUserMessageId,
      );
    }
  }

  private reconcileObservedSteerDelivery(
    nativeThreadId: string,
    remoteThreadId: string,
    clientUserMessageId: string,
  ): void {
    // A late session event is stronger than the steer transport timeout. Once
    // the exact client id is durably present, remove the temporary queue row
    // immediately so a later turn/completed event cannot replay the prompt as
    // a new normal turn.
    const queued = this.queuedTurns.get(remoteThreadId) ?? [];
    if (queued.some(candidate => candidate.messageId === clientUserMessageId)) {
      this.replaceQueuedTurns(
        remoteThreadId,
        queued.filter(candidate => candidate.messageId !== clientUserMessageId),
      );
      this.publishQueuedTurnState(remoteThreadId);
    }

    // The mutation may already have timed out and been marked uncertain by the
    // time the append-only session watcher sees the item. Persist the exact
    // acceptance so a phone retry deduplicates instead of sending the prompt
    // again. This also covers direct steers whose temporary queue row was
    // removed on the original timeout.
    for (const mutation of this.mutationStore.list()) {
      if (
        mutation.taskId !== remoteThreadId
        || mutation.messageId !== clientUserMessageId
        || (mutation.status !== "pending" && mutation.status !== "uncertain")
      ) continue;
      const sequence = mutation.resultSequence ?? ++this.sequence;
      this.sequence = Math.max(this.sequence, sequence);
      this.mutationStore.update(mutation.mutationId, {
        status: "accepted",
        nativeThreadId,
        resultSequence: sequence,
      });
    }
  }

  private async requireDurableSteerDelivery(
    observation: { promise: Promise<boolean>; cancel: () => void },
    retainQueuedTurnOnFailure: boolean,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const delivered = await Promise.race([
        observation.promise,
        new Promise<boolean>(resolvePromise => {
          timeout = setTimeout(resolvePromise, this.steerDeliveryTimeoutMs, false);
        }),
      ]);
      if (delivered) return;
      throw new Error(
        retainQueuedTurnOnFailure
          ? "Codex did not persist the steering message. It remains queued so you can try again."
          : "Codex did not persist the steering message. It was not queued; try again.",
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      observation.cancel();
    }
  }

  private async steerTurn(
    clientId: string,
    command: JsonRecord,
    trackingCommand: JsonRecord = command,
    retainQueuedTurnOnFailure = true,
    preparedAttachments?: PersistedAndroidQueuedTurn["stagedAttachments"],
  ): Promise<void> {
    const remoteThreadId = stringValue(command.threadId, 128);
    const message = record(command.message);
    if (!remoteThreadId || !message) throw new TypeError("task and message are required");
    const text = typeof message.text === "string" ? message.text : "";
    if (text.length > 120_000) throw new RangeError("prompt exceeds the 120,000 character limit");
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    if (!text && attachments.length === 0) throw new TypeError("steering message cannot be empty");
    const staged = preparedAttachments
      ?? (attachments.length > 0
        ? stageAndroidAttachments({ clientId, attachments })
        : { codexInputs: [], referencedFiles: [], stagedPaths: [] });
    const prompt = staged.referencedFiles.length > 0
      ? `${text}\n\nFiles uploaded from Android and staged on this PC:\n${staged.referencedFiles.map(path => `- ${path}`).join("\n")}`
      : text;
    const input: unknown[] = [];
    if (prompt) input.push({ type: "text", text: prompt, text_elements: [] });
    input.push(...staged.codexInputs);

    const nativeThreadId = this.nativeThreadId(remoteThreadId);
    const clientUserMessageId = stringValue(message.messageId, 128) || randomUUID();
    let expectedTurnId = await this.activeTurnId(remoteThreadId);
    if (!expectedTurnId) throw new Error("This task has no running turn to steer");

    const deliverAndConfirm = async (
      turnId: string,
      deliver: () => Promise<unknown>,
      acceptConfirmedTransport = false,
    ): Promise<void> => {
      const observation = this.registerSteerDelivery(
        nativeThreadId,
        turnId,
        clientUserMessageId,
      );
      const transport = Promise.resolve()
        .then(deliver)
        .then(
          response => ({ kind: "transport-response" as const, response }),
          error => ({ kind: "transport-error" as const, error }),
        );
      const durability = this.requireDurableSteerDelivery(
        observation,
        retainQueuedTurnOnFailure,
      ).then(
        () => ({ kind: "durable" as const }),
        error => ({ kind: "durability-error" as const, error }),
      );
      const observeLateTransport = (): void => {
        void transport.then(outcome => {
          if (process.env.OPENCODEX_ANDROID_IPC_DEBUG !== "1") return;
          if (outcome.kind === "transport-error") {
            console.log(`[remodex] steer transport settled after durable confirmation: ${
              outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
            }`);
            return;
          }
          try {
            requireCompatibleSteerTransport(outcome.response, turnId);
          } catch (error) {
            console.log(`[remodex] steer transport returned a late incompatible response: ${
              error instanceof Error ? error.message : String(error)
            }`);
          }
        });
      };
      try {
        const first = await Promise.race([transport, durability]);
        if (first.kind === "durable") {
          // Desktop can append the authoritative session record before its IPC
          // response reaches Remodex. The durable record is sufficient proof
          // of delivery; never leave the Android queue stuck behind that
          // slower transport response.
          observeLateTransport();
          return;
        }
        if (first.kind === "durability-error") {
          observeLateTransport();
          throw first.error;
        }
        if (first.kind === "transport-response") {
          requireCompatibleSteerTransport(first.response, turnId);
          if (
            acceptConfirmedTransport
            && confirmedSteerTurnId(first.response) === turnId
          ) {
            // V2 `turn/steer` succeeds with `{ turnId }`. For a Desktop-owned
            // thread this response comes from the existing writer and is the
            // authoritative acceptance boundary. The append-only session row
            // may legitimately wait behind the currently executing tool, so
            // keeping Android queued until that later write creates a false
            // failure even though Desktop has already accepted the steer.
            return;
          }
          const confirmation = await durability;
          if (confirmation.kind === "durable") return;
          throw confirmation.error;
        }
        if (steerTransportFailureMayHaveDelivered(first.error)) {
          const confirmation = await durability;
          if (confirmation.kind === "durable") return;
          // Preserve the transport failure because it is the most actionable
          // error once the session stream also failed to prove persistence.
          throw first.error;
        }
        throw first.error;
      } finally {
        observation.cancel();
      }
    };

    const sendSteer = async (turnId: string): Promise<void> => {
      const requestFollowerAction = this.desktopIpc.requestFollowerAction;
      const ownership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
      let useDesktop = ownership.state === "desktop-owned";
      let routeWasChecked = ownership.state !== "unknown";
      if (!this.drafts.has(remoteThreadId) && requestFollowerAction && ownership.state === "unknown") {
        routeWasChecked = true;
        const route = this.desktopIpc.probeFollowerRoute
          ? await this.desktopIpc.probeFollowerRoute.call(this.desktopIpc, nativeThreadId)
          : "ready";
        if (route === "unhealthy") {
          throw desktopOwnershipSafeError(nativeThreadId, "the steer route is ambiguous");
        }
        useDesktop = route === "ready";
        if (route === "absent" && (ownership.everDesktopOwned || this.desktopIpc.hasObservedDesktopOwner?.(nativeThreadId))) {
          throw desktopOwnershipSafeError(nativeThreadId, "its owner could not be reached");
        }
      }
      if (!this.drafts.has(remoteThreadId) && requestFollowerAction && useDesktop) {
        try {
          this.markDurableMutationOwner(command, "desktop", nativeThreadId);
          if (trackingCommand !== command) {
            this.markDurableMutationOwner(trackingCommand, "desktop", nativeThreadId);
          }
          // Current Codex Desktop restores the optimistic steering bubble from
          // this message before it forwards turn/steer. Older Desktop builds
          // ignored it, so keep the original input/expectedTurnId fields too.
          const cwd = await this.taskWorkspaceRoot(remoteThreadId);
          const restoreMessage = {
            id: clientUserMessageId || randomUUID(),
            text,
            context: {
              prompt: text,
              addedFiles: [],
              fileAttachments: [],
              ideContext: null,
              imageAttachments: [],
              workspaceRoots: [cwd],
              collaborationMode: null,
            },
            cwd,
            createdAt: this.now(),
          };
          const selection = this.selectedTaskModel(remoteThreadId, command);
          const serviceTierValue = optionValue(selection.options, "serviceTier");
          await deliverAndConfirm(
            turnId,
            () => requestFollowerAction.call(
              this.desktopIpc,
              "thread-follower-steer-turn",
              {
                conversationId: nativeThreadId,
                input,
                expectedTurnId: turnId,
                restoreMessage,
                attachments: [],
                ...(typeof serviceTierValue === "string"
                  ? { serviceTier: desktopServiceTierValue(serviceTierValue) }
                  : {}),
                clientUserMessageId,
              },
            ),
            true,
          );
          return;
        } catch (error) {
          // A known Desktop owner may not be replaced by the private writer,
          // even when its renderer is between handler registrations.
          throw error;
        }
      }
      if (ownership.state === "desktop-owned" || ownership.everDesktopOwned) {
        throw desktopOwnershipSafeError(nativeThreadId, "the steer was not delivered");
      }
      await this.requirePrivateMutationRoute(nativeThreadId, "the steer", {
        probeIfUnknown: !routeWasChecked,
      });
      this.markDurableMutationOwner(command, "private", nativeThreadId);
      if (trackingCommand !== command) {
        this.markDurableMutationOwner(trackingCommand, "private", nativeThreadId);
      }
      await deliverAndConfirm(
        turnId,
        () => this.requireCodex().request("turn/steer", {
          threadId: nativeThreadId,
          input,
          expectedTurnId: turnId,
          clientUserMessageId,
        }),
      );
    };

    try {
      await sendSteer(expectedTurnId);
    } catch (error) {
      if (codexHasActiveWriter(error)) {
        // The steer was explicitly rejected. Refresh only its connection;
        // preserve the existing steer action, message id and active turn.
        this.desktopIpc.releaseThread(nativeThreadId);
        const route = await this.desktopIpc.probeFollowerRoute?.(nativeThreadId, { refreshOwner: true })
          .catch(() => "unhealthy" as const);
        if (route !== "ready") throw new Error("Codex is reconnecting. The steering message was not sent; try again once connected.");
        const currentTurnId = await this.activeTurnId(remoteThreadId, true);
        if (!currentTurnId) throw new Error("This task has no running turn to steer");
        try {
          await sendSteer(currentTurnId);
        } catch (retryError) {
          if (!codexHasActiveWriter(retryError)) throw retryError;
          throw new Error("Codex is reconnecting. The steering message was not sent; try again once connected.");
        }
        return;
      }
      if (!steerErrorCanHaveStaleTurnId(error)) throw error;
      const reportedTurnId = actualTurnIdFromSteerError(error);
      const refreshedTurnId = reportedTurnId || await this.activeTurnId(remoteThreadId, true);
      if (!refreshedTurnId || refreshedTurnId === expectedTurnId) throw error;
      expectedTurnId = refreshedTurnId;
      await sendSteer(expectedTurnId);
    }
  }

  private async steerQueuedTurn(
    command: JsonRecord,
    options: {
      retainOnFailure?: boolean;
      /** The caller already performed the active-turn check for this command. */
      activeTurnAlreadyConfirmed?: boolean;
    } = {},
  ): Promise<void> {
    const remoteThreadId = stringValue(command.threadId, 128);
    const messageId = stringValue(command.messageId, 128);
    const queued = this.queuedTurns.get(remoteThreadId) ?? [];
    const queuedIndex = queued.findIndex(candidate => candidate.messageId === messageId);
    const queuedTurn = queuedIndex >= 0 ? queued[queuedIndex] : undefined;
    if (!remoteThreadId || !messageId || !queuedTurn) {
      throw new Error("This queued message is no longer available");
    }
    const flightKey = `${remoteThreadId}\u0000${messageId}`;
    const existingFlight = this.queuedSteerFlights.get(flightKey);
    if (existingFlight) {
      await existingFlight;
      return;
    }
    const flightPrefix = `${remoteThreadId}\u0000`;
    if ([...this.queuedSteerFlights.keys()].some(key => key.startsWith(flightPrefix))) {
      throw new Error("Another queued message action is already in progress for this task");
    }
    let ownsThreadLock = false;
    let deliveryAttempted = false;
    const operation = (async (): Promise<void> => {
      try {
        // Queueing performs an automatic idle probe so a message submitted on
        // a stale running snapshot cannot be stranded. A user's explicit
        // "Steer instead" action must wait for that read-only probe rather
        // than being rejected by its transient lock.
        const pendingStartProbe = this.queuedTurnStartFlights.get(remoteThreadId);
        if (pendingStartProbe) await pendingStartProbe;
        const currentQueued = this.queuedTurns.get(remoteThreadId) ?? [];
        const currentQueuedTurn = currentQueued.find(
          candidate => candidate.messageId === messageId,
        );
        if (!currentQueuedTurn) {
          throw new Error("This queued message is no longer available");
        }
        if (this.queuedTurnStarts.has(remoteThreadId)) {
          throw new Error("Another queued message action is already in progress for this task");
        }
        if (
          !options.activeTurnAlreadyConfirmed
          && !await this.threadHasActiveTurn(remoteThreadId)
        ) {
          throw new Error("This task no longer has a running turn to steer");
        }
        // A second queued action can begin while the live-turn probe is in
        // flight. Re-check before claiming the per-thread mutation lock.
        if (this.queuedTurnStarts.has(remoteThreadId)) {
          throw new Error("Another queued message action is already in progress for this task");
        }
        this.queuedTurnStarts.add(remoteThreadId);
        ownsThreadLock = true;
        deliveryAttempted = true;
        await this.steerTurn(
          currentQueuedTurn.clientId,
          currentQueuedTurn.command,
          command,
          options.retainOnFailure !== false,
          currentQueuedTurn.stagedAttachments,
        );
        const current = this.queuedTurns.get(remoteThreadId) ?? [];
        this.replaceQueuedTurns(
          remoteThreadId,
          current.filter(candidate => candidate.messageId !== messageId),
        );
        this.publishQueuedTurnState(remoteThreadId);
      } catch (error) {
        if (options.retainOnFailure === false) {
          const current = this.queuedTurns.get(remoteThreadId) ?? [];
          this.replaceQueuedTurns(
            remoteThreadId,
            current.filter(candidate => candidate.messageId !== messageId),
          );
          this.publishQueuedTurnState(remoteThreadId);
        }
        if (deliveryAttempted) {
          // An explicitly queued message stays queued so the phone can retry
          // it. A direct steer is removed instead: it must never be silently
          // downgraded into a normal turn after the active task completes.
          this.requestAuthoritativeThreadRefresh(remoteThreadId);
          console.warn(
            `[Remodex] Android ${options.retainOnFailure === false ? "direct" : "queued"} steer was not durably confirmed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        throw error;
      } finally {
        if (ownsThreadLock) this.queuedTurnStarts.delete(remoteThreadId);
      }
    })();
    // Attach cleanup after constructing the operation. An operation can reject
    // before its first await (for example, a conflicting queued action); using
    // the tracked promise guarantees the map entry is removed after it is set.
    const flight = operation.finally(() => {
      this.queuedSteerFlights.delete(flightKey);
    });
    this.queuedSteerFlights.set(flightKey, flight);
    await flight;
  }

  private scheduleWriterRecovery(remoteThreadId: string): void {
    if (this.writerRecoveryStopped || this.gatewayStatus !== "ready" || this.writerRecoveryTimers.has(remoteThreadId)) return;
    const pending = this.queuedTurns.get(remoteThreadId)?.[0];
    if (!pending || pending.command.writerRecoveryPending !== true) return;
    const attempt = this.writerRecoveryAttempts.get(remoteThreadId) ?? 0;
    this.writerRecoveryAttempts.set(remoteThreadId, attempt + 1);
    const timer = setTimeout(() => {
      this.writerRecoveryTimers.delete(remoteThreadId);
      void this.startNextQueuedTurn(remoteThreadId).catch(() => undefined);
    }, Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000));
    timer.unref?.();
    this.writerRecoveryTimers.set(remoteThreadId, timer);
  }

  private async startNextQueuedTurn(
    remoteThreadId: string,
    knownIdle = false,
  ): Promise<void> {
    const existingFlight = this.queuedTurnStartFlights.get(remoteThreadId);
    if (existingFlight) {
      await existingFlight;
      return;
    }
    const steerFlightPrefix = `${remoteThreadId}\u0000`;
    if (
      (this.queuedTurns.get(remoteThreadId)?.length ?? 0) === 0
      || this.queuedTurnStarts.has(remoteThreadId)
      || [...this.queuedSteerFlights.keys()].some(key => key.startsWith(steerFlightPrefix))
    ) return;
    let ownsThreadLock = false;
    let attemptedMessageId: string | undefined;
    let reconciledDelivery = false;
    const operation = (async (): Promise<void> => {
      try {
        if (
          this.queuedTurnStarts.has(remoteThreadId)
          || [...this.queuedSteerFlights.keys()].some(key => key.startsWith(steerFlightPrefix))
        ) return;
        this.queuedTurnStarts.add(remoteThreadId);
        ownsThreadLock = true;
        if (!knownIdle && await this.threadHasActiveTurn(remoteThreadId)) return;
        const queued = this.queuedTurns.get(remoteThreadId) ?? [];
        const queuedTurn = queued[0];
        if (!queuedTurn) return;
        attemptedMessageId = queuedTurn.messageId;
        if (queuedTurn.command.writerRecoveryPending === true) {
          if (queuedTurn.command.writerRecoveryDeliveryUncertain === true) {
            const descriptor = durableMutationDescriptor(queuedTurn.command);
            const mutation = descriptor && this.mutationStore.get(descriptor.mutationId);
            // A lost acknowledgement or process restart must only read for
            // proof of delivery, never replay the queued prompt blindly.
            if (!mutation || !await this.reconcileDurableMutation({ ...mutation, owner: "desktop" })) return;
            this.replaceQueuedTurns(remoteThreadId, (this.queuedTurns.get(remoteThreadId) ?? [])
              .filter(turn => turn.messageId !== queuedTurn.messageId));
            this.publishQueuedTurnState(remoteThreadId);
            reconciledDelivery = true;
            return;
          }
          queuedTurn.command.writerRecoveryDeliveryUncertain = true;
          this.persistQueuedTurns();
        }
        // Keep the durable queue row until the owner confirms the turn start.
        // Removing it first creates a crash window where an accepted prompt is
        // present in neither the queue nor the transcript.
        await this.startTurnNormally(
          queuedTurn.clientId,
          queuedTurn.command,
          queuedTurn.stagedAttachments,
        );
        const current = this.queuedTurns.get(remoteThreadId) ?? [];
        this.replaceQueuedTurns(
          remoteThreadId,
          current.filter(candidate => candidate.messageId !== queuedTurn.messageId),
        );
        this.publishQueuedTurnState(remoteThreadId);
      } catch (error) {
        if (error instanceof WriterOwnershipUnavailableError) {
          const queuedTurn = this.queuedTurns.get(remoteThreadId)?.find(turn => turn.messageId === attemptedMessageId);
          if (queuedTurn) {
            queuedTurn.command.writerRecoveryPending = true;
            delete queuedTurn.command.writerRecoveryDeliveryUncertain;
            this.persistQueuedTurns();
          }
        }
        // The queue entry remains durable and visible. A later terminal event,
        // reconnect, or explicit user action can retry it safely.
      } finally {
        if (ownsThreadLock) this.queuedTurnStarts.delete(remoteThreadId);
      }
    })();
    const flight = operation.finally(() => {
      this.queuedTurnStartFlights.delete(remoteThreadId);
      this.scheduleWriterRecovery(remoteThreadId);
      if (reconciledDelivery) void this.startNextQueuedTurn(remoteThreadId).catch(() => undefined);
    });
    this.queuedTurnStartFlights.set(remoteThreadId, flight);
    await flight;
  }

  private async startNextQueuedTurnAfterCompletion(
    remoteThreadId: string,
    completedTurnId: string,
  ): Promise<void> {
    const completionKey = `${remoteThreadId}\u0000${completedTurnId}`;
    if (this.queuedTurnCompletionKeys.has(completionKey)) return;
    this.queuedTurnCompletionKeys.add(completionKey);
    // Keep this replay guard bounded during very long-running gateways.
    while (this.queuedTurnCompletionKeys.size > 1_024) {
      const oldestKey = this.queuedTurnCompletionKeys.values().next().value;
      if (typeof oldestKey !== "string") break;
      this.queuedTurnCompletionKeys.delete(oldestKey);
    }

    // A very short turn can complete before the preceding queued start has
    // removed its durable queue row and released its per-thread lock. Wait for
    // that cleanup, then consume the newly completed turn's queue signal.
    const pendingStart = this.queuedTurnStartFlights.get(remoteThreadId);
    if (pendingStart) await pendingStart;
    await this.startNextQueuedTurn(remoteThreadId, true);
  }

  private async startTurn(clientId: string, command: JsonRecord): Promise<void> {
    const remoteThreadId = stringValue(command.threadId, 128);
    this.assertTaskModelRoute(this.selectedTaskModel(remoteThreadId, command), remoteThreadId);
    const deliveryMode = stringValue(command.deliveryMode, 32);
    const canQueueBehindCurrentTurn =
      record(command.promptEdit) === null
      && !this.drafts.has(remoteThreadId);
    if (deliveryMode === "queue" && canQueueBehindCurrentTurn) {
      // Explicit queue is a durable presentation mutation, not a synchronous
      // owner-discovery request. Accept it immediately and let queueTurn's
      // background idle probe decide when it can be drained. A broken Desktop
      // IPC route must never consume Android's request timeout before the
      // queued card is acknowledged.
      this.queueTurn(clientId, command);
      return;
    }
    const activeTurn = canQueueBehindCurrentTurn
      && (
        deliveryMode === ""
        || deliveryMode === "normal"
        || deliveryMode === "steer"
      )
      ? await this.threadHasActiveTurn(remoteThreadId)
      : false;
    if (
      activeTurn
      && (
        deliveryMode === ""
        || deliveryMode === "normal"
        || deliveryMode === "queue"
      )
    ) {
      this.queueTurn(clientId, command);
      return;
    }
    if (deliveryMode === "steer" && activeTurn) {
      const messageId = stringValue(record(command.message)?.messageId, 128);
      this.queueTurn(clientId, command, { startIfAlreadyIdle: false });
      await this.steerQueuedTurn({
        type: "thread.turn.queue.steer",
        threadId: remoteThreadId,
        messageId,
      }, {
        retainOnFailure: false,
        // `activeTurn` was just established above. Repeating the probe here
        // used to issue a second private thread/read while Desktop owned the
        // writer, adding another full timeout before the follower request.
        activeTurnAlreadyConfirmed: true,
      });
      return;
    }
    if (deliveryMode === "steer") {
      throw new Error("This task has no running turn to steer");
    }
    if (canQueueBehindCurrentTurn
      && this.queuedTurns.get(remoteThreadId)?.some(turn => turn.command.writerRecoveryPending === true)) {
      this.queueTurn(clientId, command);
      return;
    }
    try {
      await this.startTurnNormally(clientId, command);
    } catch (error) {
      if (error instanceof WriterOwnershipUnavailableError && canQueueBehindCurrentTurn) {
        // The writer explicitly rejected the prompt. Keep it durable and let
        // the normal queue drain reconnect; no completion event is needed.
        this.queueTurn(clientId, { ...command, writerRecoveryPending: true }, { startIfAlreadyIdle: false });
        this.scheduleWriterRecovery(remoteThreadId);
        return;
      }
      const safeQueueFallback = (
        deliveryMode === ""
        || deliveryMode === "normal"
        || deliveryMode === "queue"
      )
        && record(command.promptEdit) === null
        && !this.drafts.has(remoteThreadId)
        && fallbackOwnershipState(this.desktopIpc, this.nativeThreadId(remoteThreadId)).state !== "desktop-owned"
        && codexHasActiveWriter(error);
      if (!safeQueueFallback) throw error;
      // A writer lock alone does not mean work is running: Codex Desktop keeps
      // the lock while an open task is idle. Queue only after a fresh activity
      // probe confirms a real turn; otherwise expose the failed handoff rather
      // than trapping the prompt in a queue that can never drain.
      if (!await this.threadHasActiveTurn(remoteThreadId)) throw error;
      this.queueTurn(clientId, command);
    }
  }

  private async startTurnNormally(
    clientId: string,
    command: JsonRecord,
    preparedAttachments?: PersistedAndroidQueuedTurn["stagedAttachments"],
  ): Promise<void> {
    const remoteThreadId = stringValue(command.threadId, 128);
    const message = record(command.message);
    if (!remoteThreadId || !message) throw new TypeError("task and message are required");
    if (typeof message.text === "string" && message.text.length > 120_000) {
      throw new RangeError("prompt exceeds the 120,000 character limit");
    }
    const attachments = message.attachments;
    if (record(command.promptEdit) && Array.isArray(attachments) && attachments.length > 0) {
      throw new Error("Editing prompt attachments is not supported yet");
    }
    const staged = preparedAttachments ?? (Array.isArray(attachments) && attachments.length > 0
      ? stageAndroidAttachments({ clientId, attachments })
      : { codexInputs: [], referencedFiles: [], stagedPaths: [] });
    if (command.writerRecoveryPending !== true) {
      try {
        await this.startTurnUsingOwner(clientId, command, staged);
        return;
      } catch (error) {
        // Replaying an edit could roll history back twice. Only ordinary sends
        // rejected before turn acceptance may switch owners automatically.
        if (!codexHasActiveWriter(error) || record(command.promptEdit) || this.drafts.has(remoteThreadId)) {
          throw error;
        }
      }
    }

    const nativeThreadId = this.nativeThreadId(remoteThreadId);
    this.desktopIpc.releaseThread(nativeThreadId);
    this.forgetKnownActiveTurn(nativeThreadId);
    this.desktopActiveTurnProbes.delete(nativeThreadId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise<void>(resolve => setTimeout(resolve, attempt * 150));
      const route = await this.desktopIpc.probeFollowerRoute?.(nativeThreadId, { refreshOwner: true })
        .catch(() => "unhealthy" as const) ?? "unhealthy";
      if (route === "ready") {
        // Desktop may have started work during the failed Android send.
        // Recheck the shared task so a normal message queues behind that work.
        if (await this.threadHasActiveTurn(remoteThreadId)) throw new WriterOwnershipUnavailableError();
        try {
          await this.startTurnUsingOwner(clientId, command, staged, true);
          return;
        } catch (error) {
          // A timeout may mean the prompt was accepted. Never replay it.
          if (!codexHasActiveWriter(error)
            && !desktopTurnStartDefinitelyNotDelivered(error)
            && !(error instanceof WriterOwnershipUnavailableError)) throw error;
        }
      } else if (attempt === 0) {
        // After a reconnect the private app-server can still have this writer
        // mounted even though our mirror forgot it. Reuse that writer only
        // when its own loaded-thread list proves it exists.
        if (!desktopOwnershipIsAuthoritative(fallbackOwnershipState(this.desktopIpc, nativeThreadId))) {
          const loaded = record(await this.requireCodex().request("thread/loaded/list", {})
            .catch(() => null));
          if (Array.isArray(loaded?.data) && loaded.data.includes(nativeThreadId)) {
            this.desktopIpc.adoptLocalThread?.(nativeThreadId);
            try {
              await this.startTurnUsingOwner(clientId, command, staged, true);
              return;
            } catch (error) {
              if (!codexHasActiveWriter(error)) throw error;
              this.desktopIpc.releaseThread(nativeThreadId);
            }
          }
        }
      }
      if (attempt === 0 && command.writerRecoveryPending !== true
        && this.desktopIpc.connectionSnapshot?.().connected === true) {
        await this.desktopIpc.activateFollowerThread?.(nativeThreadId).catch(() => undefined);
      }
    }
    throw new WriterOwnershipUnavailableError();
  }

  private async startTurnUsingOwner(
    clientId: string,
    command: JsonRecord,
    preparedAttachments?: PersistedAndroidQueuedTurn["stagedAttachments"],
    recoveringWriter = false,
  ): Promise<void> {
    const remoteThreadId = stringValue(command.threadId, 128);
    const message = record(command.message);
    if (!remoteThreadId || !message) throw new TypeError("task and message are required");
    const text = typeof message.text === "string" ? message.text : "";
    if (text.length > 120_000) throw new RangeError("prompt exceeds the 120,000 character limit");
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const draft = this.drafts.get(remoteThreadId);
    const promptEdit = promptEditReference(command);
    if (promptEdit && draft) throw new Error("A draft task has no prompt to edit");
    if (promptEdit && attachments.length > 0) {
      throw new Error("Editing prompt attachments is not supported yet");
    }
    const staged = preparedAttachments
      ?? (attachments.length > 0
        ? stageAndroidAttachments({ clientId, attachments })
        : { codexInputs: [], referencedFiles: [], stagedPaths: [] });
    const prompt = staged.referencedFiles.length > 0
      ? `${text}\n\nFiles uploaded from Android and staged on this PC:\n${staged.referencedFiles.map(path => `- ${path}`).join("\n")}`
      : text;
    const validatedSelection = this.validatedTaskModelSelection(
      this.selectedTaskModel(remoteThreadId, command),
    );
    const selection = validatedSelection.selection;
    this.assertTaskModelRoute(selection, remoteThreadId);
    const runtimeMode = normalizedRuntimeMode(command.runtimeMode);
    const interactionMode = normalizedInteractionMode(command.interactionMode);
    const config = runtimeConfig(runtimeMode);
    const storedAlias = this.store.read().threadAliases.find(row => row.remoteThreadId === remoteThreadId);
    let nativeThreadId = this.nativeThreadId(remoteThreadId);
    const effort = validatedSelection.effort;
    const serviceTierValue = optionValue(selection.options, "serviceTier");
    const serviceTier = typeof serviceTierValue === "string" ? serviceTierValue : null;
    const desktopTier = desktopServiceTierValue(serviceTier);
    const input: unknown[] = [];
    if (prompt) input.push({ type: "text", text: prompt, text_elements: [] });
    input.push(...staged.codexInputs);
    const collaborationMode = {
      mode: interactionMode,
      settings: {
        model: selection.model,
        reasoning_effort: effort,
        developer_instructions: null,
      },
    };
    const makeTurnStartParams = (threadId: string): JsonRecord => ({
      threadId,
      clientUserMessageId: stringValue(message.messageId, 128) || undefined,
      input,
      model: selection.model,
      approvalPolicy: config.approvalPolicy,
      approvalsReviewer: config.approvalsReviewer,
      sandboxPolicy: config.sandboxPolicy,
      ...(typeof effort === "string" ? { effort } : {}),
      serviceTier,
      collaborationMode,
    });
    const makeDesktopTurnStartParams = (threadId: string): JsonRecord => ({
      ...makeTurnStartParams(threadId),
      model: this.desktopTaskModel(selection, remoteThreadId),
      collaborationMode: {
        ...collaborationMode,
        settings: { ...collaborationMode.settings, model: this.desktopTaskModel(selection, remoteThreadId) },
      },
      serviceTier: desktopTier,
    });
    const rememberStartedTurn = (): void => {
      this.commitTaskSelection({
        nativeThreadId,
        remoteThreadId,
        providerInstanceId: selection.instanceId,
        model: selection.model,
        ...(selection.options !== undefined ? { options: selection.options } : {}),
        ...(validatedSelection.capabilityVersion
          ? { capabilityVersion: validatedSelection.capabilityVersion }
          : {}),
        source: "android",
        updateId: stringValue(command.commandId, 128)
          || stringValue(message.messageId, 128)
          || randomUUID(),
      });
      const current = this.preferences.get(remoteThreadId) ?? {};
      this.preferences.set(remoteThreadId, { ...current, runtimeMode, interactionMode });
      const sourcePlan = record(command.sourceProposedPlan);
      const sourcePlanId = stringValue(sourcePlan?.planId, 128);
      if (sourcePlanId) this.markSourcePlanImplemented(remoteThreadId, sourcePlanId);
    };
    let turnStartParams = makeTurnStartParams(nativeThreadId);
    const stableCommandId = stringValue(command.commandId, 128)
      || stringValue(message.messageId, 128)
      || randomUUID();
    const routeDiagnostics = (
      event: string,
      details: Record<string, string | number | boolean> = {},
    ): void => {
      if (process.env.OPENCODEX_ANDROID_IPC_DEBUG !== "1") return;
      const snapshot = this.desktopIpc.connectionSnapshot?.();
      console.log(`[remodex] Android IPC route ${JSON.stringify({
        event,
        threadId: nativeThreadId,
        commandId: stableCommandId,
        connected: snapshot?.connected ?? false,
        generation: snapshot?.generation ?? 0,
        localClientId: snapshot?.localClientId || "-",
        ...details,
      })}`);
    };
    const probeDesktopOwner = async (): Promise<"ready" | "absent" | "unhealthy"> => {
      const probeFollowerRoute = this.desktopIpc.probeFollowerRoute;
      const route = probeFollowerRoute
        ? await probeFollowerRoute.call(this.desktopIpc, nativeThreadId)
        : "ready";
      routeDiagnostics("preflight", { route });
      return route;
    };
    const deliverDesktopOwnerStart = async (): Promise<boolean> => {
      const requestFollowerAction = this.desktopIpc.requestFollowerAction;
      if (!requestFollowerAction) return false;
      routeDiagnostics("dispatch", { route: "desktop" });
      try {
        this.markDurableMutationOwner(command, "desktop", nativeThreadId);
        try {
          await requestFollowerAction.call(
            this.desktopIpc,
            "thread-follower-update-thread-settings",
            {
              conversationId: nativeThreadId,
              threadSettings: {
                model: this.desktopTaskModel(selection, remoteThreadId),
                effort: effort ?? null,
                serviceTier: desktopTier,
                collaborationMode: makeDesktopTurnStartParams(nativeThreadId).collaborationMode,
              },
            },
          );
        } catch (error) {
          // This optional follower method was added after start-turn v2. A
          // router-level no-handler result is pre-delivery and the complete
          // runtime choice remains present in turnStart.request, so the prompt
          // can still be sent safely. Timeouts, disconnects, protocol errors,
          // and Desktop-side failures remain ambiguous and fail closed.
          if (!optionalDesktopSettingsHandlerUnavailable(error)) throw error;
        }
        const started = await requestFollowerAction.call(this.desktopIpc, "thread-follower-start-turn", {
          conversationId: nativeThreadId,
          turnStart: {
            request: makeDesktopTurnStartParams(nativeThreadId),
            context: {
              inheritThreadSettings: true,
            },
          },
        });
        this.rememberKnownActiveTurn(nativeThreadId, confirmedSteerTurnId(started));
        rememberStartedTurn();
        routeDiagnostics("acknowledged", { route: "desktop" });
        return true;
      } catch (error) {
        routeDiagnostics("failed", {
          route: "desktop",
          failure: desktopTurnStartFailureClass(error),
        });
        // `requestFollowerAction` retries router-level no-client-found itself.
        // Once a route was selected, every other result is ownership-safe and
        // must never fall through to the private app-server.  The fallback is
        // retained only for legacy test/integration doubles that expose no
        // ownership registry at all; the production LiveSync always exposes it.
        if (
          !this.desktopIpc.threadOwnership
          && !this.desktopIpc.hasObservedDesktopOwner?.(nativeThreadId)
          && definitiveDesktopNoOwner(error)
        ) return false;
        throw error;
      }
    };
    const startThroughDesktopOwner = async (
      ownership: DesktopThreadOwnership,
      probeUnknown = true,
    ): Promise<boolean> => {
      if (ownership.state === "desktop-owned") {
        return await deliverDesktopOwnerStart();
      }
      if (!probeUnknown) return false;
      const route = await probeDesktopOwner();
      if (route === "unhealthy") {
        routeDiagnostics("failed", {
          route: "desktop",
          failure: "preflight-unhealthy",
        });
        throw desktopOwnershipSafeError(
          nativeThreadId,
          "its IPC route is unavailable or ambiguous",
        );
      }
      if (route === "absent") return false;
      return await deliverDesktopOwnerStart();
    };
    const startThroughPrivateOwner = async (
      options: { alreadyMounted?: boolean; authoritativeAdoption?: boolean } = {},
    ): Promise<void> => {
      const ownership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
      if (ownership.state === "desktop-owned") {
        throw desktopOwnershipSafeError(
          nativeThreadId,
          "the Desktop writer is still authoritative",
        );
      }
      const alias = this.store.read().threadAliases.find(
        row => row.nativeThreadId === nativeThreadId,
      );
      routeDiagnostics("dispatch", { route: "private" });
      if (!options.alreadyMounted) {
        if (options.authoritativeAdoption) {
          this.desktopIpc.releaseDesktopOwnership?.(nativeThreadId);
        }
        this.desktopIpc.claimThread({
          threadId: nativeThreadId,
          turnStartParams,
          cwd: alias?.cwd ?? draft?.cwd,
          title: alias?.title ?? draft?.title,
        });
      }
      try {
        this.markDurableMutationOwner(command, "private", nativeThreadId);
        const started = await this.requireCodex().request("turn/start", turnStartParams);
        this.rememberKnownActiveTurn(nativeThreadId, confirmedSteerTurnId(started));
      } catch (error) {
        // A rejected start never becomes an authoritative live owner.
        // Releasing here also cancels the blocked initial-history path and
        // prevents stale private ownership from surviving a failed start.
        this.desktopIpc.releaseThread(nativeThreadId);
        routeDiagnostics("failed", {
          route: "private",
          failure: codexHasActiveWriter(error) ? "active-writer" : "owner-error",
        });
        throw error;
      }
      rememberStartedTurn();
      routeDiagnostics("acknowledged", { route: "private" });
    };

    // Codex Desktop has a dedicated edit reducer that atomically rolls back,
    // replaces its local history, and starts the edited turn. Sending separate
    // rollback and start-turn actions leaves Desktop's original user row in
    // its render cache even though the durable rollout is already correct.
    if (promptEdit) {
      const requestFollowerAction = this.desktopIpc.requestFollowerAction;
      const editOwnership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
      const mayProbeDesktopForEdit = editOwnership.state === "unknown"
        && !editOwnership.everDesktopOwned;
      if (requestFollowerAction && editOwnership.state !== "local-owned") {
        const editThroughDesktopOwner = async (): Promise<void> => {
          this.markDurableMutationOwner(command, "desktop", nativeThreadId);
          await requestFollowerAction.call(
            this.desktopIpc,
            "thread-follower-update-thread-settings",
            {
              conversationId: nativeThreadId,
              threadSettings: {
                model: this.desktopTaskModel(selection, remoteThreadId),
                ...(typeof effort === "string" ? { effort } : {}),
                ...(serviceTier !== null ? { serviceTier: desktopTier } : {}),
                collaborationMode: makeDesktopTurnStartParams(nativeThreadId).collaborationMode,
              },
            },
          );
          await requestFollowerAction.call(
            this.desktopIpc,
            "thread-follower-edit-last-user-turn",
            {
              conversationId: nativeThreadId,
              turnId: promptEdit.targetTurnId,
              message: prompt,
              agentMode: desktopAgentMode(runtimeMode),
              shouldSendPermissionOverrides: true,
              serviceTier: desktopTier,
            },
          );
        };
        let editedThroughDesktop = false;
        try {
          await editThroughDesktopOwner();
          editedThroughDesktop = true;
        } catch (error) {
          // Desktop may release an idle task while its rendered conversation
          // remains open. A private rollback is durable in that state, but the
          // stale Desktop renderer never sees the history replacement. Restore
          // the native Desktop owner and retry its atomic reducer first.
          if (!definitiveDesktopNoOwner(error)) throw error;
          if (!mayProbeDesktopForEdit && editOwnership.everDesktopOwned) {
            throw desktopOwnershipSafeError(nativeThreadId, "the Desktop edit route is unavailable");
          }
          const activateFollowerThread = this.desktopIpc.activateFollowerThread;
          if (
            nativeThreadId === remoteThreadId
            && activateFollowerThread
          ) {
            let activated = false;
            try {
              await activateFollowerThread.call(this.desktopIpc, nativeThreadId);
              activated = true;
            } catch {
              // Opening the Desktop route is best-effort. If it cannot be
              // activated, the authoritative private rollback below remains
              // available instead of stranding the Android edit.
            }
            if (activated) {
              for (const delayMs of DESKTOP_ATOMIC_EDIT_REATTACH_DELAYS_MS) {
                await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs));
                try {
                  await editThroughDesktopOwner();
                  editedThroughDesktop = true;
                  break;
                } catch (retryError) {
                  if (!definitiveDesktopNoOwner(retryError)) throw retryError;
                }
              }
            }
          }
        }
        if (editedThroughDesktop) {
          rememberStartedTurn();
          this.clearRolledBackProjection(remoteThreadId);
          try {
            await this.refreshAuthoritativeThreadNow(remoteThreadId);
          } catch {
            this.requestAuthoritativeThreadRefresh(remoteThreadId);
          }
          return;
        }
      }
    }

    const postEditOwnership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
    if (
      promptEdit
      && !this.drafts.has(remoteThreadId)
      && (postEditOwnership.state === "desktop-owned" || postEditOwnership.everDesktopOwned)
    ) {
      throw desktopOwnershipSafeError(nativeThreadId, "the Desktop edit was not delivered");
    }

    const localPromptEditTurns = promptEdit
      ? await this.promptEditRollbackCount(nativeThreadId, promptEdit.targetTurnId)
      : null;
    if (localPromptEditTurns !== null) {
      this.markDurableMutationOwner(command, "private", nativeThreadId);
    }

    // Desktop keeps an exclusive writer lock even while its task is merely
    // open and idle. Give an already-open Desktop task the turn first, so the
    // phone does not race a second app-server connection into that lock.
    //
    // A task created from Android has a remote-to-native alias. A task fetched
    // directly from Codex does not: its Android id already IS the native id.
    // Both are existing tasks and must be offered to the Desktop owner. Only a
    // still-local Android draft skips this route because no native task exists
    // for Desktop to own yet.
    let ownership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
    const privateOwnerAlreadyMounted = !draft && !promptEdit && ownership.state === "local-owned";
    if (!draft && !promptEdit) {
      if (ownership.state === "desktop-owned") {
        await startThroughDesktopOwner(ownership, false);
        return;
      }
      if (privateOwnerAlreadyMounted) {
        // `thread/resume` is not idempotent for an already-mounted Codex
        // writer. Reuse the private owner directly for consecutive Android
        // turns instead of colliding with our own retained writer lock.
        await startThroughPrivateOwner({ alreadyMounted: true });
        return;
      }
      const route = await probeDesktopOwner();
      if (route === "ready") {
        if (await deliverDesktopOwnerStart()) return;
      }
      if (recoveringWriter) throw new WriterOwnershipUnavailableError();
      if (route === "unhealthy") {
        throw desktopOwnershipSafeError(nativeThreadId, "Desktop ownership could not be ruled out");
      }
      ownership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
      if (ownership.everDesktopOwned || ownership.state === "desktop-owned") {
        throw desktopOwnershipSafeError(nativeThreadId, "its owner is not currently reachable");
      }
      // `absent` is definitive only for a thread that has never emitted a
      // Desktop ownership signal.  Local adoption below is the first writer.
    }

    this.assertPrivateTaskModelRoute(selection);
    if (nativeThreadId === remoteThreadId && draft) {
      if (draft.workspaceKind === "projectless") {
        try {
          await mkdir(draft.cwd, { recursive: true });
        } catch {
          throw new Error("The neutral Chats workspace could not be prepared");
        }
      }
      const started = record(await this.requireCodex().request("thread/start", {
        cwd: draft.cwd,
        model: selection.model,
        approvalPolicy: config.approvalPolicy,
        approvalsReviewer: config.approvalsReviewer,
        sandbox: config.sandbox,
      }));
      const nativeThread = record(started?.thread);
      nativeThreadId = stringValue(nativeThread?.id, 128);
      if (!nativeThreadId) throw new Error("Codex did not create the task");
      turnStartParams = makeTurnStartParams(nativeThreadId);
      const createdAt = draft.createdAt;
      const alias: AndroidRemoteThreadAlias = {
        remoteThreadId,
        nativeThreadId,
        projectId: draft.projectId,
        ...(draft.workspaceKind ? { workspaceKind: draft.workspaceKind } : {}),
        title: stringValue(command.titleSeed, 256) || draft.title,
        cwd: draft.cwd,
        instanceId: selection.instanceId,
        model: selection.model,
        runtimeMode,
        interactionMode,
        createdAt,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.store.upsertThreadAlias(alias);
      this.drafts.delete(remoteThreadId);
      if (alias.title) {
        await this.requireCodex().request("thread/name/set", {
          threadId: nativeThreadId,
          name: alias.title,
        }).catch(() => undefined);
      }
    } else {
      const currentOwnership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
      if (currentOwnership.state === "desktop-owned" || currentOwnership.everDesktopOwned) {
        throw desktopOwnershipSafeError(nativeThreadId, "its writer ownership is ambiguous");
      }
      await this.requireCodex().request("thread/resume", {
        threadId: nativeThreadId,
        excludeTurns: true,
        model: selection.model,
        ...(storedAlias?.cwd ? { cwd: storedAlias.cwd } : {}),
        approvalPolicy: config.approvalPolicy,
        approvalsReviewer: config.approvalsReviewer,
        sandbox: config.sandbox,
      });
      if (localPromptEditTurns !== null) {
        await this.requireCodex().request("thread/rollback", {
          threadId: nativeThreadId,
          numTurns: localPromptEditTurns,
        });
        this.clearRolledBackProjection(remoteThreadId);
        // The private app-server may still be the Desktop stream owner from a
        // previous Android edit. Its conversation cache is append-oriented and
        // would otherwise keep the rolled-back prompt, then append the edited
        // replacement. Drop that owner snapshot so claimThread hydrates a fresh
        // authoritative baseline before Desktop follows the new turn.
        this.desktopIpc.releaseThread(nativeThreadId);
      }
    }
    await startThroughPrivateOwner({ authoritativeAdoption: true });
    if (localPromptEditTurns !== null) {
      try {
        await this.refreshAuthoritativeThreadNow(remoteThreadId);
      } catch {
        this.requestAuthoritativeThreadRefresh(remoteThreadId);
      }
    }
  }

  private async promptEditRollbackCount(
    nativeThreadId: string,
    targetTurnId: string,
  ): Promise<number> {
    const currentResult = record(await this.requireCodex().request("thread/read", {
      threadId: nativeThreadId,
      includeTurns: true,
    }));
    const currentThread = record(currentResult?.thread);
    if (!currentThread) throw new Error("Codex task was not found");
    const currentTurns = Array.isArray(currentThread.turns) ? currentThread.turns : [];
    const targetIndex = currentTurns.findIndex(value =>
      stringValue(record(value)?.id, 128) === targetTurnId);
    if (targetIndex < 0) throw new Error("The prompt to edit is no longer present in this task");
    if (currentTurns.some(value => {
      const status = stringValue(record(value)?.status, 64)
        .replace(/[^a-z0-9]/giu, "")
        .toLowerCase();
      return status === "inprogress" || status === "running" || status === "active";
    })) {
      throw new Error("Stop the current work before editing this prompt");
    }
    return currentTurns.length - targetIndex;
  }

  private async interruptTurn(command: JsonRecord): Promise<void> {
    const remoteThreadId = stringValue(command.threadId, 128);
    if (!remoteThreadId) throw new TypeError("task id is required");
    const nativeThreadId = this.nativeThreadId(remoteThreadId);
    const requestFollowerAction = this.desktopIpc.requestFollowerAction;
    const ownership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
    let desktopRoute = ownership.state === "desktop-owned";
    let routeWasChecked = ownership.state !== "unknown";
    if (!this.drafts.has(remoteThreadId) && requestFollowerAction && !desktopRoute && ownership.state === "unknown") {
      routeWasChecked = true;
      const route = this.desktopIpc.probeFollowerRoute
        ? await this.desktopIpc.probeFollowerRoute.call(this.desktopIpc, nativeThreadId)
        : "ready";
      if (route === "unhealthy") {
        throw desktopOwnershipSafeError(nativeThreadId, "its interrupt route is ambiguous");
      }
      desktopRoute = route === "ready";
      if (route === "absent" && (ownership.everDesktopOwned || this.desktopIpc.hasObservedDesktopOwner?.(nativeThreadId))) {
        throw desktopOwnershipSafeError(nativeThreadId, "its owner could not be reached");
      }
    }
    if (!this.drafts.has(remoteThreadId) && requestFollowerAction && desktopRoute) {
      // Manual Stop must reach the owner even when status/history discovery is
      // unavailable. Omitting expectedTurnId uses Desktop's normal user-stop:
      // it resolves the current turn, handles a changed id during compaction,
      // pauses an active goal and cleans up its running work. A stale expected
      // id instead makes Desktop acknowledge a no-op with interruptedTurnId:null.
      const beforeStop = record(this.threadStreams.get(remoteThreadId)?.detail.thread)
        ?? this.shellLifecycles.get(remoteThreadId);
      const stoppedSnapshotTurnId = stringValue(record(beforeStop?.session)?.activeTurnId, 128);
      try {
        const response = record(await requestFollowerAction.call(this.desktopIpc, "thread-follower-interrupt-turn", {
          conversationId: nativeThreadId,
          mode: "user-stop",
        }));
        const result = record(response?.result) ?? response;
        const interruptedTurnId = nativeExpectedTurnId(result?.interruptedTurnId);
        if (!interruptedTurnId) {
          throw new Error("Codex Desktop did not confirm an active turn was stopped. Refresh the task and try Stop again.");
        }
        // Publish the owner's actual acknowledgement, not the phone's cached
        // turn id. The lifecycle reducer protects any newer observed turn.
        this.applyLiveCodexNotification({ method: "turn/completed", params: {
          threadId: nativeThreadId,
          turn: { id: interruptedTurnId, status: "interrupted" },
          stoppedSnapshotTurnId,
        } }, true, "desktop-stop");
        this.forgetKnownActiveTurn(nativeThreadId, interruptedTurnId);
        if (stringValue(result?.goalPauseError, 2048)) {
          throw new Error("The current turn stopped, but Codex Desktop could not pause its goal. Pause the goal in Desktop to prevent more work.");
        }
      } finally {
        this.desktopActiveTurnProbes.delete(nativeThreadId);
        this.desktopThreadActivityCache.delete(nativeThreadId);
        this.requestAuthoritativeThreadRefresh(remoteThreadId);
      }
      return;
    }
    if (ownership.state === "desktop-owned" || ownership.everDesktopOwned) {
      throw desktopOwnershipSafeError(nativeThreadId, "Desktop IPC cannot deliver the interrupt");
    }
    if (!this.drafts.has(remoteThreadId)) {
      await this.requirePrivateMutationRoute(nativeThreadId, "the interrupt", {
        probeIfUnknown: !routeWasChecked,
      });
    }
    // For a local owner, use already-observed identity immediately. Do not
    // put a history refresh in front of cancellation of a stalled request.
    // The owning app-server validates this id when processing turn/interrupt.
    const cachedThread = record(this.threadStreams.get(remoteThreadId)?.detail.thread);
    const watchedTurnId = this.desktopSessions.isWatching(remoteThreadId)
      ? this.desktopSessions.activeTurnId?.(remoteThreadId)
      : undefined;
    let turnId = watchedTurnId ?? (
      nativeExpectedTurnId(record(cachedThread?.session)?.activeTurnId)
      || this.knownActiveTurnIds.get(nativeThreadId)
      || nativeExpectedTurnId(command.turnId)
    );
    if (!turnId) turnId = await this.activeTurnId(remoteThreadId);
    if (!turnId) {
      const result = record(await this.requireCodex().request("thread/read", {
        threadId: nativeThreadId,
        includeTurns: true,
      }));
      const thread = record(result?.thread);
      const turns = Array.isArray(thread?.turns) ? thread.turns : [];
      const active = [...turns].reverse().map(record).find(turn => turn?.status === "inProgress");
      turnId = stringValue(active?.id, 128);
    }
    if (!turnId) throw new Error("This task has no running turn to stop");
    await this.requireCodex().request("turn/interrupt", { threadId: nativeThreadId, turnId });
  }

  private requestAuthoritativeThreadRefresh(remoteThreadId: string): void {
    if (!remoteThreadId) return;
    this.authoritativeThreadRefreshes.add(remoteThreadId);
    this.scheduleRefresh();
  }

  /**
   * Publish a rollback replacement before acknowledging the edit command.
   *
   * Android starts the replacement turn as soon as the dispatch response is
   * received. A scheduled refresh leaves a short window where the old prompt
   * and the replacement optimistic prompt are both visible. Reconcile this
   * one task synchronously so the removed suffix reaches every subscribed
   * phone before it can submit the replacement.
   */
  private async refreshAuthoritativeThreadNow(remoteThreadId: string): Promise<void> {
    if (!remoteThreadId) return;
    this.authoritativeThreadRefreshes.add(remoteThreadId);
    try {
      const current = await this.ensureThreadStream(remoteThreadId);
      const detail = await this.readFullThreadDetail(remoteThreadId, { boundedInitial: true, allowEmptyHistory: true });
      const latest = this.threadStreams.get(remoteThreadId) ?? current;
      const advanced = advanceProjectedThreadStream(latest, detail, this.now());
      this.threadStreams.set(remoteThreadId, advanced.state);
      this.pruneThreadStreams();

      const subscribedSockets = [...this.sockets].filter(ws =>
        ws.data.subscription === "thread" && ws.data.threadId === remoteThreadId);
      for (const ws of subscribedSockets) {
        for (const event of advanced.items) this.publishSubscriptionEvent(ws, event, false);
      }
      if ((this.queuedTurns.get(remoteThreadId)?.length ?? 0) > 0) {
        void this.startNextQueuedTurn(remoteThreadId).catch(() => undefined);
      }
    } finally {
      this.authoritativeThreadRefreshes.delete(remoteThreadId);
    }
  }

  private clearRolledBackProjection(remoteThreadId: string): void {
    this.windowsHistoryBackfills.delete(remoteThreadId);
    this.supplementalActivities.delete(remoteThreadId);
    this.supplementalPlans.delete(remoteThreadId);
    this.completedLiveMessageIds.delete(remoteThreadId);
    for (const [key, pending] of this.pendingRequests) {
      if (pending.remoteThreadId === remoteThreadId) this.pendingRequests.delete(key);
    }
    for (const [key, pending] of this.pendingDesktopUserInputs) {
      if (pending.remoteThreadId === remoteThreadId) this.pendingDesktopUserInputs.delete(key);
    }
    for (const key of this.projectedUserMessageIds.keys()) {
      if (key.startsWith(`${remoteThreadId}\u0000`)) this.projectedUserMessageIds.delete(key);
    }
    this.forgetDurableDesktopUserMessages(remoteThreadId);
  }

  private async rollbackThread(command: JsonRecord): Promise<void> {
    const remoteThreadId = stringValue(command.threadId, 128);
    const requestedTurnCountValue = finiteNumber(command.turnCount);
    const targetTurnId = stringValue(command.targetTurnId, 128);
    if (!remoteThreadId) throw new TypeError("task id is required");
    if (
      requestedTurnCountValue === null
      || !Number.isInteger(requestedTurnCountValue)
      || requestedTurnCountValue < 0
    ) {
      throw new TypeError("turn count must be a non-negative integer");
    }
    if (this.drafts.has(remoteThreadId)) {
      if (requestedTurnCountValue !== 0) throw new RangeError("turn count exceeds this task history");
      return;
    }

    const nativeThreadId = this.nativeThreadId(remoteThreadId);
    const currentResult = record(await this.requireCodex().request("thread/read", {
      threadId: nativeThreadId,
      includeTurns: true,
    }));
    const currentThread = record(currentResult?.thread);
    if (!currentThread) throw new Error("Codex task was not found");
    const currentTurns = Array.isArray(currentThread.turns) ? currentThread.turns : [];
    const requestedTurnCount = targetTurnId
      ? currentTurns.findIndex(value => stringValue(record(value)?.id, 128) === targetTurnId)
      : requestedTurnCountValue;
    if (targetTurnId && requestedTurnCount < 0) {
      throw new Error("The prompt to edit is no longer present in this task");
    }
    if (requestedTurnCount > currentTurns.length) {
      throw new RangeError("turn count exceeds this task history");
    }
    const numTurns = currentTurns.length - requestedTurnCount;
    if (numTurns === 0) {
      this.requestAuthoritativeThreadRefresh(remoteThreadId);
      return;
    }
    if (currentTurns.some(value => {
      const status = stringValue(record(value)?.status, 64)
        .replace(/[^a-z0-9]/giu, "")
        .toLowerCase();
      return status === "inprogress" || status === "running" || status === "active";
    })) {
      throw new Error("Stop the current work before editing this prompt");
    }

    const requestFollowerAction = this.desktopIpc.requestFollowerAction;
    let rolledBackByDesktop = false;
    const rollbackOwnership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
    let desktopRollbackAttempted = false;
    if (requestFollowerAction && rollbackOwnership.state !== "local-owned") {
      desktopRollbackAttempted = true;
      try {
        await requestFollowerAction.call(this.desktopIpc, "thread-follower-rollback-thread", {
          conversationId: nativeThreadId,
          numTurns,
        });
        rolledBackByDesktop = true;
      } catch (error) {
        if (!definitiveDesktopNoOwner(error)) throw error;
        if (rollbackOwnership.state === "desktop-owned" || rollbackOwnership.everDesktopOwned) {
          throw desktopOwnershipSafeError(nativeThreadId, "the rollback was not delivered");
        }
      }
    }
    const currentRollbackOwnership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
    if (currentRollbackOwnership.state === "desktop-owned" || currentRollbackOwnership.everDesktopOwned) {
      throw desktopOwnershipSafeError(nativeThreadId, "the rollback route is unavailable");
    }
    if (!rolledBackByDesktop) {
      // `thread/read` can hydrate history from disk without mounting the task
      // in this app-server process. After Desktop restarts, both sides can
      // therefore know the task while `thread/rollback` still answers
      // "thread not found". Mount it explicitly before the private fallback.
      await this.requirePrivateMutationRoute(nativeThreadId, "thread rollback", {
        probeIfUnknown: !desktopRollbackAttempted,
      });
      const localRollbackOwnership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
      if (localRollbackOwnership.state !== "local-owned") {
        await this.requireCodex().request("thread/resume", {
          threadId: nativeThreadId,
          excludeTurns: true,
        });
      }
      await this.requireCodex().request("thread/rollback", {
        threadId: nativeThreadId,
        numTurns,
      });
      this.desktopIpc.adoptLocalThread?.(nativeThreadId);
    }

    this.clearRolledBackProjection(remoteThreadId);
    try {
      await this.refreshAuthoritativeThreadNow(remoteThreadId);
    } catch {
      // The rollback itself already succeeded. Keep the command successful
      // and let the normal reconnect/poll path retry the replacement read.
      this.requestAuthoritativeThreadRefresh(remoteThreadId);
    }
  }

  private async mutateThread(type: string, command: JsonRecord): Promise<void> {
    const remoteThreadId = stringValue(command.threadId, 128);
    if (!remoteThreadId) throw new TypeError("task id is required");
    if (this.drafts.has(remoteThreadId)) {
      this.drafts.delete(remoteThreadId);
      this.store.removeTaskSelection(remoteThreadId);
      this.preferences.delete(remoteThreadId);
      return;
    }
    const nativeThreadId = this.nativeThreadId(remoteThreadId);
    await this.requirePrivateMutationRoute(nativeThreadId, type.replace(/^thread\./u, "thread "));
    const method = type === "thread.archive"
      ? "thread/archive"
      : type === "thread.unarchive" ? "thread/unarchive" : "thread/delete";
    await this.requireCodex().request(method, { threadId: nativeThreadId });
    if (type === "thread.delete") {
      this.store.removeThreadAlias(remoteThreadId);
      this.store.removeTaskSelection(nativeThreadId);
      this.preferences.delete(remoteThreadId);
    }
  }

  private async updateThreadMetadata(command: JsonRecord): Promise<void> {
    const selectionUpdate = this.updatePreferences(command);
    const remoteThreadId = stringValue(command.threadId, 128);
    const title = stringValue(command.title, 256);
    if (!remoteThreadId) return;
    const draft = this.drafts.get(remoteThreadId);
    if (selectionUpdate && !draft) {
      await this.syncTaskSelectionToCodex(selectionUpdate.selection);
    }
    if (!title) return;
    if (draft) {
      this.drafts.set(remoteThreadId, { ...draft, title });
      return;
    }
    await this.requirePrivateMutationRoute(
      this.nativeThreadId(remoteThreadId),
      "thread rename",
    );
    await this.requireCodex().request("thread/name/set", {
      threadId: this.nativeThreadId(remoteThreadId),
      name: title,
    });
  }

  private updatePreferences(command: JsonRecord): {
    selection: AndroidRemoteTaskSelection;
    applied: boolean;
  } | null {
    const remoteThreadId = stringValue(command.threadId, 128);
    if (!remoteThreadId) throw new TypeError("task id is required");
    const current = this.preferences.get(remoteThreadId) ?? {};
    const validatedSelection = record(command.modelSelection)
      ? this.validatedTaskModelSelection(modelSelection(command))
      : null;
    const selection = validatedSelection?.selection ?? null;
    let selectionResult: ReturnType<AndroidRemoteStore["upsertTaskSelection"]> | null = null;
    if (selection) {
      this.assertTaskModelRoute(selection, remoteThreadId);
      const rawSelection = record(command.modelSelection) ?? {};
      const requestedRevision = finiteNumber(
        rawSelection.revision
          ?? rawSelection.baseRevision
          ?? command.selectionRevision
          ?? command.expectedSelectionRevision,
      );
      const expectedRevision = requestedRevision !== null
        && Number.isSafeInteger(requestedRevision)
        && requestedRevision >= 0
        ? requestedRevision
        : undefined;
      selectionResult = this.commitTaskSelection({
        remoteThreadId,
        providerInstanceId: selection.instanceId,
        model: selection.model,
        ...(selection.options !== undefined ? { options: selection.options } : {}),
        ...(validatedSelection?.capabilityVersion
          ? { capabilityVersion: validatedSelection.capabilityVersion }
          : {}),
        source: "android",
        updateId: stringValue(command.selectionUpdateId, 128)
          || stringValue(command.commandId, 128)
          || randomUUID(),
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      });
      if (selectionResult.stale) {
        throw new Error(
          `The model selection changed on another client; refresh task revision ${selectionResult.selection.revision}`,
        );
      }
    }
    const next: Partial<DraftThread> = {
      ...current,
      ...(selectionResult ? {
        instanceId: selectionResult.selection.providerInstanceId,
        model: selectionResult.selection.model,
        modelOptions: selectionResult.selection.options,
      } : {}),
      ...(command.runtimeMode !== undefined ? { runtimeMode: normalizedRuntimeMode(command.runtimeMode) } : {}),
      ...(command.interactionMode !== undefined ? { interactionMode: normalizedInteractionMode(command.interactionMode) } : {}),
      ...(stringValue(command.title, 256) ? { title: stringValue(command.title, 256) } : {}),
    };
    this.preferences.set(remoteThreadId, next);
    const alias = this.store.read().threadAliases.find(row => row.remoteThreadId === remoteThreadId);
    if (alias) {
      this.store.upsertThreadAlias({
        ...alias,
        ...(next.title ? { title: next.title } : {}),
        ...(next.instanceId ? { instanceId: next.instanceId } : {}),
        ...(next.model ? { model: next.model } : {}),
        ...(next.runtimeMode ? { runtimeMode: next.runtimeMode } : {}),
        ...(next.interactionMode ? { interactionMode: next.interactionMode } : {}),
        updatedAt: new Date(this.now()).toISOString(),
      });
    }
    return selectionResult
      ? { selection: selectionResult.selection, applied: selectionResult.applied }
      : null;
  }

  /**
   * Apply settings through the existing Desktop writer.
   *
   * New Desktop builds expose one atomic settings method. Older builds expose
   * the model/reasoning and collaboration reducers separately. Fall back only
   * when the modern handler is conclusively unavailable before delivery;
   * timeouts, disconnects, and owner loss remain ambiguous and fail closed.
   */
  private async applyDesktopThreadSettings(
    nativeThreadId: string,
    threadSettings: JsonRecord,
  ): Promise<void> {
    const requestFollowerAction = this.desktopIpc.requestFollowerAction;
    if (!requestFollowerAction) {
      throw desktopOwnershipSafeError(nativeThreadId, "Desktop settings IPC is unavailable");
    }
    const desktopSettings: JsonRecord = { ...threadSettings };
    if (Object.hasOwn(desktopSettings, "serviceTier")) {
      desktopSettings.serviceTier = desktopServiceTierValue(desktopSettings.serviceTier);
    }
    try {
      await requestFollowerAction.call(this.desktopIpc, "thread-follower-update-thread-settings", {
        conversationId: nativeThreadId,
        threadSettings: desktopSettings,
      });
      return;
    } catch (error) {
      if (!optionalDesktopSettingsHandlerUnavailable(error)) throw error;
    }

    const legacyModelSettings: JsonRecord = {
      conversationId: nativeThreadId,
    };
    if (Object.hasOwn(desktopSettings, "model")) {
      legacyModelSettings.model = desktopSettings.model;
    }
    if (Object.hasOwn(desktopSettings, "effort")) {
      legacyModelSettings.reasoningEffort = desktopSettings.effort;
    } else if (Object.hasOwn(desktopSettings, "reasoningEffort")) {
      legacyModelSettings.reasoningEffort = desktopSettings.reasoningEffort;
    }
    if (Object.hasOwn(desktopSettings, "serviceTier")) {
      legacyModelSettings.serviceTier = desktopSettings.serviceTier;
    }
    if (Object.keys(legacyModelSettings).length > 1) {
      await requestFollowerAction.call(
        this.desktopIpc,
        "thread-follower-set-model-and-reasoning",
        legacyModelSettings,
      );
    }

    if (Object.hasOwn(desktopSettings, "collaborationMode")) {
      await requestFollowerAction.call(
        this.desktopIpc,
        "thread-follower-set-collaboration-mode",
        {
          conversationId: nativeThreadId,
          collaborationMode: desktopSettings.collaborationMode,
        },
      );
    }
  }

  private async syncTaskSelectionToCodex(selection: AndroidRemoteTaskSelection): Promise<void> {
    const nativeThreadId = selection.nativeThreadId;
    const validated = this.validatedTaskModelSelection({
      instanceId: selection.providerInstanceId,
      model: selection.model,
      ...(selection.options !== undefined ? { options: selection.options } : {}),
    });
    const effort = validated.effort;
    this.assertTaskModelRoute(validated.selection, selection.remoteThreadId);
    const serviceTier = optionValue(validated.selection.options, "serviceTier");
    const threadSettings: JsonRecord = {
      model: validated.selection.model,
      effort,
      // Explicit resets prevent a previously selected Fast tier surviving Auto/Standard.
      serviceTier: typeof serviceTier === "string" ? serviceTier : null,
    };
    const requestFollowerAction = this.desktopIpc.requestFollowerAction;
    const ownership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
    if (ownership.state === "desktop-owned" && !requestFollowerAction) {
      throw desktopOwnershipSafeError(nativeThreadId, "Desktop settings IPC is unavailable");
    }
    if (ownership.state !== "local-owned" && requestFollowerAction) {
      try {
        await this.applyDesktopThreadSettings(nativeThreadId, {
          ...threadSettings,
          model: this.desktopTaskModel(validated.selection, selection.remoteThreadId),
        });
        return;
      } catch (error) {
        if (ownership.state === "desktop-owned" || ownership.everDesktopOwned) {
          throw desktopOwnershipSafeError(nativeThreadId, "Desktop settings were not delivered");
        }
        if (!definitiveDesktopNoOwner(error)) throw error;
      }
    }
    if (ownership.state === "desktop-owned" || ownership.everDesktopOwned) {
      throw desktopOwnershipSafeError(nativeThreadId, "Desktop settings ownership is ambiguous");
    }

    this.assertPrivateTaskModelRoute(validated.selection);
    const applySettings = () => this.requireCodex().request("thread/settings/update", {
      threadId: nativeThreadId,
      ...threadSettings,
    });
    const desktopSettingsAttempted = ownership.state !== "local-owned" && Boolean(requestFollowerAction);
    if (ownership.state !== "local-owned") {
      await this.requirePrivateMutationRoute(nativeThreadId, "thread settings", {
        probeIfUnknown: !desktopSettingsAttempted,
      });
    }
    try {
      await applySettings();
    } catch (error) {
      if (codexSettingsUpdateUnavailable(error)) return;
      const currentOwnership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
      if (currentOwnership.state === "desktop-owned" || currentOwnership.everDesktopOwned) {
        throw desktopOwnershipSafeError(nativeThreadId, "Desktop settings ownership is ambiguous");
      }
      if (codexThreadNeedsResume(error) && currentOwnership.state !== "local-owned") {
        await this.requirePrivateMutationRoute(nativeThreadId, "thread settings", {
          probeIfUnknown: !desktopSettingsAttempted,
        });
        const localOwnership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
        if (localOwnership.state === "desktop-owned" || localOwnership.everDesktopOwned) {
          throw desktopOwnershipSafeError(nativeThreadId, "Desktop settings ownership is ambiguous");
        }
        try {
          await this.requireCodex().request("thread/resume", {
            threadId: nativeThreadId,
            excludeTurns: true,
          });
          this.desktopIpc.adoptLocalThread?.(nativeThreadId);
          await applySettings();
          return;
        } catch (resumeError) {
          if (codexSettingsUpdateUnavailable(resumeError)) return;
          if (resumeError instanceof Error && resumeError.message.includes("Remodex will not start a competing writer")) {
            throw resumeError;
          }
          console.warn(`[remodex] Could not persist task model settings in Codex: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`);
          return;
        }
      }
      console.warn(`[remodex] Could not persist task model settings in Codex: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async respondToApproval(command: JsonRecord): Promise<void> {
    const requestId = stringValue(command.requestId, 128);
    const pending = this.pendingRequests.get(requestId);
    if (!pending) throw new Error("This approval is no longer waiting for a response");
    const decision = stringValue(command.decision, 64);
    const legacy = pending.method === "execCommandApproval" || pending.method === "applyPatchApproval";
    const mapped = legacy
      ? decision === "accept" ? "approved"
        : decision === "acceptForSession" ? "approved_for_session"
          : decision === "cancel" ? "abort" : { denied: { rejection: "Declined from Android" } }
      : decision === "accept" || decision === "acceptForSession" || decision === "cancel"
        ? decision
        : "decline";
    const ownership = fallbackOwnershipState(this.desktopIpc, pending.nativeThreadId);
    const requestFollowerAction = this.desktopIpc.requestFollowerAction;
    let desktopApprovalRoute = ownership.state === "desktop-owned" || ownership.everDesktopOwned;
    if (!desktopApprovalRoute && ownership.state === "unknown" && requestFollowerAction) {
      const route = this.desktopIpc.probeFollowerRoute
        ? await this.desktopIpc.probeFollowerRoute.call(this.desktopIpc, pending.nativeThreadId)
        : "unhealthy";
      if (route === "unhealthy") {
        throw desktopOwnershipSafeError(pending.nativeThreadId, "the approval route is ambiguous");
      }
      desktopApprovalRoute = route === "ready";
    }
    if (desktopApprovalRoute) {
      if (!requestFollowerAction) {
        throw desktopOwnershipSafeError(pending.nativeThreadId, "the approval route is unavailable");
      }
      const followerMethod = pending.method === "item/fileChange/requestApproval"
        || pending.method === "applyPatchApproval"
        ? "thread-follower-file-approval-decision"
        : pending.method === "item/permissions/requestApproval"
          ? "thread-follower-permissions-request-approval-response"
          : "thread-follower-command-approval-decision";
      await requestFollowerAction.call(this.desktopIpc, followerMethod, {
        conversationId: pending.nativeThreadId,
        requestId: pending.nativeRequestId,
        decision,
      });
    } else {
      await this.requirePrivateMutationRoute(pending.nativeThreadId, "the approval response", {
        probeIfUnknown: !requestFollowerAction,
      });
      this.requireCodex().respond(pending.nativeRequestId, { decision: mapped });
    }
    this.resolvePendingRequest(pending, "approval.resolved", "Approval response submitted", { decision });
  }

  private async respondToUserInput(clientId: string, command: JsonRecord): Promise<void> {
    const requestId = stringValue(command.requestId, 128);
    const remoteThreadId = stringValue(command.threadId, 128);
    let pending = this.pendingRequests.get(requestId);
    const requestedAsync = this.pendingDesktopUserInputs.get(requestId);
    if ((!pending || pending.method !== "item/tool/requestUserInput")
      && !(requestedAsync && this.isAsyncDesktopQuestion(requestedAsync))) {
      const liveMatches = [...this.pendingRequests.values()].filter(candidate =>
        candidate.method === "item/tool/requestUserInput"
        && candidate.remoteThreadId === remoteThreadId);
      // The session-file watcher and app-server can publish the same question
      // with different public request ids. Prefer the one live JSON-RPC request
      // for this task so a phone holding the replay id still answers the real
      // Codex request instead of receiving a false stale-question error.
      if (liveMatches.length === 1) pending = liveMatches[0];
    }
    const rawAnswers = record(command.answers) ?? {};
    const answers: Record<string, { answers: string[] }> = {};
    for (const [id, value] of Object.entries(rawAnswers)) {
      const rows = Array.isArray(value) ? value.filter(row => typeof row === "string") : [value];
      const normalized = rows
        .filter((row): row is string => typeof row === "string")
        .map(row => row.trim())
        .filter(Boolean);
      if (normalized.length > 0) answers[id] = { answers: normalized };
    }
    if (!pending || pending.method !== "item/tool/requestUserInput") {
      const requestedDesktopPending = this.pendingDesktopUserInputs.get(requestId);
      const desktopMatches = [...this.pendingDesktopUserInputs.values()].filter(candidate =>
        candidate.remoteThreadId === remoteThreadId && !this.isAsyncDesktopQuestion(candidate));
      const desktopPending = requestedDesktopPending
        ?? (desktopMatches.length === 1 ? desktopMatches[0] : undefined);
      const readFollowerThreadState = this.desktopIpc.readFollowerThreadState;
      const requestFollowerAction = this.desktopIpc.requestFollowerAction;
      if (!desktopPending || !readFollowerThreadState || !requestFollowerAction) {
        throw new Error("This question is no longer waiting for an answer");
      }
      if (desktopPending.remoteThreadId !== remoteThreadId) throw new Error("Question does not belong to this task");
      if (this.isAsyncDesktopQuestion(desktopPending)) {
        const state = await readFollowerThreadState.call(this.desktopIpc, desktopPending.nativeThreadId, { fresh: true });
        if (!state) throw new Error("Reconnect to Codex Desktop before answering this question");
        let interactions = readDesktopInteractions(state, desktopConversationTurnRows(state));
        if (state.androidRemoteHistoryOnly === true) {
          const metadata = this.nativeThreadMetadata.get(desktopPending.nativeThreadId) ?? {};
          const seed = { ...metadata, id: desktopPending.nativeThreadId, turns: [] };
          const saved = await this.sessionCommandRecovery.enrichThread(
            seed,
            this.sourcePathsForThread(remoteThreadId, seed),
          );
          const verifiedQuestionIds = Array.isArray(saved.androidRemoteVerifiedAsyncQuestionItemIds)
            ? saved.androidRemoteVerifiedAsyncQuestionItemIds : [];
          if (saved.androidRemoteHistoryRecoveryError && !verifiedQuestionIds.includes(desktopPending.itemId)) {
            throw new Error("Could not verify this question's saved history. Your answer has not been sent; please retry.");
          }
          interactions = readDesktopInteractions(saved);
        }
        const group = interactions.questions
          .find(row => row.itemId === desktopPending.itemId && row.turnId === desktopPending.turnId);
        if (!group || group.questions.some(row => this.answeredDesktopQuestions.has(row.id)
          || interactions.answeredIds.includes(row.id))) {
          throw new Error("This question is no longer waiting for an answer");
        }
        const text = desktopAnswerMessage(group.questions, answers);
        const replyCommand = {
          ...command, type: "thread.turn.start",
          message: { messageId: randomUUID(), text, attachments: [] },
        };
        const active = state.androidRemoteHistoryOnly === true
          ? Boolean(await this.activeTurnId(remoteThreadId, true))
          : desktopConversationIsActive(state);
        if (active) await this.steerTurn(clientId, replyCommand);
        else await this.startTurnUsingOwner(clientId, replyCommand);
        for (const question of group.questions) this.answeredDesktopQuestions.add(question.id);
        this.forgetDesktopPendingUserInput(desktopPending.publicRequestId);
        this.rememberSupplementalActivity(remoteThreadId, {
          id: `resolved-${desktopPending.publicRequestId}`, kind: "user-input.resolved", tone: "info",
          summary: "User input submitted", payload: { requestId: desktopPending.publicRequestId, answers: rawAnswers },
          turnId: desktopPending.turnId, sequence: ++this.sequence, createdAt: new Date(this.now()).toISOString(),
        });
        this.scheduleRefresh();
        return;
      }
      for (const question of desktopPending.questions) {
        const questionId = stringValue(question.id, 128);
        if (questionId && !answers[questionId]) {
          throw new TypeError("Every question needs a non-empty answer");
        }
      }
      let state: JsonRecord | null = null;
      let stateReadError: unknown = null;
      const desktopOwnership = fallbackOwnershipState(this.desktopIpc, desktopPending.nativeThreadId);
      const androidOwned = desktopPending.remoteThreadId !== desktopPending.nativeThreadId;
      // An aliased `thread-...` task was created by Android and its writer is
      // Remodex. Opening that native UUID in Desktop races a second writer
      // into the same task and can abort the pending request. Only native-id
      // Desktop tasks are eligible for Desktop request reattachment.
      try {
        // An Android alias may still be actively owned by Desktop because a
        // previous phone turn was delegated there. Reading that existing
        // owner is safe and preserves its live JSON-RPC request binding.
        state = await readFollowerThreadState.call(this.desktopIpc, desktopPending.nativeThreadId);
      } catch (error) {
        stateReadError = error;
        if (!androidOwned && desktopOwnership.state !== "local-owned") {
          const activateFollowerThread = this.desktopIpc.activateFollowerThread;
          if (activateFollowerThread) {
            try {
              await activateFollowerThread.call(this.desktopIpc, desktopPending.nativeThreadId);
              for (const delayMs of DESKTOP_RESPONSE_REATTACH_DELAYS_MS) {
                await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs));
                try {
                  state = await readFollowerThreadState.call(
                    this.desktopIpc,
                    desktopPending.nativeThreadId,
                  );
                  break;
                } catch (retryError) {
                  stateReadError = retryError;
                  // A session-file question may have no live Desktop owner. The
                  // private app-server recovery below is allowed only after a
                  // definitive never-owned result.
                }
              }
            } catch {
              // Opening the deep link is best-effort. A closed or ownerless
              // Desktop must not strand an otherwise recoverable Codex question.
            }
          }
        }
      }
      const nativeRequest = (Array.isArray(state?.requests) ? state.requests : [])
        .map(record)
        .find(candidate => {
          if (stringValue(candidate?.method, 128) !== "item/tool/requestUserInput") return false;
          const params = record(candidate?.params);
          const nativeItemId = stringValue(params?.itemId, 128);
          // Session rollouts retain both a response-item id (`fc_...`) and a
          // Responses function call id (`call_...`). Current app-server builds
          // put the latter in request.params.itemId, while older projections
          // and fixtures used the former.
          return nativeItemId === desktopPending.itemId
            || nativeItemId === desktopPending.callId;
        });
      let submittedThroughDesktop = false;
      if (nativeRequest?.id !== undefined) {
        try {
          await requestFollowerAction.call(this.desktopIpc, "thread-follower-submit-user-input", {
            conversationId: desktopPending.nativeThreadId,
            requestId: nativeRequest.id,
            response: { answers },
          });
          submittedThroughDesktop = true;
        } catch (error) {
          if (!definitiveDesktopNoOwner(error)) throw error;
          stateReadError = error;
        }
      }
      if (!submittedThroughDesktop) {
        const stillDesktopOwned = desktopOwnership.state === "desktop-owned"
          || desktopOwnership.everDesktopOwned
          || this.desktopIpc.hasObservedDesktopOwner?.(desktopPending.nativeThreadId);
        if (
          stillDesktopOwned
          || (state && !nativeRequest)
          || (stateReadError && !definitiveDesktopNoOwner(stateReadError))
        ) {
          throw desktopOwnershipSafeError(
            desktopPending.nativeThreadId,
            "the user-input response was not delivered",
          );
        }
        await this.continueOwnerlessDesktopUserInput(desktopPending, answers);
      }
      this.forgetDesktopPendingUserInput(desktopPending.publicRequestId);
      this.rememberSupplementalActivity(desktopPending.remoteThreadId, {
        id: `resolved-${desktopPending.publicRequestId}`,
        tone: "info",
        kind: "user-input.resolved",
        summary: "User input submitted",
        payload: { requestId: desktopPending.publicRequestId, answers: rawAnswers },
        turnId: desktopPending.turnId,
        sequence: ++this.sequence,
        createdAt: new Date(this.now()).toISOString(),
      });
      this.scheduleRefresh();
      return;
    }
    for (const question of userInputQuestions(pending.params.questions)) {
      const questionId = stringValue(question.id, 128);
      if (questionId && !answers[questionId]) {
        throw new TypeError("Every question needs a non-empty answer");
      }
    }
    await this.requirePrivateMutationRoute(pending.nativeThreadId, "the user-input response");
    this.requireCodex().respond(pending.nativeRequestId, { answers });
    for (const [desktopRequestId, candidate] of this.pendingDesktopUserInputs) {
      if (candidate.remoteThreadId === pending.remoteThreadId
        && (candidate.itemId === pending.params.itemId || candidate.callId === pending.params.itemId)) {
        this.pendingDesktopUserInputs.delete(desktopRequestId);
        this.rememberSupplementalActivity(pending.remoteThreadId, {
          id: `resolved-${desktopRequestId}`, kind: "user-input.resolved", tone: "info",
          summary: "User input submitted", payload: { requestId: desktopRequestId, answers: rawAnswers },
          turnId: candidate.turnId, sequence: ++this.sequence, createdAt: new Date(this.now()).toISOString(),
        });
      }
    }
    this.resolvePendingRequest(pending, "user-input.resolved", "User input submitted", { answers: rawAnswers });
  }

  private async respondToMcpElicitation(command: JsonRecord): Promise<void> {
    const remoteThreadId = stringValue(command.threadId, 128);
    const requestId = stringValue(command.requestId, 128);
    if (!remoteThreadId || !requestId) throw new TypeError("task and request id are required");
    const nativeThreadId = this.nativeThreadId(remoteThreadId);
    const response = record(command.response) ?? record(command.answers) ?? {};
    const ownership = fallbackOwnershipState(this.desktopIpc, nativeThreadId);
    const requestFollowerAction = this.desktopIpc.requestFollowerAction;
    let desktopMcpRoute = ownership.state === "desktop-owned" || ownership.everDesktopOwned;
    if (!desktopMcpRoute && ownership.state === "unknown" && requestFollowerAction) {
      const route = this.desktopIpc.probeFollowerRoute
        ? await this.desktopIpc.probeFollowerRoute.call(this.desktopIpc, nativeThreadId)
        : "unhealthy";
      if (route === "unhealthy") {
        throw desktopOwnershipSafeError(nativeThreadId, "the MCP response route is ambiguous");
      }
      desktopMcpRoute = route === "ready";
    }
    if (desktopMcpRoute) {
      if (!requestFollowerAction) throw desktopOwnershipSafeError(nativeThreadId, "the MCP response route is unavailable");
      await requestFollowerAction.call(this.desktopIpc, "thread-follower-submit-mcp-server-elicitation-response", {
        conversationId: nativeThreadId,
        requestId,
        response,
      });
      return;
    }
    await this.requirePrivateMutationRoute(nativeThreadId, "the MCP response", {
      probeIfUnknown: !requestFollowerAction,
    });
    const pending = this.pendingRequests.get(requestId);
    if (!pending) throw new Error("This MCP elicitation is no longer waiting for a response");
    this.requireCodex().respond(pending.nativeRequestId, response);
    this.resolvePendingRequest(pending, "mcp-elicitation.resolved", "MCP response submitted", { response });
  }

  /**
   * Continue a request_user_input call reconstructed from Desktop's rollout
   * after the Desktop JSON-RPC request owner has disappeared. The experimental
   * injection API appends the exact Responses function-call output and resumes
   * the suspended turn. Starting another turn with empty input is both
   * unnecessary and rejected by current Codex app-server builds.
   */
  private async continueOwnerlessDesktopUserInput(
    pending: PendingDesktopUserInput,
    answers: Record<string, { answers: string[] }>,
  ): Promise<void> {
    const ownership = fallbackOwnershipState(this.desktopIpc, pending.nativeThreadId);
    if (ownership.state === "desktop-owned" || ownership.everDesktopOwned) {
      throw desktopOwnershipSafeError(
        pending.nativeThreadId,
        "a previously Desktop-owned question cannot be resumed privately",
      );
    }
    const client = this.requireCodex();
    const currentOwnership = fallbackOwnershipState(this.desktopIpc, pending.nativeThreadId);
    if (currentOwnership.state === "desktop-owned" || currentOwnership.everDesktopOwned) {
      throw desktopOwnershipSafeError(
        pending.nativeThreadId,
        "a previously Desktop-owned question cannot be resumed privately",
      );
    }
    if (currentOwnership.state !== "local-owned") {
      // The preceding Desktop state/request probe already produced the
      // definitive no-owner result required for this narrow recovery path.
      // Re-probing here can turn a transient fake/legacy route into a second
      // ambiguous decision; the monotonic ownership checks above still fail
      // closed if a Desktop signal arrived in the meantime.
      await this.requirePrivateMutationRoute(
        pending.nativeThreadId,
        "the user-input continuation",
        { probeIfUnknown: false },
      );
    }
    const latestOwnership = fallbackOwnershipState(this.desktopIpc, pending.nativeThreadId);
    const alreadyOwned = latestOwnership.state === "local-owned"
      || this.desktopIpc.isThreadOwned(pending.nativeThreadId);
    if (!alreadyOwned) {
      await client.request("thread/resume", {
        threadId: pending.nativeThreadId,
        excludeTurns: true,
      });
    }
    const turnStartParams: JsonRecord = {
      threadId: pending.nativeThreadId,
      input: [],
    };
    if (!alreadyOwned) {
      this.desktopIpc.releaseDesktopOwnership?.(pending.nativeThreadId);
      // Claim only the IPC mirror so Desktop follows Remodex instead of
      // attempting to become a second writer.
      this.desktopIpc.claimThread({
        threadId: pending.nativeThreadId,
        turnStartParams,
      });
    }
    if (!this.injectedDesktopUserInputCallIds.has(pending.callId)) {
      await client.request("thread/inject_items", {
        threadId: pending.nativeThreadId,
        items: [{
          type: "function_call_output",
          call_id: pending.callId,
          output: JSON.stringify({ answers }),
        }],
      });
      this.injectedDesktopUserInputCallIds.add(pending.callId);
    }
    try {
      const started = await client.request("turn/start", turnStartParams);
      this.rememberKnownActiveTurn(pending.nativeThreadId, confirmedSteerTurnId(started));
      this.desktopIpc.adoptLocalThread?.(pending.nativeThreadId);
      this.injectedDesktopUserInputCallIds.delete(pending.callId);
    } catch (error) {
      if (!alreadyOwned) this.desktopIpc.releaseThread(pending.nativeThreadId);
      throw error;
    }
  }

  private resolvePendingRequest(
    pending: PendingNativeRequest,
    kind: string,
    summary: string,
    extra: JsonRecord,
  ): void {
    this.pendingRequests.delete(pending.publicRequestId);
    this.rememberSupplementalActivity(pending.remoteThreadId, {
      id: `resolved-${pending.publicRequestId}`,
      tone: "info",
      kind,
      summary,
      payload: { requestId: pending.publicRequestId, ...extra },
      turnId: pending.turnId,
      sequence: ++this.sequence,
      createdAt: new Date(this.now()).toISOString(),
    });
    this.setLiveNotificationFallback(
      pending.remoteThreadId,
      pending.turnId,
      "Reasoning",
      true,
    );
    this.scheduleRefresh();
  }

  private desktopUserInputRequestId(remoteThreadId: string, itemId: string): string {
    const digest = createHash("sha256")
      .update(`${remoteThreadId}\u0000${itemId}`)
      .digest("hex")
      .slice(0, 24);
    return `desktop-input-${digest}`;
  }

  private rememberDesktopPendingUserInput(input: {
    nativeThreadId: string;
    remoteThreadId: string;
    itemId: string;
    callId: string;
    turnId: string | null;
    requestedAt: string;
    sequence?: number;
    questions: JsonRecord[];
  }): PendingDesktopUserInput {
    const publicRequestId = this.desktopUserInputRequestId(input.remoteThreadId, input.itemId);
    const existing = this.pendingDesktopUserInputs.get(publicRequestId);
    const turnId = input.sequence !== undefined ? input.turnId : existing?.turnId ?? input.turnId;
    const activity: JsonRecord = {
      id: `activity-${publicRequestId}`,
      tone: "info",
      kind: "user-input.requested",
      summary: "Answer the question",
      payload: { requestId: publicRequestId, questions: input.questions },
      turnId,
      sequence: input.sequence ?? existing?.activity.sequence ?? ++this.sequence,
      createdAt: (input.sequence !== undefined ? input.requestedAt : stringValue(existing?.activity.createdAt))
        || input.requestedAt || new Date(0).toISOString(),
    };
    const pending: PendingDesktopUserInput = {
      publicRequestId,
      nativeThreadId: input.nativeThreadId,
      remoteThreadId: input.remoteThreadId,
      itemId: input.itemId,
      callId: input.callId,
      turnId,
      questions: input.questions,
      activity: {
        ...activity,
        payload: { requestId: publicRequestId, questions: input.questions },
      },
    };
    for (const [requestId, candidate] of this.pendingDesktopUserInputs) {
      if (candidate.remoteThreadId === input.remoteThreadId && requestId !== publicRequestId
        && !this.isAsyncDesktopQuestion(candidate)) {
        this.pendingDesktopUserInputs.delete(requestId);
      }
    }
    this.pendingDesktopUserInputs.set(publicRequestId, pending);
    if (this.supplementalActivities.get(input.remoteThreadId)?.some(row => row.id === activity.id)) {
      this.rememberSupplementalActivity(input.remoteThreadId, pending.activity);
    }
    return pending;
  }

  private rememberDesktopPendingUserInputFromThread(
    thread: JsonRecord,
    remoteThreadId: string,
  ): PendingDesktopUserInput | null {
    for (const value of Array.isArray(thread.androidRemotePendingAsyncUserInputs) ? thread.androidRemotePendingAsyncUserInputs : []) {
      const input = record(value);
      const callId = stringValue(input?.callId, 128);
      const questions = userInputQuestions(input?.questions).filter(question => !this.answeredDesktopQuestions.has(stringValue(question.id, 128)));
      if (callId && questions.length) this.rememberDesktopPendingUserInput({
        nativeThreadId: this.nativeThreadId(remoteThreadId), remoteThreadId, itemId: callId, callId,
        turnId: stringValue(thread.androidRemoteLatestTurnId, 128) || null,
        requestedAt: stringValue(input?.requestedAt, 64), questions,
      });
    }
    const source = record(thread.androidRemotePendingUserInput);
    const itemId = stringValue(source?.itemId, 128);
    const callId = stringValue(source?.callId, 128);
    const questions = userInputQuestions(source?.questions).filter(question => !this.answeredDesktopQuestions.has(stringValue(question.id, 128)));
    if (!itemId || !callId || questions.length === 0) return null;
    const requestId = this.desktopUserInputRequestId(remoteThreadId, itemId);
    if (this.supplementalActivities.get(remoteThreadId)?.some(activity =>
      activity.kind === "user-input.resolved" && record(activity.payload)?.requestId === requestId)) return null;
    return this.rememberDesktopPendingUserInput({
      nativeThreadId: this.nativeThreadId(remoteThreadId),
      remoteThreadId,
      itemId,
      callId,
      turnId: stringValue(thread.androidRemoteLatestTurnId, 128) || null,
      requestedAt: stringValue(source?.requestedAt, 64),
      questions,
    });
  }

  private forgetDesktopPendingUserInput(requestId: string): void {
    this.pendingDesktopUserInputs.delete(requestId);
  }

  private rememberSupplementalActivity(remoteThreadId: string, activity: JsonRecord): void {
    const rows = this.supplementalActivities.get(remoteThreadId) ?? [];
    const id = stringValue(activity.id, 128);
    const next = id
      ? [...rows.filter(row => stringValue(row.id, 128) !== id), activity]
      : [...rows, activity];
    this.supplementalActivities.set(remoteThreadId, next.slice(-64));
    if (activity.kind === "user-input.resolved") this.publishResolvedUserInput(remoteThreadId, activity);
  }

  /** Historical request rows remain in the transcript after their answers. */
  private hasUnresolvedUserInput(activities: JsonRecord[]): boolean {
    const resolved = new Set(activities.filter(row => row.kind === "user-input.resolved")
      .map(row => stringValue(record(row.payload)?.requestId, 128)).filter(Boolean));
    return activities.some(row => {
      if (row.kind !== "user-input.requested") return false;
      const payload = record(row.payload);
      if (resolved.has(stringValue(payload?.requestId, 128))) return false;
      const questions = userInputQuestions(payload?.questions);
      return !questions.length || questions.some(question =>
        !this.answeredDesktopQuestions.has(stringValue(question.id, 128)));
    });
  }

  /** A successful delivery is sufficient evidence; do not wait for a Desktop echo. */
  private publishResolvedUserInput(remoteThreadId: string, activity: JsonRecord): void {
    const current = this.threadStreams.get(remoteThreadId);
    const shellThread = Array.isArray(this.shellCache?.threads)
      ? this.shellCache.threads.map(record).find(row => row?.id === remoteThreadId) : null;
    const thread = record(current?.detail.thread) ?? this.shellLifecycles.get(remoteThreadId) ?? shellThread;
    if (!thread) return;
    const activities = this.upsertProjectedActivity(thread.activities, activity);
    const pendingActivities = [
      ...activities,
      ...(this.supplementalActivities.get(remoteThreadId) ?? []),
      ...[...this.pendingRequests.values()].filter(row => row.remoteThreadId === remoteThreadId).map(row => row.activity),
      ...[...this.pendingDesktopUserInputs.values()].filter(row => row.remoteThreadId === remoteThreadId).map(row => row.activity),
    ].filter((row): row is JsonRecord => Boolean(row));
    const nowIso = new Date(this.now()).toISOString();
    const nextThread = {
      ...thread, activities, updatedAt: nowIso,
      hasPendingUserInput: this.hasUnresolvedUserInput(pendingActivities)
        || [...this.pendingRequests.values()].some(row => row.remoteThreadId === remoteThreadId
          && row.method === "item/tool/requestUserInput"),
      // Keep the owning turn's state, but retain the newer input acknowledgement
      // when a catalogue read still carries the pre-answer lifecycle timestamp.
      ...(record(thread.session) ? { session: { ...record(thread.session), updatedAt: nowIso } } : {}),
    };
    this.rememberShellLifecycle(remoteThreadId, nextThread);
    if (current) {
      const advanced = advanceProjectedThreadStream(current, { ...current.detail, thread: nextThread }, this.now());
      this.threadStreams.set(remoteThreadId, advanced.state);
      for (const ws of this.sockets) {
        if (ws.data.subscription !== "thread" || ws.data.threadId !== remoteThreadId) continue;
        for (const item of advanced.items) this.publishSubscriptionEvent(ws, item, false);
      }
    }
    this.setLiveNotificationFallback(remoteThreadId, stringValue(activity.turnId, 128) || null, "Reasoning");
    this.publishCachedLiveThreadToShell(remoteThreadId);
  }

  private forgetSupplementalActivity(remoteThreadId: string, activityId: string): void {
    const rows = this.supplementalActivities.get(remoteThreadId);
    if (!rows) return;
    const next = rows.filter(row => stringValue(row.id, 128) !== activityId);
    if (next.length > 0) this.supplementalActivities.set(remoteThreadId, next);
    else this.supplementalActivities.delete(remoteThreadId);
  }

  private rememberSupplementalPlan(remoteThreadId: string, plan: JsonRecord): void {
    const rows = this.supplementalPlans.get(remoteThreadId) ?? [];
    const id = stringValue(plan.id, 128);
    const next = id
      ? [...rows.filter(row => stringValue(row.id, 128) !== id), plan]
      : [...rows, plan];
    this.supplementalPlans.set(remoteThreadId, next.slice(-32));
  }

  private forgetSupplementalPlan(remoteThreadId: string, planId: string): void {
    const rows = this.supplementalPlans.get(remoteThreadId);
    if (!rows) return;
    const next = rows.filter(row => stringValue(row.id, 128) !== planId);
    if (next.length > 0) this.supplementalPlans.set(remoteThreadId, next);
    else this.supplementalPlans.delete(remoteThreadId);
  }

  private markSourcePlanImplemented(remoteThreadId: string, planId: string): void {
    const stream = this.threadStreams.get(remoteThreadId);
    const thread = stream ? record(stream.detail.thread) : null;
    const current = projectedRow(thread?.proposedPlans, planId)
      ?? this.supplementalPlans.get(remoteThreadId)?.find(row => stringValue(row.id, 128) === planId);
    if (!current) return;
    const updatedAt = new Date(this.now()).toISOString();
    this.rememberSupplementalPlan(remoteThreadId, {
      ...current,
      implementedAt: updatedAt,
      implementationThreadId: remoteThreadId,
      updatedAt,
    });
  }

  private onCodexMessage(message: CodexJsonRpcMessage): void {
    this.desktopIpc.observeCodexMessage(message);
    if (message.method && message.id !== undefined) {
      this.handleCodexServerRequest(message);
      return;
    }
    if (
      message.method === "model/list/updated" ||
      message.method === "model/rerouted" ||
      message.method === "skills/changed"
    ) {
      this.configCache = null;
    }
    if (message.method === "account/rateLimits/updated" || message.method === "account/updated") {
      if (message.method === "account/updated") {
        this.nativeAccountQuota = null;
        this.nativeAccountQuotaGeneration += 1;
        this.nativeAccountQuotaRefresh = null;
        this.publishNativeAccountQuota();
      }
      this.nativeAccountQuotaRefreshAfter = 0;
      this.refreshNativeAccountQuota();
    }
    if (this.applyLiveCodexNotification(message, true, "app-server")) return;
    this.scheduleRefresh();
  }

  private onDesktopSessionMessage(message: CodexJsonRpcMessage): void {
    const params = record(message.params) ?? {};
    const replayThreadId = stringValue(params.threadId, 128);
    // Session-file watchers are keyed by the Android-facing task id so their
    // lifecycle follows the selected phone task. Android-created tasks also
    // have a distinct native Codex UUID, however, and every Desktop/app-server
    // operation must retain that native identity. Normalize replay events at
    // this boundary before they can create a pending approval or user-input
    // request with the non-UUID `thread-...` alias.
    const nativeThreadId = replayThreadId ? this.nativeThreadId(replayThreadId) : "";
    const remoteThreadId = nativeThreadId ? this.remoteThreadId(nativeThreadId) : "";
    if (message.method === "thread/history/changed" && remoteThreadId) {
      this.syncKnownActiveTurnFromDesktopSession(remoteThreadId);
      this.desktopActiveTurnProbes.delete(nativeThreadId);
      this.desktopThreadActivityCache.delete(nativeThreadId);
      this.projectedActivityReconciledAt.delete(remoteThreadId);
      this.requestAuthoritativeThreadRefresh(remoteThreadId);
      return;
    }
    const publish = !remoteThreadId || !this.desktopSessionInstallations.has(remoteThreadId);
    const normalizedMessage = nativeThreadId && nativeThreadId !== replayThreadId
      ? { ...message, params: { ...params, threadId: nativeThreadId } }
      : message;
    if (this.applyLiveCodexNotification(normalizedMessage, publish, "desktop-session")) return;
    // Unknown session records never force an expensive full-task read. The
    // normal slow safety poll and reconnect snapshot remain recovery paths.
  }

  private desktopProviderInstanceId(
    settings: DesktopThreadSettings,
    fallbackInstanceId = "",
  ): string {
    // Qualified selectors identify the Remodex route even when the private
    // app-server reports its transport provider as openai.
    const routedRow = this.managementModelRows.find(row =>
      settings.model.startsWith(`${row.provider}/`)
      && (row.namespaced === settings.model || slugEquals(settings.model, row.provider, row.id)));
    if (routedRow) return androidProviderInstanceId(routedRow.provider);
    const routedProvider = this.listModelProviderOrder?.().find(provider => settings.model.startsWith(`${provider}/`));
    if (routedProvider) return androidProviderInstanceId(routedProvider);
    if (settings.modelProviderId) {
      return androidProviderInstanceId(settings.modelProviderId);
    }
    return fallbackInstanceId || androidProviderInstanceId(this.desktopDirectModelProvider() || "openai");
  }

  private applyDesktopThreadSettingsPreference(
    remoteThreadId: string,
    settings: DesktopThreadSettings,
    fallbackInstanceId = "",
    fallbackOptions?: unknown,
  ): { instanceId: string; model: string; options: unknown } {
    const current = this.preferences.get(remoteThreadId) ?? {};
    const instanceId = this.desktopProviderInstanceId(settings, fallbackInstanceId);
    const normalized = this.normalizedTaskModelSelection({ instanceId, model: settings.model });
    const baseOptions = normalized.model === current.model && instanceId === current.instanceId
      ? current.modelOptions : fallbackOptions;
    const requestedOptions = settings.reasoningEffort
      ? modelOptionsWithValue(
          baseOptions,
          "reasoningEffort",
          settings.reasoningEffort,
        )
      : settings.reasoningEffortPresent
        ? modelOptionsWithoutValues(baseOptions, REASONING_SELECTION_OPTION_IDS)
        : baseOptions;
    const optionsWithServiceTier = settings.serviceTier
      ? modelOptionsWithValue(requestedOptions, "serviceTier", settings.serviceTier)
      : requestedOptions;
    const validated = this.validatedTaskModelSelection({
      instanceId,
      model: normalized.model,
      ...(optionsWithServiceTier !== undefined ? { options: optionsWithServiceTier } : {}),
    });
    const options = validated.selection.options;
    this.preferences.set(remoteThreadId, {
      ...current,
      instanceId,
      model: validated.selection.model,
      modelOptions: options,
    });
    return { instanceId, model: validated.selection.model, options };
  }

  private rememberDesktopThreadSettings(
    remoteThreadId: string,
    params: JsonRecord,
    fallbackInstanceId = "",
  ): DesktopThreadSettings | null {
    const previous = this.desktopThreadSettings.get(remoteThreadId);
    const nested = record(params.threadSettings);
    const source = nested ?? params;
    const model = stringValue(source.model, 256) || previous?.model || "";
    if (!model) return null;
    const modelProviderId = stringValue(source.modelProviderId, 64)
      || stringValue(source.modelProvider, 64)
      || stringValue(source.model_provider_id, 64)
      || stringValue(source.model_provider, 64)
      || previous?.modelProviderId
      || this.nativeThreadModelProviders.get(remoteThreadId)
      || "";
    const modelIdentityChanged = previous !== undefined && (
      model !== previous.model
      || Boolean(
        modelProviderId
        && previous.modelProviderId
        && modelProviderId !== previous.modelProviderId,
      )
    );
    const serviceTierPresent = Object.hasOwn(source, "serviceTier")
      || Object.hasOwn(source, "service_tier");
    const serviceTier = serviceTierPresent
      ? normalizedServiceTierId(source.serviceTier ?? source.service_tier) || "default"
      : modelIdentityChanged ? "default" : previous?.serviceTier ?? "";
    const reasoningKey = ["reasoningEffort", "effort", "reasoning_effort"]
      .find(key => Object.hasOwn(source, key));
    const reasoningEffortPresent = reasoningKey !== undefined || modelIdentityChanged
      || previous?.reasoningEffortPresent === true;
    const requested: DesktopThreadSettings = {
      model,
      modelProviderId,
      reasoningEffort: reasoningKey !== undefined ? stringValue(source[reasoningKey], 64)
        : modelIdentityChanged ? "" : previous?.reasoningEffort ?? "",
      reasoningEffortPresent,
      serviceTier,
      updatedAtMs: finiteNumber(params.updatedAtMs)
        ?? finiteNumber(source.updatedAtMs)
        ?? previous?.updatedAtMs
        ?? this.now(),
    };
    const current = this.storedTaskSelection(remoteThreadId);
    const currentPreference = this.preferences.get(remoteThreadId);
    const providerInstanceId = this.desktopProviderInstanceId(
      requested,
      current?.providerInstanceId || fallbackInstanceId,
    );
    const normalized = this.normalizedTaskModelSelection({ instanceId: providerInstanceId, model: requested.model });
    const currentOptions = current?.providerInstanceId === providerInstanceId && current?.model === normalized.model
      ? current.options
      : currentPreference?.instanceId === providerInstanceId && currentPreference?.model === normalized.model
        ? currentPreference.modelOptions
        : undefined;
    const requestedOptions = requested.reasoningEffort
      ? modelOptionsWithValue(currentOptions, "reasoningEffort", requested.reasoningEffort)
      : requested.reasoningEffortPresent
        ? modelOptionsWithoutValues(currentOptions, REASONING_SELECTION_OPTION_IDS)
        : currentOptions;
    const optionsWithServiceTier = requested.serviceTier
      ? modelOptionsWithValue(requestedOptions, "serviceTier", requested.serviceTier)
      : requestedOptions;
    const validated = this.validatedTaskModelSelection({
      instanceId: providerInstanceId,
      model: normalized.model,
      ...(optionsWithServiceTier !== undefined ? { options: optionsWithServiceTier } : {}),
    });
    const options = validated.selection.options;
    const next: DesktopThreadSettings = {
      ...requested,
      reasoningEffort: validated.effort ?? "",
      serviceTier: validated.serviceTier ?? "",
    };
    this.desktopThreadSettings.set(remoteThreadId, next);
    this.commitTaskSelection({
      remoteThreadId,
      providerInstanceId,
      model: validated.selection.model,
      ...(options !== undefined ? { options } : {}),
      ...(validated.capabilityVersion
        ? { capabilityVersion: validated.capabilityVersion }
        : {}),
      source: "desktop",
      updateId: `desktop-${createHash("sha256")
        .update(JSON.stringify({ model: validated.selection.model, providerInstanceId, options: options ?? null }))
        .digest("hex")
        .slice(0, 32)}`,
      updatedAt: new Date(next.updatedAtMs).toISOString(),
    });
    this.shellCache = null;
    this.scheduleRefresh();
    return next;
  }

  private projectedThreadWithDesktopSettings(
    thread: JsonRecord,
    remoteThreadId: string,
    settings: DesktopThreadSettings,
    nowIso: string,
  ): JsonRecord {
    const currentSelection = record(thread.modelSelection) ?? {};
    const currentSession = record(thread.session) ?? {};
    const { instanceId, model, options } = this.applyDesktopThreadSettingsPreference(
      remoteThreadId,
      settings,
      stringValue(currentSelection.instanceId, 64)
        || stringValue(currentSession.providerInstanceId, 64),
      currentSelection.options,
    );
    const stored = this.storedTaskSelection(remoteThreadId);
    return {
      ...thread,
      updatedAt: nowIso,
      modelSelection: {
        ...currentSelection,
        instanceId,
        model,
        options: options ?? [],
        ...(stored ? { revision: stored.revision, updatedAt: stored.updatedAt } : {}),
      },
      session: {
        ...currentSession,
        threadId: remoteThreadId,
        providerName: "codex",
        providerInstanceId: instanceId,
        updatedAt: nowIso,
      },
    };
  }

  private reapplyDesktopThreadSettingsAfterModelCatalogRefresh(): void {
    for (const [remoteThreadId, settings] of this.desktopThreadSettings) {
      const current = this.preferences.get(remoteThreadId);
      const streamThread = record(this.threadStreams.get(remoteThreadId)?.detail.thread);
      const fallback = stringValue(record(streamThread?.modelSelection)?.instanceId, 64)
        || stringValue(record(streamThread?.session)?.providerInstanceId, 64);
      const previousInstanceId = current?.instanceId;
      this.rememberDesktopThreadSettings(remoteThreadId, {
        model: settings.model,
        modelProviderId: settings.modelProviderId,
        reasoningEffort: settings.reasoningEffort,
        serviceTier: settings.serviceTier,
        updatedAtMs: settings.updatedAtMs,
      }, fallback);
      const instanceId = this.preferences.get(remoteThreadId)?.instanceId ?? previousInstanceId;
      if (instanceId !== previousInstanceId && this.threadStreams.has(remoteThreadId)) {
        this.requestAuthoritativeThreadRefresh(remoteThreadId);
      }
    }
  }

  private revalidateStoredTaskSelectionsAfterModelCatalogRefresh(): void {
    for (const current of this.store.read().taskSelections) {
      const validated = this.validatedTaskModelSelection({
        instanceId: current.providerInstanceId,
        model: current.model,
        ...(current.options !== undefined ? { options: current.options } : {}),
      });
      // A temporarily missing provider row is not proof that the persisted selection is invalid.
      // Request-time validation still omits unverified effort values until the row returns.
      if (!validated.capabilityVersion) continue;
      if (
        current.capabilityVersion === validated.capabilityVersion
        && !validated.changed
        && current.model === validated.selection.model
      ) continue;
      const result = this.commitTaskSelection({
        nativeThreadId: current.nativeThreadId,
        remoteThreadId: current.remoteThreadId,
        providerInstanceId: current.providerInstanceId,
        model: validated.selection.model,
        ...(validated.selection.options !== undefined
          ? { options: validated.selection.options }
          : {}),
        capabilityVersion: validated.capabilityVersion,
        source: current.source,
        updateId: `capability-${createHash("sha256")
          .update(JSON.stringify({
            thread: current.remoteThreadId,
            model: validated.selection.model,
            capabilityVersion: validated.capabilityVersion,
            options: validated.selection.options ?? null,
          }))
          .digest("hex")
          .slice(0, 32)}`,
        updatedAt: new Date(this.now()).toISOString(),
        expectedRevision: current.revision,
      });
      if (!result.applied) continue;
      this.shellCache = null;
      if (validated.changed && !this.drafts.has(current.remoteThreadId)) {
        void this.syncTaskSelectionToCodex(result.selection).catch(error => {
          console.warn(`[remodex] Codex did not apply a revalidated reasoning selection: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }

  private rememberShellLifecycle(threadId: string, thread: JsonRecord): void {
    this.shellLifecycles.delete(threadId);
    this.shellLifecycles.set(threadId, {
      id: threadId, latestTurn: thread.latestTurn, session: thread.session,
      hasPendingApprovals: thread.hasPendingApprovals,
      hasPendingUserInput: thread.hasPendingUserInput,
      updatedAt: thread.updatedAt,
    });
    while (this.shellLifecycles.size > MAX_LIVE_NOTIFICATION_ACTIVITY_THREADS) {
      const oldest = this.shellLifecycles.keys().next().value;
      if (typeof oldest !== "string") break;
      this.shellLifecycles.delete(oldest);
    }
  }

  private projectLiveTurnLifecycle(detailThread: JsonRecord, remoteThreadId: string, method: string, params: JsonRecord): JsonRecord | null {
    const turn = record(params.turn);
    const turnId = stringValue(params.turnId, 128) || stringValue(turn?.id, 128);
    const nowIso = new Date(this.now()).toISOString();
    if (!turnId) return null;
    const completed = method === "turn/completed";
    const turnStatus = stringValue(turn?.status, 64);
    const status = !completed
      ? "running"
      : turnStatus === "failed"
        ? "error"
        : turnStatus === "interrupted" || turnStatus === "cancelled"
          ? "interrupted"
          : "ready";
    const latestTurnState = !completed
      ? "running"
      : status === "error"
        ? "error"
        : status === "interrupted"
          ? "interrupted"
          : "completed";
    const existingLatestTurn = record(detailThread.latestTurn);
    const sameLatestTurn = stringValue(existingLatestTurn?.turnId, 128) === turnId;
    const startedAtMs = finiteNumber(params.startedAtMs)
      ?? (finiteNumber(turn?.startedAt) === null ? null : finiteNumber(turn?.startedAt)! * 1_000);
    const completedAtMs = finiteNumber(params.completedAtMs)
      ?? (finiteNumber(turn?.completedAt) === null ? null : finiteNumber(turn?.completedAt)! * 1_000);
    const startedAt = startedAtMs === null
      ? sameLatestTurn ? stringValue(existingLatestTurn?.startedAt, 64) || nowIso : nowIso
      : new Date(startedAtMs).toISOString();
    const completedAt = completed
      ? completedAtMs === null ? nowIso : new Date(completedAtMs).toISOString()
      : null;
    return {
      ...detailThread,
      ...(completed && Array.isArray(detailThread.activities) ? {
        activities: projectedRows(detailThread.activities).filter(activity =>
          stringValue(activity.turnId, 128) !== turnId
          || activity.kind !== "task.progress"
          || record(activity.payload)?.summaryAvailable !== false),
      } : {}),
      updatedAt: nowIso,
      latestTurn: {
        ...(sameLatestTurn ? existingLatestTurn : {}),
        turnId,
        state: latestTurnState,
        requestedAt: sameLatestTurn
          ? stringValue(existingLatestTurn?.requestedAt, 64) || startedAt
          : startedAt,
        startedAt,
        completedAt,
        assistantMessageId: sameLatestTurn
          ? existingLatestTurn?.assistantMessageId ?? null
          : null,
      },
      session: {
        ...(record(detailThread.session) ?? {}),
        threadId: remoteThreadId,
        status,
        statusConfidence: "confirmed",
        providerName: "codex",
        providerInstanceId:
          stringValue(record(detailThread.session)?.providerInstanceId, 64)
          || stringValue(record(detailThread.modelSelection)?.instanceId, 64)
          || "openai",
        runtimeMode: stringValue(record(detailThread.session)?.runtimeMode, 64) || "full-access",
        activeTurnId: completed ? null : turnId,
        lastError: completed && status === "error"
          ? stringValue(record(turn?.error)?.message, 4096) || "The Codex turn failed."
          : null,
        updatedAt: nowIso,
      },
    };
  }

  private applyLiveCodexNotification(
    message: CodexJsonRpcMessage,
    publish = true,
    source: LiveCodexNotificationSource = "app-server",
  ): boolean {
    if (source === "desktop-session") this.observeAuthoritativeSteerDelivery(message);
    const method = stringValue(message.method, 128);
    let params = record(message.params) ?? {};
    const nativeThreadId = stringValue(params.threadId, 128);
    if (!nativeThreadId) return false;
    if (source === "app-server"
      && (method === "thread/status/changed" || method === "turn/started" || method === "turn/completed"
        || ((method === "item/started" || method === "item/completed")
          && record(params.item)?.type === "contextCompaction"))
      && desktopOwnershipIsAuthoritative(fallbackOwnershipState(this.desktopIpc, nativeThreadId))) {
      // A secondary reader cannot stop or revive a Desktop-owned execution.
      // Reconcile through the owner/session stream instead.
      this.requestAuthoritativeThreadRefresh(this.remoteThreadId(nativeThreadId));
      return true;
    }
    if (method === "turn/started") this.missingNativeThreadIds.delete(nativeThreadId);
    const remoteThreadId = this.remoteThreadId(nativeThreadId);
    const eventItem = record(params.item);
    const eventTurnId = stringValue(params.turnId, 128) || stringValue(record(params.turn)?.id, 128);
    if (method === "item/started" && eventItem?.type === "contextCompaction"
      && eventTurnId && this.completedDesktopTurns.get(remoteThreadId) === eventTurnId) return true;
    if (method === "item/started" && eventItem?.type === "contextCompaction"
      && eventTurnId && stringValue(eventItem.id, 128)) {
      const previous = this.desktopInteractions.get(remoteThreadId);
      this.desktopInteractions.set(remoteThreadId, {
        activeTurnId: eventTurnId,
        compaction: { id: stringValue(eventItem.id, 128), turnId: eventTurnId, active: true,
          startedAt: finiteNumber(params.startedAtMs)
            ?? (previous?.compaction?.id === eventItem.id ? previous?.compaction?.startedAt : null)
            ?? this.now() },
        questions: previous?.questions ?? [], answeredIds: previous?.answeredIds ?? [],
      });
      this.liveCompactionSources.set(remoteThreadId, source);
      this.desktopInteractionObservedAt.set(remoteThreadId, this.now());
      while (this.liveCompactionSources.size > 128) {
        const oldest = this.liveCompactionSources.keys().next().value!;
        this.liveCompactionSources.delete(oldest);
        this.desktopInteractions.delete(oldest);
        this.desktopInteractionObservedAt.delete(oldest);
      }
      this.applyLiveCodexNotification({ method: "turn/started", params: {
        threadId: nativeThreadId, turnId: eventTurnId,
        turn: { id: eventTurnId, status: "inProgress" },
      } }, publish, source);
    }
    const liveCompaction = this.desktopInteractions.get(remoteThreadId)?.compaction;
    const completedItem = record(params.item);
    if (source === "desktop-session" && method === "item/completed" && completedItem?.type === "contextCompaction"
      && liveCompaction?.turnId === stringValue(params.turnId, 128)) {
      if (liveCompaction.startedAt !== null
        && stringValue(completedItem.id, 128).startsWith(`context-compaction-${liveCompaction.turnId}-`)
        && (finiteNumber(params.completedAtMs) ?? -Infinity) >= liveCompaction.startedAt) {
        params = { ...params, item: { ...completedItem, id: liveCompaction.id } };
        message = { ...message, params };
      }
      if (record(params.item)?.id === liveCompaction.id) liveCompaction.active = false;
    }
    if (method === "turn/completed" && source === "app-server" && liveCompaction?.active
      && this.liveCompactionSources.get(remoteThreadId) !== "app-server"
      && (this.liveCompactionSources.has(remoteThreadId)
        || this.now() - (this.desktopInteractionObservedAt.get(remoteThreadId) ?? -Infinity) < 20_000)
      && liveCompaction.turnId === (stringValue(params.turnId, 128) || stringValue(record(params.turn)?.id, 128))) return true;
    if (method === "item/completed" && record(params.item)?.type === "contextCompaction"
      && liveCompaction?.turnId === eventTurnId && record(params.item)?.id === liveCompaction.id) {
      liveCompaction.active = false;
      this.liveCompactionSources.delete(remoteThreadId);
    }
    if (method === "turn/completed") {
      const previous = record(this.threadStreams.get(remoteThreadId)?.detail.thread)
        ?? this.shellLifecycles.get(remoteThreadId);
      const previousSession = record(previous?.session);
      const previousTurnId = stringValue(previousSession?.activeTurnId, 128)
        || stringValue(record(previous?.latestTurn)?.turnId, 128);
      const incomingTurnId = stringValue(params.turnId, 128) || stringValue(record(params.turn)?.id, 128);
      if ((turnStatusIsActive(previousSession?.status) || previousSession?.statusConfidence === "unknown")
        && previousTurnId && incomingTurnId && previousTurnId !== incomingTurnId
        // The owner may stop a newer turn than our stale snapshot. Accept that
        // result only if no different active turn appeared while Stop awaited
        // its acknowledgement; never terminate work observed after the click.
        && !(source === "desktop-stop" && previousTurnId === params.stoppedSnapshotTurnId)) {
        this.requestAuthoritativeThreadRefresh(remoteThreadId);
        return true;
      }
    }
    const nextNotificationActivity = this.nextLiveNotificationActivityState(
      remoteThreadId,
      message,
    );
    try {
    if (method === "turn/started" || method === "turn/completed") {
      const active = method === "turn/started";
      this.updateActivityRevision++;
      this.projectedActivityReconciledAt.delete(remoteThreadId);
      this.desktopThreadActivityCache.set(nativeThreadId, {
        active,
        expiresAt: this.now() + (active ? 10_000 : 30_000),
      });
      this.desktopActiveTurnProbes.set(nativeThreadId, {
        active,
        turnId: active ? nativeExpectedTurnId(
          stringValue(params.turnId, 128) || stringValue(record(params.turn)?.id, 128),
        ) : "",
        expiresAt: this.now() + (active ? DESKTOP_ACTIVE_TURN_PROBE_CACHE_MS : 250),
      });
    }
    const turn = record(params.turn);
    const turnId = stringValue(params.turnId, 128) || stringValue(turn?.id, 128);
    if (method === "turn/started") {
      this.rememberKnownActiveTurn(nativeThreadId, turnId);
      if (source === "desktop-session") this.completedDesktopTurns.delete(remoteThreadId);
      const interactions = this.desktopInteractions.get(remoteThreadId);
      if (interactions?.compaction?.active && interactions.compaction.turnId !== turnId) {
        interactions.compaction = { ...interactions.compaction, active: false };
        interactions.activeTurnId = turnId;
        this.liveCompactionSources.delete(remoteThreadId);
      }
    } else if (method === "turn/completed") {
      this.forgetKnownActiveTurn(nativeThreadId, turnId);
      if (source === "desktop-session" || source === "desktop-stop") {
        this.completedDesktopTurns.set(remoteThreadId, turnId);
        while (this.completedDesktopTurns.size > 128) {
          this.completedDesktopTurns.delete(this.completedDesktopTurns.keys().next().value!);
        }
      }
      const interactions = this.desktopInteractions.get(remoteThreadId);
      if (interactions?.activeTurnId === turnId) interactions.activeTurnId = null;
      if (interactions?.compaction?.turnId === turnId) {
        interactions.compaction = { ...interactions.compaction, active: false };
        this.liveCompactionSources.delete(remoteThreadId);
      }
    }
    const replayedSettings = method === "thread/settings/updated"
      ? this.rememberDesktopThreadSettings(remoteThreadId, params)
      : null;
    if (method === "thread/settings/updated" && !replayedSettings) return true;
    const current = this.threadStreams.get(remoteThreadId);
    if (!current && (method === "turn/started" || method === "turn/completed" || method === "thread/status/changed")) {
      const cached = Array.isArray(this.shellCache?.threads)
        ? this.shellCache.threads.find(value => stringValue(record(value)?.id, 128) === remoteThreadId)
        : null;
      const base = this.shellLifecycles.get(remoteThreadId) ?? record(cached) ?? { id: remoteThreadId };
      const next = method === "thread/status/changed"
        ? projectRuntimeStatus(base, remoteThreadId, params.status, new Date(this.now()).toISOString())
        : this.projectLiveTurnLifecycle(base, remoteThreadId, method, params);
      if (next) this.rememberShellLifecycle(remoteThreadId, next);
      this.requestAuthoritativeThreadRefresh(remoteThreadId);
      return true;
    }
    if (!current) return method === "thread/settings/updated";
    const detailThread = record(current.detail.thread);
    if (!detailThread) return method === "thread/settings/updated";
    const nowIso = new Date(this.now()).toISOString();
    let nextThread: JsonRecord | null = null;

    if (method === "thread/status/changed") {
      nextThread = projectRuntimeStatus(detailThread, remoteThreadId, params.status, nowIso);
    } else if (method === "thread/settings/updated" && replayedSettings) {
      nextThread = this.projectedThreadWithDesktopSettings(
        detailThread,
        remoteThreadId,
        replayedSettings,
        nowIso,
      );
    } else if (method === "thread/tokenUsage/updated") {
      const tokenUsage = record(params.tokenUsage) ?? record(params.usage);
      if (!tokenUsage) return true;
      this.latestThreadTokenUsage.set(remoteThreadId, tokenUsage);
      const activity = projectCodexContextWindowActivity({
        threadId: remoteThreadId,
        tokenUsage,
        createdAt: nowIso,
        turnId: turnId || null,
      });
      if (!activity) return true;
      nextThread = {
        ...detailThread,
        updatedAt: nowIso,
        activities: this.upsertProjectedActivity(detailThread.activities, activity),
      };
    } else if (method === "item/agentMessage/delta") {
      const itemId = stringValue(params.itemId, 128);
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!turnId || !itemId || !delta) return true;
      const messages = projectedRows(detailThread.messages);
      const existing = messages.find(value => stringValue(value.id, 128) === itemId);
      const sequence = finiteNumber(existing?.sequence) ?? this.nextProjectedTurnSequence(detailThread, turnId);
      const nextMessage: JsonRecord = existing
        ? {
            ...existing,
            text: `${typeof existing.text === "string" ? existing.text : ""}${delta}`,
            streaming: true,
          }
        : {
            id: itemId,
            role: "assistant",
            text: delta,
            attachments: [],
            turnId,
            sequence,
            streaming: true,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
      nextThread = {
        ...detailThread,
        updatedAt: nowIso,
        messages: existing
          ? messages.map(value => value === existing ? nextMessage : value)
          : [...messages, nextMessage],
      };
    } else if (method === "item/plan/delta") {
      const itemId = stringValue(params.itemId, 128);
      const delta = rawStringValue(params.delta);
      if (!turnId || !itemId || !delta) return true;
      const existing = projectedRow(detailThread.messages, itemId);
      const sequence = finiteNumber(existing?.sequence)
        ?? this.nextProjectedTurnSequence(detailThread, turnId);
      const nextMessage: JsonRecord = {
        ...(existing ?? {}),
        id: itemId,
        role: "assistant",
        turnId,
        sequence,
        text: rawStringValue(`${rawStringValue(existing?.text)}${delta}`),
        phase: "commentary",
        attachments: [],
        streaming: true,
        createdAt: stringValue(existing?.createdAt, 64) || nowIso,
        updatedAt: nowIso,
      };
      nextThread = {
        ...detailThread,
        updatedAt: nowIso,
        messages: this.upsertProjectedRow(detailThread.messages, nextMessage),
      };
    } else if (
      method === "item/reasoning/summaryPartAdded" ||
      method === "item/reasoning/summaryTextDelta"
    ) {
      const itemId = stringValue(params.itemId, 128);
      if (!turnId || !itemId) return true;
      const existing = projectedRow(detailThread.activities, itemId);
      const existingPayload = record(existing?.payload) ?? {};
      const summaryParts = Array.isArray(existingPayload.summaryParts)
        ? existingPayload.summaryParts.flatMap(value => typeof value === "string" ? [value] : [])
        : [];
      const rawIndex = finiteNumber(params.summaryIndex) ?? summaryParts.length;
      const summaryIndex = Math.max(0, Math.min(15, Math.floor(rawIndex)));
      while (summaryParts.length <= summaryIndex) summaryParts.push("");
      if (method === "item/reasoning/summaryTextDelta") {
        summaryParts[summaryIndex] = `${summaryParts[summaryIndex] ?? ""}${rawStringValue(params.delta)}`
          .slice(-4096);
      }
      const combined = summaryParts.filter(Boolean).join("\n\n").trim();
      const sequence = finiteNumber(existing?.sequence)
        ?? this.nextProjectedTurnSequence(detailThread, turnId);
      const nextActivity: JsonRecord = {
        ...(existing ?? {}),
        id: itemId,
        tone: "info",
        kind: "task.progress",
        summary: combined ? combined.slice(-240) : "Reasoning",
        payload: {
          ...existingPayload,
          itemId,
          status: "inProgress",
          summaryParts,
        },
        turnId,
        sequence,
        createdAt: stringValue(existing?.createdAt, 64) || nowIso,
      };
      this.rememberSupplementalActivity(remoteThreadId, nextActivity);
      nextThread = {
        ...detailThread,
        updatedAt: nowIso,
        activities: this.upsertProjectedActivity(detailThread.activities, nextActivity),
      };
    } else if (method === "item/fileChange/patchUpdated") {
      const itemId = stringValue(params.itemId, 128);
      if (!turnId || !itemId) return true;
      const existing = projectedRow(detailThread.activities, itemId);
      const sequence = finiteNumber(existing?.sequence)
        ?? this.nextProjectedTurnSequence(detailThread, turnId);
      const projected = projectCodexLiveTurnItem({
        threadId: remoteThreadId,
        turnId,
        item: {
          type: "fileChange",
          id: itemId,
          changes: Array.isArray(params.changes) ? params.changes.slice(0, 64) : [],
          status: "inProgress",
        },
        sequence,
        createdAtMs: this.now(),
        completed: false,
      });
      if (!projected.activity) return true;
      const nextActivity = {
        ...projected.activity,
        createdAt: stringValue(existing?.createdAt, 64) || nowIso,
      };
      this.rememberSupplementalActivity(remoteThreadId, nextActivity);
      nextThread = {
        ...detailThread,
        updatedAt: nowIso,
        activities: this.upsertProjectedActivity(detailThread.activities, nextActivity),
      };
    } else if (method === "item/mcpToolCall/progress") {
      const itemId = stringValue(params.itemId, 128);
      const progress = stringValue(params.message, 4096);
      if (!turnId || !itemId || !progress) return true;
      const existing = projectedRow(detailThread.activities, itemId);
      const existingPayload = record(existing?.payload) ?? {};
      const sequence = finiteNumber(existing?.sequence)
        ?? this.nextProjectedTurnSequence(detailThread, turnId);
      const nextActivity: JsonRecord = {
        ...(existing ?? {}),
        id: itemId,
        tone: "tool",
        kind: "mcpToolCall",
        summary: stringValue(existing?.summary, 240) || "MCP tool",
        payload: {
          ...existingPayload,
          itemId,
          itemType: "mcp_tool_call",
          status: "inProgress",
          detail: progress,
        },
        turnId,
        sequence,
        createdAt: stringValue(existing?.createdAt, 64) || nowIso,
      };
      this.rememberSupplementalActivity(remoteThreadId, nextActivity);
      nextThread = {
        ...detailThread,
        updatedAt: nowIso,
        activities: this.upsertProjectedActivity(detailThread.activities, nextActivity),
      };
    } else if (method === "turn/plan/updated") {
      if (!turnId) return true;
      const itemId = `turn-plan-${turnId}`;
      const existing = projectedRow(detailThread.activities, itemId);
      const plan = (Array.isArray(params.plan) ? params.plan : []).slice(0, 64).flatMap(value => {
        const step = record(value);
        const title = stringValue(step?.step, 4096);
        const status = stringValue(step?.status, 64);
        return title && status ? [{ step: title, status }] : [];
      });
      const activeStep = plan.find(step => step.status === "inProgress" || step.status === "in_progress")?.step;
      const sequence = finiteNumber(existing?.sequence)
        ?? this.nextProjectedTurnSequence(detailThread, turnId);
      const nextActivity: JsonRecord = {
        ...(existing ?? {}),
        id: itemId,
        tone: "info",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        payload: {
          itemType: "plan-update",
          title: "Plan updated",
          plan,
          ...(stringValue(params.explanation, 8192) ? { explanation: stringValue(params.explanation, 8192) } : {}),
          ...(activeStep ? { detail: activeStep } : {}),
          ...(Array.isArray(params.plan) && params.plan.length > 64 ? { truncated: true } : {}),
        },
        turnId,
        sequence,
        createdAt: stringValue(existing?.createdAt, 64) || nowIso,
      };
      this.rememberSupplementalActivity(remoteThreadId, nextActivity);
      nextThread = {
        ...detailThread,
        updatedAt: nowIso,
        activities: this.upsertProjectedActivity(detailThread.activities, nextActivity),
      };
    } else if (method === "item/started" || method === "item/completed") {
      const item = record(params.item);
      const itemId = stringValue(item?.id, 128);
      if (!turnId || !item || !itemId) return false;
      const replacesItemId = source === "desktop-session" ? stringValue(params.replacesItemId, 128) : "";
      const replacedActivity = replacesItemId ? projectedRow(detailThread.activities, replacesItemId) : null;
      const normalizedItemType = stringValue(item.type, 64)
        .replace(/[^a-z0-9]/giu, "")
        .toLowerCase();
      const itemRole = stringValue(item.role, 32).toLowerCase();
      const userMessage =
        normalizedItemType === "usermessage"
        || (normalizedItemType === "message" && itemRole === "user");
      // App-server notifications are an in-memory preview. Codex Desktop can
      // publish one before its IPC write reaches the append-only rollout, and
      // failed writes can leave that preview behind. Only the session-file
      // source is durable enough to become Android chat history.
      if (source === "app-server" && userMessage) return true;
      const itemArguments = record(item.arguments);
      const asyncQuestion = desktopAsyncQuestionItem(item);
      const asyncGroup = asyncQuestion
        ? readDesktopInteractions({ turns: [{ id: turnId, items: [asyncQuestion] }] }).questions[0] : null;
      const recoveredQuestions = item.type === "dynamicToolCall"
        && stringValue(item.tool, 128) === "request_user_input"
        ? userInputQuestions(itemArguments?.questions)
        : asyncGroup?.questions.filter(question => !this.answeredDesktopQuestions.has(question.id)) ?? [];
      const recoveredDesktopInput = recoveredQuestions.length > 0
        ? this.rememberDesktopPendingUserInput({
            nativeThreadId,
            remoteThreadId,
            itemId: asyncGroup?.itemId ?? itemId,
            callId: asyncGroup?.itemId ?? (stringValue(item.callId, 128) || itemId),
            turnId,
            requestedAt: new Date(
              finiteNumber(params.startedAtMs)
                ?? finiteNumber(params.completedAtMs)
                ?? this.now(),
            ).toISOString(),
            questions: recoveredQuestions,
          })
        : null;
      const sequence = this.existingProjectedItemSequence(detailThread, itemId)
        ?? finiteNumber(replacedActivity?.sequence)
        ?? this.nextProjectedTurnSequence(detailThread, turnId);
      const projected = projectCodexLiveTurnItem({
        threadId: remoteThreadId,
        turnId,
        item: item.type === "agentMessage"
          && stringValue(item.phase, 64) === "final_answer"
          && stringValue(detailThread.interactionMode, 64) === "plan"
          ? { ...item, androidRemotePlanMode: true }
          : item,
        sequence,
        createdAtMs: finiteNumber(params.completedAtMs)
          ?? finiteNumber(params.startedAtMs)
          ?? this.now(),
        completed: method === "item/completed",
      });
      let projectedMessageRows = projectedRows(detailThread.messages);
      if (projected.message) {
        if (projected.message.role === "user") {
          const aliasKey = `${remoteThreadId}\u0000${itemId}`;
          const rememberedId = this.projectedUserMessageIds.get(aliasKey);
          const projectedId = stringValue(projected.message.id, 128);
          const projectedText = normalizedProjectedUserMessageText(projected.message.text);
          const explicitClientId = stringValue(item.clientId ?? item.client_id, 128);
          const exactPromptRows = projectedMessageRows.filter(candidate =>
            candidate.role === "user"
            && stringValue(candidate.turnId, 128) === turnId
            && [itemId, projectedId, rememberedId].includes(
              stringValue(candidate.id, 128),
            ));
          const sameTextPrompt = exactPromptRows.length > 0
            ? undefined
            : projectedMessageRows.find(candidate =>
                candidate.role === "user"
                && stringValue(candidate.turnId, 128) === turnId
                && normalizedProjectedUserMessageText(candidate.text) === projectedText);
          const samePromptRows = exactPromptRows.length > 0
            ? exactPromptRows
            : sameTextPrompt
              ? [sameTextPrompt]
              : [];
          const existingPromptId = stringValue(samePromptRows[0]?.id, 128);
          // The live app-server and the append-only session file use different
          // native ids for the same submitted prompt (`item-1` versus `msg_…`).
          // A Codex turn has one visible user message, so reconcile those
          // sources by turn and normalized text. Prefer an explicit phone
          // clientId when it is present; that immediately replaces Android's
          // optimistic row without relying on a text fallback.
          const stableId = (explicitClientId ? projectedId : rememberedId || existingPromptId)
            || projectedId;
          if (stableId) {
            projected.message = {
              ...projected.message,
              id: stableId,
              ...(samePromptRows[0]?.sequence === undefined
                ? {}
                : { sequence: samePromptRows[0].sequence }),
            };
            projectedMessageRows = projectedMessageRows.filter(candidate =>
              !samePromptRows.includes(candidate)
              || stringValue(candidate.id, 128) === stableId);
            this.rememberProjectedUserMessageAlias(remoteThreadId, itemId, stableId);
            for (const samePromptRow of samePromptRows) {
              const samePromptId = stringValue(samePromptRow.id, 128);
              if (samePromptId) {
                this.rememberProjectedUserMessageAlias(
                  remoteThreadId,
                  samePromptId,
                  stableId,
                );
              }
            }
          }
        }
        const projectedMessageId = stringValue(projected.message.id, 128);
        const existingMessage = projectedMessageRows
          .find(candidate => stringValue(candidate?.id, 128) === projectedMessageId);
        if (existingMessage) {
          projected.message = {
            ...projected.message,
            createdAt: existingMessage.createdAt,
            updatedAt: nowIso,
          };
        }
        if (
          source === "desktop-session"
          && method === "item/completed"
          && projected.message.role === "user"
          && Boolean(stringValue(item.clientId ?? item.client_id, 128))
        ) {
          this.rememberDurableDesktopUserMessage(remoteThreadId, projected.message);
        }
      }
      if (projected.activity) {
        const existingActivity = projectedRow(detailThread.activities, itemId) ?? replacedActivity;
        if (existingActivity) {
          const existingPayload = record(existingActivity.payload);
          const projectedPayload = record(projected.activity.payload);
          const existingFileChanges = Array.isArray(existingPayload?.fileChanges)
            ? existingPayload.fileChanges
            : [];
          const projectedFileChanges = Array.isArray(projectedPayload?.fileChanges)
            ? projectedPayload.fileChanges
            : [];
          projected.activity = {
            ...projected.activity,
            createdAt: existingActivity.createdAt,
            // The Desktop app-server and the append-only session watcher can
            // report the same running patch in either order. Never let a
            // later, empty `item/started` snapshot erase line totals that the
            // session watcher or `patchUpdated` notification already knew.
            ...(item.type === "fileChange"
              && existingFileChanges.length > 0
              && projectedFileChanges.length === 0
              && projectedPayload
              ? {
                  payload: {
                    ...projectedPayload,
                    fileChanges: existingFileChanges,
                  },
                }
              : {}),
          };
          const existingItemType = stringValue(existingPayload?.itemType, 64);
          const projectedItemType = stringValue(projectedPayload?.itemType, 64);
          const preserveCommandPresentation = item.type === "commandExecution"
            && projectedItemType === "command_execution"
            && (existingItemType === "file-read" || existingItemType === "codebase-search");
          if (preserveCommandPresentation && projectedPayload) {
            projected.activity = {
              ...projected.activity,
              summary: existingActivity.summary,
              payload: {
                ...projectedPayload,
                itemType: existingItemType,
                title: existingPayload?.title,
                requestKind: existingPayload?.requestKind,
              },
            };
          }
        }
      }
      if (projected.proposedPlan) {
        const projectedPlanId = codexProposedPlanId(turnId, itemId);
        projected.proposedPlan = { ...projected.proposedPlan, id: projectedPlanId };
        const existingPlan = projectedRow(detailThread.proposedPlans, projectedPlanId);
        if (existingPlan) {
          projected.proposedPlan = {
            ...projected.proposedPlan,
            createdAt: existingPlan.createdAt,
            updatedAt: nowIso,
          };
        }
      }
      if (method === "item/completed") {
        this.forgetSupplementalActivity(remoteThreadId, itemId);
        this.forgetSupplementalPlan(remoteThreadId, itemId);
        if (projected.proposedPlan) {
          this.rememberSupplementalPlan(remoteThreadId, {
            ...projected.proposedPlan,
            _androidRemoteSourceItemId: itemId,
          });
        }
        if (projected.message?.role === "assistant") {
          const completed = this.completedLiveMessageIds.get(remoteThreadId) ?? new Set<string>();
          completed.add(itemId);
          this.completedLiveMessageIds.set(remoteThreadId, completed);
        }
      }
      const retainedActivities = projectedRows(detailThread.activities).filter(activity =>
        (!replacedActivity || activity !== replacedActivity)
        && !(method === "item/completed" && normalizedItemType === "reasoning"
          && !projected.activity && stringValue(activity.id, 128) === itemId
          && record(activity.payload)?.summaryAvailable === false));
      if (replacedActivity) this.forgetSupplementalActivity(remoteThreadId, replacesItemId);
      let nextActivities = projected.activity
        ? this.upsertProjectedActivity(retainedActivities, projected.activity)
        : retainedActivities;
      if (recoveredDesktopInput) {
        if (method === "item/started" || asyncGroup) {
          nextActivities = this.upsertProjectedActivity(nextActivities, recoveredDesktopInput.activity);
        } else {
          nextActivities = nextActivities.filter(activity =>
            stringValue(activity.id, 128) !== stringValue(recoveredDesktopInput.activity.id, 128));
          this.forgetDesktopPendingUserInput(recoveredDesktopInput.publicRequestId);
        }
      }
      const answeredIds = method === "item/completed" ? desktopQuestionReplyIds(item) : [];
      for (const id of answeredIds) this.answeredDesktopQuestions.add(id);
      if (answeredIds.length) {
        for (const pending of this.pendingDesktopUserInputs.values()) {
          if (pending.remoteThreadId !== remoteThreadId || !this.isAsyncDesktopQuestion(pending)) continue;
          const questions = pending.questions.filter(question => !this.answeredDesktopQuestions.has(stringValue(question.id, 128)));
          this.forgetSupplementalActivity(remoteThreadId, stringValue(pending.activity.id, 128));
          if (questions.length) {
            pending.questions = questions;
            pending.activity = { ...pending.activity, payload: { requestId: pending.publicRequestId, questions } };
            nextActivities = this.upsertProjectedActivity(nextActivities, pending.activity);
          } else {
            this.forgetDesktopPendingUserInput(pending.publicRequestId);
            nextActivities = nextActivities.filter(activity => activity.id !== pending.activity.id);
          }
        }
        nextActivities = nextActivities.flatMap(activity => {
          if (activity.kind !== "user-input.requested") return [activity];
          const payload = record(activity.payload);
          const questions = userInputQuestions(payload?.questions);
          if (!questions.length || !questions.every(question => stringValue(question.id, 128).startsWith('["request_user_input_async",'))) return [activity];
          const remaining = questions.filter(question => !this.answeredDesktopQuestions.has(stringValue(question.id, 128)));
          if (!remaining.length) return [];
          return [{ ...activity, payload: { ...payload, questions: remaining } }];
        });
      }
      nextThread = {
        ...detailThread,
        updatedAt: nowIso,
        ...(projected.message
          ? { messages: this.upsertProjectedRow(projectedMessageRows, projected.message) }
          : projected.proposedPlan && method === "item/completed"
            ? {
                messages: projectedRows(detailThread.messages).filter(message =>
                  stringValue(message.id, 128) !== itemId),
              }
          : {}),
        activities: nextActivities,
        ...(projected.proposedPlan
          ? { proposedPlans: this.upsertProjectedRow(detailThread.proposedPlans, projected.proposedPlan) }
          : {}),
        ...(recoveredDesktopInput || answeredIds.length
          ? { hasPendingUserInput: this.hasUnresolvedUserInput(nextActivities) }
          : {}),
      };
    } else if (method === "turn/started" || method === "turn/completed") {
      nextThread = this.projectLiveTurnLifecycle(detailThread, remoteThreadId, method, params);
    } else if (
      method === "item/reasoning/textDelta" ||
      method === "item/commandExecution/outputDelta" ||
      method === "item/commandExecution/terminalInteraction" ||
      method === "item/fileChange/outputDelta" ||
      method === "turn/diff/updated" ||
      method.includes("delta") ||
      method.includes("Delta")
    ) {
      // Raw reasoning stays private, and raw command/file output remains
      // inside the structured tool row rather than becoming Markdown. These
      // high-frequency fragments must not trigger a complete task reread.
      return true;
    } else {
      return false;
    }

    if (!nextThread) return false;
    if (nextThread.hasPendingUserInput === false && nextThread.hasPendingApprovals !== true
      && nextNotificationActivity?.fallbackLabel === "Requires your input") {
      nextNotificationActivity.fallbackLabel = "Reasoning";
    }
    if (
      source === "desktop-session"
      && turnId
      && (method === "item/started" || method === "item/completed" || method === "item/agentMessage/delta")
      && this.desktopSessions.activeTurnId?.(remoteThreadId) === turnId
      && !turnStatusIsActive(record(nextThread.session)?.status)
    ) {
      // A stale secondary-reader snapshot must not strand the phone on Pause
      // or Send while the watched Desktop turn keeps producing real work.
      // Never revive old item echoes after task_complete/turn_aborted: the
      // watcher has already cleared (or changed) its active turn at that point.
      const previousTurn = record(nextThread.latestTurn);
      const sameTurn = stringValue(previousTurn?.turnId, 128) === turnId;
      nextThread = {
        ...nextThread,
        latestTurn: {
          ...(sameTurn ? previousTurn : {}),
          turnId,
          state: "running",
          requestedAt: sameTurn ? previousTurn?.requestedAt ?? nowIso : nowIso,
          startedAt: sameTurn ? previousTurn?.startedAt ?? previousTurn?.requestedAt ?? nowIso : nowIso,
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          ...(record(nextThread.session) ?? {}),
          threadId: remoteThreadId,
          status: "running",
          statusConfidence: "confirmed",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: nowIso,
        },
      };
    }
    if (method === "turn/started" || method === "turn/completed" || method === "thread/status/changed"
      || nextThread.hasPendingUserInput !== detailThread.hasPendingUserInput
      || nextThread.hasPendingApprovals !== detailThread.hasPendingApprovals) {
      this.rememberShellLifecycle(remoteThreadId, nextThread);
    }
    const advanced = advanceProjectedThreadStream(
      current,
      { ...current.detail, thread: nextThread },
      this.now(),
    );
    this.threadStreams.set(remoteThreadId, advanced.state);
    if (publish) {
      for (const ws of this.sockets) {
        if (ws.data.subscription !== "thread" || ws.data.threadId !== remoteThreadId) continue;
        for (const item of advanced.items) this.publishSubscriptionEvent(ws, item, false);
      }
    }
    // A start/terminal boundary gets one authoritative reconciliation.
    // Desktop rollback/edit is a non-prefix history rewrite, so the stream
    // diff will deliberately fall back to a bounded replacement snapshot.
    // Ordinary token and tool-row updates stay entirely on the small path.
    if (method === "turn/started" || method === "turn/completed" || method === "thread/status/changed") {
      this.requestAuthoritativeThreadRefresh(remoteThreadId);
      if (method === "turn/completed") {
        void this.startNextQueuedTurnAfterCompletion(remoteThreadId, turnId);
      }
    }
    return true;
    } finally {
      this.commitLiveNotificationActivityState(remoteThreadId, nextNotificationActivity);
    }
  }

  private upsertProjectedRow(value: unknown, row: JsonRecord): JsonRecord[] {
    const current = Array.isArray(value)
      ? value.flatMap(candidate => record(candidate) ? [record(candidate)!] : [])
      : [];
    const id = stringValue(row.id, 128);
    const index = current.findIndex(candidate => stringValue(candidate.id, 128) === id);
    if (index < 0) return [...current, row];
    return current.map((candidate, candidateIndex) => candidateIndex === index ? row : candidate);
  }

  private upsertProjectedActivity(value: unknown, row: JsonRecord): JsonRecord[] {
    const current = projectedRows(value);
    const id = stringValue(row.id, 128);
    const existingIndex = current.findIndex(candidate => stringValue(candidate.id, 128) === id);
    if (existingIndex >= 0) {
      return current.map((candidate, index) => index === existingIndex ? row : candidate);
    }
    const kind = stringValue(row.kind, 128);
    const statusKinds = new Set(["context-window.updated", "provider.usage.updated"]);
    const insertionIndex = statusKinds.has(kind)
      ? current.length
      : current.findIndex(candidate => statusKinds.has(stringValue(candidate.kind, 128)));
    const rowSignature = projectedReasoningSignature(row);
    const previousIndex = (insertionIndex < 0 ? current.length : insertionIndex) - 1;
    const previous = previousIndex >= 0 ? current[previousIndex] : undefined;
    if (
      rowSignature !== null
      && previous
      && rowSignature === projectedReasoningSignature(previous)
    ) {
      const previousPayload = record(previous.payload) ?? {};
      const rowPayload = record(row.payload) ?? {};
      return current.map((candidate, index) =>
        index === previousIndex
          ? {
              ...previous,
              ...row,
              id: previous.id,
              turnId: previous.turnId,
              sequence: previous.sequence,
              createdAt: previous.createdAt,
              payload: {
                ...previousPayload,
                ...rowPayload,
                itemId: previousPayload.itemId ?? previous.id,
              },
            }
          : candidate);
    }
    if (insertionIndex < 0) return [...current, row];
    return [
      ...current.slice(0, insertionIndex),
      row,
      ...current.slice(insertionIndex),
    ];
  }

  /** Read account-wide limits independently of proxy provider quota reports. */
  private refreshNativeAccountQuota(): void {
    const client = this.codex;
    if (!client || client.directModelProvider !== "openai" || this.nativeAccountQuotaRefresh
      || this.nativeAccountQuotaRefreshAfter > this.now()) return;
    const generation = this.nativeAccountQuotaGeneration;
    this.nativeAccountQuotaRefreshAfter = this.now() + 60_000;
    const flight = client.request("account/rateLimits/read", {}, 8_000)
      .then(response => {
        if (this.codex !== client || generation !== this.nativeAccountQuotaGeneration) return;
        const next = codexAccountQuotaReport(response, this.now());
        const changed = fingerprints(next) !== fingerprints(this.nativeAccountQuota);
        this.nativeAccountQuota = next;
        if (changed) this.publishNativeAccountQuota();
      })
      .catch(() => {
        if (this.codex !== client || generation !== this.nativeAccountQuotaGeneration) return;
        this.nativeAccountQuotaRefreshAfter = this.now() + 30_000;
        // A transient error may retain a recent snapshot, but never indefinitely.
        const updatedAt = finiteNumber(this.nativeAccountQuota?.updatedAt) ?? 0;
        if (updatedAt < this.now() - 5 * 60_000) {
          this.nativeAccountQuota = null;
          this.publishNativeAccountQuota();
        }
      })
      .finally(() => {
        if (this.nativeAccountQuotaRefresh === flight) this.nativeAccountQuotaRefresh = null;
      });
    this.nativeAccountQuotaRefresh = flight;
  }

  /** Update status in place, without reloading messages or changing task order. */
  private publishNativeAccountQuota(): void {
    if (this.codex?.directModelProvider !== "openai") return;
    for (const [threadId, current] of this.threadStreams) {
      const thread = record(current.detail.thread);
      if (!thread || stringValue(record(thread.modelSelection)?.instanceId, 64) !== "openai") continue;
      const previous = projectedRows(thread.activities)
        .find(row => row.id === `provider-usage-${threadId}`);
      const activity = projectProviderUsageActivity({
        threadId,
        report: this.nativeAccountQuota,
        fallbackCreatedAt: new Date(this.now()).toISOString(),
      }) ?? (previous ? {
        ...previous,
        createdAt: new Date(this.now()).toISOString(),
        payload: { providerId: "openai", providerLabel: "ChatGPT account", windows: [] },
      } : null);
      if (!activity || fingerprints(previous?.payload) === fingerprints(activity.payload)) continue;
      const advanced = advanceProjectedThreadStream(current, {
        ...current.detail,
        thread: { ...thread, activities: this.upsertProjectedActivity(thread.activities, activity) },
      }, this.now());
      this.threadStreams.set(threadId, advanced.state);
      for (const ws of this.sockets) {
        if (ws.data.subscription !== "thread" || ws.data.threadId !== threadId) continue;
        for (const item of advanced.items) this.publishSubscriptionEvent(ws, item, false);
      }
    }
  }

  private refreshProviderQuotaReports(): void {
    if (
      !this.listProviderQuotaReports
      || this.providerQuotaRefresh
      || this.providerQuotaRefreshAfter > this.now()
    ) return;
    this.providerQuotaRefreshAfter = this.now() + 5 * 60_000;
    const modelRowsPromise = this.listModels
      ? this.listModels().catch(() => this.managementModelRows)
      : Promise.resolve(this.managementModelRows);
    this.providerQuotaRefresh = Promise.all([
      this.listProviderQuotaReports(),
      modelRowsPromise,
    ])
      .then(([reports, modelRows]) => {
        const next = Array.isArray(reports) ? reports.slice(0, 128) : [];
        const nextModelRows = Array.isArray(modelRows) ? modelRows.slice(0, 4_096) : [];
        const modelRowFingerprint = (row: ManagementModelRow): JsonRecord => ({
          provider: row.provider,
          id: row.id,
          namespaced: row.namespaced,
          disabled: row.disabled,
          sourceVisible: row.sourceVisible,
          pickerDisplayName: row.pickerDisplayName,
          reasoningControl: row.reasoningControl,
          reasoningEfforts: row.reasoningEfforts,
          defaultReasoningEffort: row.defaultReasoningEffort,
          reasoningRequired: row.reasoningRequired,
          supportsReasoningSummaries: row.supportsReasoningSummaries,
          serviceTiers: row.serviceTiers ?? null,
          additionalSpeedTiers: row.additionalSpeedTiers ?? null,
          defaultServiceTier: row.defaultServiceTier ?? null,
        });
        const changed = fingerprints(next) !== fingerprints(this.providerQuotaReports)
          || fingerprints(nextModelRows.map(modelRowFingerprint))
            !== fingerprints(this.managementModelRows.map(modelRowFingerprint));
        this.providerQuotaReports = next;
        this.managementModelRows = nextModelRows;
        this.revalidateStoredTaskSelectionsAfterModelCatalogRefresh();
        this.reapplyDesktopThreadSettingsAfterModelCatalogRefresh();
        if (changed) {
          this.configCache = null;
          this.scheduleRefresh();
        }
      })
      .catch(error => {
        this.providerQuotaRefreshAfter = this.now() + 30_000;
        console.warn(`[remodex] Android Remote could not refresh provider usage: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.providerQuotaRefresh = null;
      });
  }

  private providerUsageActivity(
    thread: JsonRecord,
    remoteThreadId: string,
    fallbackCreatedAt: string,
  ): JsonRecord | null {
    const instanceId = stringValue(thread.androidRemoteProviderInstanceId, 64)
      || stringValue(thread.modelProvider, 64)
      || "openai";
    let report: unknown = instanceId === "openai" && this.codex?.directModelProvider === "openai"
      ? this.nativeAccountQuota : null;
    report ??= this.providerQuotaReports.find(value => {
      const row = record(value);
      const provider = stringValue(row?.provider, 64);
      return provider === instanceId || androidProviderInstanceId(provider) === instanceId;
    });
    if (!report) {
      const model = stringValue(thread.androidRemoteModel, 256)
        || stringValue(thread.model, 256)
        || "gpt-5.6-sol";
      const modelRow = this.managementModelRows.find(row =>
        !row.disabled && (row.namespaced === model || row.id === model));
      const routedProvider = modelRow?.provider;
      if (routedProvider) {
        report = this.providerQuotaReports.find(value => {
          const row = record(value);
          return stringValue(row?.provider, 64) === routedProvider;
        });
      }
    }
    return projectProviderUsageActivity({
      threadId: remoteThreadId,
      report,
      fallbackCreatedAt,
    });
  }

  private existingProjectedItemSequence(thread: JsonRecord, itemId: string): number | null {
    for (const key of ["messages", "activities", "proposedPlans"] as const) {
      const values = Array.isArray(thread[key]) ? thread[key] : [];
      for (const value of values) {
        const row = record(value);
        if (stringValue(row?.id, 128) === itemId) return finiteNumber(row?.sequence);
      }
    }
    return null;
  }

  private nextProjectedTurnSequence(thread: JsonRecord, turnId: string): number {
    let maximum = -1;
    for (const key of ["messages", "activities", "proposedPlans"] as const) {
      const values = Array.isArray(thread[key]) ? thread[key] : [];
      for (const value of values) {
        const row = record(value);
        if (stringValue(row?.turnId, 128) !== turnId) continue;
        maximum = Math.max(maximum, finiteNumber(row?.sequence) ?? -1);
      }
    }
    return maximum + 1;
  }

  private handleCodexServerRequest(message: CodexJsonRpcMessage): void {
    const method = stringValue(message.method, 128);
    const params = record(message.params) ?? {};
    if (method === "currentTime/read") {
      this.requireCodex().respond(message.id!, { currentTimeAt: Math.floor(this.now() / 1000) });
      return;
    }
    const nativeThreadId = stringValue(params.threadId, 128)
      || stringValue(params.conversationId, 128);
    if (!nativeThreadId) {
      this.requireCodex().reject(message.id!, -32601, "Remodex cannot handle this Codex client request");
      return;
    }
    let kind: "approval.requested" | "user-input.requested";
    let summary: string;
    let payload: JsonRecord;
    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
      const command = stringValue(params.command, 8192)
        || (Array.isArray(params.command) ? params.command.filter(row => typeof row === "string").join(" ") : "");
      kind = "approval.requested";
      summary = "Command approval requested";
      payload = {
        requestKind: "command",
        detail: command || stringValue(params.reason, 4096) || "Codex wants to run a command",
      };
    } else if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      kind = "approval.requested";
      summary = "File-change approval requested";
      payload = {
        requestKind: "file-change",
        detail: stringValue(params.reason, 4096)
          || stringValue(params.grantRoot, 4096)
          || "Codex wants to change files",
      };
    } else if (method === "item/tool/requestUserInput" || method === "item/tool/requestMcpServerElicitation") {
      const questions = userInputQuestions(params.questions);
      if (method === "item/tool/requestUserInput" && questions.length === 0) {
        this.requireCodex().reject(message.id!, -32602, "Codex sent an invalid user question");
        return;
      }
      kind = "user-input.requested";
      summary = method === "item/tool/requestMcpServerElicitation"
        ? "MCP server response requested"
        : "User input requested";
      payload = method === "item/tool/requestMcpServerElicitation"
        ? { requestKind: "mcp-elicitation", questions, responseSchema: record(params.schema) ?? null }
        : { questions };
    } else {
      this.requireCodex().reject(message.id!, -32601, "This Codex client request is not supported by Android Remote");
      return;
    }
    const publicRequestId = `request-${randomUUID()}`;
    const remoteThreadId = this.remoteThreadId(nativeThreadId);
    const createdAt = new Date(this.now()).toISOString();
    const turnId = stringValue(params.turnId, 128) || null;
    const activity: JsonRecord = {
      id: `activity-${publicRequestId}`,
      tone: kind === "approval.requested" ? "approval" : "info",
      kind,
      summary,
      payload: { requestId: publicRequestId, ...payload },
      turnId,
      sequence: ++this.sequence,
      createdAt,
    };
    this.pendingRequests.set(publicRequestId, {
      publicRequestId,
      nativeRequestId: message.id!,
      method,
      nativeThreadId,
      remoteThreadId,
      turnId,
      createdAt,
      params,
      activity,
    });
    this.setLiveNotificationFallback(remoteThreadId, turnId, "Requires your input", true);
    this.scheduleRefresh();
  }
}

export function createAndroidRemoteGatewayController(
  store: AndroidRemoteStore,
  options?: AndroidRemoteGatewayOptions,
): AndroidRemoteGatewayController {
  return new AndroidRemoteGatewayController(store, options);
}
