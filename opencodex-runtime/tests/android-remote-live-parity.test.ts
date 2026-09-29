import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopSessionRecordProjector, DesktopSessionStream } from "../src/android-remote/desktop-session-stream";
import { normalizedCompletedItem } from "../src/android-remote/desktop-thread-item";

type Row = Record<string, any>;
const record = (payload: Row) => ({ timestamp: "2026-08-12T10:00:00.000Z", type: "event_msg", payload });
const start = record({ type: "task_started", turn_id: "turn-1" });
const end = record({ type: "task_complete", turn_id: "turn-1" });
function structured(item: Row, completed = true) {
  return record({ type: completed ? "item_completed" : "item_started", turn_id: "turn-1",
    started_at_ms: 1786528800000, ...(completed ? { completed_at_ms: 1786528800500 } : {}), item });
}

describe("Desktop live and saved tool parity", () => {
  test("an edit followed by a command poll is labelled as an edit before the wrapper finishes", () => {
    const events: Row[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", event => events.push(event));
    projector.consume(start);
    projector.consume({ type: "response_item", payload: {
      type: "custom_tool_call", id: "edit-wrapper", call_id: "edit-wrapper", name: "exec",
      input: 'await tools.apply_patch("*** Begin Patch\\n*** Update File: example.ts\\n@@\\n-old\\n+new\\n*** End Patch"); await tools.write_stdin({session_id:123});',
    } });
    expect(events.at(-1)).toMatchObject({ method: "item/started", params: { item: { type: "fileChange" } } });
    projector.consume(structured({ type: "FileChange", id: "desktop-edit", status: "completed", changes: [
      { path: "example.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new" },
    ] }));
    expect(events.at(-1)).toMatchObject({ method: "item/completed", params: {
      replacesItemId: "edit-wrapper", item: { id: "desktop-edit", type: "fileChange", status: "completed" },
    } });
  });

  for (const cwd of ["C:\\workspace", "/home/example/workspace"]) {
    test(`publishes all structured commands and their real results immediately: ${cwd}`, () => {
      const events: Row[] = [];
      const projector = new DesktopSessionRecordProjector("thread-1", event => events.push(event));
      projector.consume(start);
      const first = { type: "CommandExecution", id: "cmd-a", command: ["git", "status"], cwd, status: "InProgress" };
      projector.consume(structured(first, false));
      expect(events.at(-1)).toMatchObject({ method: "item/started", params: {
        item: { id: "cmd-a", type: "commandExecution", command: "git status", status: "inProgress" },
      } });
      for (const id of ["cmd-a", "cmd-b"]) {
        const item = { ...first, id, status: "completed", aggregated_output: `output-${id}`, exit_code: 7,
          duration: { secs: 2, nanos: 500000000 } };
        projector.consume(structured(item));
        expect(events.at(-1)).toMatchObject({ method: "item/completed", params: {
          item: normalizedCompletedItem(item, true), startedAtMs: 1786528800000, completedAtMs: 1786528800500,
        } });
      }
      expect(events.filter(event => event.method === "item/completed")).toHaveLength(2);
    });
  }

  test("replaces an inferred command with its canonical Desktop id and ignores its later wrapper result", () => {
    const events: Row[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", event => events.push(event));
    projector.consume(start);
    projector.consume({ type: "response_item", payload: { type: "function_call", name: "exec_command",
      id: "raw-command", call_id: "wrapper-call", arguments: JSON.stringify({ cmd: "git status" }) } });
    projector.consume(structured({ type: "CommandExecution", id: "desktop-command", command: "git status",
      status: "completed", aggregated_output: "exact result", exit_code: 0 }));
    expect(events.at(-1)).toMatchObject({ method: "item/completed", params: {
      replacesItemId: "raw-command", item: { id: "desktop-command", aggregatedOutput: "exact result" },
    } });
    const count = events.length;
    projector.consume({ type: "response_item", payload: { type: "function_call_output", call_id: "wrapper-call", output: "wrapper result" } });
    expect(events).toHaveLength(count);
  });

  test("structured assistant/reasoning echoes do not duplicate messages or expose compaction context", () => {
    const events: Row[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", event => events.push(event));
    projector.consume(start);
    projector.consume(structured({ type: "AgentMessage", id: "answer", phase: "commentary", content: [{ type: "Text", text: "Checking files" }] }));
    expect(events.at(-1)).toMatchObject({ method: "item/completed", params: { item: { id: "answer", text: "Checking files" } } });
    projector.consume({ type: "response_item", payload: { type: "message", id: "answer", role: "assistant", content: [{ type: "output_text", text: "Checking files" }] } });
    expect(events.filter(event => event.params?.item?.id === "answer")).toHaveLength(1);
    projector.consume(structured({ type: "AgentMessage", id: "private-summary", phase: "final_answer", content: [{ type: "Text", text: "private handoff" }] }));
    projector.consume({ type: "response_item", payload: { type: "message", id: "private-summary", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "private handoff" }] } });
    projector.consume({ type: "compacted", payload: {} });
    expect(JSON.stringify(events)).not.toContain("private handoff");
  });

  test("a wrapper exposes all its real tools and command polling does not add another command", () => {
    const visible = new Map<string, Row>();
    const projector = new DesktopSessionRecordProjector("thread-1", event => {
      const params = event.params as Row;
      if (params.replacesItemId) visible.delete(params.replacesItemId);
      if (params.item) visible.set(params.item.id, params.item);
    });
    projector.consume(start);
    const wrapper = (id: string, input: string) => projector.consume({ type: "response_item", payload: {
      type: "custom_tool_call", id, call_id: id, name: "exec", input,
    } });
    const output = (id: string) => projector.consume({ type: "response_item", payload: {
      type: "custom_tool_call_output", call_id: id, output: "wrapper returned",
    } });
    wrapper("wrapper-a", 'await tools.exec_command({cmd:"git status"}); await tools.exec_command({cmd:"git diff"});');
    projector.consume(structured({ type: "CommandExecution", id: "cmd-a", command: "powershell -Command git status", status: "completed" }));
    projector.consume(structured({ type: "CommandExecution", id: "cmd-b", command: "powershell -Command git diff", status: "completed" }));
    output("wrapper-a");
    wrapper("wrapper-b", 'await tools.write_stdin({session_id:123});');
    projector.consume(structured({ type: "CommandExecution", id: "cmd-b", command: "powershell -Command git diff", status: "completed" }));
    output("wrapper-b");
    wrapper("empty-poll", 'await tools.write_stdin({session_id:123});');
    output("empty-poll");
    expect([...visible.keys()]).toEqual(["cmd-a", "cmd-b"]);
  });

  test("an older completion does not clear a newer running turn", () => {
    const events: Row[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", event => events.push(event));
    projector.consume(start);
    projector.consume(record({ type: "task_started", turn_id: "turn-2" }));
    projector.consume(end);
    expect(projector.activeTurnId()).toBe("turn-2");
    expect(events.filter(event => event.method === "turn/completed")).toHaveLength(0);
  });

  for (const splitEvent of ["start", "tool", "completion"]) {
    test(`joining during a partially saved ${splitEvent} does not lose it`, async () => {
      const home = await mkdtemp(join(tmpdir(), "remodex-live-parity-"));
      const stream = new DesktopSessionStream({ codexHome: home });
      try {
        await mkdir(join(home, "sessions"));
        const source = join(home, "sessions", "rollout.jsonl");
        const event = splitEvent === "start" ? start : splitEvent === "completion" ? end
          : structured({ type: "CommandExecution", id: "split-tool", command: "git status", status: "completed" });
        const serialized = JSON.stringify(event);
        const split = Math.floor(serialized.length / 2);
        await writeFile(source, (splitEvent === "start" ? "" : JSON.stringify(start) + "\n") + serialized.slice(0, split));
        const events: Row[] = [];
        expect(await stream.watchThread({ threadId: "thread-1", sourcePath: source, onMessage: event => events.push(event) })).toBe(true);
        await appendFile(source, serialized.slice(split) + "\n");
        const expected = splitEvent === "start" ? "turn/started" : splitEvent === "completion" ? "turn/completed" : "item/completed";
        for (let attempt = 0; attempt < 70 && !events.some(event => event.method === expected); attempt++) await Bun.sleep(20);
        expect(events.filter(event => event.method === expected)).toHaveLength(1);
        expect(stream.activeTurnId("thread-1")).toBe(splitEvent === "completion" ? null : "turn-1");
      } finally {
        stream.close();
        await rm(home, { recursive: true, force: true });
      }
    });
  }

  test("a rewritten history file resets the old working state and requests one history refresh", async () => {
    const home = await mkdtemp(join(tmpdir(), "remodex-live-rewrite-"));
    const stream = new DesktopSessionStream({ codexHome: home });
    try {
      await mkdir(join(home, "sessions"));
      const source = join(home, "sessions", "rollout.jsonl");
      await writeFile(source, JSON.stringify(start) + "\n" + JSON.stringify({ type: "padding", payload: "x".repeat(2000) }) + "\n");
      const events: Row[] = [];
      await stream.watchThread({ threadId: "thread-1", sourcePath: source, onMessage: event => events.push(event) });
      expect(stream.activeTurnId("thread-1")).toBe("turn-1");
      await writeFile(source, JSON.stringify(start) + "\n" + JSON.stringify(end) + "\n");
      for (let attempt = 0; attempt < 70 && !events.some(event => event.method === "thread/history/changed"); attempt++) await Bun.sleep(20);
      expect(stream.activeTurnId("thread-1")).toBeNull();
      expect(events.filter(event => event.method === "thread/history/changed")).toHaveLength(1);
    } finally {
      stream.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
