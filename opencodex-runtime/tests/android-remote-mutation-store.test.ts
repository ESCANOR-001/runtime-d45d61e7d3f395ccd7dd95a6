import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  androidRemoteMutationStatePath,
  createAndroidRemoteMutationStore,
} from "../src/android-remote/mutation-store";

describe("Android Remote mutation store", () => {
  test("persists only delivery metadata with owner-only permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-android-mutations-"));
    try {
      const store = createAndroidRemoteMutationStore(
        root,
        () => Date.parse("2026-08-22T12:00:00.000Z"),
      );
      store.put({
        mutationId: "command:command-1",
        commandId: "command-1",
        taskId: "thread-1",
        nativeThreadId: "thread-1",
        messageId: "message-1",
        kind: "turn-start",
        payloadFingerprint: "payload-fingerprint",
        visibleMessageFingerprint: "visible-fingerprint",
        status: "pending",
      });
      store.update("command:command-1", {
        owner: "desktop",
        status: "accepted",
        resultSequence: 7,
      });

      const restarted = createAndroidRemoteMutationStore(root);
      expect(restarted.get("command:command-1")).toMatchObject({
        commandId: "command-1",
        taskId: "thread-1",
        messageId: "message-1",
        owner: "desktop",
        status: "accepted",
        resultSequence: 7,
      });
      const path = androidRemoteMutationStatePath(root);
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      const serialized = readFileSync(path, "utf8");
      expect(serialized).not.toContain("secret prompt");
      expect(serialized).not.toContain("apiKey");
      expect(serialized).not.toContain("attachment");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a command id reused with a different fingerprint", () => {
    const store = createAndroidRemoteMutationStore();
    store.put({
      mutationId: "command:command-1",
      commandId: "command-1",
      taskId: "thread-1",
      kind: "turn-start",
      payloadFingerprint: "first",
      status: "pending",
    });
    expect(() => store.put({
      mutationId: "command:command-1",
      commandId: "command-1",
      taskId: "thread-1",
      kind: "turn-start",
      payloadFingerprint: "second",
      status: "pending",
    })).toThrow("reused with different content");
  });
});
