import { describe, expect, test } from "bun:test";
import {
  advanceProjectedThreadStream,
  createProjectedThreadStreamState,
  mergeBoundedThreadDetail,
  projectedThreadBoundedSnapshot,
  projectedThreadOlderPage,
  readProjectedOlderPage,
  replayProjectedThreadAfter,
} from "../src/android-remote/thread-stream";

type JsonRecord = Record<string, unknown>;

describe("history cursor recovery", () => {
  test("loads an older boundary after the live stream advances to a different bounded window", async () => {
    const messages = Array.from({ length: 240 }, (_, index) => message(`m-${index}`, `Message ${index}`, index));
    const full = detail({ messages });
    const original = createProjectedThreadStreamState(full);
    const snapshot = projectedThreadBoundedSnapshot(original) as any;
    const cursor = snapshot.snapshot.historyPage.olderCursor;
    const expected = projectedThreadOlderPage(original, cursor);
    const recent = createProjectedThreadStreamState(detail({ messages: messages.slice(-8) }));
    let reads = 0;
    const page = await readProjectedOlderPage(recent, cursor, async () => { reads += 1; return full; });
    expect(page).toEqual(expected);
    expect(reads).toBe(1);
    expect((recent.detail.thread as JsonRecord).messages).toEqual(messages.slice(-8));
    await expect(readProjectedOlderPage(recent, "invalid", async () => { reads += 1; return full; })).rejects.toThrow("invalid");
    expect(reads).toBe(1);
  });

  test("does not resurrect a boundary removed from saved history", async () => {
    const full = detail({ messages: Array.from({ length: 120 }, (_, index) => message(`m-${index}`, "Text", index)) });
    const snapshot = projectedThreadBoundedSnapshot(createProjectedThreadStreamState(full)) as any;
    const empty = createProjectedThreadStreamState(detail());
    await expect(readProjectedOlderPage(empty, snapshot.snapshot.historyPage.olderCursor, async () => detail())).rejects.toThrow("page boundary");
  });
});

function message(id: string, text: string, sequence: number, streaming = false): JsonRecord {
  const createdAt = new Date(Date.parse("2026-08-11T00:00:00.000Z") + sequence * 1_000).toISOString();
  return {
    id,
    role: sequence === 0 ? "user" : "assistant",
    text,
    attachments: [],
    turnId: `turn-${Math.floor(sequence / 4)}`,
    sequence,
    streaming,
    createdAt,
    updatedAt: createdAt,
  };
}

