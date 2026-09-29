import { describe, expect, test } from "bun:test";
import {
  DESKTOP_CONTENT_CHUNK_MAX_BYTES,
  DESKTOP_HISTORY_PAGE_MAX_ITEMS,
  DESKTOP_HISTORY_PAGE_MAX_SERIALIZED_BYTES,
  DESKTOP_HISTORY_PAGE_MAX_TURNS,
  DesktopHistoryPageStore,
} from "../src/android-remote/desktop-history-page";

function thread(turnCount = 24): Record<string, unknown> {
  return {
    id: "thread-with-a-long-history",
    hostId: "local",
    updatedAt: 42,
    title: "Long task",
    requests: [],
    turns: Array.from({ length: turnCount }, (_, index) => ({
      id: `turn-${index}`,
      status: index === turnCount - 1 ? "inProgress" : "completed",
      items: [{
        id: `item-${index}`,
        type: "agentMessage",
        text: `message-${index}`,
      }],
    })),
  };
}

describe("Desktop bounded history pages", () => {
  test("sends a recent tail under the serialized-byte budget with opaque older cursors", () => {
    const store = new DesktopHistoryPageStore();
    const page = store.recentPage("thread-with-a-long-history", thread());
    expect(page.state.turns).toHaveLength(DESKTOP_HISTORY_PAGE_MAX_TURNS);
    expect(page.state.turns.length).toBeLessThanOrEqual(DESKTOP_HISTORY_PAGE_MAX_TURNS);
    expect(JSON.stringify(page.state).length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(page.state), "utf8"))
      .toBeLessThanOrEqual(DESKTOP_HISTORY_PAGE_MAX_SERIALIZED_BYTES);
    expect(page.pageInfo.hasOlder).toBe(true);
    expect(page.pageInfo.olderPageToken).toStartWith("desktop_page_v1_");
    expect(page.pageInfo.olderPageToken).not.toContain("thread-with-a-long-history");
    expect(page.pageInfo.olderPageToken).not.toContain("turn-13");
  });

  test("moves an oversized field behind an opaque handle and serves bounded chunks", () => {
    let now = 100;
    const store = new DesktopHistoryPageStore({ now: () => now });
    const source = thread(1);
    const large = "🙂".repeat(600_000);
    (source.turns as Array<Record<string, unknown>>)[0]!.items = [{
      id: "large-item",
      type: "agentMessage",
      text: large,
    }];
    const page = store.recentPage("thread-with-a-long-history", source);
    const item = (page.state.turns[0] as Record<string, unknown>).items as Array<Record<string, unknown>>;
    const reference = item[0]!.text as Record<string, unknown>;
    expect(reference.kind).toBe("handle");
    expect(typeof reference.handle).toBe("string");
    expect(reference.preview).toBeString();
    expect(reference.byteLength).toBe(Buffer.byteLength(large, "utf8"));

    const first = store.readContentChunk({
      threadId: "thread-with-a-long-history",
      sourceRevision: page.pageInfo.sourceRevision,
      handle: reference.handle as string,
      offset: 0,
    });
    expect(first.kind).toBe("chunk");
    if (first.kind !== "chunk") return;
    expect(first.chunkByteLength).toBeLessThanOrEqual(DESKTOP_CONTENT_CHUNK_MAX_BYTES);
    expect(first.nextOffset).toBe(first.chunkByteLength);
    expect(Buffer.from(first.data, "base64").byteLength).toBe(first.chunkByteLength);
    expect(first.totalByteLength).toBe(reference.byteLength);

    now += 1;
    const second = store.readContentChunk({
      threadId: "thread-with-a-long-history",
      sourceRevision: page.pageInfo.sourceRevision,
      handle: reference.handle as string,
      offset: first.nextOffset,
    });
    expect(second.kind).toBe("chunk");
  });

  test("walks older pages and rejects a token for the wrong task or source revision", () => {
    const store = new DesktopHistoryPageStore({ maxTurns: 3 });
    const source = thread(9);
    const recent = store.recentPage("thread-with-a-long-history", source);
    const olderToken = recent.pageInfo.olderPageToken;
    expect(olderToken).toBeString();
    const older = store.page("thread-with-a-long-history", source, "older", olderToken!);
    expect(older.state.turns).toHaveLength(3);
    expect(older.pageInfo.olderPageToken).not.toBe(olderToken);
    expect(() => store.page("other-thread", source, "older", older.pageInfo.olderPageToken!))
      .toThrow("another task");
    const changed = { ...source, updatedAt: 43 };
    expect(() => store.page("thread-with-a-long-history", changed, "older", older.pageInfo.olderPageToken!))
      .toThrow("source changed");
  });

  test("caps retained opaque references and page tokens", () => {
    const store = new DesktopHistoryPageStore({ maxPageTokens: 2, maxContentEntries: 1, maxRetainedContentBytes: 2_000_000 });
    const source = thread(20);
    for (const turn of source.turns as Array<Record<string, unknown>>) {
      turn.items = [{ id: String(turn.id), text: "x".repeat(300_000), type: "agentMessage" }];
    }
    store.recentPage("thread-with-a-long-history", source);
    store.recentPage("thread-with-a-long-history", { ...source, updatedAt: 43 });
    store.recentPage("thread-with-a-long-history", { ...source, updatedAt: 44 });
    expect(store.pageTokenCount).toBeLessThanOrEqual(2);
    expect(store.contentEntryCount).toBeLessThanOrEqual(1);
    expect(DESKTOP_HISTORY_PAGE_MAX_ITEMS).toBeGreaterThan(0);
  });

  test("reserves the global item budget from newest to oldest", () => {
    const source = thread(3);
    (source.turns as Array<Record<string, unknown>>).forEach((turn, turnIndex) => {
      turn.items = Array.from({ length: 4 }, (_, itemIndex) => ({
        id: `turn-${turnIndex}-item-${itemIndex}`,
        type: "agentMessage",
        text: `${turnIndex}:${itemIndex}`,
      }));
    });
    const store = new DesktopHistoryPageStore({ maxTurns: 3, maxItems: 5 });
    const page = store.recentPage("thread-with-a-long-history", source);
    const turns = page.state.turns as Array<Record<string, unknown>>;
    expect(turns.map(turn => turn.id)).toEqual(["turn-0", "turn-1", "turn-2"]);
    expect((turns[0]!.items as Array<Record<string, unknown>>)).toHaveLength(0);
    expect((turns[1]!.items as Array<Record<string, unknown>>)).toHaveLength(1);
    expect((turns[2]!.items as Array<Record<string, unknown>>).map(item => item.id))
      .toEqual(["turn-2-item-0", "turn-2-item-1", "turn-2-item-2", "turn-2-item-3"]);
    expect(page.pageInfo.itemsOmitted).toBe(7);
  });

  test("keeps shrinking a single oversized turn until it fits", () => {
    const source = thread(1);
    (source.turns as Array<Record<string, unknown>>)[0]!.items = Array.from(
      { length: 500 },
      (_, index) => ({ id: `item-${index}`, type: "agentMessage", text: "x".repeat(1000) }),
    );
    const store = new DesktopHistoryPageStore({ maxSerializedBytes: 2_048, maxTurns: 1 });
    const page = store.recentPage("thread-with-a-long-history", source);
    expect(Buffer.byteLength(JSON.stringify(page.state), "utf8"))
      .toBeLessThanOrEqual(2_048);
    expect(page.pageInfo.itemsOmitted).toBeGreaterThan(0);
    expect((page.state.turns[0] as Record<string, unknown>).items).toBeArray();
  });
});
