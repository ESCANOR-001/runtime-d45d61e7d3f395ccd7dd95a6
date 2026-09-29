import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteFile,
  hardenExistingSecret,
} from "../config";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";

const QUEUED_TURN_STATE_VERSION = 1;
const QUEUED_TURN_STATE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_TURNS = 32;
const MAX_COMMAND_BYTES = 256 * 1024;
const MAX_PROMPT_LENGTH = 120_000;
const MAX_STAGED_ATTACHMENTS = 8;
const SAFE_ID = /^[a-zA-Z0-9._:/-]{1,256}$/;

type JsonRecord = Record<string, unknown>;

export type PersistedAndroidQueuedAttachments = {
  codexInputs: Array<{ type: "localImage"; path: string }>;
  referencedFiles: string[];
  stagedPaths: string[];
};

/**
 * Accepted queue entries are persisted separately from the mutation journal.
 *
 * The mutation journal deliberately contains only fingerprints. A queued
 * command is different: Remodex has acknowledged that it owns the prompt
 * until the active turn finishes, so losing the payload during a gateway
 * lifecycle transition would silently discard accepted user work.
 *
 * Raw upload bytes are never written here. The gateway stages them first and
 * stores only protected PC-local paths under the existing Android attachment
 * directory.
 */
export type PersistedAndroidQueuedTurn = {
  taskId: string;
  clientId: string;
  messageId: string;
  command: JsonRecord;
  displayText: string;
  stagedAttachments: PersistedAndroidQueuedAttachments;
  createdAt: string;
  updatedAt: string;
};

type AndroidQueuedTurnState = {
  version: 1;
  turns: PersistedAndroidQueuedTurn[];
};

export interface AndroidRemoteQueuedTurnStore {
  list(): readonly PersistedAndroidQueuedTurn[];
  replace(turns: readonly PersistedAndroidQueuedTurn[]): void;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function isoTimestamp(value: unknown): string | null {
  const normalized = stringValue(value, 64);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

function storedPaths(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_STAGED_ATTACHMENTS) return null;
  const paths = value.map(path => stringValue(path, 32 * 1024));
  return paths.every((path): path is string => path !== null) ? paths : null;
}

function storedAttachments(value: unknown): PersistedAndroidQueuedAttachments | null {
  const row = record(value);
  if (!row) return null;
  const referencedFiles = storedPaths(row.referencedFiles);
  const stagedPaths = storedPaths(row.stagedPaths);
  if (!referencedFiles || !stagedPaths) return null;
  if (!Array.isArray(row.codexInputs) || row.codexInputs.length > MAX_STAGED_ATTACHMENTS) {
    return null;
  }
  const codexInputs = row.codexInputs.flatMap(value => {
    const input = record(value);
    const path = stringValue(input?.path, 32 * 1024);
    return input?.type === "localImage" && path
      ? [{ type: "localImage" as const, path }]
      : [];
  });
  if (codexInputs.length !== row.codexInputs.length) return null;
  const staged = new Set(stagedPaths);
  if (
    codexInputs.some(input => !staged.has(input.path))
    || referencedFiles.some(path => !staged.has(path))
  ) {
    return null;
  }
  return { codexInputs, referencedFiles, stagedPaths };
}

function storedTurn(value: unknown): PersistedAndroidQueuedTurn | null {
  const row = record(value);
  if (!row) return null;
  const taskId = stringValue(row.taskId, 256);
  const clientId = stringValue(row.clientId, 256);
  const messageId = stringValue(row.messageId, 256);
  const command = record(row.command);
  const displayText =
    typeof row.displayText === "string" && row.displayText.length <= MAX_PROMPT_LENGTH
      ? row.displayText
      : null;
  const stagedAttachments = storedAttachments(row.stagedAttachments);
  const createdAt = isoTimestamp(row.createdAt);
  const updatedAt = isoTimestamp(row.updatedAt);
  const message = record(command?.message);
  const commandText =
    typeof message?.text === "string" && message.text.length <= MAX_PROMPT_LENGTH
      ? message.text
      : null;
  let commandBytes = Number.POSITIVE_INFINITY;
  try {
    commandBytes = Buffer.byteLength(JSON.stringify(command), "utf8");
  } catch {
    // Invalid recursive data is rejected below.
  }
  if (
    !taskId
    || !clientId
    || !messageId
    || !command
    || displayText === null
    || !stagedAttachments
    || !createdAt
    || !updatedAt
    || !SAFE_ID.test(taskId)
    || !SAFE_ID.test(clientId)
    || !SAFE_ID.test(messageId)
    || command.type !== "thread.turn.start"
    || command.threadId !== taskId
    || message?.messageId !== messageId
    || message.role !== "user"
    || commandText === null
    || !Array.isArray(message.attachments)
    || message.attachments.length !== 0
    || commandBytes > MAX_COMMAND_BYTES
  ) {
    return null;
  }
  return {
    taskId,
    clientId,
    messageId,
    command,
    displayText,
    stagedAttachments,
    createdAt,
    updatedAt,
  };
}

function defaultState(): AndroidQueuedTurnState {
  return { version: QUEUED_TURN_STATE_VERSION, turns: [] };
}

function parseState(value: unknown): AndroidQueuedTurnState {
  const row = record(value);
  const turns = Array.isArray(row?.turns)
    ? row.turns.flatMap(value => {
        const parsed = storedTurn(value);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    version: QUEUED_TURN_STATE_VERSION,
    turns: turns.slice(-MAX_QUEUED_TURNS),
  };
}

function ensureStateDirectory(root: string): void {
  assertNotRealHomeUnderTest(root);
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch { /* platform may ignore chmod */ }
  if (process.platform === "win32") hardenSecretDir(root, { required: false });
}

export function androidRemoteQueuedTurnStatePath(root: string): string {
  return join(root, "android-remote-queued-turns.json");
}

export function createAndroidRemoteQueuedTurnStore(
  root?: string,
): AndroidRemoteQueuedTurnStore {
  let memoryState = defaultState();
  const path = root ? androidRemoteQueuedTurnStatePath(root) : null;

  const read = (): AndroidQueuedTurnState => {
    if (!path) return structuredClone(memoryState);
    try {
      if (!existsSync(path)) return defaultState();
      hardenExistingSecret(path);
      if (statSync(path).size > QUEUED_TURN_STATE_MAX_BYTES) return defaultState();
      return parseState(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return defaultState();
    }
  };

  const write = (turns: readonly PersistedAndroidQueuedTurn[]): void => {
    const parsed = turns.flatMap(value => {
      const turn = storedTurn(value);
      return turn ? [turn] : [];
    });
    if (parsed.length !== turns.length || parsed.length > MAX_QUEUED_TURNS) {
      throw new TypeError("invalid Android Remote queued turn state");
    }
    const next = {
      version: QUEUED_TURN_STATE_VERSION,
      turns: parsed,
    } satisfies AndroidQueuedTurnState;
    if (!path || !root) {
      memoryState = structuredClone(next);
      return;
    }
    ensureStateDirectory(root);
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > QUEUED_TURN_STATE_MAX_BYTES) {
      throw new RangeError("Android Remote queued turn state exceeds its storage limit");
    }
    atomicWriteFile(path, serialized);
  };

  return {
    list() {
      return read().turns;
    },
    replace(turns) {
      write(turns);
    },
  };
}
