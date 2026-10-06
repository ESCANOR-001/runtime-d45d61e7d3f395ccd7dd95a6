import { afterEach, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidRemoteSessionCommandRecovery } from "../src/android-remote/session-command-recovery";
import { projectCodexShellSnapshot, projectCodexThreadDetail } from "../src/android-remote/projection";
import { createProjectedThreadStreamState, projectedThreadRecentPage, projectedThreadOlderPage } from "../src/android-remote/thread-stream";

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
  const home = await fsPromises.realpath(await mkdtemp(join(tmpdir(), "remodex-lineage-")));
  roots.push(home);
  await mkdir(join(home, "sessions"));
  const path = (logical: string, physical: string) => join(home, "sessions", `rollout-${logical}_${physical}.jsonl`);
  return { home, path, recovery: new AndroidRemoteSessionCommandRecovery({ codexHome: home }) };
}
const ids = (result: Record<string, unknown>) => (result.turns as Array<{ id: string }>).map(turn => turn.id);

test("large valid image-bearing compaction records do not discard the continuation's chat history", async () => {
  const fixture = await setup();
  const prefix = encode([meta("task"), ...events("older"),
    { type: "compacted", payload: { replacement_history: [{ type: "message", role: "user",
      content: [{ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(36 * 1024 * 1024)}` }] }] } },
  ]);
  await writeFile(fixture.path("task", "parent"), prefix);
  const leaf = fixture.path("task", "leaf");
  await writeFile(leaf, encode([meta("task", "parent", Buffer.byteLength(prefix)), ...events("newer")]));
  const recovered = await fixture.recovery.enrichThread({ id: "task", path: leaf, turns: [] });
  expect(recovered.androidRemoteHistoryRecoveryError).toBeUndefined();
  expect(ids(recovered)).toEqual(["older", "newer"]);
  expect(JSON.stringify(recovered).length).toBeLessThan(10_000);
  expect(JSON.stringify(recovered)).not.toContain("data:image");
});

test("retains readable history around a zero-filled record and verifies only questions after the gap", async () => {
  const f = await setup();
  const question = (id: string) => ({ type: "response_item", payload: {
    type: "function_call", name: "request_user_input_async", call_id: id,
    arguments: JSON.stringify({ questions: [{ title: "Which device?" }] }),
  } });
  const prefix = encode([meta("task"), ...events("old"),
    { type: "turn_context", payload: { turn_id: "old-question-turn" } }, question("before-gap")])
    + "\0".repeat(2942) + "\n"
    + encode(Array.from({ length: 110 }, (_, index) => events(`retained-${index}`)).flat());
  await writeFile(f.path("task", "parent"), prefix);
  const leaf = f.path("task", "leaf");
  await writeFile(leaf, encode([meta("task", "parent", Buffer.byteLength(prefix)),
    { type: "turn_context", payload: { turn_id: "new-question-turn" } }, question("after-gap"),
    ...events("newest"),
  ]));
  const result = await f.recovery.enrichThread({ id: "task", path: leaf, turns: [] });
  expect(result.androidRemoteHistoryRecoveryError).toContain("Some older saved records are unreadable");
  expect(result.androidRemoteVerifiedAsyncQuestionItemIds).toEqual(["after-gap"]);
  expect(ids(result)).toContain("old");
  expect(ids(result)).toContain("newest");
  const detail = projectCodexThreadDetail(result, 1);
  const state = createProjectedThreadStreamState(detail);
  let page = projectedThreadRecentPage(detail);
  const messages = [...page.messages];
  expect(page.pageInfo.hasOlder).toBe(true);
  while (page.pageInfo.olderCursor) {
    page = projectedThreadOlderPage(state, page.pageInfo.olderCursor);
    messages.push(...page.messages);
  }
  expect(messages.some(message => message.text === "old")).toBe(true);
  expect(messages.some(message => message.text === "newest")).toBe(true);
});

test("does not skip arbitrary malformed records or trust inherited verification markers", async () => {
  const f = await setup();
  const prefix = encode([meta("task"), ...events("old")]) + "{broken-json}\n";
  await writeFile(f.path("task", "parent"), prefix);
  const leaf = f.path("task", "leaf");
  await writeFile(leaf, encode([meta("task", "parent", Buffer.byteLength(prefix)), ...events("new")]));
  const result = await f.recovery.enrichThread({ id: "task", path: leaf, turns: [], androidRemoteVerifiedAsyncQuestionItemIds: ["untrusted"] });
  expect(result.androidRemoteHistoryRecoveryError).toContain("could not be verified");
  expect(result.androidRemoteVerifiedAsyncQuestionItemIds).toEqual([]);
});

for (const rewrite of [false, true]) {
  test(`${rewrite ? "rejects rewritten" : "accepts unchanged"} scanned prefixes when a live file grows`, async () => {
    const fixture = await setup();
    const prefix = encode([meta("task"), ...events("inherited")]);
    await writeFile(fixture.path("task", "parent"), prefix);
    const leaf = fixture.path("task", "leaf");
    const body = encode([meta("task", "parent", Buffer.byteLength(prefix)), ...events("chosen")]);
    await writeFile(leaf, body);
    const canonicalLeaf = await fsPromises.realpath(leaf);
    const originalStat = fsPromises.stat;
    let leafChecks = 0;
    const statSpy = spyOn(fsPromises, "stat").mockImplementation((async (...args: Parameters<typeof fsPromises.stat>) => {
      if (args[0] === canonicalLeaf && args[1]?.bigint && ++leafChecks === 2) {
        if (rewrite) await writeFile(leaf, body.replaceAll("chosen", "edited"));
        await appendFile(leaf, encode(events("appended")));
      }
      return originalStat(...args);
    }) as typeof fsPromises.stat);
    try {
      const result = await fixture.recovery.enrichThread({ id: "task", path: leaf, turns: [{ id: "native", items: [] }] });
      expect(leafChecks).toBe(2);
      if (rewrite) {
        expect(ids(result)).toEqual(["native"]);
        expect(result.androidRemoteHistoryRecoveryError).toContain("could not be verified");
        expect(result.androidRemoteVerifiedAsyncQuestionItemIds).toEqual([]);
      } else {
        expect(result.androidRemoteHistoryRecoveryError).toBeUndefined();
        expect(ids(result)).toEqual(["inherited", "chosen"]);
        expect(ids(await fixture.recovery.enrichThread({ id: "task", path: leaf }))).toEqual(["inherited", "chosen", "appended"]);
      }
    } finally {
      statSpy.mockRestore();
    }
  });
}

test("does not retain a previous question verification when a source becomes unreadable", async () => {
  const fixture = await setup();
  const leaf = fixture.path("task", "leaf");
  await writeFile(leaf, "not a session\n");
  const result = await fixture.recovery.enrichThread({ id: "task", path: leaf,
    androidRemoteHistoryRecoveryError: "Some saved history could not be verified.",
    androidRemoteVerifiedAsyncQuestionItemIds: ["previously-verified"],
  });
  expect(result.androidRemoteHistoryRecoveryError).toContain("could not be verified");
  expect(result.androidRemoteVerifiedAsyncQuestionItemIds).toBeUndefined();
});

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

test("rejects a parent record above the 64 MiB recovery limit", async () => {
  const f = await setup();
  const prefix = encode([
    meta("original-task"),
    { type: "compacted", payload: { message: "x".repeat(64 * 1024 * 1024) } },
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
