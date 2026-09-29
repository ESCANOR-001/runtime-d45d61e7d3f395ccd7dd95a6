import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteFile,
  hardenExistingSecret,
} from "../config";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";

const MUTATION_STATE_VERSION = 1;
const MUTATION_STATE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_MUTATIONS = 4_096;
const MUTATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const SAFE_ID = /^[a-zA-Z0-9._:/-]{1,256}$/;

export type AndroidRemoteMutationKind =
  | "turn-start"
  | "prompt-edit"
  | "queue-steer";

export type AndroidRemoteMutationStatus =
  | "pending"
  | "uncertain"
  | "accepted"
  | "failed";

export type AndroidRemoteMutationOwner =
  | "desktop"
  | "private"
  | "queue";

/**
 * Durable delivery metadata for one Android mutation.
 *
 * This record intentionally contains no prompt, attachment, credential, API
 * key, or provider configuration. Fingerprints are one-way SHA-256 values used
 * only to reject command-id collisions and reconcile legacy prompt edits.
 */
export type AndroidRemoteMutation = {
  mutationId: string;
  commandId: string;
  taskId: string;
  nativeThreadId?: string;
  messageId?: string;
  kind: AndroidRemoteMutationKind;
  payloadFingerprint: string;
  visibleMessageFingerprint?: string;
  targetTurnId?: string;
  status: AndroidRemoteMutationStatus;
  owner?: AndroidRemoteMutationOwner;
  resultSequence?: number;
  createdAt: string;
  updatedAt: string;
};

export type AndroidRemoteMutationWrite = Omit<
  AndroidRemoteMutation,
  "createdAt" | "updatedAt"
> & {
  createdAt?: string;
  updatedAt?: string;
};

type AndroidRemoteMutationState = {
  version: 1;
  mutations: AndroidRemoteMutation[];
};

export interface AndroidRemoteMutationStore {
  get(mutationId: string): AndroidRemoteMutation | null;
  list(): readonly AndroidRemoteMutation[];
  put(mutation: AndroidRemoteMutationWrite): AndroidRemoteMutation;
  update(
    mutationId: string,
    patch: Partial<Omit<AndroidRemoteMutation, "mutationId" | "commandId" | "createdAt">>,
  ): AndroidRemoteMutation | null;
}

function stringValue(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function mutationKind(value: unknown): AndroidRemoteMutationKind | null {
  return value === "turn-start" || value === "prompt-edit" || value === "queue-steer"
    ? value
    : null;
}

function mutationStatus(value: unknown): AndroidRemoteMutationStatus | null {
  return value === "pending"
    || value === "uncertain"
    || value === "accepted"
    || value === "failed"
    ? value
    : null;
}

function mutationOwner(value: unknown): AndroidRemoteMutationOwner | null {
  return value === "desktop" || value === "private" || value === "queue"
    ? value
    : null;
}

function storedMutation(value: unknown): AndroidRemoteMutation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const mutationId = stringValue(row.mutationId, 256);
  const commandId = stringValue(row.commandId, 256);
  const taskId = stringValue(row.taskId, 256);
  const nativeThreadId = stringValue(row.nativeThreadId, 256) ?? undefined;
  const messageId = stringValue(row.messageId, 256) ?? undefined;
  const kind = mutationKind(row.kind);
  const payloadFingerprint = stringValue(row.payloadFingerprint, 128);
  const visibleMessageFingerprint =
    stringValue(row.visibleMessageFingerprint, 128) ?? undefined;
  const targetTurnId = stringValue(row.targetTurnId, 256) ?? undefined;
  const status = mutationStatus(row.status);
  const owner = mutationOwner(row.owner) ?? undefined;
  const createdAt = stringValue(row.createdAt, 64);
  const updatedAt = stringValue(row.updatedAt, 64);
  const resultSequence =
    typeof row.resultSequence === "number"
    && Number.isSafeInteger(row.resultSequence)
    && row.resultSequence >= 0
      ? row.resultSequence
      : undefined;
  if (
    !mutationId
    || !commandId
    || !taskId
    || !kind
    || !payloadFingerprint
    || !status
    || !createdAt
    || !updatedAt
    || !SAFE_ID.test(mutationId)
    || !SAFE_ID.test(commandId)
    || !SAFE_ID.test(taskId)
  ) {
    return null;
  }
  if (
    (nativeThreadId && !SAFE_ID.test(nativeThreadId))
    || (messageId && !SAFE_ID.test(messageId))
    || (targetTurnId && !SAFE_ID.test(targetTurnId))
  ) {
    return null;
  }
  return {
    mutationId,
    commandId,
    taskId,
    ...(nativeThreadId ? { nativeThreadId } : {}),
    ...(messageId ? { messageId } : {}),
    kind,
    payloadFingerprint,
    ...(visibleMessageFingerprint ? { visibleMessageFingerprint } : {}),
    ...(targetTurnId ? { targetTurnId } : {}),
    status,
    ...(owner ? { owner } : {}),
    ...(resultSequence !== undefined ? { resultSequence } : {}),
    createdAt,
    updatedAt,
  };
}

