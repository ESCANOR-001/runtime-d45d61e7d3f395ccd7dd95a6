import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readUpdateTaskIds, readUpdateTaskPath } from "../src/update/task-inventory";
import { readBoundedDesktopTaskActivity } from "../src/android-remote/desktop-workspace-state";
import { AndroidRemoteGatewayController } from "../src/android-remote/gateway";
import { createAndroidRemoteStore } from "../src/android-remote/store";
import type { AndroidDesktopIpcSync } from "../src/android-remote/desktop-ipc";

const roots: string[] = [];
const root = async () => { const dir = await mkdtemp(join(tmpdir(), "rmx-update-inventory-")); roots.push(dir); return dir; };
afterEach(async () => {
  for (const dir of roots.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !dir.includes("rmx-update-inventory-")) throw new Error("Unexpected test directory");
    await rm(dir, { recursive: true, force: true });
  }
});
const marker = (type: string, timestamp = "2026-09-10T12:00:00Z") => JSON.stringify({
  type: "event_msg", timestamp, payload: { type, turn_id: "turn" },
}) + "\n";

test("reads IDs from the newest index without altering its data or reading transcripts", async () => {
  const dir = await root();
  for (const version of [5, 6]) {
    const db = new Database(join(dir, `state_${version}.sqlite`));
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, archived INTEGER, title TEXT)");
    db.query("INSERT INTO threads VALUES (?, ?, ?, ?)").run(`task-${version}`, "/does-not-exist", 1, "private title");
    db.close();
  }
  const path = join(dir, "state_6.sqlite");
  const before = await readFile(path);
  expect(await readUpdateTaskIds(dir)).toEqual(["task-6"]);
  expect(await readUpdateTaskPath(dir, "task-6")).toBe("/does-not-exist");
  expect(await readFile(path)).toEqual(before);
});

test("missing index can fall back; a corrupt or oversized index cannot imply idle", async () => {
  const dir = await root();
  expect(await readUpdateTaskIds(dir)).toBeNull();
  const db = new Database(join(dir, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY)");
  db.transaction(() => {
    const insert = db.query("INSERT INTO threads VALUES (?)");
    for (let i = 0; i < 2001; i++) insert.run(`task-${i}`);
  })();
  db.close();
  await expect(readUpdateTaskIds(dir)).rejects.toThrow("completely");
});

test("bounded tail detects completion after a long turn and does not scan back to a distant start", async () => {
  const dir = await root(), path = join(dir, "rollout.jsonl");
  await writeFile(path, marker("task_started") + "x".repeat(2 * 1024 * 1024) + "\n");
  expect(await readBoundedDesktopTaskActivity(path)).toBeNull();
  await appendFile(path, JSON.stringify({ type: "response_item", timestamp: "2026-09-10T12:01:00Z", payload: { type: "function_call", name: "read" } }) + "\n");
  const active = await readBoundedDesktopTaskActivity(path);
  expect(active?.lastProgressAt).toBe("2026-09-10T12:01:00Z");
  expect(active?.turnId).toBe("");
  await appendFile(path, marker("task_complete", "2026-09-10T12:02:00Z"));
  expect((await readBoundedDesktopTaskActivity(path))?.state).toBe("completed");
});

test("gateway verifies native and Desktop owners without trusting the stale sidebar", async () => {
  const dir = await root();
  let owned: boolean | null = false, loaded = false;
  let nativeStatus = "active", desktopStatus = "idle";
  const ipc = {
    hasLiveThreadOwner: async () => owned,
    readFollowerThreadState: async (_id: string, options?: { fresh?: boolean }) => {
      expect(options?.fresh).toBe(true);
      return { threadRuntimeStatus: { type: desktopStatus, activeFlags: desktopStatus === "active" ? ["running"] : [] } };
    },
  } as unknown as AndroidDesktopIpcSync;
  const gateway = new AndroidRemoteGatewayController(createAndroidRemoteStore(dir), { desktopIpcSync: ipc });
  Object.assign(gateway, {
    shellCache: { threads: [{ session: { status: "error", activeTurnId: "old" }, latestTurn: null }] },
    shellUpdatedAt: 0,
    listUpdateTasks: async () => ({ data: [{ id: "task", status: loaded ? "unknown" : "notLoaded", updateLoadedLocally: loaded }] }),
    codex: { request: async (method: string, params: unknown) => {
      expect(method).toBe("thread/read");
      expect(params).toEqual({ threadId: "task", includeTurns: false });
      return { thread: { status: { type: nativeStatus } } };
    } },
  });
  expect(await gateway.refreshUpdateActivity()).toEqual({ known: true, running: 0 });
  loaded = true;
  expect(await gateway.refreshUpdateActivity()).toEqual({ known: true, running: 1 });
  nativeStatus = "idle";
  expect(await gateway.refreshUpdateActivity()).toEqual({ known: true, running: 0 });
  loaded = false; owned = true; desktopStatus = "active";
  expect(await gateway.refreshUpdateActivity()).toEqual({ known: true, running: 1 });
  desktopStatus = "idle";
  expect(await gateway.refreshUpdateActivity()).toEqual({ known: true, running: 0 });
  owned = null;
  expect(await gateway.refreshUpdateActivity()).toEqual({ known: false, running: 0 });
});
