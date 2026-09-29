import { describe, expect, test } from "bun:test";
import {
  canonicalizeCodexThreadCandidates,
  codexThreadSourcePaths,
} from "../src/android-remote/thread-reconciliation";

describe("Android Remote Codex thread reconciliation", () => {
  test("projects one logical thread while preserving every rollout path", () => {
    const rows = canonicalizeCodexThreadCandidates([
      {
        archived: true,
        thread: {
          id: "thread-1",
          name: "Archived duplicate",
          path: "/sessions/older.jsonl",
          createdAt: 10,
          updatedAt: 40,
          recencyAt: 35,
        },
      },
      {
        archived: false,
        thread: {
          id: "thread-1",
          name: "Active task",
          path: "/sessions/newer.jsonl",
          createdAt: 20,
          updatedAt: 30,
          recencyAt: 50,
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      archived: false,
      thread: {
        id: "thread-1",
        name: "Active task",
        createdAt: 10,
        updatedAt: 40,
        recencyAt: 50,
        path: "/sessions/newer.jsonl",
        androidRemoteSourcePaths: [
          "/sessions/older.jsonl",
          "/sessions/newer.jsonl",
        ],
      },
    });
    expect(codexThreadSourcePaths(rows[0]!.thread)).toEqual([
      "/sessions/older.jsonl",
      "/sessions/newer.jsonl",
    ]);
  });

  test("orders logical threads by recency instead of migration-updated time", () => {
    const rows = canonicalizeCodexThreadCandidates([
      {
        archived: false,
        thread: {
          id: "recent-conversation",
          path: "/sessions/recent.jsonl",
          createdAt: 10,
          updatedAt: 20,
          recencyAt: 100,
        },
      },
      {
        archived: false,
        thread: {
          id: "recently-migrated",
          path: "/sessions/migrated.jsonl",
          createdAt: 5,
          updatedAt: 500,
          recencyAt: 50,
        },
      },
    ]);

    expect(rows.map(row => row.thread.id)).toEqual([
      "recent-conversation",
      "recently-migrated",
    ]);
  });
});