function defaultState(): AndroidRemoteMutationState {
  return { version: MUTATION_STATE_VERSION, mutations: [] };
}

function parseState(value: unknown): AndroidRemoteMutationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultState();
  const row = value as Record<string, unknown>;
  const mutations = Array.isArray(row.mutations)
    ? row.mutations.flatMap(value => {
        const parsed = storedMutation(value);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    version: MUTATION_STATE_VERSION,
    mutations: mutations.slice(-MAX_MUTATIONS),
  };
}

function ensureStateDirectory(root: string): void {
  assertNotRealHomeUnderTest(root);
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch { /* platform may ignore chmod */ }
  if (process.platform === "win32") hardenSecretDir(root, { required: false });
}

function pruneMutations(
  mutations: readonly AndroidRemoteMutation[],
  nowMs: number,
): AndroidRemoteMutation[] {
  const retained = mutations.filter(mutation => {
    const updatedAt = Date.parse(mutation.updatedAt);
    return !Number.isFinite(updatedAt) || nowMs - updatedAt <= MUTATION_RETENTION_MS;
  });
  return retained.slice(-MAX_MUTATIONS);
}

export function androidRemoteMutationStatePath(root: string): string {
  return join(root, "android-remote-mutations.json");
}

export function createAndroidRemoteMutationStore(
  root?: string,
  now: () => number = Date.now,
): AndroidRemoteMutationStore {
  let memoryState = defaultState();
  const path = root ? androidRemoteMutationStatePath(root) : null;

  const read = (): AndroidRemoteMutationState => {
    if (!path) return structuredClone(memoryState);
    try {
      if (!existsSync(path)) return defaultState();
      hardenExistingSecret(path);
      if (statSync(path).size > MUTATION_STATE_MAX_BYTES) return defaultState();
      return parseState(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return defaultState();
    }
  };

  const write = (state: AndroidRemoteMutationState): AndroidRemoteMutationState => {
    const next = {
      version: MUTATION_STATE_VERSION,
      mutations: pruneMutations(state.mutations, now()),
    } satisfies AndroidRemoteMutationState;
    if (!path || !root) {
      memoryState = structuredClone(next);
      return structuredClone(next);
    }
    ensureStateDirectory(root);
    atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  };

  return {
    get(mutationId) {
      return read().mutations.find(mutation => mutation.mutationId === mutationId) ?? null;
    },
    list() {
      return read().mutations;
    },
    put(input) {
      const parsed = storedMutation({
        ...input,
        createdAt: input.createdAt ?? new Date(now()).toISOString(),
        updatedAt: input.updatedAt ?? new Date(now()).toISOString(),
      });
      if (!parsed) throw new TypeError("invalid Android Remote mutation");
      const current = read();
      const existing = current.mutations.find(
        mutation => mutation.mutationId === parsed.mutationId,
      );
      if (
        existing
        && (
          existing.commandId !== parsed.commandId
          || existing.payloadFingerprint !== parsed.payloadFingerprint
        )
      ) {
        throw new Error("Android command id was reused with different content");
      }
      const next = [
        ...current.mutations.filter(mutation => mutation.mutationId !== parsed.mutationId),
        existing ?? parsed,
      ];
      return write({ version: MUTATION_STATE_VERSION, mutations: next })
        .mutations.find(mutation => mutation.mutationId === parsed.mutationId)!;
    },
    update(mutationId, patch) {
      const current = read();
      const existing = current.mutations.find(mutation => mutation.mutationId === mutationId);
      if (!existing) return null;
      const parsed = storedMutation({
        ...existing,
        ...patch,
        mutationId: existing.mutationId,
        commandId: existing.commandId,
        createdAt: existing.createdAt,
        updatedAt: new Date(now()).toISOString(),
      });
      if (!parsed) throw new TypeError("invalid Android Remote mutation update");
      return write({
        version: MUTATION_STATE_VERSION,
        mutations: [
          ...current.mutations.filter(mutation => mutation.mutationId !== mutationId),
          parsed,
        ],
      }).mutations.find(mutation => mutation.mutationId === mutationId)!;
    },
  };
}
