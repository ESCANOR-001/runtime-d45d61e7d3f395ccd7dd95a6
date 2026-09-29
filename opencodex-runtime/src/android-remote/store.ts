import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteFile,
  getConfigDir,
  hardenExistingSecret,
} from "../config";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";

const ANDROID_REMOTE_STATE_VERSION = 1;
const ANDROID_REMOTE_STATE_MAX_BYTES = 1024 * 1024;
const CLIENT_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const STORED_MODEL_OPTION_IDS = new Set([
  "effort",
  "reasoningEffort",
  "serviceTier",
]);

/** Stable grouping id for the Android Remote flat Chats section. */
export const ANDROID_REMOTE_PROJECTLESS_ID = "codex-project-chats";
export type AndroidRemoteWorkspaceKind = "projectless";

export type AndroidRemoteSettings = {
  controlEnabled: boolean;
  keepAwake: boolean;
  /** Explicit opt-in from local-first onboarding; existing installs stay loopback-only. */
  localNetworkEnabled?: boolean;
  /** Dashboard selection; does not enable/disable either connection route. */
  connectionChoice?: "local" | "quick" | "named";
  tunnelMode: "quick" | "named";
  namedTunnelHostname?: string;
};

/**
 * Stored client data is deliberately separate from every existing Remodex token class.
 * `credentialDigest` is private store data and must never appear in a management response.
 */
export type AndroidRemoteStoredClient = {
  id: string;
  label: string;
  deviceType: "mobile";
  os: string;
  address?: string;
  scopes: string[];
  createdAt: string;
  lastSeenAt?: string;
  credentialExpiresAt?: string;
  credentialDigest: string;
  installationDigest?: string;
};

/**
 * Codex creates the durable task id, while Remodex creates a temporary task id
 * before the first prompt is sent. This small mapping keeps the Android task id
 * stable after Remodex restarts. It never contains prompts or transcript data.
 */
export type AndroidRemoteThreadAlias = {
  remoteThreadId: string;
  nativeThreadId: string;
  projectId: string;
  /** Present for a general Chat that must not inherit a project workspace. */
  workspaceKind?: AndroidRemoteWorkspaceKind;
  title: string;
  cwd: string;
  instanceId?: string;
  model: string;
  runtimeMode: "approval-required" | "auto-accept-edits" | "full-access";
  interactionMode: "default" | "plan";
  createdAt: string;
  updatedAt: string;
};

export type AndroidRemoteTaskSelectionSource = "android" | "desktop" | "migration";

/**
 * Durable model state for one Codex task.
 *
 * This is intentionally provider/model metadata only. Provider credentials stay
 * in the normal Remodex credential stores and are never projected to Android.
 */
export type AndroidRemoteTaskSelection = {
  nativeThreadId: string;
  remoteThreadId: string;
  providerInstanceId: string;
  model: string;
  options?: unknown;
  /** Hash of the model capability row used to validate the stored options. */
  capabilityVersion?: string;
  revision: number;
  source: AndroidRemoteTaskSelectionSource;
  updateId: string;
  updatedAt: string;
};

export type AndroidRemoteTaskSelectionWrite = Omit<AndroidRemoteTaskSelection, "revision"> & {
  expectedRevision?: number;
};

export type AndroidRemoteTaskSelectionWriteResult = {
  applied: boolean;
  duplicate: boolean;
  stale: boolean;
  selection: AndroidRemoteTaskSelection;
  state: AndroidRemoteState;
};

export type AndroidRemoteState = {
  version: 1;
  settings: AndroidRemoteSettings;
  clients: AndroidRemoteStoredClient[];
  threadAliases: AndroidRemoteThreadAlias[];
  taskSelections: AndroidRemoteTaskSelection[];
};

export interface AndroidRemoteStore {
  /** Present only for a filesystem-backed store. Tests and memory stores omit it. */
  readonly stateRoot?: string;
  read(): AndroidRemoteState;
  updateSettings(patch: Partial<AndroidRemoteSettings>): AndroidRemoteState;
  upsertClient(client: AndroidRemoteStoredClient, replaceClientIds?: readonly string[]): AndroidRemoteState;
  updateClientMetadata(id: string, patch: { label?: string; os?: string; installationDigest?: string }): AndroidRemoteState;
  touchClient(id: string, patch: { address?: string; lastSeenAt: string }): AndroidRemoteState;
  revokeClient(id: string): { removed: boolean; state: AndroidRemoteState };
  upsertThreadAlias(alias: AndroidRemoteThreadAlias): AndroidRemoteState;
  removeThreadAlias(remoteThreadId: string): AndroidRemoteState;
  upsertTaskSelection(selection: AndroidRemoteTaskSelectionWrite): AndroidRemoteTaskSelectionWriteResult;
  removeTaskSelection(threadId: string): AndroidRemoteState;
}

