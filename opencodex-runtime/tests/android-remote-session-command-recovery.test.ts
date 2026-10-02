import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AndroidRemoteSessionCommandRecovery } from "../src/android-remote/session-command-recovery";

type JsonRecord = Record<string, unknown>;

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(lines: JsonRecord[]): Promise<{
  home: string;
  path: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "ocx-android-command-recovery-"));
  temporaryRoots.push(home);
  const sessions = join(home, "sessions", "2026", "08", "12");
  await mkdir(sessions, { recursive: true });
  const path = join(sessions, "rollout-test.jsonl");
  await writeFile(path, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return { home, path };
}

function thread(path: string): JsonRecord {
  return {
    id: "thread-1",
    path,
    cwd: "C:/workspace",
    turns: [{
      id: "turn-1",
      status: "completed",
      items: [
        { type: "userMessage", id: "item-100", content: [] },
        { type: "reasoning", id: "item-101", summary: ["Checking"] },
        { type: "fileChange", id: "patch-event-1", status: "completed", changes: [] },
        { type: "mcpToolCall", id: "mcp-event-1", server: "icons", tool: "search" },
        { type: "agentMessage", id: "item-102", text: "Done" },
      ],
    }],
  };
}

describe("Android Remote completed command recovery", () => {
  test("Windows page context never becomes a prompt ahead of the real saved user message", async () => {
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      { type: "turn_context", payload: { turn_id: "turn-1" } },
      { type: "response_item", payload: { type: "message", role: "user", id: "internal-page",
        content: [{ type: "input_text", text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' }] } },
      { type: "response_item", payload: { type: "message", role: "developer", id: "context", content: [{ type: "input_text", text: "Private context" }] } },
      { type: "response_item", payload: { type: "message", role: "user", id: "raw-prompt", content: [{ type: "input_text", text: "Fetch the project branches." }] } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-1", item: { type: "UserMessage", id: "public-prompt", client_id: "phone-prompt",
        content: [{ type: "text", text: "Fetch the project branches." }] } } },
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
    const seed = { id: "thread-1", path, turns: [] };
    for (const recovered of [await recovery.enrichThread(seed), (await recovery.enrichRecentThread(seed, [path]))!.thread]) {
      const users = (recovered.turns as JsonRecord[]).flatMap(turn => turn.items as JsonRecord[]).filter(item => item.type === "userMessage");
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ id: "public-prompt", clientId: "phone-prompt", content: [{ type: "text", text: "Fetch the project branches." }] });
      expect(JSON.stringify(recovered)).not.toContain("external_codex_apps_open_page");
      expect(JSON.stringify(recovered)).not.toContain("Private context");
    }
  });

  test("reads a bounded recent tail first and leaves older messages available to full recovery", async () => {
    const item = (id: string, text: string) => ({ type: "event_msg", payload: {
      type: "item_completed", turn_id: id, item: { id, type: "agentMessage", text },
    } });
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      item("old", "Older saved answer"),
      { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "private-context".repeat(180000) }] } },
      { type: "turn_context", payload: { turn_id: "new" } },
      item("new", "Newest saved answer"),
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
    const seed = { id: "thread-1", path, turns: [] };
    const recent = await recovery.enrichRecentThread(seed, [path]);
    expect(recent?.hasOlder).toBe(true);
    expect(JSON.stringify(recent)).toContain("Newest saved answer");
    expect(JSON.stringify(recent)).not.toContain("Older saved answer");
    expect(JSON.stringify(recent)).not.toContain("private-context");
    const full = await recovery.enrichThread(seed, [path]);
    expect(JSON.stringify(full)).toContain("Older saved answer");
    expect(JSON.stringify(full)).toContain("Newest saved answer");
    expect(JSON.stringify(full)).not.toContain("private-context");
    expect(await recovery.enrichRecentThread({ ...seed, id: "another-task" }, [path])).toBeNull();
    expect(await recovery.enrichRecentThread(seed, [path, path])).toBeNull();
  });

  test("recent recovery defers continuation parents to the verified lineage reader", async () => {
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1", history_base: { thread_id: "parent", end_byte_offset: 100 } } },
    ]);
    expect(await new AndroidRemoteSessionCommandRecovery({ codexHome: home })
      .enrichRecentThread({ id: "thread-1", path }, [path])).toBeNull();
  });

  test("a saved compacted record alone is a completed marker, never live compaction", async () => {
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      { type: "turn_context", payload: { turn_id: "turn-1" } },
      { type: "compacted", payload: { message: "private handoff" } },
    ]);
    const recovered = await new AndroidRemoteSessionCommandRecovery({ codexHome: home }).enrichThread(thread(path));
    const items = ((recovered.turns as JsonRecord[])[0]!.items as JsonRecord[]);
    expect(items.find(item => item.type === "contextCompaction")).toMatchObject({ status: "completed" });
    expect(JSON.stringify(recovered)).not.toContain("private handoff");
  });

  test("restores exact changed-file paths into completed task items", async () => {
    const directPatch = [
      "*** Begin Patch",
      "*** Add File: C:\\workspace\\src\\added.ts",
      "+added",
      "*** Update File: C:\\workspace\\src\\changed.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: C:\\workspace\\src\\removed.ts",
      "*** Update File: C:\\WORKSPACE\\SRC\\CHANGED.TS",
      "*** End Patch",
    ].join("\n");
    const wrappedPatch = [
      "*** Begin Patch",
      "*** Update File: apps/android-remote/src/live-row.tsx",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      { type: "turn_context", payload: { turn_id: "turn-1" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          id: "direct-patch-item",
          call_id: "direct-patch-call",
          name: "apply_patch",
          input: directPatch,
        },
      },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "direct-patch-call", output: "Done!" } },
      { type: "event_msg", payload: { type: "patch_apply_end", call_id: "desktop-file-item-1" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          id: "wrapped-patch-item",
          call_id: "wrapped-patch-call",
          name: "exec",
          input: `const patch = ${JSON.stringify(wrappedPatch)};\ntext(await tools.apply_patch(patch));`,
        },
      },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "wrapped-patch-call", output: "Done!" } },
      { type: "event_msg", payload: { type: "patch_apply_end", call_id: "desktop-file-item-2" } },
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
    const completed = thread(path);
    const turn = (completed.turns as JsonRecord[])[0]!;
    turn.items = [
      { type: "fileChange", id: "desktop-file-item-1", status: "completed", changes: [] },
      { type: "fileChange", id: "desktop-file-item-2", status: "completed", changes: [] },
    ];

    const enriched = await recovery.enrichThread(completed);
    const items = ((enriched.turns as JsonRecord[])[0]!.items as JsonRecord[]);

    expect(items).toEqual([
      expect.objectContaining({
        id: "desktop-file-item-1",
        status: "completed",
        changes: [
          { path: "C:\\workspace\\src\\added.ts", kind: { type: "add" }, diff: "+added" },
          { path: "C:\\workspace\\src\\changed.ts", kind: { type: "update" }, diff: "@@\n-old\n+new" },
          { path: "C:\\workspace\\src\\removed.ts", kind: { type: "delete" } },
        ],
      }),
      expect.objectContaining({
        id: "desktop-file-item-2",
        status: "completed",
        changes: [
          {
            path: "apps/android-remote/src/live-row.tsx",
            kind: { type: "update" },
            diff: "@@\n-old\n+new",
          },
        ],
      }),
    ]);
  });

  test("restores omitted terminal commands in their original positions", async () => {
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      { type: "turn_context", payload: { turn_id: "turn-1" } },
      { type: "response_item", payload: { type: "message", id: "user-1" } },
      { type: "response_item", payload: { type: "reasoning", id: "reasoning-1" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          id: "command-item-1",
          call_id: "command-call-1",
          name: "exec_command",
          arguments: JSON.stringify({ command: "git status" }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "command-call-1",
          output: "Process exited with code 0\nWall time: 0.25 seconds\nOutput:\nclean",
        },
      },
      { type: "response_item", payload: { type: "custom_tool_call", id: "file-1", call_id: "patch-1", name: "apply_patch", input: "patch" } },
      { type: "event_msg", payload: { type: "patch_apply_end", call_id: "patch-event-1" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          id: "command-item-2",
          call_id: "command-call-2",
          name: "exec",
          status: "completed",
          input: "const result = await tools.exec_command({ cmd: 'bun test' }); text(result.output);",
        },
      },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "command-call-2", output: [{ type: "input_text", text: "Script completed\nWall time 1.5 seconds\nOutput:\npassed" }] } },
      { type: "response_item", payload: { type: "custom_tool_call", id: "mcp-wrapper", call_id: "mcp-wrapper", name: "exec", input: "const result = await tools.mcp__icons__search_icons({ query: 'terminal' }); text(result);" } },
      { type: "event_msg", payload: { type: "mcp_tool_call_end", call_id: "mcp-event-1" } },
      { type: "response_item", payload: { type: "mcp_tool_call", id: "mcp-1" } },
      { type: "response_item", payload: { type: "message", id: "agent-1" } },
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });

    const enriched = await recovery.enrichThread(thread(path));
    const turn = (enriched.turns as JsonRecord[])[0]!;
    const items = turn.items as JsonRecord[];

    expect(items.map(item => item.type)).toEqual([
      "userMessage",
      "reasoning",
      "commandExecution",
      "fileChange",
      "commandExecution",
      "mcpToolCall",
      "agentMessage",
    ]);
    expect(items.filter(item => item.type === "commandExecution")).toEqual([
      expect.objectContaining({
        command: "git status",
        status: "completed",
        exitCode: 0,
        durationMs: 250,
        aggregatedOutput: "clean",
      }),
      expect.objectContaining({
        status: "completed",
        durationMs: 1_500,
        aggregatedOutput: "passed",
      }),
    ]);
    expect(JSON.stringify(enriched)).not.toContain("mcp__icons__search_icons");
  });

  test("restores completed routed activities that thread/read omits", async () => {
    const output = (callId: string) => ({
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: callId, output: "completed" },
    });
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      { type: "turn_context", payload: { turn_id: "turn-1" } },
      { type: "response_item", payload: { type: "message", id: "user-1", role: "user" } },
      { type: "response_item", payload: { type: "reasoning", id: "reasoning-1" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          id: "plan-item",
          call_id: "plan-call",
          name: "exec",
          input: "await tools.update_plan({plan:[{step:\"Inspect\",status:\"completed\"}]});",
        },
      },
      output("plan-call"),
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          id: "image-item",
          call_id: "image-call",
          name: "exec",
          input: "const result = await tools.view_image({path:\"/tmp/example.png\"}); image(result.image_url);",
        },
      },
      output("image-call"),
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          id: "agent-item",
          call_id: "agent-call",
          name: "exec",
          input: "await tools.multi_agent_v1__spawn_agent({message:\"Inspect\"});",
        },
      },
      output("agent-call"),
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          id: "review-item",
          call_id: "review-call",
          name: "exec",
          input: "await tools.codex_app__open_in_codex({target:{type:\"review\",path:\"fixture.ts\"}});",
        },
      },
      output("review-call"),
      {
        type: "response_item",
        payload: {
          type: "function_call",
          id: "question-item",
          call_id: "question-call",
          name: "request_user_input",
          arguments: JSON.stringify({
            questions: [{ id: "scope", question: "Which scope?", options: [] }],
          }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "question-call", output: "answered" },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          id: "mcp-wrapper",
          call_id: "mcp-wrapper-call",
          name: "exec",
          input: "await tools.mcp__icons__search_icons({query:\"image\"});",
        },
      },
      { type: "event_msg", payload: { type: "mcp_tool_call_end", call_id: "mcp-event-1" } },
      { type: "compacted", payload: {} },
      { type: "event_msg", payload: { type: "context_compacted" } },
      { type: "response_item", payload: { type: "message", id: "assistant-1", role: "assistant" } },
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
    const completed = thread(path);
    const turn = (completed.turns as JsonRecord[])[0]!;
    turn.items = [
      { type: "userMessage", id: "user-1", content: [] },
      { type: "reasoning", id: "reasoning-1", summary: ["Checking"] },
      { type: "mcpToolCall", id: "mcp-event-1", server: "icons", tool: "search" },
      { type: "agentMessage", id: "assistant-1", text: "Done" },
    ];

    const enriched = await recovery.enrichThread(completed);
    const items = ((enriched.turns as JsonRecord[])[0]!.items as JsonRecord[]);

    expect(items.map(item => item.type)).toEqual([
      "userMessage",
      "reasoning",
      "planUpdate",
      "dynamicToolCall",
      "dynamicToolCall",
      "dynamicToolCall",
      "userInputRequest",
      "mcpToolCall",
      "contextCompaction",
      "agentMessage",
    ]);
    expect(items.find(item => item.id === "image-item")).toMatchObject({
      tool: "view_image",
      status: "completed",
    });
    expect(items.find(item => item.id === "agent-item")).toMatchObject({
      tool: "multi_agent_v1__spawn_agent",
      status: "completed",
    });
    expect(items.find(item => item.id === "review-item")).toMatchObject({
      tool: "codex_app__open_in_codex",
      arguments: { target: { type: "review" } },
      status: "completed",
    });
    expect(items.find(item => item.type === "planUpdate")).toMatchObject({
      id: "turn-plan-turn-1",
      plan: [{ step: "Inspect", status: "completed" }],
    });
    expect(items.find(item => item.type === "userInputRequest")).toMatchObject({
      id: "question-item",
      status: "completed",
    });
    expect(items.find(item => item.type === "contextCompaction")).toMatchObject({
      status: "completed",
    });
    expect(JSON.stringify(enriched)).not.toContain("mcp__icons__search_icons");
  });

  test("continues indexing an appended command without needing another turn marker", async () => {
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      { type: "turn_context", payload: { turn_id: "turn-1" } },
      { type: "response_item", payload: { type: "message", id: "user-1" } },
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
    const before = await recovery.enrichThread(thread(path));
    expect(JSON.stringify(before)).not.toContain("commandExecution");

    await appendFile(path, `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: "appended-command",
        call_id: "appended-command-call",
        name: "exec",
        input: "await tools.exec_command({ cmd: 'pwd' });",
      },
    })}\n`, "utf8");

    const after = await recovery.enrichThread(thread(path));
    expect(JSON.stringify(after)).toContain("commandExecution");
    expect(JSON.stringify(after)).toContain("tools.exec_command");
  });

  test("rescans an unfinished large record from its byte offset after it is completed", async () => {
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      { type: "turn_context", payload: { turn_id: "turn-1" } },
      { type: "response_item", payload: {
        type: "custom_tool_call", id: "large-command", call_id: "large-call",
        name: "exec", input: "await tools.exec_command({ cmd: 'pwd' });",
      } },
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
    const output = Buffer.from(JSON.stringify({ type: "response_item", payload: {
      type: "custom_tool_call_output", call_id: "large-call",
      output: "你好".repeat(512 * 1024),
    } }) + "\n");
    // Split a multi-byte character as well as the JSON record across refreshes.
    const split = output.indexOf(Buffer.from("你")) + 1;
    await appendFile(path, output.subarray(0, split));
    const before = await recovery.enrichThread(thread(path));
    const command = (result: JsonRecord) => ((result.turns as JsonRecord[])[0]!.items as JsonRecord[])
      .find(item => item.id === "large-command");
    expect(command(before)?.status).toBe("inProgress");
    await appendFile(path, output.subarray(split));
    const after = await recovery.enrichThread(thread(path));
    expect(command(after)?.status).toBe("completed");
    const recoveredOutput = command(after)?.aggregatedOutput as string;
    expect(recoveredOutput.startsWith("你好")).toBe(true);
    expect(recoveredOutput).not.toContain("\uFFFD");
    expect(Buffer.byteLength(recoveredOutput)).toBeLessThanOrEqual(64 * 1024);
    expect(await recovery.enrichThread(thread(path))).toEqual(after);
  });

  test("does not read an unrelated file or a session belonging to another task", async () => {
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "another-thread" } },
      { type: "turn_context", payload: { turn_id: "turn-1" } },
      { type: "response_item", payload: { type: "function_call", id: "command", call_id: "command", name: "exec_command", arguments: JSON.stringify({ command: "whoami" }) } },
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
    const mismatched = thread(path);
    expect(await recovery.enrichThread(mismatched)).toBe(mismatched);

    const outside = join(home, "outside.jsonl");
    await writeFile(outside, "{}\n", "utf8");
    const outsideThread = thread(outside);
    expect(await recovery.enrichThread(outsideThread)).toBe(outsideThread);
  });

  test("replaces optimistic user previews with the durable rollout message and client id", async () => {
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      {
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "durable-user-message",
          role: "user",
          content: [{ type: "input_text", text: "Keep this instruction." }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Keep this instruction.",
          client_id: "android-client-message",
        },
      },
      {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1" },
      },
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
    const optimistic = {
      id: "thread-1",
      path,
      turns: [{
        id: "turn-1",
        status: "completed",
        items: [{
          type: "userMessage",
          id: "provisional-matching-message",
          clientId: "android-client-message",
          content: [{ type: "text", text: "Keep this instruction." }],
        }, {
          type: "userMessage",
          id: "failed-optimistic-message",
          clientId: "failed-client-message",
          content: [{ type: "text", text: "This send failed." }],
        }, {
          type: "dynamicToolCall",
          id: "app-server-tool-item",
          tool: "keep_me",
          status: "completed",
        }],
      }],
    };

    const enriched = await recovery.enrichThread(optimistic);
    const items = ((enriched.turns as JsonRecord[])[0]!.items as JsonRecord[]);
    expect(items).toEqual([
      expect.objectContaining({
        type: "userMessage",
        id: "durable-user-message",
        clientId: "android-client-message",
        content: [{ type: "text", text: "Keep this instruction." }],
      }),
      expect.objectContaining({
        type: "dynamicToolCall",
        id: "app-server-tool-item",
      }),
    ]);
    expect(JSON.stringify(items)).not.toContain("failed-optimistic-message");
  });

  test("recovers the prompt after bootstrap context without persisting the context", async () => {
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "windows-combined-message",
          role: "user",
          content: [{
            type: "input_text",
            text: [
              "<recommended_plugins>private plugins</recommended_plugins>",
              "<environment_context>private workspace</environment_context>",
              "Recover only this prompt.",
            ].join("\n"),
          }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Recover only this prompt.",
          client_id: "windows-public-message-id",
        },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
    const enriched = await recovery.enrichThread({
      id: "thread-1",
      path,
      turns: [{ id: "turn-1", status: "completed", items: [] }],
    });
    const items = ((enriched.turns as JsonRecord[])[0]!.items as JsonRecord[]);

    expect(items).toEqual([expect.objectContaining({
      id: "windows-combined-message",
      clientId: "windows-public-message-id",
      content: [{ type: "text", text: "Recover only this prompt." }],
    })]);
    expect(JSON.stringify(enriched)).not.toContain("private plugins");
    expect(JSON.stringify(enriched)).not.toContain("private workspace");
  });

  test("private recovered rows neither become bubbles nor discard legitimate history", async () => {
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          item: {
            type: "UserMessage",
            id: "plain-developer-context",
            role: "developer",
            content: [{ type: "Text", text: "# AGENTS.md\nPrivate tools and MCP configuration" }],
          },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          item: {
            type: "UserMessage",
            id: "structured-private-context",
            content: [{ type: "Text", text: "<skills_instructions>private tools</skills_instructions>" }],
          },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "legacy-stop-record",
          role: "user",
          content: [{
            type: "input_text",
            text: "<turn_aborted>The user interrupted the previous turn.</turn_aborted>",
          }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          item: {
            type: "AgentMessage",
            id: "misclassified-stop-record",
            content: [{
              type: "Text",
              text: "<turn_aborted>The previous turn was interrupted.</turn_aborted>",
            }],
          },
        },
      },
      { type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-1" } },
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
    const enriched = await recovery.enrichThread({
      id: "thread-1",
      path,
      turns: [{
        id: "turn-1",
        status: "interrupted",
        items: [{
          type: "userMessage",
          id: "legitimate-existing-message",
          content: [{ type: "text", text: "Keep this real prompt." }],
        }, {
          type: "agentMessage",
          id: "legitimate-existing-answer",
          text: "Keep this real answer.",
        }],
      }],
    });
    const items = ((enriched.turns as JsonRecord[])[0]!.items as JsonRecord[]);

    expect(items.map(item => item.id)).toEqual([
      "legitimate-existing-message",
      "legitimate-existing-answer",
    ]);
    expect(JSON.stringify(enriched)).not.toContain("skills_instructions");
    expect(JSON.stringify(enriched)).not.toContain("turn_aborted");
    expect(JSON.stringify(enriched)).not.toContain("AGENTS.md");
    expect(JSON.stringify(enriched)).not.toContain("MCP configuration");
  });

  test("keeps an incomplete user response pending until an appended identity event arrives", async () => {
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      {
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "incremental-user-message",
          role: "user",
          content: [{ type: "input_text", text: "Incremental identity." }],
        },
      },
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
    const base = {
      id: "thread-1",
      path,
      turns: [{ id: "turn-1", status: "inProgress", items: [] }],
    };

    const beforeIdentity = await recovery.enrichThread(base);
    expect(JSON.stringify(beforeIdentity)).not.toContain("incremental-user-message");

    await appendFile(path, `${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Incremental identity.",
        client_id: "incremental-client-id",
      },
    })}\n`, "utf8");

    const afterIdentity = await recovery.enrichThread(base);
    expect(((afterIdentity.turns as JsonRecord[])[0]!.items as JsonRecord[])).toEqual([
      expect.objectContaining({
        type: "userMessage",
        id: "incremental-user-message",
        clientId: "incremental-client-id",
      }),
    ]);
  });

  test("preserves two intentional identical durable messages with different client ids", async () => {
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      {
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "repeated-user-a",
          role: "user",
          content: [{ type: "input_text", text: "Repeat this intentionally." }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Repeat this intentionally.",
          client_id: "repeated-client-a",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "repeated-user-b",
          role: "user",
          content: [{ type: "input_text", text: "Repeat this intentionally." }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Repeat this intentionally.",
          client_id: "repeated-client-b",
        },
      },
      {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1" },
      },
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });

    const enriched = await recovery.enrichThread({
      id: "thread-1",
      path,
      turns: [{ id: "turn-1", status: "completed", items: [] }],
    });
    const items = ((enriched.turns as JsonRecord[])[0]!.items as JsonRecord[]);
    expect(items.map(item => [item.id, item.clientId])).toEqual([
      ["repeated-user-a", "repeated-client-a"],
      ["repeated-user-b", "repeated-client-b"],
    ]);
  });

  test("pairs native response rows with structured Android user items after restart", async () => {
    const { home, path } = await fixture([
      { type: "session_meta", payload: { id: "thread-1" } },
      {
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "native-response-a",
          role: "user",
          content: [{ type: "input_text", text: "Repeat this intentionally." }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          item: {
            type: "UserMessage",
            id: "structured-user-a",
            client_id: "android-client-a",
            content: [{ type: "Text", text: "Repeat this intentionally." }],
          },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "native-response-b",
          role: "user",
          content: [{ type: "input_text", text: "Repeat this intentionally." }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          item: {
            type: "UserMessage",
            id: "structured-user-b",
            client_id: "android-client-b",
            content: [{ type: "Text", text: "Repeat this intentionally." }],
          },
        },
      },
      {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1" },
      },
    ]);
    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });

    const enriched = await recovery.enrichThread({
      id: "thread-1",
      path,
      turns: [{ id: "turn-1", status: "completed", items: [] }],
    });
    const items = ((enriched.turns as JsonRecord[])[0]!.items as JsonRecord[]);
    expect(items.map(item => [item.id, item.clientId])).toEqual([
      ["structured-user-a", "android-client-a"],
      ["structured-user-b", "android-client-b"],
    ]);
    expect(JSON.stringify(items)).not.toContain("native-response");
  });

  test("merges sibling rollouts and restores later terminal turns and structured items", async () => {
    const threadId = "01a02300-0a3f-7381-ad40-9dd092c61f3a";
    const home = await mkdtemp(join(tmpdir(), "ocx-android-multi-rollout-"));
    temporaryRoots.push(home);
    const sessions = join(home, "sessions", "2026", "08", "21");
    await mkdir(sessions, { recursive: true });
    const firstPath = join(
      sessions,
      `rollout-2026-08-21T10-00-00-${threadId}.jsonl`,
    );
    const secondPath = join(
      sessions,
      `rollout-2026-08-21T11-00-00-${threadId}_continuation.jsonl`,
    );
    const line = (timestamp: string, type: string, payload: JsonRecord) => ({
      timestamp,
      type,
      payload,
    });
    await writeFile(firstPath, [
      line("2026-08-21T10:00:00.000Z", "session_meta", { id: threadId }),
      line("2026-08-21T10:00:01.000Z", "event_msg", {
        type: "task_started",
        turn_id: "turn-resumed",
      }),
      line("2026-08-21T10:00:02.000Z", "event_msg", {
        type: "item_completed",
        turn_id: "turn-resumed",
        item: {
          type: "UserMessage",
          id: "user-resumed",
          content: [{ type: "Text", text: "Continue" }],
        },
      }),
      line("2026-08-21T10:00:03.000Z", "event_msg", {
        type: "turn_aborted",
        turn_id: "turn-resumed",
      }),
      line("2026-08-21T10:01:00.000Z", "event_msg", {
        type: "task_started",
        turn_id: "turn-only-in-first-rollout",
      }),
      line("2026-08-21T10:01:01.000Z", "event_msg", {
        type: "item_completed",
        turn_id: "turn-only-in-first-rollout",
        item: {
          type: "AgentMessage",
          id: "answer-only-in-first-rollout",
          content: [{ type: "Text", text: "Intermediate answer" }],
        },
      }),
      line("2026-08-21T10:01:02.000Z", "event_msg", {
        type: "task_complete",
        turn_id: "turn-only-in-first-rollout",
      }),
    ].map(value => JSON.stringify(value)).join("\n") + "\n", "utf8");
    await writeFile(secondPath, [
      line("2026-08-21T11:00:00.000Z", "session_meta", { id: threadId }),
      line("2026-08-21T11:00:01.000Z", "turn_context", { turn_id: "turn-resumed" }),
      line("2026-08-21T11:00:02.000Z", "event_msg", {
        type: "task_complete",
        turn_id: "turn-resumed",
      }),
      line("2026-08-21T11:01:00.000Z", "event_msg", {
        type: "task_started",
        turn_id: "turn-latest",
      }),
      line("2026-08-21T11:01:01.000Z", "event_msg", {
        type: "item_started",
        turn_id: "turn-latest",
        item: {
          type: "CommandExecution",
          id: "command-1",
          command: ["bun", "test"],
          status: "InProgress",
        },
      }),
      line("2026-08-21T11:01:02.000Z", "event_msg", {
        type: "item_completed",
        turn_id: "turn-latest",
        item: {
          type: "CommandExecution",
          id: "command-1",
          command: ["bun", "test"],
          cwd: "/workspace",
          status: "Completed",
          parsed_cmd: [{ type: "Unknown" }],
          aggregated_output: "passed",
          exit_code: 0,
          duration_ms: 250,
        },
      }),
      line("2026-08-21T11:01:03.000Z", "event_msg", {
        type: "item_completed",
        turn_id: "turn-latest",
        item: {
          type: "FileChange",
          id: "patch-1",
          status: "Completed",
          changes: {
            "/workspace/example.ts": {
              type: "update",
              unified_diff: "@@\n-old\n+new",
            },
          },
        },
      }),
      line("2026-08-21T11:01:04.000Z", "event_msg", {
        type: "item_completed",
        turn_id: "turn-latest",
        item: { type: "ImageView", id: "image-1", path: "/tmp/example.png" },
      }),
      line("2026-08-21T11:01:05.000Z", "event_msg", {
        type: "item_completed",
        turn_id: "turn-latest",
        item: { type: "ContextCompaction", id: "compaction-1" },
      }),
      line("2026-08-21T11:01:06.000Z", "event_msg", {
        type: "item_completed",
        turn_id: "turn-latest",
        item: {
          type: "DynamicToolCall",
          id: "dynamic-1",
          tool: "lookup",
          status: "Completed",
          arguments: { query: "short" },
        },
      }),
      line("2026-08-21T11:01:07.000Z", "event_msg", {
        type: "task_complete",
        turn_id: "turn-latest",
      }),
    ].map(value => JSON.stringify(value)).join("\n") + "\n", "utf8");

    const recovery = new AndroidRemoteSessionCommandRecovery({ codexHome: home });
    const enriched = await recovery.enrichThread({
      id: threadId,
      path: secondPath,
      turns: [{
        id: "turn-resumed",
        status: "interrupted",
        startedAt: Date.parse("2026-08-21T10:00:01.000Z") / 1_000,
        completedAt: null,
        items: [],
      }],
    });
    const turns = enriched.turns as JsonRecord[];

    expect(turns.map(turn => turn.id)).toEqual([
      "turn-resumed",
      "turn-only-in-first-rollout",
      "turn-latest",
    ]);
    expect(turns[0]).toMatchObject({
      status: "completed",
      completedAt: Date.parse("2026-08-21T11:00:02.000Z") / 1_000,
    });
    expect(turns[1]).toMatchObject({
      status: "completed",
      items: [expect.objectContaining({
        id: "answer-only-in-first-rollout",
        type: "agentMessage",
        text: "Intermediate answer",
      })],
    });
    const latestItems = turns[2]!.items as JsonRecord[];
    expect(latestItems.map(item => item.type)).toEqual([
      "commandExecution",
      "fileChange",
      "imageView",
      "contextCompaction",
      "dynamicToolCall",
    ]);
    expect(latestItems.filter(item => item.id === "command-1")).toHaveLength(1);
    expect(latestItems[0]).toMatchObject({
      command: "bun test",
      cwd: "/workspace",
      status: "completed",
      aggregatedOutput: "passed",
      exitCode: 0,
      durationMs: 250,
    });
    expect(latestItems[1]).toMatchObject({
      changes: [{
        path: "/workspace/example.ts",
        kind: { type: "update" },
        diff: "@@\n-old\n+new",
      }],
    });
  });
});
