import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesktopFollowUpQueue, createDesktopFollowUpStore, desktopFollowUpTurnParams } from "../src/android-remote/desktop-follow-up-queue";

const thread = "019fff9d-2b6b-7282-9c2e-cc519d73135d";
const message = (id: string, text = "Follow up") => ({ id, text, context: {
  prompt: text, addedFiles: [], fileAttachments: [], imageAttachments: [], ideContext: null,
  workspaceRoots: ["/workspace"],
}, submission: { hostId: "local", status: "pending" } });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function setup(options: { ready?: boolean; send?: (id: string, params: Record<string, unknown>) => Promise<void>; store?: ReturnType<typeof createDesktopFollowUpStore> } = {}) {
  let ready = options.ready ?? true;
  const sent: Record<string, unknown>[] = [];
  const published: Record<string, unknown>[][] = [];
  const store = options.store ?? createDesktopFollowUpStore();
  const queue = new DesktopFollowUpQueue({ store, isReady: () => ready, send: options.send ?? (async (_, params) => { sent.push(params); }),
    publish: (_, messages) => published.push(messages), warn: () => {},
  });
  return { queue, store, sent, published, ready(value: boolean) { ready = value; } };
}

describe("Desktop follower follow-up queue", () => {
  test("acknowledges, persists, delivers and broadcasts an ordinary desktop submission", async () => {
    const h = setup();
    h.queue.accept(thread, { [thread]: [message("one")] });
    expect(h.store.read().entries).toHaveLength(1);
    await tick();
    expect(h.sent).toEqual([{ input: [{ type: "text", text: "Follow up", text_elements: [] }], clientUserMessageId: "one", runtimeWorkspaceRoots: ["/workspace"] }]);
    expect(h.queue.messages(thread)).toEqual([]);
    expect(h.published.at(-1)).toEqual([]);
    // Desktop retries the same persisted state after losing the original IPC response.
    h.queue.accept(thread, { [thread]: [message("one")] });
    await tick();
    expect(h.sent).toHaveLength(1);
  });
  test("waits while a turn is active and keeps edits and reordering", async () => {
    const h = setup({ ready: false });
    h.queue.accept(thread, { [thread]: [message("one"), message("two")] });
    h.queue.accept(thread, { [thread]: [message("two", "Edited"), message("one")] });
    await tick();
    expect(h.sent).toEqual([]);
    h.ready(true); h.queue.wake(thread); await tick();
    expect(h.sent.map(p => p.clientUserMessageId)).toEqual(["two", "one"]);
    expect(h.sent[0]?.input).toEqual([{ type: "text", text: "Edited", text_elements: [] }]);
  });
  test("does not send a message removed before dispatch or after losing ownership", async () => {
    const h = setup();
    h.queue.accept(thread, { [thread]: [message("one")] });
    h.queue.accept(thread, { [thread]: [] });
    await tick(); expect(h.sent).toEqual([]);
    h.queue.accept(thread, { [thread]: [message("two")] });
    h.ready(false); await tick(); expect(h.sent).toEqual([]);
  });
  test("retains uncertain submissions across restart, stale updates, and missing deletions", async () => {
    const store = createDesktopFollowUpStore();
    const h = setup({ store, send: async () => { throw new Error("IPC timed out"); } });
    h.queue.accept(thread, { [thread]: [message("one")] }); await tick();
    expect(h.queue.messages(thread)[0]).toMatchObject({ id: "one", submission: { status: "outcome-unknown" } });
    h.queue.stop();
    const restarted = setup({ store });
    restarted.queue.accept(thread, { [thread]: [message("one", "Stale overwrite")] });
    restarted.queue.accept(thread, { [thread]: [] });
    restarted.queue.wake(thread); await tick();
    expect(restarted.sent).toEqual([]);
    expect(restarted.queue.messages(thread)[0]?.text).toBe("Follow up");
    restarted.queue.accept(thread, { [thread]: [] }, ["one"]);
    expect(restarted.queue.messages(thread)).toEqual([]);
  });
  test("settles a late durable receipt without resending", async () => {
    const h = setup({ send: async () => { throw new Error("lost response"); } });
    h.queue.accept(thread, { [thread]: [message("one")] }); await tick();
    h.queue.accepted(thread, "one");
    expect(h.queue.messages(thread)).toEqual([]);
    h.queue.accept(thread, { [thread]: [message("one")] });
    expect(h.queue.messages(thread)).toEqual([]);
  });
  test("rejects an entire invalid state without accepting a partial queue", () => {
    const h = setup({ ready: false });
    expect(() => h.queue.accept(thread, { [thread]: [message("one"), message("one")] })).toThrow();
    expect(() => h.queue.accept(thread, { other: [message("one")] })).toThrow();
    expect(() => h.queue.accept(thread, { [thread]: [message("one", "x".repeat(120001))] })).toThrow();
    expect(h.store.read().entries).toEqual([]);
  });
  test("a failed persistence write neither acknowledges nor sends the prompt", async () => {
    const h = setup({ store: { read: () => ({ entries: [], receipts: [] }), write: () => { throw new Error("disk full"); } } });
    expect(() => h.queue.accept(thread, { [thread]: [message("one")] })).toThrow("disk full");
    await tick(); expect(h.sent).toEqual([]); expect(h.published).toEqual([]);
  });
  test("a corrupt journal cannot erase the desktop queue or accept new messages", async () => {
    const h = setup({ store: { read: () => { throw new Error("corrupt"); }, write: () => { throw new Error("must not overwrite"); } } });
    h.queue.publish(thread);
    expect(() => h.queue.accept(thread, { [thread]: [message("one")] })).toThrow("storage is unavailable");
    h.queue.wake(thread); await tick();
    expect(h.published).toEqual([]); expect(h.sent).toEqual([]);
  });
  test("stopping a turn pauses its waiting messages across a restart", async () => {
    const h = setup({ ready: false });
    h.queue.accept(thread, { [thread]: [message("one")] });
    h.queue.pause(thread); h.ready(true); h.queue.wake(thread); await tick();
    const restarted = setup({ store: h.store });
    restarted.queue.wake(thread); await tick();
    expect(h.sent).toEqual([]); expect(restarted.sent).toEqual([]);
    expect(restarted.queue.messages(thread)[0]?.pausedReason).toContain("stopped");
  });
  test("shows sending only until an uncertain response and keeps failed receipts non-fatal", async () => {
    let fail!: (error: Error) => void;
    const h = setup({ send: () => new Promise((_, reject) => { fail = reject; }) });
    h.queue.accept(thread, { [thread]: [message("one")] }); await tick();
    expect(h.queue.messages(thread)[0]).toMatchObject({ submission: { status: "sending" } });
    fail(new Error("lost response")); await tick();
    expect(h.published.at(-1)?.[0]).toMatchObject({ submission: { status: "outcome-unknown" } });
    h.store.write = () => { throw new Error("disk full"); };
    expect(() => h.queue.accepted(thread, "one")).not.toThrow();
    expect(h.queue.messages(thread)).toHaveLength(1);
  });
  test("preserves explicit model and resolved permission selections", () => {
    const params = desktopFollowUpTurnParams({ ...message("one"),
      context: { ...message("one").context, workPermissions: { resolvedPermissions: {
        approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" }, approvalsReviewer: "user",
      } } },
      submissionOptions: { collaborationMode: { mode: "default", settings: { model: "gpt-6-astra", reasoning_effort: "high" } }, serviceTier: "fast" },
    });
    expect(params).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" }, serviceTier: "fast",
      collaborationMode: { settings: { model: "gpt-6-astra", reasoning_effort: "high" } } });
    expect(() => desktopFollowUpTurnParams({ ...message("one"), clientUserMessageId: {} })).toThrow("message id");
    expect(() => desktopFollowUpTurnParams({ ...message("one"), submissionOptions: { executionHostId: "remote" } })).toThrow("local computer");
  });
  test("preserves local and remote images and file references", () => {
    const params = desktopFollowUpTurnParams({ ...message("one"), context: { prompt: "Check", imageAttachments: [{ localPath: "/tmp/example.png" }, { src: "https://example.com/image.png" }], fileAttachments: [{ path: "/workspace/file.ts" }] } });
    expect(params.input).toEqual([
      { type: "text", text: "Check", text_elements: [] }, { type: "localImage", path: "/tmp/example.png" },
      { type: "image", url: "https://example.com/image.png" }, { type: "text", text: "File attached on this PC: /workspace/file.ts", text_elements: [] },
    ]);
  });
  test("preserves named permission profiles instead of reducing them to a sandbox mode", () => {
    const params = desktopFollowUpTurnParams({ ...message("one"), context: { ...message("one").context,
      workPermissions: { resolvedPermissions: { activePermissionProfile: { id: ":read-only" },
        sandboxPolicy: { type: "readOnly" }, approvalPolicy: "on-request", runtimeWorkspaceRoots: ["/safe"] } },
    } });
    expect(params.permissions).toBe(":read-only"); expect(params.sandboxPolicy).toBeUndefined();
    expect(params.runtimeWorkspaceRoots).toEqual(["/safe"]);
    expect(() => desktopFollowUpTurnParams({ ...message("one"), submissionOptions: { permissionSelection: { kind: "custom" } } })).toThrow("permissions");
  });
  test("honors desktop agent-mode selections when the composer uses permission selection", () => {
    const params = desktopFollowUpTurnParams({ ...message("one"), submissionOptions: {
      usePermissionSelection: true, permissionSelection: { kind: "agent-mode", agentMode: "read-only" },
    } });
    expect(params).toMatchObject({ permissions: ":read-only", approvalPolicy: "on-request", approvalsReviewer: "user" });
  });
  test("does not silently drop unsupported desktop context", () => {
    expect(() => desktopFollowUpTurnParams({ ...message("one"), context: { prompt: "Check", mcpAppModelContextAttachments: [{ content: "Important context" }] } })).toThrow("desktop-only context");
  });
  test("restores protected persistent entries and refuses corrupt storage", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-follow-up-test-"));
    try {
      const store = createDesktopFollowUpStore(root);
      const h = setup({ store, ready: false }); h.queue.accept(thread, { [thread]: [message("one")] });
      expect(createDesktopFollowUpStore(root).read().entries[0]?.message.id).toBe("one");
      const path = join(root, "android-remote-desktop-follow-ups.json");
      expect(JSON.parse(readFileSync(path, "utf8")).entries).toHaveLength(1);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      writeFileSync(path, "invalid json");
      expect(() => createDesktopFollowUpStore(root).read()).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("Desktop remove and clear persist queue changes without sending removed messages", async () => {
  const store = createDesktopFollowUpStore();
  const h = setup({ ready: false, store });
  h.queue.accept(thread, { [thread]: [message("remove-me"), message("clear-me")] });
  expect(h.queue.remove(thread, "remove-me")).toBe(true);
  expect(h.queue.remove(thread, "missing")).toBe(false);
  expect(h.queue.clear(thread).map(row => row.id)).toEqual(["clear-me"]);
  const restarted = setup({ store });
  restarted.queue.wake(thread); await tick();
  expect(restarted.sent).toEqual([]);
  expect(restarted.queue.messages(thread)).toEqual([]);
});