export const DEFAULT_ANDROID_REMOTE_SETTINGS: Readonly<AndroidRemoteSettings> = {
  controlEnabled: false,
  keepAwake: false,
  tunnelMode: "quick",
};

function defaultState(): AndroidRemoteState {
  return {
    version: ANDROID_REMOTE_STATE_VERSION,
    settings: { ...DEFAULT_ANDROID_REMOTE_SETTINGS },
    clients: [],
    threadAliases: [],
    taskSelections: [],
  };
}

function stringValue(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function storedClient(value: unknown): AndroidRemoteStoredClient | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = stringValue(row.id, 128);
  const label = stringValue(row.label, 160);
  const os = stringValue(row.os, 64);
  const createdAt = stringValue(row.createdAt, 64);
  const credentialDigest = stringValue(row.credentialDigest, 256);
  if (!id || !CLIENT_ID_PATTERN.test(id) || !label || !os || !createdAt || !credentialDigest) return null;
  if (row.deviceType !== "mobile") return null;
  const scopes = Array.isArray(row.scopes)
    ? row.scopes.flatMap(scope => {
        const parsed = stringValue(scope, 96);
        return parsed ? [parsed] : [];
      }).slice(0, 32)
    : [];
  const address = stringValue(row.address, 256) ?? undefined;
  const lastSeenAt = stringValue(row.lastSeenAt, 64) ?? undefined;
  const credentialExpiresAt = stringValue(row.credentialExpiresAt, 64) ?? undefined;
  const installationDigest = typeof row.installationDigest === "string" && /^[a-f0-9]{64}$/.test(row.installationDigest)
    ? row.installationDigest : undefined;
  return {
    id,
    label,
    deviceType: "mobile",
    os,
    scopes,
    createdAt,
    credentialDigest,
    ...(installationDigest ? { installationDigest } : {}),
    ...(address ? { address } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(credentialExpiresAt ? { credentialExpiresAt } : {}),
  };
}

function storedThreadAlias(value: unknown): AndroidRemoteThreadAlias | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const remoteThreadId = stringValue(row.remoteThreadId, 128);
  const nativeThreadId = stringValue(row.nativeThreadId, 128);
  const projectId = stringValue(row.projectId, 128);
  const workspaceKind = row.workspaceKind === "projectless" ? "projectless" as const : undefined;
  const title = stringValue(row.title, 256);
  const cwd = stringValue(row.cwd, 4096);
  const instanceId = stringValue(row.instanceId, 64) ?? undefined;
  const model = stringValue(row.model, 256);
  const createdAt = stringValue(row.createdAt, 64);
  const updatedAt = stringValue(row.updatedAt, 64);
  const runtimeMode = row.runtimeMode;
  const interactionMode = row.interactionMode;
  if (!remoteThreadId || !nativeThreadId || !projectId || !title || !cwd || !model
    || !createdAt || !updatedAt) return null;
  if (!CLIENT_ID_PATTERN.test(remoteThreadId) || !CLIENT_ID_PATTERN.test(nativeThreadId)
    || !CLIENT_ID_PATTERN.test(projectId)) return null;
  if (runtimeMode !== "approval-required" && runtimeMode !== "auto-accept-edits"
    && runtimeMode !== "full-access") return null;
  if (interactionMode !== "default" && interactionMode !== "plan") return null;
  return {
    remoteThreadId,
    nativeThreadId,
    projectId,
    ...(workspaceKind ? { workspaceKind } : {}),
    title,
    cwd,
    ...(instanceId ? { instanceId } : {}),
    model,
    runtimeMode,
    interactionMode,
    createdAt,
    updatedAt,
  };
}

function storedModelOptions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.flatMap(candidate => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const row = candidate as Record<string, unknown>;
      const id = stringValue(row.id, 64);
      const optionValue = row.value;
      if (!id || !STORED_MODEL_OPTION_IDS.has(id)
        || (typeof optionValue !== "string" && typeof optionValue !== "boolean"
        && typeof optionValue !== "number")) return [];
      return [{ id, value: typeof optionValue === "string" ? optionValue.slice(0, 256) : optionValue }];
    }).slice(0, 32);
  }
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([rawId, optionValue]) => {
    const id = stringValue(rawId, 64);
    if (!id || !STORED_MODEL_OPTION_IDS.has(id)
      || (typeof optionValue !== "string" && typeof optionValue !== "boolean"
      && typeof optionValue !== "number")) return [];
    return [[id, typeof optionValue === "string" ? optionValue.slice(0, 256) : optionValue] as const];
  }).slice(0, 32);
  return Object.fromEntries(entries);
}

