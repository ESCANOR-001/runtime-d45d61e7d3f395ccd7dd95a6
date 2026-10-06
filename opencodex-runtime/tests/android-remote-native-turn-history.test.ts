import { describe, expect, test } from "bun:test";
import type { AndroidCodexClient } from "../src/android-remote/codex-app-server";
import { decodeNativeHistoryCursor, nativeHistoryCursor, nativeHistoryIsUnsupported, nativeHistoryNeedsSessionRecovery, readNativeTurnsPage, windowsNativeHistoryNeedsSessionRecovery } from "../src/android-remote/native-turn-history";
import { projectCodexThreadDetail } from "../src/android-remote/projection";
import { createProjectedThreadStreamState, projectedThreadBoundedSnapshot, projectedThreadOlderPage, projectedThreadRecentPage } from "../src/android-remote/thread-stream";

describe("complete bounded Android history", () => {
  test("recognizes the exact lineage failure for recovery on every operating system", () => {
    expect(nativeHistoryNeedsSessionRecovery(new Error("invalid paginated history lineage for task: source rollout belongs to another thread"))).toBe(true);
    expect(nativeHistoryNeedsSessionRecovery({ message: "invalid paginated history lineage: source rollout belongs to another thread" })).toBe(true);
    for (const unrelated of [null, {}, new Error("request timed out"), new Error("invalid paginated history lineage: missing file")]) {
      expect(nativeHistoryNeedsSessionRecovery(unrelated)).toBe(false);
    }
  });
  test("recovers only the specific Windows lineage failure without changing other platforms", () => {
    const error = new Error("invalid paginated history lineage for task: source rollout belongs to another thread");
    expect(windowsNativeHistoryNeedsSessionRecovery(error, "win32")).toBe(true);
    expect(windowsNativeHistoryNeedsSessionRecovery({ code: -32600, message: error.message }, "win32")).toBe(true);
    expect(nativeHistoryIsUnsupported(error)).toBe(false);
    for (const platform of ["linux", "darwin"] as const) {
      expect(windowsNativeHistoryNeedsSessionRecovery(error, platform)).toBe(false);
    }
    for (const unrelated of [null, {}, new Error("request timed out"), new Error("invalid paginated history lineage: missing file"), { code: -32601 }]) {
      expect(windowsNativeHistoryNeedsSessionRecovery(unrelated, "win32")).toBe(false);
    }
  });

  test("requests full recent items and puts retained work into the first mobile snapshot", async () => {
    const calls: unknown[] = [];
    const turns = [{
      id: "recent", status: "completed", startedAt: 100, completedAt: 102,
      items: [
        { id: "user", type: "userMessage", content: [{ type: "text", text: "Fix it" }] },
        { id: "reasoning", type: "reasoning", summary: ["Checking the parser"], content: ["private"] },
        { id: "command", type: "commandExecution", command: "echo test", aggregatedOutput: "x".repeat(500_000), status: "completed" },
        { id: "search", type: "webSearch", query: "parser" },
        { id: "patch", type: "fileChange", status: "completed", changes: [{ path: "src/parser.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new" }] },
        { id: "answer", type: "agentMessage", text: "Fixed", phase: "final_answer" },
      ],
    }];
    const client = {
      request: async (_method: string, params: { itemsView?: string }) => {
        calls.push(params);
        return { data: params.itemsView === "full" ? turns : turns.map(turn => ({ ...turn, items: turn.items.filter(item => /Message$/u.test(item.type)) })), nextCursor: "older-native-page" };
      },
    } as unknown as AndroidCodexClient;
    const page = await readNativeTurnsPage(client, "task");
    const detail = projectCodexThreadDetail({
      id: "task", cwd: "/workspace", turns: page.turns,
      historyPage: { olderCursor: nativeHistoryCursor("task", page.nextCursor) },
    }, 1, { compactCompletedWork: true });
    const snapshot = projectedThreadBoundedSnapshot(createProjectedThreadStreamState(detail)) as any;
    expect(calls).toEqual([{ threadId: "task", limit: 1, sortDirection: "desc", itemsView: "full" }]);
    expect(snapshot.snapshot.thread.activities.map((item: any) => item.id)).toEqual(["reasoning", "command", "search", "patch"]);
    expect(snapshot.snapshot.thread.messages.map((item: any) => item.id)).toEqual(["user", "answer"]);
    expect(JSON.stringify(snapshot)).not.toContain("private");
    expect(JSON.stringify(snapshot).length).toBeLessThan(10_000);
    expect(decodeNativeHistoryCursor("task", snapshot.snapshot.historyPage.olderCursor)).toBe("older-native-page");

    turns[0]!.status = "inProgress";
    const live = projectCodexThreadDetail({ id: "task", turns }, 2, { compactCompletedWork: true }) as any;
    expect(live.thread.activities.map((item: any) => item.id)).toContain("command");
    expect(live.thread.activities.map((item: any) => item.id)).toContain("search");
  });

  test("continues through local blocks into the native cursor without replacing live state", () => {
    const sourceCursor = nativeHistoryCursor("task", "next-page");
    const thread = {
      id: "task", activities: [], proposedPlans: [], historyPage: { olderCursor: sourceCursor },
      messages: Array.from({ length: 120 }, (_, index) => ({ id: `m${index}`, turnId: `t${index}`, sequence: index, role: "user", createdAt: new Date(index * 1000).toISOString() })),
    };
    const state = createProjectedThreadStreamState({ thread });
    const recent = projectedThreadRecentPage(state.detail);
    expect(recent.messages).toHaveLength(96);
    const older = projectedThreadOlderPage(state, recent.pageInfo.olderCursor!);
    expect(older.messages).toHaveLength(24);
    expect(older.pageInfo).toEqual({ hasOlder: true, olderCursor: sourceCursor });
    expect(state.sequence).toBe(1);
    expect(state.replay).toEqual([]);
  });

  test("passes the native continuation and preserves its oldest-first order", async () => {
    const client = { request: async (_method: string, params: unknown) => {
      expect(params).toMatchObject({ cursor: "next-page", itemsView: "full", limit: 1 });
      return { data: [{ id: "newer" }, { id: "older" }], nextCursor: null };
    } } as unknown as AndroidCodexClient;
    expect(await readNativeTurnsPage(client, "task", "next-page")).toEqual({ turns: [{ id: "older" }, { id: "newer" }], nextCursor: null });
    expect(() => decodeNativeHistoryCursor("other-task", nativeHistoryCursor("task", "cursor")!)).toThrow();
    expect(nativeHistoryIsUnsupported(new Error("request timed out"))).toBe(false);
    expect(nativeHistoryIsUnsupported({ code: -32601 })).toBe(true);
  });
});
