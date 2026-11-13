import { describe, expect, test } from "bun:test";
import { DesktopSessionRecordProjector } from "../src/android-remote/desktop-session-stream";
import { commandPollSessionId, commandSessionOutput } from "../src/android-remote/command-session-output";
import type { CodexJsonRpcMessage } from "../src/android-remote/codex-app-server";

function fixture() {
  const events: CodexJsonRpcMessage[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const projector = new DesktopSessionRecordProjector("thread", message => {
    events.push(message);
    const params = message.params as { item?: Record<string, unknown>; replacesItemId?: string };
    if (params.replacesItemId) rows.delete(params.replacesItemId);
    if (params.item?.type === "commandExecution") rows.set(String(params.item.id), params.item);
  });
  const consume = (type: string, payload: Record<string, unknown>, at = 1000) => projector.consume({
    type, timestamp: new Date(at).toISOString(), payload,
  });
  const call = (id: string, input: string, at = 1100) => consume("response_item", {
    type: "custom_tool_call", name: "exec", id, call_id: id, input,
  }, at);
  const output = (id: string, value: unknown, at = 1200) => consume("response_item", {
    type: "custom_tool_call_output", call_id: id,
    output: [{ type: "input_text", text: "Script completed" },
      { type: "input_text", text: JSON.stringify(value) }],
  }, at);
  consume("event_msg", { type: "task_started", turn_id: "turn" });
  return { events, rows, consume, call, output };
}

describe("code-mode command session activities", () => {
  test("keeps one running row while polls update the original process, then replaces it with the saved command", () => {
    const f = fixture();
    f.call("wrapper", 'text(await tools.exec_command({cmd:"python3 wait.py"}));');
    f.output("wrapper", { session_id: 42, output: "started\n" });
    expect(f.rows.get("wrapper")).toMatchObject({ status: "inProgress", exitCode: null, processId: "42" });
    for (let i = 0; i < 3; i++) {
      f.call(`poll-${i}`, 'text(await tools.write_stdin({session_id:42,chars:""}));', 1300 + i * 100);
      f.output(`poll-${i}`, { session_id: 42, output: `${i}\n` }, 1350 + i * 100);
      expect([...f.rows.keys()]).toEqual(["wrapper"]);
      expect(f.rows.get("wrapper")?.status).toBe("inProgress");
    }
    f.call("last-poll", 'text(await tools.write_stdin({session_id:42,chars:""}));', 1800);
    f.consume("event_msg", { type: "item_completed", turn_id: "turn", started_at_ms: 1150,
      item: { type: "CommandExecution", id: "native", command: ["/bin/bash", "-lc", "python3 wait.py"],
        status: "completed", aggregated_output: "started\n0\n1\n2\ndone\n", exit_code: 0 } }, 2000);
    f.output("last-poll", { output: "done\n", exit_code: 0 }, 2001);
    expect([...f.rows.keys()]).toEqual(["native"]);
    expect(f.rows.get("native")).toMatchObject({ status: "completed", exitCode: 0 });
    expect(f.events.filter(event => event.method === "item/started").every(event =>
      (event.params as { item: { id: string } }).item.id === "wrapper")).toBe(true);
  });

  test("handles terminal poll results without a canonical event and preserves failure", () => {
    const f = fixture();
    f.call("wrapper", 'text(await tools.exec_command({cmd:"check"}));');
    f.output("wrapper", { session_id: "proc-2", output: "start\n" });
    f.call("poll", "text(await tools.write_stdin({session_id:'proc-2',chars:''}));", 1300);
    f.output("poll", { output: "failed\n", exit_code: 7 }, 1400);
    expect([...f.rows.values()]).toEqual([expect.objectContaining({
      id: "wrapper", status: "failed", exitCode: 7, aggregatedOutput: "start\nfailed\n",
    })]);
  });

  test("keeps the same command when a process poll yields an exec cell and resumes through wait", () => {
    const f = fixture();
    f.call("wrapper", 'text(await tools.exec_command({cmd:"check"}));');
    f.output("wrapper", { session_id: 42, output: "started\n" });
    f.call("poll", 'text(await tools.write_stdin({session_id:42}));', 1300);
    f.consume("response_item", { type: "custom_tool_call_output", call_id: "poll",
      output: "Script running with cell ID 7\nWall time 3.0 seconds\nOutput:\n" }, 1400);
    expect(f.rows.get("wrapper")?.status).toBe("inProgress");
    f.consume("response_item", { type: "function_call", name: "wait", id: "wait", call_id: "wait",
      arguments: '{"cell_id":"7","yield_time_ms":1000}' }, 1500);
    f.output("wait", { session_id: 42, output: "still running\n" }, 1600);
    f.call("last-poll", 'text(await tools.write_stdin({session_id:42}));', 1700);
    f.output("last-poll", { exit_code: 0, output: "done\n" }, 1800);
    expect([...f.rows.values()]).toEqual([expect.objectContaining({ id: "wrapper",
      status: "completed", aggregatedOutput: "started\nstill running\ndone\n" })]);
    expect(f.events.some(event => (event.params as { item?: { type: string } }).item?.type === "dynamicToolCall")).toBe(false);
  });

  test("joins late canonical completion by command and execution interval without merging a later equal command", () => {
    const f = fixture();
    f.call("wrapper", 'const result = await tools.exec_command({cmd:"echo ok"});');
    f.consume("response_item", { type: "custom_tool_call_output", call_id: "wrapper", output: "Script completed" }, 1500);
    const canonical = (id: string, start: number) => f.consume("event_msg", {
      type: "item_completed", turn_id: "turn", started_at_ms: start,
      item: { type: "CommandExecution", id, command: ["/bin/bash", "-lc", "echo ok"], status: "completed", exit_code: 0 },
    }, 2000);
    canonical("different-execution", 1600);
    expect([...f.rows.keys()]).toEqual(["wrapper", "different-execution"]);
    canonical("same-execution", 1150);
    expect([...f.rows.keys()]).toEqual(["different-execution", "same-execution"]);
    canonical("same-execution", 1150);
    expect(f.rows.size).toBe(2);
  });

  test("does not surface a trailing wait when a poll starts after canonical completion", () => {
    const f = fixture();
    f.call("wrapper", 'text(await tools.exec_command({cmd:"check"}));');
    f.output("wrapper", { session_id: 42, output: "started\n" });
    f.consume("event_msg", { type: "item_completed", turn_id: "turn", started_at_ms: 1150,
      item: { type: "CommandExecution", id: "native", process_id: "42", command: "check",
        status: "completed", exit_code: 0 } }, 2000);
    const count = f.events.length;
    f.call("last-poll", 'text(await tools.write_stdin({session_id:42}));', 2100);
    f.consume("response_item", { type: "custom_tool_call_output", call_id: "last-poll",
      output: "Script running with cell ID 10" }, 2200);
    f.consume("response_item", { type: "function_call", name: "wait", id: "wait", call_id: "wait",
      arguments: '{"cell_id":"10"}' }, 2300);
    f.output("wait", { exit_code: 0, output: "done\n" }, 2400);
    expect(f.events).toHaveLength(count);
    expect([...f.rows.keys()]).toEqual(["native"]);
  });

  test("drops process aliases at a turn boundary and bounds accumulated poll output", () => {
    const f = fixture();
    f.call("wrapper", 'text(await tools.exec_command({cmd:"check"}));');
    f.output("wrapper", { session_id: 42, output: "a".repeat(60000) });
    f.call("poll", 'text(await tools.write_stdin({session_id:42}));');
    f.output("poll", { session_id: 42, output: "b".repeat(60000) });
    expect(String(f.rows.get("wrapper")?.aggregatedOutput).length).toBe(64 * 1024);
    f.consume("event_msg", { type: "task_complete", turn_id: "turn" }, 3000);
    f.consume("event_msg", { type: "task_started", turn_id: "next" }, 4000);
    f.call("unrelated-poll", 'text(await tools.write_stdin({session_id:42}));', 4100);
    f.output("unrelated-poll", { output: "new process", exit_code: 0 }, 4200);
    expect(f.rows.get("wrapper")?.aggregatedOutput).not.toContain("new process");
  });

  test("keeps equal commands in distinct process sessions separate", () => {
    const f = fixture();
    for (const session of [1, 2]) {
      f.call(`wrapper-${session}`, 'text(await tools.exec_command({cmd:"check"}));');
      f.output(`wrapper-${session}`, { session_id: session, output: "" });
    }
    const complete = (session: number) => f.consume("event_msg", {
      type: "item_completed", turn_id: "turn", started_at_ms: 1150,
      item: { type: "CommandExecution", id: `native-${session}`, process_id: String(session),
        command: ["/bin/bash", "-lc", "check"], status: "completed", exit_code: 0 },
    }, 2000);
    complete(3);
    expect([...f.rows.keys()]).toEqual(["wrapper-1", "wrapper-2", "native-3"]);
    complete(1);
    expect([...f.rows.keys()]).toEqual(["wrapper-2", "native-3", "native-1"]);
    complete(2);
    expect([...f.rows.keys()]).toEqual(["native-3", "native-1", "native-2"]);
  });

  test("does not infer execution state from prose, malformed, oversized, or multi-tool outputs", () => {
    for (const output of ["Script completed", '{"session_id":3}', 'bad json', 'x'.repeat(300000)]) {
      expect(commandSessionOutput({ output })).toBeNull();
    }
    expect(commandSessionOutput({ output: [1, 2].map(id => ({ text: JSON.stringify({ session_id: id, output: "" }) })) })).toBeNull();
    expect(commandPollSessionId({ input: 'tools.write_stdin({session_id:1}); tools.write_stdin({session_id:2});' })).toBeNull();
    expect(commandPollSessionId({ arguments: '{"session_id":17}' })).toBe("17");
    expect(commandPollSessionId({ input: 'tools.write_stdin({session_id:1});' + " ".repeat(128 * 1024)
      + 'tools.write_stdin({session_id:2});' })).toBeNull();
    expect(commandPollSessionId({ arguments: JSON.stringify({ session_id: 17, padding: "x".repeat(128 * 1024) }) })).toBeNull();
  });
});
