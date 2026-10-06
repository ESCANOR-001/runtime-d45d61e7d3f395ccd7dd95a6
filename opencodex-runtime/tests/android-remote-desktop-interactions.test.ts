import { describe, expect, test } from "bun:test";
import { desktopAnswerMessage, desktopQuestionReplies, readDesktopInteractions } from "../src/android-remote/desktop-interactions";

const questionItem = { type: "agentMessage", id: "call-question", questions: [
  { title: "Which platform?", options: ["Android", "All platforms"] },
  { title: "Anything else?" },
] };
const state = (items: unknown[], status = "in_progress") => ({
  threadRuntimeStatus: { type: "idle" }, turns: [{ turnId: "turn-current", status, items }],
});

describe("Desktop live interaction projection", () => {
  test("does not invent a current timestamp for missing or invalid historical dates", () => {
    for (const startedAt of [undefined, "invalid", Infinity, 1e20]) {
      const result = readDesktopInteractions({ turns: [{
        id: "old-turn", startedAt, status: "completed", items: [questionItem],
      }] });
      expect(result.questions[0]?.requestedAt).toBe("");
    }
  });

  test("preserves old question turn, timestamp and provider position across later turns", () => {
    const turns = Array.from({ length: 70 }, (_, index) => ({
      id: `turn-${index}`, startedAt: 1_700_000_000 + index, status: "completed",
      items: [{ type: "agentMessage", id: `answer-${index}`, text: "Done" },
        ...(index === 60 ? [questionItem] : []),
      ],
    }));
    expect(readDesktopInteractions({ turns }).questions[0]).toMatchObject({
      turnId: "turn-60", requestedAt: new Date(1_700_000_060_000).toISOString(), sequence: 61,
    });
    expect(readDesktopInteractions({ turns: [...turns, {
      id: "latest", startedAt: 1_800_000_000, status: "completed", items: [],
    }] }).questions[0]).toEqual(readDesktopInteractions({ turns }).questions[0]);
  });

  test("maps async questions with exact Desktop IDs and supports free text", () => {
    const groups = readDesktopInteractions(state([questionItem])).questions;
    expect(groups[0]?.questions).toEqual([
      { id: '["request_user_input_async","call-question",0]', header: "Question", question: "Which platform?", multiSelect: false,
        options: [{ label: "Android", description: "Android" }, { label: "All platforms", description: "All platforms" }] },
      { id: '["request_user_input_async","call-question",1]', header: "Question", question: "Anything else?", options: [], multiSelect: false },
    ]);
  });

  test("the immediate tool receipt does not resolve an async question", () => {
    expect(readDesktopInteractions(state([questionItem, { type: "functionCallOutput", callId: "call-question", output: "accepted" }]))
      .questions).toHaveLength(1);
  });

  test("resolves selected and custom answers from Desktop without reopening on reconnect", () => {
    const questions = readDesktopInteractions(state([questionItem])).questions[0]!.questions;
    const message = desktopAnswerMessage(questions, Object.fromEntries(questions.map((question, index) =>
      [question.id, { answers: [index === 0 ? "Android" : "My custom answer"] }])));
    const reply = { type: "userMessage", content: [{ type: "text", text: message }] };
    expect(desktopQuestionReplies(message).map(reply => reply.answer)).toEqual(["Android", "My custom answer"]);
    expect(readDesktopInteractions(state([questionItem, reply], "completed")).questions).toEqual([]);
    expect(readDesktopInteractions(state([questionItem, { ...reply, type: "steeringUserMessage", input: reply.content, status: "accepted" }])).questions).toEqual([]);
    expect(readDesktopInteractions(state([questionItem, { ...reply, type: "steeringUserMessage", status: "rejected" }])).questions).toHaveLength(1);
    expect(() => desktopAnswerMessage(questions, {})).toThrow("Every question");
  });

  test("compaction is live only in the current unfinished turn and contains no private text", () => {
    const item = { type: "contextCompaction", id: "compact", completed: false, startedAtMs: 123, text: "private handoff" };
    expect(readDesktopInteractions(state([item])).compaction).toEqual({ id: "compact", turnId: "turn-current", active: true, startedAt: 123 });
    expect(readDesktopInteractions(state([{ ...item, completed: true }])).compaction?.active).toBe(false);
    expect(readDesktopInteractions(state([item], "completed")).compaction?.active).toBe(false);
    expect(readDesktopInteractions({ turns: [...state([item]).turns, { turnId: "new-turn", status: "completed", items: [] }] }).compaction).toBeNull();
    expect(JSON.stringify(readDesktopInteractions(state([item])))).not.toContain("private handoff");
  });
});
