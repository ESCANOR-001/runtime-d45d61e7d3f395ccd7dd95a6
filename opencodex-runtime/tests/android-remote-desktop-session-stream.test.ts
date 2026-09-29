import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DesktopSessionRecordProjector,
  DesktopSessionStream,
} from "../src/android-remote/desktop-session-stream";
import { projectCodexLiveTurnItem } from "../src/android-remote/projection";
import { ANDROID_REMOTE_TURN_ERROR_LIMIT } from "../src/android-remote/turn-activity";
import type { CodexJsonRpcMessage } from "../src/android-remote/codex-app-server";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function responseItem(payload: Record<string, unknown>) {
  return {
    timestamp: "2026-08-12T10:00:01.000Z",
    type: "response_item",
    payload: {
      ...payload,
      internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
    },
  };
}

describe("desktop Codex session projection", () => {
  test("projects only the public request from a Desktop attachment envelope", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    const imagePath = "/tmp/codex-remote-attachments/thread/batch/1-Photo-1.jpg";
    projector.consume({
      timestamp: "2026-08-12T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    projector.consume(
      responseItem({
        type: "message",
        id: "user-1",
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "# Files mentioned by the user:",
              "",
              `## Photo 1.jpg: ${imagePath}`,
              "",
              "## My request for Codex:",
              "",
              "Show only my actual prompt.",
            ].join("\n"),
          },
          { type: "input_text", text: `<image name=[Image #1] path="${imagePath}">` },
          { type: "input_text", text: "</image>" },
        ],
      }),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        client_id: "phone-message-1",
        message: "Show only my actual prompt.",
      },
    });

    expect(messages[1]).toMatchObject({
      method: "item/completed",
      params: {
        item: {
          type: "userMessage",
          clientId: "phone-message-1",
          content: [
            { type: "text", text: "Show only my actual prompt." },
            { type: "text", text: `<image name=[Image #1] path="${imagePath}">` },
            { type: "text", text: "</image>" },
          ],
        },
      },
    });
  });

  test("projects only the real prompt appended to Windows bootstrap context", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", message =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    projector.consume(
      responseItem({
        type: "message",
        id: "windows-combined-user-message",
        role: "user",
        content: [{
          type: "input_text",
          text: [
            "<environment_context>private workspace</environment_context>",
            "<skills_instructions>private tools</skills_instructions>",
            "Keep only my prompt.",
          ].join("\n"),
        }],
      }),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:00.100Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        client_id: "windows-public-client-id",
        message: "Keep only my prompt.",
      },
    });

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      method: "item/completed",
      params: {
        item: {
          type: "userMessage",
          clientId: "windows-public-client-id",
          content: [{ type: "text", text: "Keep only my prompt." }],
        },
      },
    });
    expect(JSON.stringify(messages)).not.toContain("private workspace");
    expect(JSON.stringify(messages)).not.toContain("private tools");
  });

  test("does not publish bootstrap or raw Stop records as message bubbles", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", message =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    for (const [id, role, text] of [
      ["private-bootstrap", "user", "<skills_instructions>private tools</skills_instructions>"],
      ["windows-project-rules", "user", "# AGENTS.md instructions for C:\\Users\\Example\\project\r\n<INSTRUCTIONS>private project rules</INSTRUCTIONS>"],
      ["posix-project-rules", "user", "# AGENTS.md instructions for /home/example/project\n<INSTRUCTIONS>private project rules</INSTRUCTIONS>"],
      ["legacy-stop-row", "user", "<turn_aborted>The user interrupted the previous turn.</turn_aborted>"],
      ["misclassified-stop-row", "assistant", "<turn_aborted>The previous turn was interrupted.</turn_aborted>"],
    ] as const) {
      projector.consume(responseItem({
        type: "message",
        id,
        role,
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
      }));
    }
    projector.consume({
      timestamp: "2026-08-12T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "turn_aborted", turn_id: "turn-1" },
    });

    expect(messages.map(message => message.method)).toEqual([
      "turn/started",
      "turn/completed",
    ]);
    expect(messages[1]).toMatchObject({
      params: { turn: { id: "turn-1", status: "interrupted" } },
    });
    expect(JSON.stringify(messages)).not.toContain("turn_aborted");
    expect(JSON.stringify(messages)).not.toContain("skills_instructions");
  });

  test("applies the same transcript boundary to structured historical items", () => {
    const project = (item: Record<string, unknown>) => projectCodexLiveTurnItem({
      threadId: "thread-1",
      turnId: "turn-1",
      item,
      sequence: 1,
      createdAtMs: Date.now(),
      completed: true,
    }).message;

    expect(project({
      type: "userMessage",
      id: "combined-history-message",
      content: [{
        type: "text",
        text: "<apps_instructions>private apps</apps_instructions>\nVisible history prompt",
      }],
    })).toMatchObject({ role: "user", text: "Visible history prompt" });
    expect(project({
      type: "userMessage",
      id: "private-history-message",
      content: [{
        type: "text",
        text: "<environment_context>private workspace</environment_context>",
      }],
    })).toBeNull();
    expect(project({
      type: "userMessage",
      id: "headed-project-history",
      content: [{
        type: "text",
        text: "# AGENTS.md instructions for C:\\Users\\Example\\project\n<INSTRUCTIONS>project rules</INSTRUCTIONS>",
      }],
    })).toBeNull();
    expect(project({
      type: "agentMessage",
      id: "private-history-stop",
      text: "<turn_aborted>The previous turn was interrupted.</turn_aborted>",
    })).toBeNull();
    expect(project({
      type: "agentMessage",
      id: "ordinary-tag-discussion",
      text: "The <turn_aborted> tag represents an interrupted turn.",
    })).toMatchObject({
      role: "assistant",
      text: "The <turn_aborted> tag represents an interrupted turn.",
    });
    expect(project({
      type: "userMessage",
      id: "plain-developer-history",
      role: "developer",
      content: [{ type: "text", text: "# AGENTS.md\nPrivate tools and MCP configuration" }],
    })).toBeNull();
  });

  test("joins each steering response item to its client id without merging repeated text", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-22T10:10:20.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });

    for (const [id, clientId] of [
      ["persisted-user-1", "android-message-1"],
      ["persisted-user-2", "android-message-2"],
    ]) {
      projector.consume(
        responseItem({
          type: "message",
          id,
          role: "user",
          content: [{ type: "input_text", text: "Keep this run focused." }],
        }),
      );
      // The response row is deliberately held until its adjacent identity
      // event arrives, so Android never sees a temporary duplicate id.
      expect(messages.filter((message) => message.method === "item/completed")).toHaveLength(
        clientId === "android-message-1" ? 0 : 1,
      );
      projector.consume({
        timestamp: "2026-08-22T10:10:20.001Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          client_id: clientId,
          message: "Keep this run focused.",
        },
      });
    }

    const userItems = messages
      .filter((message) => message.method === "item/completed")
      .map((message) => (message.params as { item: JsonRecord }).item);
    expect(userItems).toEqual([
      expect.objectContaining({
        id: "persisted-user-1",
        clientId: "android-message-1",
      }),
      expect.objectContaining({
        id: "persisted-user-2",
        clientId: "android-message-2",
      }),
    ]);
  });

  test("joins a steering response item to the structured completed item client id", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-24T17:27:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    projector.consume(
      responseItem({
        type: "message",
        id: "native-response-message",
        role: "user",
        content: [{ type: "input_text", text: "Steer the running task now." }],
      }),
    );

    expect(messages.filter((message) => message.method === "item/completed")).toEqual([]);
    projector.consume({
      timestamp: "2026-08-24T17:27:00.001Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: "thread-1",
        turn_id: "turn-1",
        item: {
          type: "UserMessage",
          id: "structured-user-message",
          client_id: "android-steer-message",
          content: [{ type: "text", text: "Steer the running task now.", text_elements: [] }],
        },
      },
    });

    const userItems = messages
      .filter((message) => message.method === "item/completed")
      .map((message) => (message.params as { item: JsonRecord }).item);
    expect(userItems).toEqual([
      expect.objectContaining({
        id: "native-response-message",
        clientId: "android-steer-message",
        content: [{ type: "text", text: "Steer the running task now." }],
      }),
    ]);
  });

  test("publishes only safe model and reasoning settings and deduplicates turn context", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-17T08:55:55.291Z",
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: {
          model: "gpt-5.6-sol",
          model_provider_id: "codex-lb",
          reasoning_effort: "xhigh",
          service_tier: "fast",
          developer_instructions: "private instructions must never cross this boundary",
          cwd: "/private/workspace",
        },
      },
    });
    projector.consume({
      timestamp: "2026-08-17T08:55:55.330Z",
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        developer_instructions: "another private value",
      },
    });
    projector.consume({
      timestamp: "2026-08-17T08:55:55.800Z",
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        model: "gpt-5.6-luna",
        effort: "max",
      },
    });
    projector.consume({
      timestamp: "2026-08-17T08:55:56.000Z",
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        model: "gpt-5.6-luna",
        effort: "max",
        service_tier: null,
      },
    });

    expect(messages).toEqual([
      {
        method: "thread/settings/updated",
        params: {
          threadId: "thread-1",
          turnId: null,
          model: "gpt-5.6-sol",
          modelProviderId: "codex-lb",
          reasoningEffort: "xhigh",
          serviceTier: "priority",
          updatedAtMs: Date.parse("2026-08-17T08:55:55.291Z"),
        },
      },
      {
        method: "thread/settings/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          model: "gpt-5.6-luna",
          modelProviderId: "codex-lb",
          reasoningEffort: "max",
          updatedAtMs: Date.parse("2026-08-17T08:55:55.800Z"),
        },
      },
      {
        method: "thread/settings/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          model: "gpt-5.6-luna",
          modelProviderId: "codex-lb",
          reasoningEffort: "max",
          serviceTier: "default",
          updatedAtMs: Date.parse("2026-08-17T08:55:56.000Z"),
        },
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("private instructions");
    expect(JSON.stringify(messages)).not.toContain("private/workspace");
  });

  test("publishes exact live context usage from Desktop token-count records", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-17T08:43:04.751Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    projector.consume({
      timestamp: "2026-08-17T08:43:05.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 1_122_929_241 },
          last_token_usage: {
            input_tokens: 159_498,
            cached_input_tokens: 157_952,
            output_tokens: 294,
            reasoning_output_tokens: 32,
            total_tokens: 159_792,
          },
          model_context_window: 258_400,
        },
      },
    });

    expect(messages[1]).toMatchObject({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          last_token_usage: { total_tokens: 159_792 },
          model_context_window: 258_400,
        },
      },
    });
  });

  test("preserves structured pending user-input questions for the Android card", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-14T09:32:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    projector.consume(
      responseItem({
        type: "function_call",
        id: "input-item-1",
        call_id: "input-call-1",
        name: "request_user_input",
        arguments: JSON.stringify({
          questions: [
            {
              id: "platform_scope",
              header: "Platform",
              question: "Which platform should the UI test plan cover?",
              options: [
                { label: "Android (Recommended)", description: "Focus on Android UI tests." },
                { label: "All platforms", description: "Cover every relevant platform." },
              ],
            },
          ],
        }),
      }),
    );

    expect(messages[1]).toMatchObject({
      method: "item/started",
      params: {
        item: {
          type: "dynamicToolCall",
          id: "input-item-1",
          callId: "input-call-1",
          tool: "request_user_input",
          arguments: {
            questions: [{ id: "platform_scope", header: "Platform" }],
          },
        },
      },
    });
  });

  test("publishes a safe compaction marker and never publishes the private handoff answer", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    projector.consume(
      responseItem({
        type: "message",
        id: "private-compaction-answer",
        role: "assistant",
        phase: "final_answer",
        content: [
          { type: "output_text", text: "## Handoff Summary\n\nPrivate replacement history" },
        ],
      }),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:01.100Z",
      type: "token_usage_record",
      payload: { usage: { total_tokens: 42 } },
    });
    projector.consume({
      timestamp: "2026-08-12T10:00:01.150Z",
      type: "event_msg",
      payload: { type: "token_count" },
    });
    projector.consume({
      timestamp: "2026-08-12T10:00:01.200Z",
      type: "compacted",
      payload: {
        message: "private compaction prompt",
        replacement_history: "private generated history",
      },
    });
    projector.consume({
      timestamp: "2026-08-12T10:00:01.300Z",
      type: "event_msg",
      payload: { type: "context_compacted" },
    });

    expect(messages.map((message) => message.method)).toEqual(["turn/started", "item/completed"]);
    expect((messages[1]?.params as { item: Record<string, unknown> }).item).toMatchObject({
      type: "contextCompaction",
      status: "completed",
    });
    expect(JSON.stringify(messages)).not.toContain("Handoff Summary");
    expect(JSON.stringify(messages)).not.toContain("replacement history");
  });

  test("releases an ordinary final answer before completing its turn", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    projector.consume(
      responseItem({
        type: "message",
        id: "answer-1",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Finished safely" }],
      }),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:01.100Z",
      type: "token_usage_record",
      payload: { usage: { total_tokens: 42 } },
    });
    projector.consume({
      timestamp: "2026-08-12T10:00:01.150Z",
      type: "event_msg",
      payload: { type: "token_count" },
    });
    projector.consume({
      timestamp: "2026-08-12T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1" },
    });

    expect(messages.map((message) => message.method)).toEqual([
      "turn/started",
      "item/completed",
      "turn/completed",
    ]);
    expect((messages[1]?.params as { item: { text: string } }).item.text).toBe("Finished safely");
  });

  test("projects a failed task_complete marker with its bounded provider error", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    const errorMessage = `unexpected status 502 Bad Gateway: ${"x".repeat(
      ANDROID_REMOTE_TURN_ERROR_LIMIT,
    )}`;
    projector.consume({
      timestamp: "2026-08-12T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    projector.consume({
      timestamp: "2026-08-12T10:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        error: {
          message: errorMessage,
          privateDiagnostics: { responseBody: "must not be projected" },
        },
      },
    });

    const expectedMessage = errorMessage.slice(0, ANDROID_REMOTE_TURN_ERROR_LIMIT);
    expect(messages).toEqual([
      expect.objectContaining({ method: "turn/started" }),
      expect.objectContaining({
        method: "turn/completed",
        params: expect.objectContaining({
          turn: {
            id: "turn-1",
            status: "failed",
            error: {
              message: expectedMessage,
            },
          },
        }),
      }),
    ]);
    expect(expectedMessage).toHaveLength(ANDROID_REMOTE_TURN_ERROR_LIMIT);
    expect(JSON.stringify(messages)).not.toContain("privateDiagnostics");
  });

  test("marks an untagged final answer with its Plan-mode turn metadata", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-1",
        collaboration_mode_kind: "plan",
      },
    });
    projector.consume(
      responseItem({
        type: "message",
        id: "answer-1",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "1. Inspect\n2. Test" }],
      }),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1" },
    });

    const item = (messages[1]?.params as { item: Record<string, unknown> }).item;
    expect(item).toMatchObject({
      type: "agentMessage",
      phase: "final_answer",
      androidRemotePlanMode: true,
    });
    const projected = projectCodexLiveTurnItem({
      threadId: "thread-1",
      turnId: "turn-1",
      item,
      sequence: 1,
      createdAtMs: Date.now(),
      completed: true,
    });
    expect(projected.message).toBeNull();
    expect(projected.proposedPlan).toMatchObject({
      id: "turn-1:proposed-plan",
      planMarkdown: "1. Inspect\n2. Test",
    });
  });

  test("preserves live text and command order and removes no boundaries", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    projector.consume(
      responseItem({
        type: "message",
        id: "user-message-1",
        role: "user",
        content: [{ type: "input_text", text: "Run the live test" }],
      }),
    );
    projector.consume(
      responseItem({
        type: "reasoning",
        id: "reason-1",
        summary: [{ type: "summary_text", text: "Thinking first" }],
      }),
    );
    projector.consume(
      responseItem({
        type: "message",
        id: "message-1",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "First live block" }],
      }),
    );
    projector.consume(
      responseItem({
        type: "custom_tool_call",
        id: "command-1",
        call_id: "call-1",
        name: "exec",
        input: 'const r = await tools.exec_command({cmd:"echo one"});',
      }),
    );
    projector.consume(
      responseItem({
        type: "custom_tool_call_output",
        id: "output-1",
        call_id: "call-1",
        output: [{ type: "input_text", text: "Script completed\nOutput:\none\n" }],
      }),
    );
    projector.consume(
      responseItem({
        type: "message",
        id: "message-2",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Second live block" }],
      }),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1" },
    });

    expect(messages.map((message) => message.method)).toEqual([
      "turn/started",
      "item/completed",
      "item/completed",
      "item/completed",
      "item/started",
      "item/completed",
      "item/completed",
      "turn/completed",
    ]);
    expect(
      messages
        .map((message) => (message.params as { item?: { type?: string } }).item?.type)
        .filter(Boolean),
    ).toEqual([
      "userMessage",
      "reasoning",
      "agentMessage",
      "commandExecution",
      "commandExecution",
      "agentMessage",
    ]);
    expect(
      (messages[1]?.params as { item: { content: Array<{ type: string; text: string }> } }).item
        .content[0],
    ).toEqual({ type: "text", text: "Run the live test" });
    expect((messages[4]?.params as { item: { command: string } }).item.command).toBe("echo one");
    expect((messages[5]?.params as { item: { status: string } }).item.status).toBe("completed");
    expect((messages[3]?.params as { item: { phase: string } }).item.phase).toBe("commentary");
  });

  test("preserves a reasoning-used item when the provider returns no public summary", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    projector.consume(
      responseItem({
        type: "reasoning",
        id: "reasoning-without-summary",
        summary: [],
        content: [{ type: "reasoning_text", text: "private reasoning" }],
      }),
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      method: "item/completed",
      params: {
        item: {
          type: "reasoning",
          id: "reasoning-without-summary",
          summary: [],
        },
      },
    });
    expect(JSON.stringify(messages[1])).not.toContain("private reasoning");
  });

  test("does not publish bare internal exec wrappers as tool activities", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    projector.consume(
      responseItem({
        type: "custom_tool_call",
        id: "internal-exec",
        call_id: "internal-exec-call",
        name: "exec",
        input:
          "const matches = ALL_TOOLS.filter(tool => tool.name.includes('cloudflare')); text(matches);",
      }),
    );
    projector.consume(
      responseItem({
        type: "custom_tool_call_output",
        id: "internal-exec-output",
        call_id: "internal-exec-call",
        output: "[]",
      }),
    );

    expect(messages.map((message) => message.method)).toEqual(["turn/started"]);
  });

  test("projects wrapped plan, search, and review calls with semantic Android roles", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    projector.consume(
      responseItem({
        type: "custom_tool_call",
        id: "plan-1",
        call_id: "plan-call",
        name: "exec",
        input: [
          "const r = await tools.update_plan({plan:[",
          '{step:"Verify semantic activity icons",status:"in_progress"},',
          '{step:"Finish isolated verification",status:"pending"}',
          "]}); text(r);",
        ].join(""),
      }),
    );
    projector.consume(
      responseItem({
        type: "custom_tool_call_output",
        call_id: "plan-call",
        output: "{}",
      }),
    );
    projector.consume(
      responseItem({
        type: "custom_tool_call",
        id: "search-1",
        call_id: "search-call",
        name: "exec",
        input:
          'const r = await tools.exec_command({cmd:"rg -n marker fixture.txt"}); text(r.output);',
      }),
    );
    projector.consume(
      responseItem({
        type: "custom_tool_call_output",
        call_id: "search-call",
        output: "Script completed\nOutput:\n1:marker",
      }),
    );
    projector.consume(
      responseItem({
        type: "custom_tool_call",
        id: "review-1",
        call_id: "review-call",
        name: "exec",
        input:
          'const r = await tools.codex_app__open_in_codex({target:{type:"review",path:"fixture.txt",view:"unstaged"}}); text(r);',
      }),
    );
    projector.consume(
      responseItem({
        type: "custom_tool_call_output",
        call_id: "review-call",
        output: "queued",
      }),
    );
    projector.consume(
      responseItem({
        type: "custom_tool_call",
        id: "agent-1",
        call_id: "agent-call",
        name: "exec",
        input:
          'await tools.multi_agent_v1__spawn_agent({task_name:"icon_audit",message:"Inspect icons"});',
      }),
    );
    projector.consume(
      responseItem({
        type: "custom_tool_call_output",
        call_id: "agent-call",
        output: "started",
      }),
    );

    expect(messages[1]).toMatchObject({
      method: "turn/plan/updated",
      params: {
        plan: [
          { step: "Verify semantic activity icons", status: "in_progress" },
          { step: "Finish isolated verification", status: "pending" },
        ],
      },
    });
    expect((messages[2]?.params as { item: JsonRecord }).item).toMatchObject({
      type: "commandExecution",
      command: "rg -n marker fixture.txt",
    });
    expect((messages[4]?.params as { item: JsonRecord }).item).toMatchObject({
      type: "dynamicToolCall",
      tool: "codex_app__open_in_codex",
      arguments: { target: { type: "review" }, path: "fixture.txt" },
    });
    expect((messages[5]?.params as { item: JsonRecord }).item).toMatchObject({
      status: "completed",
      arguments: { target: { type: "review" }, path: "fixture.txt" },
    });
    expect((messages[6]?.params as { item: JsonRecord }).item).toMatchObject({
      type: "dynamicToolCall",
      tool: "multi_agent_v1__spawn_agent",
      arguments: { task_name: "icon_audit" },
    });
    expect((messages[7]?.params as { item: JsonRecord }).item).toMatchObject({
      status: "completed",
      arguments: { task_name: "icon_audit" },
    });
  });

  test("keeps exact file paths from direct and wrapped patch calls through completion", () => {
    const messages: CodexJsonRpcMessage[] = [];
    const projector = new DesktopSessionRecordProjector("thread-1", (message) =>
      messages.push(message),
    );
    projector.consume({
      timestamp: "2026-08-12T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1" },
    });
    projector.consume(
      responseItem({
        type: "function_call",
        id: "command-1",
        call_id: "call-1",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "bun test tests/live.test.ts" }),
      }),
    );
    projector.consume(
      responseItem({
        type: "function_call",
        id: "patch-1",
        call_id: "call-2",
        name: "apply_patch",
        arguments: JSON.stringify({
          patch: [
            "*** Begin Patch",
            "*** Add File: C:\\workspace\\src\\new-file.ts",
            "+new",
            "*** Update File: C:\\workspace\\src\\existing-file.ts",
            "@@",
            "-old",
            "+new",
            "*** Delete File: C:\\workspace\\src\\old-file.ts",
            "*** Update File: C:\\WORKSPACE\\SRC\\EXISTING-FILE.TS",
            "*** End Patch",
          ].join("\n"),
        }),
      }),
    );
    projector.consume(
      responseItem({
        type: "function_call_output",
        id: "patch-output-1",
        call_id: "call-2",
        output: "Done!",
      }),
    );
    const wrappedPatch = [
      "*** Begin Patch",
      "*** Update File: apps/android-remote/src/screen.tsx",
      "@@",
      "-before",
      "+after",
      "*** End Patch",
    ].join("\n");
    projector.consume(
      responseItem({
        type: "custom_tool_call",
        id: "patch-2",
        call_id: "call-3",
        name: "exec",
        input: `const patch = ${JSON.stringify(wrappedPatch)};\ntext(await tools.apply_patch(patch));`,
      }),
    );
    projector.consume(
      responseItem({
        type: "custom_tool_call_output",
        id: "patch-output-2",
        call_id: "call-3",
        output: "Done!",
      }),
    );

    expect((messages[1]?.params as { item: { type: string; command: string } }).item).toMatchObject(
      {
        type: "commandExecution",
        command: "bun test tests/live.test.ts",
      },
    );
    const expectedDirectChanges = [
      { path: "C:\\workspace\\src\\new-file.ts", kind: { type: "add" }, diff: "+new" },
      {
        path: "C:\\workspace\\src\\existing-file.ts",
        kind: { type: "update" },
        diff: "@@\n-old\n+new",
      },
      { path: "C:\\workspace\\src\\old-file.ts", kind: { type: "delete" } },
    ];
    expect((messages[2]?.params as { item: { changes: unknown[] } }).item.changes).toEqual(
      expectedDirectChanges,
    );
    expect(
      (messages[3]?.params as { item: { status: string; changes: unknown[] } }).item,
    ).toMatchObject({ status: "completed", changes: expectedDirectChanges });
    expect((messages[4]?.params as { item: { changes: unknown[] } }).item.changes).toEqual([
      {
        path: "apps/android-remote/src/screen.tsx",
        kind: { type: "update" },
        diff: "@@\n-before\n+after",
      },
    ]);
    expect(
      (messages[5]?.params as { item: { status: string; changes: unknown[] } }).item,
    ).toMatchObject({
      status: "completed",
      changes: [
        {
          path: "apps/android-remote/src/screen.tsx",
          kind: { type: "update" },
          diff: "@@\n-before\n+after",
        },
      ],
    });

    const projected = projectCodexLiveTurnItem({
      threadId: "thread-1",
      turnId: "turn-1",
      item: (messages[2]?.params as { item: Record<string, unknown> }).item,
      sequence: 7,
      createdAtMs: Date.parse("2026-08-12T10:00:01.000Z"),
      completed: false,
    });
    expect(projected.activity).toMatchObject({
      kind: "fileChange",
      summary: "File Change",
      payload: {
        itemId: "patch-1",
        itemType: "file_change",
        status: "inProgress",
        fileChanges: [
          {
            path: "C:\\workspace\\src\\new-file.ts",
            additions: 1,
            deletions: 0,
            diff: "+new",
          },
          {
            path: "C:\\workspace\\src\\existing-file.ts",
            additions: 1,
            deletions: 1,
            diff: "@@\n-old\n+new",
          },
          { path: "C:\\workspace\\src\\old-file.ts", additions: 0, deletions: 0 },
        ],
        data: { toolCallId: "patch-1" },
      },
    });
  });

  test("a file watcher publishes newly appended desktop records without a history poll", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-desktop-session-"));
    roots.push(root);
    const sessions = join(root, "sessions", "2026", "08", "12");
    mkdirSync(sessions, { recursive: true });
    const source = join(sessions, "rollout.jsonl");
    writeFileSync(
      source,
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-1" } })}\n`,
    );
    const messages: CodexJsonRpcMessage[] = [];
    const stream = new DesktopSessionStream({ codexHome: root });
    try {
      expect(
        await stream.watchThread({
          threadId: "thread-1",
          sourcePath: source,
          onMessage: (message) => messages.push(message),
        }),
      ).toBe(true);
      appendFileSync(
        source,
        [
          JSON.stringify({
            timestamp: "2026-08-12T10:00:00.000Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-1" },
          }),
          JSON.stringify(
            responseItem({
              type: "message",
              id: "message-1",
              role: "assistant",
              phase: "commentary",
              content: [{ type: "output_text", text: "Immediate block" }],
            }),
          ),
          "",
        ].join("\n"),
      );
      const deadline = Date.now() + 2_000;
      while (messages.length < 2 && Date.now() < deadline) await Bun.sleep(20);
      expect(messages.map((message) => message.method)).toEqual(["turn/started", "item/completed"]);
      expect((messages[1]?.params as { item: { text: string } }).item.text).toBe("Immediate block");
    } finally {
      stream.close();
    }
  });

  test("replays an active turn whose start is older than the fast tail window", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-desktop-session-long-turn-"));
    roots.push(root);
    const sessions = join(root, "sessions", "2026", "08", "12");
    mkdirSync(sessions, { recursive: true });
    const source = join(sessions, "rollout.jsonl");
    const filler = JSON.stringify({
      timestamp: "2026-08-12T10:00:00.500Z",
      type: "response_item",
      payload: { type: "ignored", padding: "x".repeat(256 * 1024) },
    });
    writeFileSync(
      source,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread-1" } }),
        JSON.stringify({
          timestamp: "2026-08-12T09:59:59.000Z",
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: {
              model: "gpt-5.6-sol",
              model_provider_id: "codex-lb",
              reasoning_effort: "xhigh",
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-12T10:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-1" },
        }),
        ...Array.from({ length: 68 }, () => filler),
        JSON.stringify(
          responseItem({
            type: "message",
            id: "user-message-1",
            role: "user",
            content: [{ type: "input_text", text: "Do not lose this prompt" }],
          }),
        ),
        JSON.stringify(
          responseItem({
            type: "message",
            id: "assistant-message-1",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Still working" }],
          }),
        ),
        "",
      ].join("\n"),
    );
    const messages: CodexJsonRpcMessage[] = [];
    const stream = new DesktopSessionStream({ codexHome: root });
    try {
      expect(
        await stream.watchThread({
          threadId: "thread-1",
          sourcePath: source,
          onMessage: (message) => messages.push(message),
        }),
      ).toBe(true);
      expect(messages.map((message) => message.method)).toEqual([
        "thread/settings/updated",
        "turn/started",
        "item/completed",
        "item/completed",
      ]);
      expect(messages[0]).toMatchObject({
        params: {
          model: "gpt-5.6-sol",
          modelProviderId: "codex-lb",
          reasoningEffort: "xhigh",
        },
      });
      expect(stream.activeTurnId("thread-1")).toBe("turn-1");
      expect(
        (messages[2]?.params as { item: { content: Array<{ text: string }> } }).item.content[0]
          ?.text,
      ).toBe("Do not lose this prompt");
      expect((messages[3]?.params as { item: { phase: string } }).item.phase).toBe("commentary");

      appendFileSync(
        source,
        `${JSON.stringify({
          timestamp: "2026-08-12T10:00:03.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        })}\n`,
      );
      const terminalDeadline = Date.now() + 2_000;
      while (stream.activeTurnId("thread-1") !== null && Date.now() < terminalDeadline) {
        await Bun.sleep(20);
      }
      expect(stream.activeTurnId("thread-1")).toBeNull();
    } finally {
      stream.close();
    }
  });

  test("restores picker settings for an idle completed desktop task", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-desktop-session-idle-settings-"));
    roots.push(root);
    const sessions = join(root, "sessions", "2026", "08", "12");
    mkdirSync(sessions, { recursive: true });
    const source = join(sessions, "rollout.jsonl");
    writeFileSync(
      source,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread-1" } }),
        JSON.stringify({
          timestamp: "2026-08-12T09:59:59.000Z",
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: {
              model: "gpt-5.6-luna",
              model_provider_id: "codex-lb",
              reasoning_effort: "max",
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-12T10:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-1" },
        }),
        JSON.stringify({
          timestamp: "2026-08-12T10:00:00.100Z",
          type: "turn_context",
          payload: { turn_id: "turn-1", model: "gpt-5.6-luna", effort: "max" },
        }),
        JSON.stringify({
          timestamp: "2026-08-12T10:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        }),
        "",
      ].join("\n"),
    );
    const messages: CodexJsonRpcMessage[] = [];
    const stream = new DesktopSessionStream({ codexHome: root });
    try {
      expect(
        await stream.watchThread({
          threadId: "thread-1",
          sourcePath: source,
          onMessage: (message) => messages.push(message),
        }),
      ).toBe(true);
      expect(messages).toEqual([
        {
          method: "thread/settings/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            model: "gpt-5.6-luna",
            reasoningEffort: "max",
            updatedAtMs: Date.parse("2026-08-12T10:00:00.100Z"),
          },
        },
      ]);
      expect(stream.activeTurnId("thread-1")).toBeNull();
    } finally {
      stream.close();
    }
  });

  test("restores context usage for an idle completed desktop task", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-desktop-session-idle-context-"));
    roots.push(root);
    const sessions = join(root, "sessions", "2026", "08", "12");
    mkdirSync(sessions, { recursive: true });
    const source = join(sessions, "rollout.jsonl");
    writeFileSync(
      source,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread-1" } }),
        JSON.stringify({
          timestamp: "2026-08-12T10:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-1" },
        }),
        JSON.stringify({
          timestamp: "2026-08-12T10:00:00.500Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { total_tokens: 900_000 },
              last_token_usage: { total_tokens: 96_000 },
              model_context_window: 258_400,
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-12T10:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        }),
        "",
      ].join("\n"),
    );
    const messages: CodexJsonRpcMessage[] = [];
    const stream = new DesktopSessionStream({ codexHome: root });
    try {
      expect(
        await stream.watchThread({
          threadId: "thread-1",
          sourcePath: source,
          onMessage: (message) => messages.push(message),
        }),
      ).toBe(true);
      expect(messages).toEqual([
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: null,
            tokenUsage: {
              total_token_usage: { total_tokens: 900_000 },
              last_token_usage: { total_tokens: 96_000 },
              model_context_window: 258_400,
            },
          },
        },
      ]);
    } finally {
      stream.close();
    }
  });

  test("restores completed picker settings and context older than the fast tail window", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-desktop-session-long-idle-settings-"));
    roots.push(root);
    const sessions = join(root, "sessions", "2026", "08", "12");
    mkdirSync(sessions, { recursive: true });
    const source = join(sessions, "rollout.jsonl");
    const filler = JSON.stringify({
      timestamp: "2026-08-12T10:00:00.500Z",
      type: "response_item",
      payload: { type: "ignored", padding: "x".repeat(256 * 1024) },
    });
    writeFileSync(
      source,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread-1" } }),
        JSON.stringify({
          timestamp: "2026-08-12T09:59:59.000Z",
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: {
              model: "gpt-5.6-luna",
              model_provider_id: "codex-lb",
              reasoning_effort: "max",
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-12T10:00:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-1" },
        }),
        JSON.stringify({
          timestamp: "2026-08-12T10:00:00.100Z",
          type: "turn_context",
          payload: { turn_id: "turn-1", model: "gpt-5.6-luna", effort: "max" },
        }),
        JSON.stringify({
          timestamp: "2026-08-12T10:00:00.200Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: 128_000 },
              model_context_window: 258_400,
            },
          },
        }),
        ...Array.from({ length: 68 }, () => filler),
        JSON.stringify({
          timestamp: "2026-08-12T10:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        }),
        "",
      ].join("\n"),
    );
    const messages: CodexJsonRpcMessage[] = [];
    const stream = new DesktopSessionStream({ codexHome: root });
    try {
      expect(
        await stream.watchThread({
          threadId: "thread-1",
          sourcePath: source,
          onMessage: (message) => messages.push(message),
        }),
      ).toBe(true);
      expect(messages).toEqual([
        {
          method: "thread/settings/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            model: "gpt-5.6-luna",
            reasoningEffort: "max",
            updatedAtMs: Date.parse("2026-08-12T10:00:00.100Z"),
          },
        },
        {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: { total_tokens: 128_000 },
              model_context_window: 258_400,
            },
          },
        },
      ]);
      expect(stream.activeTurnId("thread-1")).toBeNull();
    } finally {
      stream.close();
    }
  });

  test("refuses a source outside the Codex session directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-desktop-session-boundary-"));
    roots.push(root);
    mkdirSync(join(root, "sessions"), { recursive: true });
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, "{}\n");
    const stream = new DesktopSessionStream({ codexHome: root });
    try {
      expect(
        await stream.watchThread({
          threadId: "thread-1",
          sourcePath: outside,
          onMessage: () => undefined,
        }),
      ).toBe(false);
    } finally {
      stream.close();
    }
  });
});
