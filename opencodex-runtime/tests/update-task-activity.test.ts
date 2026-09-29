import { describe, expect, test } from "bun:test";
import { createTaskActivityReader } from "../src/update/task-activity";
import { AndroidDesktopIpcLiveSync } from "../src/android-remote/desktop-ipc";
import { readUpdateActivity, setUpdateActivityReader } from "../src/update/activity";

describe("current update task activity", () => {
  test("checks later pages and tracked tasks without reading saved conversations", async () => {
    const probed: string[] = [];
    const read = createTaskActivityReader({
      list: async cursor => cursor === null
        ? { data: [{ id: "closed", status: { type: "notLoaded" } }], nextCursor: "next" }
        : { data: [{ id: "local-active", status: { type: "active" } }], nextCursor: null },
      trackedIds: () => ["closed", "desktop-active"], revision: () => 0,
      probe: async id => { probed.push(id); return id === "desktop-active"; },
    });
    expect(await read()).toEqual({ known: true, running: 2 });
    expect(probed.sort()).toEqual(["closed", "desktop-active"]);
  });

  test("old running markers do not override a current idle owner; next call observes new work", async () => {
    let active = false;
    const read = createTaskActivityReader({
      list: async () => ({ data: [{ id: "task", status: "notLoaded", latestTurn: { state: "running" } }] }),
      trackedIds: () => ["task"], revision: () => 0, probe: async () => active,
    });
    expect(await read()).toEqual({ known: true, running: 0 });
    active = true;
    expect(await read()).toEqual({ known: true, running: 1 });
  });

  test("failed owners and incomplete lists never authorize a restart", async () => {
    for (const list of [async () => ({}), async () => { throw new Error("offline"); },
      async () => ({ data: [{ id: "task" }], nextCursor: "repeated" }),
      async () => ({ data: [{ id: "task" }] })]) {
      const read = createTaskActivityReader({ list, probe: async () => null, trackedIds: () => [], revision: () => 0 });
      expect((await read()).known).toBe(false);
    }
  });

  test("concurrent checks share work and a turn starting during the check requires another check", async () => {
    let revision = 0, calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const read = createTaskActivityReader({
      list: async () => { calls++; await blocked; return { data: [] }; },
      probe: async () => false, trackedIds: () => [], revision: () => revision,
    });
    const first = read(), second = read();
    expect(first).toBe(second);
    revision++;
    release();
    expect(await first).toEqual({ known: false, running: 0 });
    expect(calls).toBe(1);
    expect(await read()).toEqual({ known: true, running: 0 });
  });

  test("timeout returns unknown without accumulating more stalled scans, then recovers", async () => {
    let release!: (value: unknown) => void;
    let calls = 0;
    const read = createTaskActivityReader({
      list: async () => { calls++; return calls === 1 ? new Promise(resolve => { release = resolve; }) : { data: [] }; },
      probe: async () => false, trackedIds: () => [], revision: () => 0, timeoutMs: 10,
    });
    expect(await read()).toEqual({ known: false, running: 0 });
    expect(await read()).toEqual({ known: false, running: 0 });
    expect(calls).toBe(1);
    release({ data: [] });
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(await read()).toEqual({ known: true, running: 0 });
  });

  test("owner discovery checks closed tasks without loading history and preserves uncertainty on disconnect", async () => {
    let discovery: { canHandle: boolean; handledByClientId?: string; timedOut?: boolean } = { canHandle: false };
    const ipc = Object.assign(Object.create(AndroidDesktopIpcLiveSync.prototype), {
      transport: { connected: true },
      discoverDesktopOwner: async () => discovery,
      readFollowerThreadState: () => { throw new Error("must not read history"); },
    });
    expect(await ipc.hasLiveThreadOwner("closed")).toBe(false);
    discovery = { canHandle: true, handledByClientId: "owner" };
    expect(await ipc.hasLiveThreadOwner("open")).toBe(true);
    discovery = { canHandle: false, timedOut: true };
    expect(await ipc.hasLiveThreadOwner("unknown")).toBeNull();
    ipc.transport.connected = false;
    expect(await ipc.hasLiveThreadOwner("closed")).toBeNull();
  });

  test("desktop activity endpoint reader awaits verification and handles failed verification", async () => {
    try {
      setUpdateActivityReader(async () => ({ known: true, running: 0 }));
      expect(await readUpdateActivity()).toEqual({ known: true, running: 0 });
      setUpdateActivityReader(async () => { throw new Error("offline"); });
      expect(await readUpdateActivity()).toEqual({ known: false, running: 0 });
    } finally { setUpdateActivityReader(); }
  });
});