function activity(id: string, sequence: number, status: string): JsonRecord {
  return {
    id,
    tone: "tool",
    kind: "commandExecution",
    summary: "Run tests",
    payload: { status },
    turnId: "turn-0",
    sequence,
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

function statusActivity(): JsonRecord {
  return {
    id: "context-window.updated-thread-1",
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: { usedTokens: 45_000, maxTokens: 258_000 },
    turnId: null,
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

function providerUsageActivity(): JsonRecord {
  return {
    id: "provider-usage-thread-1",
    tone: "info",
    kind: "provider.usage.updated",
    summary: "Provider usage updated",
    payload: { providerLabel: "OpenAI", windows: [{ label: "Weekly", remainingPercent: 71 }] },
    turnId: null,
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

function detail(input: {
  messages?: JsonRecord[];
  activities?: JsonRecord[];
  sessionStatus?: string;
  readSequence?: number;
} = {}): JsonRecord {
  const updatedAt = "2026-08-11T00:10:00.000Z";
  return {
    snapshotSequence: input.readSequence ?? 1,
    thread: {
      id: "thread-1",
      projectId: "project-1",
      title: "Task",
      modelSelection: { instanceId: "openai", model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "C:/workspace",
      latestTurn: null,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt,
      archivedAt: null,
      deletedAt: null,
      messages: input.messages ?? [],
      proposedPlans: [],
      activities: input.activities ?? [],
      checkpoints: [],
      session: {
        threadId: "thread-1",
        status: input.sessionStatus ?? "idle",
        providerName: "openai",
        runtimeMode: "full-access",
        activeTurnId: input.sessionStatus === "running" ? "turn-0" : null,
        lastError: null,
        updatedAt,
      },
    },
  };
}

describe("Android Remote projected task stream", () => {
  test("keeps the whole active turn and every queued follow-up in the one-turn bootstrap", () => {
    const messages = [
      { ...message("older", "Previous prompt", 0), turnId: "old" },
      { ...message("prompt", "Current prompt", 1), role: "user", turnId: "turn-0" },
      { ...message("steer", "Steering prompt", 2), role: "user", turnId: "turn-0" },
      { ...message("answer", "Working", 3, true), turnId: "turn-0" },
      ...Array.from({ length: 12 }, (_, index) => ({ ...message(`queue-${index}`, "Follow up", index + 4),
        role: "user", phase: "queued", turnId: null, queuePosition: index })),
    ];
    const state = createProjectedThreadStreamState(detail({ messages, sessionStatus: "running" }));
    const snapshot = projectedThreadBoundedSnapshot(state, 1) as any;
    expect(snapshot.snapshot.thread.messages.map((row: JsonRecord) => row.id)).toEqual(messages.slice(1).map(row => row.id));
    expect(projectedThreadOlderPage(state, snapshot.snapshot.historyPage.olderCursor).messages.map(row => row.id)).toEqual(["older"]);
  });

  test("queued messages older than a newly delivered steer remain visible", () => {
    const messages = [
      { ...message("queued", "Next task", 1), role: "user", phase: "queued", turnId: null, queuePosition: 0 },
      { ...message("steer", "Change direction", 2), role: "user", turnId: "turn-0" },
    ];
    const state = createProjectedThreadStreamState(detail({ messages, sessionStatus: "running" }));
    const snapshot = projectedThreadBoundedSnapshot(state, 1) as any;
    expect(snapshot.snapshot.thread.messages.map((row: JsonRecord) => row.id)).toEqual(["queued", "steer"]);
    expect(snapshot.snapshot.historyPage).toEqual({ hasOlder: false, olderCursor: null });
  });

  test("pages orphaned turns without splitting a large work log or counting question replies", () => {
    const messages = Array.from({ length: 15 }, (_, index) => ({
      ...message(`orphan-${index}`, "Recovered answer", index), role: "assistant", turnId: `orphan-${index}`,
    }));
    messages.push(...Array.from({ length: 150 }, (_, index) => ({
      ...message(`work-${index}`, "Work", index + 15), role: "assistant", turnId: "live",
    })));
    messages.push({ ...message("reply", "<send_user_message_question_reply>[]</send_user_message_question_reply>", 165), role: "user", turnId: "live" });
    const state = createProjectedThreadStreamState(detail({ messages }));
    const first = projectedThreadBoundedSnapshot(state) as any;
    expect(first.snapshot.thread.messages.some((row: JsonRecord) => row.id === "orphan-0")).toBe(false);
    const older = projectedThreadOlderPage(state, first.snapshot.historyPage.olderCursor);
    expect(older.messages.some(row => row.id === "orphan-0")).toBe(true);
    expect(older.messages.some(row => row.turnId === "live")).toBe(false);
    expect(older.pageInfo.hasOlder).toBe(false);
  });

  test("retains current limits and context outside the recent prompt window", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      ...message(`prompt-${index}`, `Prompt ${index}`, index + 1), role: "user",
    }));
    const status = [statusActivity(), providerUsageActivity()];
    const state = createProjectedThreadStreamState(detail({ messages, activities: status }));
    for (const limit of [1, 10]) {
      const snapshot = projectedThreadBoundedSnapshot(state, limit) as any;
      expect(snapshot.snapshot.thread.messages).toHaveLength(limit);
      expect(snapshot.snapshot.thread.activities).toEqual(status);
      const older = projectedThreadOlderPage(state, snapshot.snapshot.historyPage.olderCursor);
      expect(older.activities).toEqual([]);
    }
  });

  test("status alone never creates older chat history and latest clearing wins", () => {
    const previous = providerUsageActivity();
    const cleared = { ...previous, id: "latest-status", createdAt: "2026-08-11T00:05:00.000Z",
      payload: { providerLabel: "OpenAI", windows: [] } };
    const state = createProjectedThreadStreamState(detail({ activities: [cleared, previous] }));
    const snapshot = projectedThreadBoundedSnapshot(state, 1) as any;
    expect(snapshot.snapshot.thread.activities).toEqual([cleared]);
    expect(snapshot.snapshot.historyPage).toEqual({ hasOlder: false, olderCursor: null });
  });

  test("history retention does not revive status missing from the authoritative read", () => {
    const previous = detail({ messages: [message("old", "Earlier", 1)], activities: [providerUsageActivity()] });
    const next = detail({ messages: [message("new", "Latest", 20)] });
    (next.thread as JsonRecord).historyPage = { olderCursor: "older-history" };
    const merged = mergeBoundedThreadDetail(previous, next);
    expect((merged.thread as JsonRecord).messages).toHaveLength(2);
    expect((merged.thread as JsonRecord).activities).toEqual([]);
  });

  test("suppresses a read-counter-only refresh", () => {
    const state = createProjectedThreadStreamState(detail({ readSequence: 4 }));
    const advanced = advanceProjectedThreadStream(state, detail({ readSequence: 99 }));
    expect(advanced.items).toEqual([]);
    expect(advanced.state.sequence).toBe(1);
  });

  test("suppresses a task timestamp refresh when no visible field changed", () => {
    const before = detail({ messages: [message("m-1", "Hello", 1)] });
    const after = structuredClone(before);
    (after.thread as JsonRecord).updatedAt = "2026-08-11T00:11:00.000Z";
    const advanced = advanceProjectedThreadStream(createProjectedThreadStreamState(before), after);
    expect(advanced.items).toEqual([]);
    expect(advanced.usedSnapshot).toBe(false);
    expect(advanced.state.sequence).toBe(1);
  });

  test("sends only the assistant suffix and replays it by sequence", () => {
    const before = detail({ messages: [message("m-1", "Hello", 1, true)] });
    const after = detail({ messages: [message("m-1", "Hello world", 1, true)] });
    const advanced = advanceProjectedThreadStream(createProjectedThreadStreamState(before), after);
    expect(advanced.usedSnapshot).toBe(false);
    expect(advanced.items).toHaveLength(1);
    expect(advanced.items[0]).toMatchObject({
      kind: "event",
      event: {
        sequence: 2,
        type: "thread.message-sent",
        payload: { messageId: "m-1", text: " world", streaming: true, sequence: 1 },
      },
    });
    expect(replayProjectedThreadAfter(advanced.state, 1)).toEqual(advanced.items);
    expect(replayProjectedThreadAfter(advanced.state, 0)).toBeNull();
  });

  test("keeps the assistant phase on the small live message event", () => {
    const commentary = { ...message("m-1", "Still working", 1), phase: "commentary" };
    const advanced = advanceProjectedThreadStream(
      createProjectedThreadStreamState(detail()),
      detail({ messages: [commentary] }),
    );
    expect(advanced.usedSnapshot).toBe(false);
    expect(advanced.items[0]).toMatchObject({
      event: {
        type: "thread.message-sent",
        payload: { messageId: "m-1", phase: "commentary" },
      },
    });
  });

  test("updates one stable tool row instead of appending a duplicate", () => {
    const before = detail({ activities: [activity("tool-1", 2, "inProgress")] });
    const after = detail({ activities: [activity("tool-1", 2, "completed")] });
    const advanced = advanceProjectedThreadStream(createProjectedThreadStreamState(before), after);
    expect(advanced.items).toHaveLength(1);
    expect(advanced.items[0]).toMatchObject({
      event: {
        type: "thread.activity-appended",
        payload: { activity: { id: "tool-1", sequence: 2, payload: { status: "completed" } } },
      },
    });
  });

  test("streams a visible activity even when hidden status rows move behind it", () => {
    const contextWindow = statusActivity();
    const tool = activity("tool-1", 2, "inProgress");
    const advanced = advanceProjectedThreadStream(
      createProjectedThreadStreamState(detail({ activities: [contextWindow] })),
      detail({ activities: [tool, contextWindow] }),
    );

    expect(advanced.usedSnapshot).toBe(false);
    expect(advanced.items).toEqual([
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          type: "thread.activity-appended",
          payload: expect.objectContaining({ activity: expect.objectContaining({ id: "tool-1" }) }),
        }),
      }),
    ]);
  });

  test("keeps provider usage behind newly appended visible activities", () => {
    const providerUsage = providerUsageActivity();
    const tool = activity("tool-provider-status", 2, "inProgress");
    const advanced = advanceProjectedThreadStream(
      createProjectedThreadStreamState(detail({ activities: [providerUsage] })),
      detail({ activities: [tool, providerUsage] }),
    );

    expect(advanced.usedSnapshot).toBe(false);
    expect(advanced.items).toHaveLength(1);
    expect(advanced.items[0]).toMatchObject({
      event: {
        type: "thread.activity-appended",
        payload: { activity: { id: "tool-provider-status" } },
      },
    });
  });

  test("falls back to a bounded snapshot for a rewrite or removal", () => {
    const before = detail({
      messages: [message("m-1", "One", 1), message("m-2", "Two", 2)],
    });
    const after = detail({ messages: [message("m-2", "Two", 2)] });
    const advanced = advanceProjectedThreadStream(createProjectedThreadStreamState(before), after);
    expect(advanced.usedSnapshot).toBe(true);
    expect(advanced.items[0]).toMatchObject({
      kind: "snapshot",
      snapshot: { snapshotSequence: 2 },
    });
  });

  test("keeps explicit queued-message order in bounded reconnect snapshots", () => {
    const first = {
      ...message("queued-1", "First", 1),
      role: "user",
      turnId: null,
      phase: "queued",
      queuePosition: 1,
    };
    const second = {
      ...message("queued-2", "Second", 2),
      role: "user",
      turnId: null,
      phase: "queued",
      queuePosition: 0,
    };
    const snapshot = projectedThreadBoundedSnapshot(
      createProjectedThreadStreamState(detail({ messages: [second, first] })),
    ) as { snapshot: { thread: { messages: JsonRecord[] } } };

    expect(snapshot.snapshot.thread.messages.map(row => row.id)).toEqual([
      "queued-2",
      "queued-1",
    ]);
  });

  test("bounds the first page and walks backward with opaque cursors", () => {
    const manyMessages = Array.from({ length: 300 }, (_, index) =>
      message(`m-${index}`, `Message ${index}`, index),
    );
    const state = createProjectedThreadStreamState(detail({ messages: manyMessages }));
    const snapshot = projectedThreadBoundedSnapshot(state) as {
      snapshot: {
        historyPage: { hasOlder: boolean; olderCursor: string | null };
        thread: { messages: JsonRecord[] };
      };
    };
    expect(snapshot.snapshot.historyPage.hasOlder).toBe(true);
    expect(snapshot.snapshot.thread.messages.length).toBeLessThan(300);
    const cursor = snapshot.snapshot.historyPage.olderCursor;
    expect(cursor).not.toBeNull();
    const older = projectedThreadOlderPage(state, cursor!);
    expect(older.messages.length).toBeGreaterThan(0);
    expect(older.messages.at(-1)?.id).not.toBe(snapshot.snapshot.thread.messages[0]?.id);
    const recentIds = new Set(snapshot.snapshot.thread.messages.map(row => row.id));
    expect(older.messages.some(row => recentIds.has(row.id))).toBe(false);
    expect(older.pageInfo.olderCursor).not.toBe(cursor);
    expect(() => projectedThreadOlderPage(state, "not-a-cursor")).toThrow("cursor is invalid");
  });
});
