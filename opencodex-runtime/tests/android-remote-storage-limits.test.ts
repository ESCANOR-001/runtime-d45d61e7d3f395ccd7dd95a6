import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { androidRemoteStatePath, createAndroidRemoteStore } from "../src/android-remote/store";
import { androidRemoteMutationStatePath, createAndroidRemoteMutationStore } from "../src/android-remote/mutation-store";
import { androidDesktopOwnershipStatePath, createAndroidDesktopOwnershipStore } from "../src/android-remote/desktop-ownership-store";

const timestamp = "2026-10-11T00:00:00.000Z";
const now = () => Date.parse(timestamp);
function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "android-storage-limits-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("Android durable state byte budgets", () => {
  test("a metadata ledger larger than the old read limit preserves pairing and settings", () => withRoot(root => {
    const store = createAndroidRemoteStore(root);
    const state = store.upsertClient({ id: "phone", label: "Test phone", deviceType: "mobile", os: "android",
      scopes: ["read"], createdAt: timestamp, credentialDigest: "test-digest" });
    state.settings.controlEnabled = true;
    state.taskSelections = Array.from({ length: 2000 }, (_, i) => ({
      nativeThreadId: `native-${i}`, remoteThreadId: `remote-${i}`, providerInstanceId: "codex",
      model: "test-model", options: [{ id: "reasoningEffort", value: "high" }, { id: "serviceTier", value: "fast" }],
      capabilityVersion: "a".repeat(128), revision: 1, source: "android", updateId: `update-${i}`, updatedAt: timestamp,
    }));
    writeFileSync(androidRemoteStatePath(root), JSON.stringify(state));
    store.updateSettings({ keepAwake: true });
    expect(statSync(androidRemoteStatePath(root)).size).toBeGreaterThan(1024 * 1024);
    const restarted = createAndroidRemoteStore(root);
    expect(restarted.read().taskSelections).toHaveLength(2000);
    expect(restarted.read().clients).toEqual(state.clients);
    expect(restarted.read().settings).toMatchObject({ controlEnabled: true, keepAwake: true });
    const before = readFileSync(androidRemoteStatePath(root), "utf8");
    expect(() => store.updateSettings({ namedTunnelHostname: "x".repeat(16 * 1024 * 1024) })).toThrow("storage limit");
    expect(readFileSync(androidRemoteStatePath(root), "utf8")).toBe(before);
  }));

  test("a full mutation journal remains readable after update and restart", () => withRoot(root => {
    const id = (index: number) => `id-${index}-`.padEnd(256, "x");
    const mutations = Array.from({ length: 4096 }, (_, i) => ({
      mutationId: id(i), commandId: id(i), taskId: id(i), nativeThreadId: id(i), messageId: id(i), targetTurnId: id(i),
      kind: "turn-start", status: "uncertain", owner: "desktop", payloadFingerprint: "a".repeat(128),
      visibleMessageFingerprint: "b".repeat(128), createdAt: timestamp, updatedAt: timestamp,
    }));
    const path = androidRemoteMutationStatePath(root);
    writeFileSync(path, JSON.stringify({ version: 1, mutations }));
    expect(statSync(path).size).toBeGreaterThan(4 * 1024 * 1024);
    createAndroidRemoteMutationStore(root, now).update(id(4095), { status: "accepted" });
    const restarted = createAndroidRemoteMutationStore(root, now);
    expect(restarted.list()).toHaveLength(4096);
    expect(restarted.get(id(0))?.status).toBe("uncertain");
    expect(restarted.get(id(4095))?.status).toBe("accepted");
  }));

  test("a full ownership ledger preserves long thread IDs across writes", () => withRoot(root => {
    const desktopOwnedThreadIds = Array.from({ length: 4096 }, (_, i) => `thread-${i}-`.padEnd(256, "x"));
    const path = androidDesktopOwnershipStatePath(root);
    writeFileSync(path, JSON.stringify({ version: 1, desktopOwnedThreadIds }));
    expect(statSync(path).size).toBeGreaterThan(512 * 1024);
    createAndroidDesktopOwnershipStore(root).remember(desktopOwnedThreadIds[0]!);
    expect(createAndroidDesktopOwnershipStore(root).list()).toHaveLength(4096);
    expect(new Set(createAndroidDesktopOwnershipStore(root).list())).toEqual(new Set(desktopOwnedThreadIds));
  }));

  test.each(["settings", "mutations", "ownership"])("an oversized %s file is never replaced with empty defaults", kind => withRoot(root => {
    const path = kind === "settings" ? androidRemoteStatePath(root)
      : kind === "mutations" ? androidRemoteMutationStatePath(root) : androidDesktopOwnershipStatePath(root);
    const limit = (kind === "ownership" ? 2 : 16) * 1024 * 1024;
    const original = `{}${" ".repeat(limit)}`;
    writeFileSync(path, original);
    const write = () => {
      if (kind === "settings") createAndroidRemoteStore(root).updateSettings({ keepAwake: true });
      else if (kind === "ownership") createAndroidDesktopOwnershipStore(root).remember("new-thread");
      else createAndroidRemoteMutationStore(root).put({ mutationId: "new", commandId: "new", taskId: "task",
        kind: "turn-start", status: "pending", payloadFingerprint: "fingerprint" });
    };
    expect(write).toThrow("storage limit");
    expect(readFileSync(path, "utf8")).toBe(original);
  }));
});
