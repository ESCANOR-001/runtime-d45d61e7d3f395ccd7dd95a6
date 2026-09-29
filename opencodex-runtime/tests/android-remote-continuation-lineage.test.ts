import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidRemoteSessionCommandRecovery } from "../src/android-remote/session-command-recovery";
import { projectCodexShellSnapshot } from "../src/android-remote/projection";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const encode = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const meta = (id: string, parent?: string, end?: number) => ({
  type: "session_meta", payload: { id, ...(parent ? { history_base: { thread_id: parent, end_byte_offset: end } } : {}) },
});
const events = (id: string, timestamp = "2026-09-06T08:00:00Z") => [
  { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: id } },
  { timestamp, type: "event_msg", payload: { type: "item_completed", turn_id: id, item: { id: `message-${id}`, type: "agentMessage", text: id } } },
  { timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: id } },
];
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "remodex-lineage-"));
  roots.push(home);
  await mkdir(join(home, "sessions"));
  const path = (logical: string, physical: string) => join(home, "sessions", `rollout-${logical}_${physical}.jsonl`);
  return { home, path, recovery: new AndroidRemoteSessionCommandRecovery({ codexHome: home }) };
}
const ids = (result: Record<string, unknown>) => (result.turns as Array<{ id: string }>).map(turn => turn.id);

test("inherits only a parent's byte prefix, excludes siblings/native leftovers, and ignores reversed clocks", async () => {
  const f = await setup();
  const prefix = encode([meta("task"), ...events("inherited", "2026-09-07T10:00:00Z")]);
  const parent = f.path("task", "parent");
  const leaf = f.path("task", "leaf");
  await writeFile(parent, prefix + encode(events("after-cutoff")));
  await writeFile(leaf, encode([meta("task", "parent", Buffer.byteLength(prefix)), ...events("chosen", "2026-09-06T10:00:00Z")]));
  await writeFile(f.path("task", "sibling"), encode([meta("task", "parent", Buffer.byteLength(prefix)), ...events("abandoned", "2026-09-08T10:00:00Z")]));
  const input = { id: "task", path: leaf, turns: [{ id: "abandoned", items: [] }] };
  const result = await f.recovery.enrichThread(input);
  expect(ids(result)).toEqual(["inherited", "chosen"]);
  expect(input.turns[0]?.id).toBe("abandoned");
  expect(result.androidRemoteHistoryRecoveryError).toBeUndefined();
});

for (const largeRecord of [false, true]) {
  test(`bounds a large parent prefix with ${largeRecord ? "a record larger than 2 MiB" : "many small records"}`, async () => {
    const f = await setup();
    // Separate the Windows stream-boundary regression from the record-size limit.
    const padding = { type: "compacted", payload: { message: "x".repeat(largeRecord ? 7 * 1024 * 1024 : 256 * 1024) } };
    const prefix = encode([
      meta("original-task"),
      ...Array.from({ length: largeRecord ? 1 : 28 }, () => padding),
      ...events("inherited-你好"),
    ]);
    const parent = f.path("original-task", "parent");
    const leaf = f.path("task", "leaf");
    await writeFile(parent, prefix + encode([
      ...events("after-cutoff"),
      { type: "compacted", payload: { message: "y".repeat(512 * 1024) } },
    ]));
    await writeFile(leaf, encode([
      meta("task", "parent", Buffer.byteLength(prefix)),
      ...events("chosen"),
    ]));
    const input = { id: "task", path: leaf, turns: [{ id: "after-cutoff", items: [] }] };
    const result = await f.recovery.enrichThread(input);
    expect(result.androidRemoteHistoryRecoveryError).toBeUndefined();
    expect(ids(result)).toEqual(["inherited-你好", "chosen"]);
    expect(JSON.stringify(result)).not.toContain("after-cutoff");
    // Reusing the cached replay must preserve the same verified boundary.
    expect(await f.recovery.enrichThread(input)).toEqual(result);
  });
}

test("rejects a parent record above the 16 MiB recovery limit", async () => {
  const f = await setup();
  const prefix = encode([
    meta("original-task"),
    { type: "compacted", payload: { message: "x".repeat(16 * 1024 * 1024) } },
    ...events("inherited"),
  ]);
  await writeFile(f.path("original-task", "parent"), prefix);
  const leaf = f.path("task", "leaf");
  await writeFile(leaf, encode([meta("task", "parent", Buffer.byteLength(prefix)), ...events("chosen")]));
  const result = await f.recovery.enrichThread({ id: "task", path: leaf, turns: [{ id: "native", items: [] }] });
  expect(ids(result)).toEqual(["native"]);
  expect(result.androidRemoteHistoryRecoveryError).toContain("could not be verified");
});

test("resolves a linked ancestor with a different logical id and applies rollback across the boundary", async () => {
  const f = await setup();
  const prefix = encode([meta("original-task"), ...events("keep"), ...events("undo")]);
  await writeFile(f.path("original-task", "ancestor"), prefix);
  const leaf = f.path("task", "leaf");
  await writeFile(leaf, encode([
    meta("task", "ancestor", Buffer.byteLength(prefix)),
    { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
    ...events("replacement"),
  ]));
  expect(ids(await f.recovery.enrichThread({ id: "task", path: leaf }))).toEqual(["keep", "replacement"]);
});

for (const failure of ["missing-parent", "cycle", "mid-record", "missing-cutoff", "ambiguous-leaf"] as const) {
  test(`keeps native history and exposes incomplete recovery for ${failure}`, async () => {
    const f = await setup();
    const prefix = encode([meta("task", failure === "cycle" ? "leaf" : undefined, 0), ...events("parent")]);
    const parent = f.path("task", "parent");
    await writeFile(parent, prefix);
    const leaf = f.path("task", "leaf");
    await writeFile(leaf, encode([meta("task", failure === "missing-parent" ? "missing" : "parent",
      failure === "missing-cutoff" ? undefined : Buffer.byteLength(prefix) - (failure === "mid-record" ? 1 : 0)), ...events("leaf")]));
    if (failure === "ambiguous-leaf") await writeFile(f.path("task", "sibling"), encode([meta("task", "parent", Buffer.byteLength(prefix)), ...events("sibling")]));
    const input = { id: "task", path: failure === "ambiguous-leaf" ? parent : leaf, turns: [{ id: "native", items: [] }] };
    const result = await f.recovery.enrichThread(input);
    expect(ids(result)).toEqual(["native"]);
    expect(result.androidRemoteHistoryRecoveryError).toContain("could not be verified");
    const shell = projectCodexShellSnapshot([result], 1);
    expect((shell.threads as Array<{ session: { lastError: string } }>)[0]?.session.lastError).toContain("could not be verified");
  });
}

test("follows more than sixteen parents and refreshes when the selected leaf grows", async () => {
  const f = await setup();
  let previous = "";
  let bytes = 0;
  let leaf = "";
  for (let index = 0; index < 20; index++) {
    const physical = `part-${index}`;
    const body = encode([meta("task", previous || undefined, bytes), ...events(`turn-${index}`)]);
    leaf = f.path("task", physical);
    await writeFile(leaf, body);
    bytes = Buffer.byteLength(body);
    previous = physical;
  }
  const input = { id: "task", path: leaf };
  expect(ids(await f.recovery.enrichThread(input))).toEqual(Array.from({ length: 20 }, (_, i) => `turn-${i}`));
  await appendFile(leaf, encode(events("appended")));
  expect(ids(await f.recovery.enrichThread(input)).at(-1)).toBe("appended");
});
