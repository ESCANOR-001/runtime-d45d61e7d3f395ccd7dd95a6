import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopAnswerMessage, desktopAsyncQuestionItem, readDesktopInteractions } from "../src/android-remote/desktop-interactions";
import { annotateDesktopTaskActivity } from "../src/android-remote/desktop-workspace-state";
import { AndroidRemoteSessionCommandRecovery } from "../src/android-remote/session-command-recovery";

const roots: string[] = [];
const questions = [{ title: "Which scope?", options: ["Local", "All"] }, { title: "Any notes?" }];
const questionIds = questions.map((_, index) => JSON.stringify(["request_user_input_async", "call-async", index]));
const call = { type: "function_call", id: "fc-async", call_id: "call-async", name: "request_user_input_async", arguments: JSON.stringify({ questions }) };
const canonical = { type: "AgentMessage", id: "call-async", delivery: "async", phase: "final_answer", questions,
  content: [{ type: "Text", text: "Which scope?\nAny notes?" }] };
const acknowledgement = { type: "function_call_output", call_id: "call-async", output: '{"accepted":true}' };
const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: "2026-10-03T08:00:00.000Z", type, payload }) + "\n";
const reply = (index: number, role = "user") => ({
  type: "message", role, id: `reply-${index}`,
  content: [{ type: "input_text", text: desktopAnswerMessage(
    [readDesktopInteractions({ turns: [{ items: [call] }] }).questions[0]!.questions[index]!],
    { [questionIds[index]!]: { answers: [index ? "Keep it small" : "Local"] } },
  ) }],
});

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(canonicalEvents = false) {
  const root = await mkdtemp(join(tmpdir(), "remodex-async-rollout-"));
  roots.push(root);
  await mkdir(join(root, "sessions"));
  const path = join(root, "sessions", "rollout-async.jsonl");
  await writeFile(path, line("session_meta", { id: "thread-async" })
    + line("event_msg", { type: "task_started", turn_id: "turn-async" })
    + line("response_item", call)
    + (canonicalEvents ? line("event_msg", { type: "item_completed", turn_id: "turn-async", item: canonical }) : "")
    + line("response_item", acknowledgement));
  return { root, path, thread: { id: "thread-async", path, turns: [{ id: "turn-async", status: "inProgress", items: [] }] } };
}

test("async raw calls use call IDs, deduplicate canonical echoes, and ignore acceptance receipts", () => {
  const items = [call, { ...canonical, type: "agentMessage" }, acknowledgement];
  const groups = readDesktopInteractions({ turns: [{ id: "turn-async", items }] }).questions;
  expect(groups).toHaveLength(1);
  expect(groups[0]?.questions.map(question => question.id)).toEqual(questionIds);
  expect(groups[0]?.questions[1]?.options).toEqual([]);
  expect(groups[0]?.questions[0]?.options).toEqual([{ label: "Local", description: "Local" }, { label: "All", description: "All" }]);
  expect(desktopAsyncQuestionItem({ ...call, arguments: "broken" })).toBeNull();
  expect(desktopAsyncQuestionItem({ ...call, name: "request_user_input" })).toBeNull();
  expect(readDesktopInteractions({ turns: [{ items: [...items, reply(0, "assistant")] }] }).questions[0]?.questions).toHaveLength(2);
  expect(readDesktopInteractions({ turns: [{ items: [...items, reply(0)] }] }).questions[0]?.questions.map(question => question.id)).toEqual([questionIds[1]!]);
});

test("sidebar tracks async questions through receipts and partial durable answers", async () => {
  const { root, path, thread } = await fixture(true);
  const read = async () => (await annotateDesktopTaskActivity([thread], 50, { codexHome: root }))[0]!;
  expect(await read()).toMatchObject({ androidRemoteWaitingOnUserInput: true,
    androidRemotePendingUserInput: { callId: "call-async", questions: [{ id: questionIds[0] }, { id: questionIds[1] }] } });
  await appendFile(path, line("response_item", reply(0)));
  expect(await read()).toMatchObject({ androidRemotePendingUserInput: { questions: [{ id: questionIds[1] }] } });
  await appendFile(path, line("response_item", reply(1)));
  expect(await read()).toMatchObject({ androidRemoteWaitingOnUserInput: false });
  expect((await read()).androidRemotePendingAsyncUserInputs).toBeUndefined();
});

for (const canonicalEvents of [false, true]) {
  test(`rollout recovery retains async questions and durable answers (canonical=${canonicalEvents})`, async () => {
    const { root, path, thread } = await fixture(canonicalEvents);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: root });
    const read = async () => readDesktopInteractions(await recovery.enrichThread(thread)).questions;
    expect((await read())[0]?.questions.map(question => question.id)).toEqual(questionIds);
    await appendFile(path, line("response_item", reply(0)));
    expect((await read())[0]?.questions.map(question => question.id)).toEqual([questionIds[1]!]);
    await appendFile(path, line("response_item", reply(1)));
    expect(await read()).toEqual([]);
  });
}
