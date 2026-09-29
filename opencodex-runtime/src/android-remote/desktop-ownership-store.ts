import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, hardenExistingSecret } from "../config";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir } from "../lib/windows-secret-acl";

const STATE_VERSION = 1;
const STATE_MAX_BYTES = 512 * 1024;
const MAX_THREAD_IDS = 4_096;
const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

type DesktopOwnershipState = {
  version: 1;
  desktopOwnedThreadIds: string[];
};

export interface AndroidDesktopOwnershipStore {
  list(): readonly string[];
  remember(threadId: string): void;
  release(threadId: string): void;
}

function parsedState(value: unknown): DesktopOwnershipState {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const values = Array.isArray(row.desktopOwnedThreadIds) ? row.desktopOwnedThreadIds : [];
  const desktopOwnedThreadIds = [...new Set(values.flatMap(value =>
    typeof value === "string" && SAFE_THREAD_ID.test(value.trim()) ? [value.trim()] : [],
  ))].slice(-MAX_THREAD_IDS);
  return { version: STATE_VERSION, desktopOwnedThreadIds };
}

function ensureStateDirectory(root: string): void {
  assertNotRealHomeUnderTest(root);
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch { /* platform may ignore chmod */ }
  if (process.platform === "win32") hardenSecretDir(root, { required: false });
}

export function androidDesktopOwnershipStatePath(root: string): string {
  return join(root, "android-remote-desktop-ownership.json");
}

export function createAndroidDesktopOwnershipStore(
  root?: string,
): AndroidDesktopOwnershipStore {
  let memoryState: DesktopOwnershipState = {
    version: STATE_VERSION,
    desktopOwnedThreadIds: [],
  };
  const path = root ? androidDesktopOwnershipStatePath(root) : null;

  const read = (): DesktopOwnershipState => {
    if (!path) return structuredClone(memoryState);
    try {
      if (!existsSync(path)) return parsedState(null);
      hardenExistingSecret(path);
      if (statSync(path).size > STATE_MAX_BYTES) return parsedState(null);
      return parsedState(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return parsedState(null);
    }
  };

  const write = (state: DesktopOwnershipState): void => {
    const next = parsedState(state);
    if (!path || !root) {
      memoryState = structuredClone(next);
      return;
    }
    ensureStateDirectory(root);
    atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
    try { chmodSync(path, 0o600); } catch { /* platform may ignore chmod */ }
    hardenExistingSecret(path);
  };

  return {
    list: () => read().desktopOwnedThreadIds,
    remember(threadIdValue: string): void {
      const threadId = threadIdValue.trim();
      if (!SAFE_THREAD_ID.test(threadId)) return;
      const current = read().desktopOwnedThreadIds.filter(value => value !== threadId);
      write({
        version: STATE_VERSION,
        desktopOwnedThreadIds: [...current, threadId].slice(-MAX_THREAD_IDS),
      });
    },
    release(threadIdValue: string): void {
      const threadId = threadIdValue.trim();
      if (!threadId) return;
      const current = read().desktopOwnedThreadIds;
      const next = current.filter(value => value !== threadId);
      if (next.length === current.length) return;
      write({ version: STATE_VERSION, desktopOwnedThreadIds: next });
    },
  };
}