function storedTaskSelection(value: unknown): AndroidRemoteTaskSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const nativeThreadId = stringValue(row.nativeThreadId, 128);
  const remoteThreadId = stringValue(row.remoteThreadId, 128);
  const providerInstanceId = stringValue(row.providerInstanceId, 64);
  const model = stringValue(row.model, 256);
  const updateId = stringValue(row.updateId, 128);
  const updatedAt = stringValue(row.updatedAt, 64);
  const capabilityVersion = stringValue(row.capabilityVersion, 128) ?? undefined;
  const revision = typeof row.revision === "number" && Number.isSafeInteger(row.revision)
    ? row.revision
    : 0;
  const source = row.source;
  if (!nativeThreadId || !remoteThreadId || !providerInstanceId || !model || !updateId
    || !updatedAt || revision < 1) return null;
  if (!CLIENT_ID_PATTERN.test(nativeThreadId) || !CLIENT_ID_PATTERN.test(remoteThreadId)
    || !CLIENT_ID_PATTERN.test(providerInstanceId)) return null;
  if (source !== "android" && source !== "desktop" && source !== "migration") return null;
  const options = storedModelOptions(row.options);
  return {
    nativeThreadId,
    remoteThreadId,
    providerInstanceId,
    model,
    ...(options !== undefined ? { options } : {}),
    ...(capabilityVersion ? { capabilityVersion } : {}),
    revision,
    source,
    updateId,
    updatedAt,
  };
}

function sameTaskSelection(
  left: Pick<AndroidRemoteTaskSelection, "nativeThreadId" | "remoteThreadId" | "providerInstanceId" | "model" | "options" | "capabilityVersion">,
  right: Pick<AndroidRemoteTaskSelection, "nativeThreadId" | "remoteThreadId" | "providerInstanceId" | "model" | "options" | "capabilityVersion">,
): boolean {
  return left.nativeThreadId === right.nativeThreadId
    && left.remoteThreadId === right.remoteThreadId
    && left.providerInstanceId === right.providerInstanceId
    && left.model === right.model
    && left.capabilityVersion === right.capabilityVersion
    && JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null);
}

function parseState(value: unknown): AndroidRemoteState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultState();
  const root = value as Record<string, unknown>;
  const rawSettings = root.settings && typeof root.settings === "object" && !Array.isArray(root.settings)
    ? root.settings as Record<string, unknown>
    : {};
  return {
    version: ANDROID_REMOTE_STATE_VERSION,
    settings: {
      controlEnabled: rawSettings.controlEnabled === true,
      keepAwake: rawSettings.keepAwake === true,
      ...(rawSettings.localNetworkEnabled === true ? { localNetworkEnabled: true } : {}),
      tunnelMode: rawSettings.tunnelMode === "named" ? "named" : "quick",
      ...(rawSettings.connectionChoice === "local" || rawSettings.connectionChoice === "quick" || rawSettings.connectionChoice === "named"
        ? { connectionChoice: rawSettings.connectionChoice }
        : {}),
      ...(stringValue(rawSettings.namedTunnelHostname, 253)
        ? { namedTunnelHostname: stringValue(rawSettings.namedTunnelHostname, 253)! }
        : {}),
    },
    clients: Array.isArray(root.clients)
      ? root.clients.flatMap(client => {
          const parsed = storedClient(client);
          return parsed ? [parsed] : [];
        }).slice(0, 256)
      : [],
    threadAliases: Array.isArray(root.threadAliases)
      ? root.threadAliases.flatMap(alias => {
          const parsed = storedThreadAlias(alias);
          return parsed ? [parsed] : [];
        }).slice(-1024)
      : [],
    taskSelections: Array.isArray(root.taskSelections)
      ? root.taskSelections.flatMap(selection => {
          const parsed = storedTaskSelection(selection);
          return parsed ? [parsed] : [];
        }).slice(-4096)
      : [],
  };
}

function ensureStateDirectory(root: string): void {
  assertNotRealHomeUnderTest(root);
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch { /* platform may ignore chmod */ }
  if (process.platform === "win32") hardenSecretDir(root, { required: false });
}

export function androidRemoteStatePath(root = getConfigDir()): string {
  return join(root, "android-remote.json");
}

