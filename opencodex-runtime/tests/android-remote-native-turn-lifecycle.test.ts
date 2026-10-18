import { expect, test } from "bun:test";
import { confirmNativeTurnStopped, pauseNativeGoal, readNativeStopState } from "../src/android-remote/native-turn-lifecycle";

test.each(["completed", "interrupted", "failed"] as const)("requires exact native terminal evidence: %s", async status => {
  let reads = 0;
  expect(await confirmNativeTurnStopped({ threadId: "chat", turnId: "turn", read: async () => {
    reads++;
    return { thread: { id: "chat", turns: [{ id: "turn", status: reads === 1 ? "inProgress" : status }] } };
  } })).toBe(status);
  expect(reads).toBe(2);
});

test.each([{}, { id: "wrong-chat", turns: [{ id: "turn", status: "interrupted" }] },
  { id: "chat", turns: [{ id: "wrong-turn", status: "interrupted" }] },
  { id: "chat", turns: [{ id: "turn", status: "inProgress" }] },
])("empty acknowledgements, wrong identities and active work cannot confirm Stop: %j", async evidence => {
  await expect(confirmNativeTurnStopped({ threadId: "chat", turnId: "turn", timeoutMs: 10, read: async () => evidence })).rejects.toThrow("has not confirmed");
});

test("a hung read has a deadline and cannot keep Stop pending forever", async () => {
  await expect(confirmNativeTurnStopped({ threadId: "chat", turnId: "turn", timeoutMs: 10,
    read: () => new Promise(() => {}),
  })).rejects.toThrow("has not confirmed");
});

test("uses bounded native status pages and never retries a timeout as unbounded history", async () => {
  const calls: string[] = [];
  expect(await readNativeStopState("chat", async (method, params) => {
    calls.push(method); expect(params.itemsView).toBe("summary"); return { data: [{ id: "turn", status: "interrupted" }] };
  })).toEqual({ id: "chat", turns: [{ id: "turn", status: "interrupted" }] });
  expect(calls).toEqual(["thread/turns/list"]);
  await expect(readNativeStopState("chat", async method => { calls.push(method); throw new Error("timeout"); })).rejects.toThrow("timeout");
  expect(calls).not.toContain("thread/read");
});

test("manual Stop pauses active goals but never creates one", async () => {
  const calls: unknown[] = [];
  await pauseNativeGoal("chat", async (method, params) => {
    calls.push({ method, params }); return { goal: { status: method.endsWith("get") ? "active" : "paused" } };
  });
  expect(calls).toContainEqual({ method: "thread/goal/set", params: { threadId: "chat", status: "paused", origin: "user" } });
  calls.length = 0;
  await pauseNativeGoal("chat", async method => { calls.push(method); return { goal: null }; });
  expect(calls).toEqual(["thread/goal/get"]);
});

test("distinguishes a native start rejection from uncertain transport delivery", async () => {
  const { nativeStartDefinitelyRejected } = await import("../src/android-remote/native-turn-lifecycle");
  expect(nativeStartDefinitelyRejected(Object.assign(new Error("failed to submit turn input"), {
    code: -32603, codexRequestRejected: true, requestMethod: "turn/start",
  }))).toBe(true);
  expect(nativeStartDefinitelyRejected(Object.assign(new Error("read failed"), {
    code: -32603, codexRequestRejected: true, requestMethod: "thread/read",
  }))).toBe(false);
  expect(nativeStartDefinitelyRejected(new Error("Codex request timed out: turn/start"))).toBe(false);
});