export function createAndroidRemoteStore(root = getConfigDir()): AndroidRemoteStore {
  const path = androidRemoteStatePath(root);

  const read = (): AndroidRemoteState => {
    try {
      if (!existsSync(path)) return defaultState();
      hardenExistingSecret(path);
      if (statSync(path).size > ANDROID_REMOTE_STATE_MAX_BYTES) return defaultState();
      return parseState(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      // Fail closed. Invalid local state never enables remote control or admits a client.
      return defaultState();
    }
  };

  const write = (state: AndroidRemoteState): AndroidRemoteState => {
    ensureStateDirectory(root);
    atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  };

  return {
    stateRoot: root,
    read,
    updateSettings(patch) {
      const current = read();
      return write({
        ...current,
        settings: {
          controlEnabled: patch.controlEnabled ?? current.settings.controlEnabled,
          keepAwake: patch.keepAwake ?? current.settings.keepAwake,
          localNetworkEnabled: patch.localNetworkEnabled ?? current.settings.localNetworkEnabled,
          tunnelMode: patch.tunnelMode ?? current.settings.tunnelMode,
          connectionChoice: patch.connectionChoice ?? patch.tunnelMode ?? current.settings.connectionChoice,
          ...(patch.namedTunnelHostname !== undefined
            ? patch.namedTunnelHostname.trim().length > 0
              ? { namedTunnelHostname: patch.namedTunnelHostname.trim() }
              : {}
            : current.settings.namedTunnelHostname
              ? { namedTunnelHostname: current.settings.namedTunnelHostname }
              : {}),
        },
      });
    },
    upsertClient(client, replaceClientIds = []) {
      const parsed = storedClient(client);
      if (!parsed) throw new TypeError("invalid Android Remote client");
      const current = read();
      const clients = current.clients.filter(row => row.id !== parsed.id && !replaceClientIds.includes(row.id));
      clients.push(parsed);
      return write({ ...current, clients: clients.slice(-256) });
    },
    updateClientMetadata(id, patch) {
      const current = read();
      let changed = false;
      const clients = current.clients.map(client => {
        if (client.id !== id) return client;
        const label = patch.label?.trim().slice(0, 160);
        const os = patch.os?.trim().slice(0, 64);
        changed = true;
        return {
          ...client,
          ...(label ? { label } : {}),
          ...(os ? { os } : {}),
          ...(patch.installationDigest && /^[a-f0-9]{64}$/.test(patch.installationDigest)
            ? { installationDigest: patch.installationDigest } : {}),
        };
      });
      return changed ? write({ ...current, clients }) : current;
    },
    touchClient(id, patch) {
      const current = read();
      let changed = false;
      const clients = current.clients.map(client => {
        if (client.id !== id) return client;
        changed = true;
        return {
          ...client,
          lastSeenAt: patch.lastSeenAt,
          ...(patch.address ? { address: patch.address } : {}),
        };
      });
      return changed ? write({ ...current, clients }) : current;
    },
    revokeClient(id) {
      const current = read();
      const clients = current.clients.filter(client => client.id !== id);
      if (clients.length === current.clients.length) return { removed: false, state: current };
      return { removed: true, state: write({ ...current, clients }) };
    },
    upsertThreadAlias(alias) {
      const parsed = storedThreadAlias(alias);
      if (!parsed) throw new TypeError("invalid Android Remote task mapping");
      const current = read();
      const threadAliases = current.threadAliases.filter(row =>
        row.remoteThreadId !== parsed.remoteThreadId && row.nativeThreadId !== parsed.nativeThreadId);
      threadAliases.push(parsed);
      return write({ ...current, threadAliases: threadAliases.slice(-1024) });
    },
    removeThreadAlias(remoteThreadId) {
      const current = read();
      const threadAliases = current.threadAliases.filter(row => row.remoteThreadId !== remoteThreadId);
      return threadAliases.length === current.threadAliases.length
        ? current
        : write({ ...current, threadAliases });
    },
    upsertTaskSelection(input) {
      const current = read();
      const existing = current.taskSelections.find(row =>
        row.nativeThreadId === input.nativeThreadId || row.remoteThreadId === input.remoteThreadId);
      if (existing?.updateId === input.updateId) {
        return { applied: false, duplicate: true, stale: false, selection: existing, state: current };
      }
      const expectedRevision = input.expectedRevision;
      if (expectedRevision !== undefined && expectedRevision !== (existing?.revision ?? 0)) {
        if (!existing) throw new TypeError("invalid Android Remote task selection revision");
        return { applied: false, duplicate: false, stale: true, selection: existing, state: current };
      }
      const candidate = storedTaskSelection({
        ...input,
        revision: (existing?.revision ?? 0) + 1,
      });
      if (!candidate) throw new TypeError("invalid Android Remote task selection");
      if (existing && sameTaskSelection(existing, candidate)) {
        return { applied: false, duplicate: true, stale: false, selection: existing, state: current };
      }
      const taskSelections = current.taskSelections.filter(row =>
        row.nativeThreadId !== candidate.nativeThreadId && row.remoteThreadId !== candidate.remoteThreadId);
      taskSelections.push(candidate);
      const state = write({ ...current, taskSelections: taskSelections.slice(-4096) });
      return { applied: true, duplicate: false, stale: false, selection: candidate, state };
    },
    removeTaskSelection(threadId) {
      const current = read();
      const taskSelections = current.taskSelections.filter(row =>
        row.nativeThreadId !== threadId && row.remoteThreadId !== threadId);
      return taskSelections.length === current.taskSelections.length
        ? current
        : write({ ...current, taskSelections });
    },
  };
}
