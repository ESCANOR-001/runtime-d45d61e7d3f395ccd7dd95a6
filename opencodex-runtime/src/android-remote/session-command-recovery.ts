import { open, realpath, stat } from "node:fs/promises";
import { createHash, type Hash } from "node:crypto";
import { generatedImagePaths, imageGenerationWaitCell, runningImageGenerationCell } from "./generated-images";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { deepCamelValue, durationMilliseconds, itemType, normalizedCompletedItem } from "./desktop-thread-item";
import { getCodexHome } from "../codex/paths";
import { planUpdateFromToolCall, toolItem } from "./desktop-session-stream";
import { fileChangesFromToolCall, type AndroidRemoteFileChange } from "./file-change-parser";
import {
  canonicalUserMessageText,
  isPrivateTranscriptRole,
  publicUserMessageText,
  sanitizePublicTranscriptText,
} from "./user-message-identity";
import { resolveThreadSourcePaths } from "./thread-source-paths";
import { desktopAsyncQuestionItem, desktopQuestionReplyIds } from "./desktop-interactions";

type JsonRecord = Record<string, unknown>;

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_CACHE_ENTRIES = 6;
const RECENT_HISTORY_BYTES = 2 * 1024 * 1024;

type RecoveredCommand = {
  callId: string;
  itemId: string;
  order: number;
  command: string;
  status: string;
  output: string | null;
  exitCode: number | null;
  durationMs: number | null;
};

type RecoveredFileChange = {
  callId: string;
  itemId: string;
  order: number;
  status: string;
  changes: AndroidRemoteFileChange[];
};

type RecoveredActivity = {
  callId: string;
  itemId: string;
  order: number;
  item: JsonRecord;
};

type RecoveredTurnItem = {
  order: number;
  item: JsonRecord;
};

type RecoveredTurn = {
  id: string;
  order: number;
  status: "inProgress" | "completed" | "interrupted" | "failed";
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  error: JsonRecord | null;
  collaborationMode: JsonRecord | null;
  items: Map<string, RecoveredTurnItem>;
  canonicalItemEvents: boolean;
  durableUserMessages: boolean;
};

type PendingDurableUserMessage = {
  turnId: string;
  order: number;
  item: JsonRecord;
  comparisonText: string;
};

type TurnRecovery = {
  commands: Map<string, RecoveredCommand>;
  fileChanges: Map<string, RecoveredFileChange>;
  activities: Map<string, RecoveredActivity>;
  responseOrder: Map<string, number>;
  anchors: Array<{
    type: "userMessage" | "agentMessage" | "reasoning" | "mcpToolCall" | "fileChange";
    order: number;
  }>;
};

type SessionCache = {
  canonicalPath: string;
  device: number | bigint;
  inode: number | bigint;
  size: number;
  completeOffset: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  threadId: string | null;
  /** Physical rollout identity used by Codex continuation metadata. */
  physicalId: string | null;
  historyBaseThreadId: string | null;
  historyBaseEndByteOffset: number | null;
  mtimeNs: bigint;
  currentTurnId: string | null;
  nextTurnPlanMode: boolean;
  turnsInOrder: string[];
  recoveredTurns: Map<string, RecoveredTurn>;
  turns: Map<string, TurnRecovery>;
  pendingUserMessage: PendingDurableUserMessage | null;
  touchedAt: number;
  lastDamagedRecordOrder?: number;
};

export interface AndroidRemoteCommandRecovery {
  resolveSourcePaths?(threadId: string, explicit: readonly string[]): Promise<string[]>;
  enrichRecentThread?(thread: JsonRecord, sourcePaths: readonly string[]): Promise<{ thread: JsonRecord; hasOlder: boolean } | null>;
  enrichThread(thread: JsonRecord, sourcePaths?: readonly string[]): Promise<JsonRecord>;
  clear(): void;
}

export type AndroidRemoteSessionCommandRecoveryOptions = {
  codexHome?: string;
  now?: () => number;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bounded(value: string, maximumBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  return new TextDecoder().decode(encoded.subarray(0, maximumBytes)).replace(/\uFFFD$/u, "");
}

function turnRecovery(turns: Map<string, TurnRecovery>, turnId: string): TurnRecovery {
  const existing = turns.get(turnId);
  if (existing) return existing;
  const created: TurnRecovery = {
    commands: new Map(),
    fileChanges: new Map(),
    activities: new Map(),
    responseOrder: new Map(),
    anchors: [],
  };
  turns.set(turnId, created);
  return created;
}

function recoveredTurn(cache: SessionCache, turnId: string, order: number): RecoveredTurn {
  const existing = cache.recoveredTurns.get(turnId);
  if (existing) return existing;
  const created: RecoveredTurn = {
    id: turnId,
    order,
    status: "inProgress",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    error: null,
    collaborationMode: null,
    items: new Map(),
    canonicalItemEvents: false,
    durableUserMessages: false,
  };
  cache.recoveredTurns.set(turnId, created);
  cache.turnsInOrder.push(turnId);
  return created;
}

function timestampSeconds(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric !== null) {
    return numeric > 10_000_000_000 ? numeric / 1_000 : numeric;
  }
  const parsed = Date.parse(stringValue(value));
  return Number.isFinite(parsed) ? parsed / 1_000 : null;
}

function rememberRecoveredTurnItem(
  cache: SessionCache,
  turnId: string,
  order: number,
  value: unknown,
  completed: boolean,
): void {
  const item = normalizedCompletedItem(value, completed);
  if (!item) return;
  const turn = recoveredTurn(cache, turnId, order);
  const id = stringValue(item.id);
  const existing = turn.items.get(id);
  turn.items.set(id, {
    order: existing?.order ?? order,
    item: {
      ...(existing?.item ?? {}),
      ...item,
    },
  });
  turn.canonicalItemEvents ||= completed;
  if (item.type === "userMessage") turn.durableUserMessages = true;
}

function responseMessageText(payload: JsonRecord): string {
  if (!Array.isArray(payload.content)) return "";
  return payload.content.flatMap(value => {
    const row = record(value);
    const part = row && typeof row.text === "string"
      ? row.text
      : row && typeof row.value === "string"
        ? row.value
        : "";
    return part ? [part] : [];
  }).join("");
}

function responseUserMessageContent(payload: JsonRecord): JsonRecord[] {
  if (!Array.isArray(payload.content)) return [];
  return payload.content.flatMap(value => {
    const row = record(value);
    const text = publicUserMessageText(row?.text ?? row?.value);
    return text ? [{ type: "text", text }] : [];
  });
}

function recoveredUserMessageText(value: unknown): string {
  const item = record(value);
  if (!item || item.type !== "userMessage" || !Array.isArray(item.content)) return "";
  return canonicalUserMessageText(item.content.flatMap(partValue => {
    const part = record(partValue);
    const text = stringValue(part?.text);
    return text ? [text] : [];
  }).join(""));
}

function rememberPendingUserMessage(
  cache: SessionCache,
  pending: PendingDurableUserMessage,
  clientId = "",
): void {
  if (!Array.isArray(pending.item.content) || pending.item.content.length === 0) return;
  const turn = recoveredTurn(cache, pending.turnId, pending.order);
  const item: JsonRecord = {
    ...pending.item,
    ...(clientId ? { clientId } : {}),
  };
  const matchingEntry = clientId
    ? [...turn.items.entries()].find(([, existing]) =>
        existing.item.type === "userMessage"
        && stringValue(existing.item.clientId ?? existing.item.client_id).trim() === clientId)
    : undefined;
  const key = matchingEntry?.[0] ?? stringValue(item.id);
  const existing = matchingEntry?.[1] ?? turn.items.get(key);
  turn.items.set(key, {
    order: existing?.order ?? pending.order,
    item: {
      ...(existing?.item ?? {}),
      ...item,
    },
  });
  turn.durableUserMessages = true;
}

function outputText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const entry of value) {
    const row = record(entry);
    if (!row) continue;
    const text = stringValue(row.text);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : null;
}

function parseCommandOutput(value: string): {
  output: string;
  exitCode: number | null;
  durationMs: number | null;
} {
  let exitCode: number | null = null;
  let durationMs: number | null = null;
  let pastHeader = false;
  const output: string[] = [];
  for (const line of value.replaceAll("\r\n", "\n").split("\n")) {
    if (!pastHeader) {
      const exit = /^(?:Process|Command|Script) (?:exited|failed) with (?:code|exit code) (-?\d+)$/u.exec(line);
      if (exit?.[1]) {
        exitCode = Number.parseInt(exit[1], 10);
        continue;
      }
      const wall = /^Wall time:?\s+([\d.]+)\s+(?:seconds?|s)$/u.exec(line);
      if (wall?.[1]) {
        durationMs = Math.round(Number.parseFloat(wall[1]) * 1_000);
        continue;
      }
      if (
        line === "Script completed" ||
        line.startsWith("Command:") ||
        line.startsWith("Chunk ID:") ||
        line.startsWith("Original token count:")
      ) {
        continue;
      }
      if (line === "Output:" || line === "Final output:") {
        pastHeader = true;
        continue;
      }
    }
    output.push(line);
  }
  return {
    output: bounded(output.join("\n").trimEnd(), MAX_OUTPUT_BYTES),
    exitCode,
    durationMs,
  };
}

function commandFromFunctionCall(payload: JsonRecord): string | null {
  const raw = stringValue(payload.arguments);
  if (!raw) return null;
  try {
    const args = record(JSON.parse(raw));
    const command = args?.command;
    if (typeof command === "string" && command.trim()) return command;
    if (Array.isArray(command)) {
      const joined = command.filter(value => typeof value === "string").join(" ").trim();
      if (joined) return joined;
    }
    for (const key of ["cmd", "script", "input"] as const) {
      const value = stringValue(args?.[key]).trim();
      if (value) return value;
    }
  } catch {
    return raw;
  }
  return raw;
}

function customExecCommand(payload: JsonRecord): string | null {
  const input = stringValue(payload.input);
  if (!input || !/\btools\.exec_command\s*\(/u.test(input)) return null;
  return input;
}

function responseIdentity(payload: JsonRecord): string[] {
  return [stringValue(payload.id), stringValue(payload.call_id)].filter(Boolean);
}

function consumeRecord(
  parsed: JsonRecord,
  order: number,
  state: { currentTurnId: string | null; cache: SessionCache },
): void {
  const timestamp = timestampSeconds(parsed.timestamp);
  if (timestamp !== null) {
    state.cache.firstTimestamp = state.cache.firstTimestamp === null
      ? timestamp
      : Math.min(state.cache.firstTimestamp, timestamp);
    state.cache.lastTimestamp = state.cache.lastTimestamp === null
      ? timestamp
      : Math.max(state.cache.lastTimestamp, timestamp);
  }
  const payload = record(parsed.payload);
  if (!payload) return;
  const rowType = stringValue(parsed.type);
  const payloadType = stringValue(payload.type);
  // Codex may insert a private attachment/resize notice between the response
  // and its durable user item. It is not a public message boundary.
  const privateContextMessage = rowType === "response_item" && payloadType === "message"
    && (payload.role === "developer" || payload.role === "system");
  const userMessageIdentityEvent =
    rowType === "event_msg" && payloadType === "user_message";
  if (state.cache.pendingUserMessage && !privateContextMessage) {
    const pending = state.cache.pendingUserMessage;
    const completedUserItem = rowType === "event_msg"
      && (payloadType === "item_started" || payloadType === "item_completed")
      ? normalizedCompletedItem(payload.item, payloadType === "item_completed")
      : null;
    const completedUserTurnId = stringValue(payload.turn_id) || state.currentTurnId;
    if (
      completedUserItem?.type === "userMessage"
      && completedUserTurnId === pending.turnId
      && recoveredUserMessageText(completedUserItem) === pending.comparisonText
    ) {
      // Current Codex rollouts persist one logical phone prompt twice: first
      // as the native response item, then as the structured ThreadItem that
      // carries the Android client id. They are adjacent representations of
      // one message, not two chat bubbles. Preserve the earlier ordering while
      // letting the structured item provide the stable visible identity.
      state.cache.pendingUserMessage = null;
      rememberRecoveredTurnItem(
        state.cache,
        pending.turnId,
        pending.order,
        payload.item,
        payloadType === "item_completed",
      );
      return;
    }
    const clientId = userMessageIdentityEvent
      ? stringValue(payload.client_id ?? payload.clientId).trim()
      : "";
    const comparisonText = userMessageIdentityEvent
      ? canonicalUserMessageText(payload.message)
      : "";
    if (
      userMessageIdentityEvent
      && clientId
      && comparisonText === pending.comparisonText
    ) {
      state.cache.pendingUserMessage = null;
      rememberPendingUserMessage(state.cache, pending, clientId);
      return;
    }
    state.cache.pendingUserMessage = null;
    rememberPendingUserMessage(state.cache, pending);
  }
  // The identity event enriches the immediately preceding response item. It
  // never represents another standalone Android message.
  if (userMessageIdentityEvent) return;
  if (rowType === "session_meta") {
    const id = stringValue(payload.id) || stringValue(payload.session_id);
    if (id && state.cache.threadId === null) state.cache.threadId = id;
    const historyBase = record(payload.history_base);
    if (historyBase) {
      const parent = stringValue(historyBase.thread_id);
      if (parent) state.cache.historyBaseThreadId = parent;
      state.cache.historyBaseEndByteOffset = finiteNumber(historyBase.end_byte_offset);
    }
    return;
  }
  if (rowType === "turn_context") {
    state.currentTurnId = stringValue(payload.turn_id) || null;
    state.cache.currentTurnId = state.currentTurnId;
    if (state.currentTurnId) {
      const turn = recoveredTurn(state.cache, state.currentTurnId, order);
      const collaborationMode = record(deepCamelValue(payload.collaboration_mode));
      if (collaborationMode) turn.collaborationMode = collaborationMode;
    }
    return;
  }
  if (rowType === "event_msg") {
    const event = stringValue(payload.type);
    if (event === "thread_settings_applied") {
      const settings = record(payload.thread_settings);
      state.cache.nextTurnPlanMode =
        stringValue(record(settings?.collaboration_mode)?.mode) === "plan";
      return;
    }
    if (event === "task_started") {
      state.currentTurnId = stringValue(payload.turn_id) || state.currentTurnId;
      state.cache.currentTurnId = state.currentTurnId;
      if (state.currentTurnId) {
        const turn = recoveredTurn(state.cache, state.currentTurnId, order);
        turn.status = "inProgress";
        turn.startedAt = timestampSeconds(payload.started_at)
          ?? timestampSeconds(parsed.timestamp)
          ?? turn.startedAt;
        if (
          stringValue(payload.collaboration_mode_kind) === "plan"
          || state.cache.nextTurnPlanMode
        ) {
          turn.collaborationMode = { mode: "plan" };
        }
      }
      state.cache.nextTurnPlanMode = false;
      return;
    }
    if (event === "task_complete" || event === "turn_aborted") {
      const turnId = stringValue(payload.turn_id) || state.currentTurnId;
      if (turnId) {
        const turn = recoveredTurn(state.cache, turnId, order);
        const error = record(deepCamelValue(payload.error));
        turn.status = event === "turn_aborted"
          ? "interrupted"
          : error
            ? "failed"
            : "completed";
        turn.error = error;
        turn.startedAt = timestampSeconds(payload.started_at) ?? turn.startedAt;
        turn.completedAt = timestampSeconds(payload.completed_at)
          ?? timestampSeconds(parsed.timestamp)
          ?? turn.completedAt;
        turn.durationMs = durationMilliseconds(payload.duration_ms) ?? turn.durationMs;
      }
      if (!turnId || state.currentTurnId === turnId) {
        state.currentTurnId = null;
        state.cache.currentTurnId = null;
      }
      return;
    }
    if (event === "item_started" || event === "item_completed") {
      const turnId = stringValue(payload.turn_id) || state.currentTurnId;
      if (turnId) {
        const normalized = normalizedCompletedItem(payload.item, event === "item_completed");
        if (normalized?.type === "imageGeneration") {
          const pendingImages = [...turnRecovery(state.cache.turns, turnId).activities.values()]
            .filter(activity => activity.item.type === "imageGeneration" && activity.item.status === "inProgress");
          if (pendingImages.length === 1) {
            const pending = pendingImages[0]!;
            pending.item = { ...pending.item, generatedImages: generatedImagePaths([pending.item, normalized]),
              ...(normalized.status === "failed" ? { androidRemoteImageFailed: true } : {}) };
            rememberRecoveredTurnItem(state.cache, turnId, pending.order, pending.item, false);
            return;
          }
        }
        rememberRecoveredTurnItem(
          state.cache,
          turnId,
          order,
          payload.item,
          event === "item_completed",
        );
      }
      return;
    }
    if (event === "thread_rolled_back") {
      const count = Math.max(0, Math.floor(finiteNumber(payload.num_turns) ?? 0));
      const removed = state.cache.turnsInOrder.splice(Math.max(0, state.cache.turnsInOrder.length - count));
      for (const turnId of removed) {
        state.cache.recoveredTurns.delete(turnId);
        state.cache.turns.delete(turnId);
      }
      state.currentTurnId = null;
      state.cache.currentTurnId = null;
      return;
    }
    if (event === "error" && state.currentTurnId) {
      const turn = recoveredTurn(state.cache, state.currentTurnId, order);
      turn.status = "failed";
      turn.error = {
        message: stringValue(payload.message) || "Codex task failed",
      };
    }
  }
  if (rowType === "compacted" && state.currentTurnId) {
    const recovery = turnRecovery(state.cache.turns, state.currentTurnId);
    const itemId = `context-compaction-${state.currentTurnId}`;
    recovery.activities.set(itemId, {
      callId: itemId,
      itemId,
      order,
      item: { type: "contextCompaction", id: itemId, status: "completed" },
    });
    return;
  }
  if (rowType === "event_msg" && state.currentTurnId) {
    const recovery = turnRecovery(state.cache.turns, state.currentTurnId);
    const callId = stringValue(payload.call_id);
    if (payload.type === "context_compacted") {
      const itemId = `context-compaction-${state.currentTurnId}`;
      const existing = recovery.activities.get(itemId);
      recovery.activities.set(itemId, {
        callId: itemId,
        itemId,
        order: existing?.order ?? order,
        item: { type: "contextCompaction", id: itemId, status: "completed" },
      });
    } else if (payload.type === "mcp_tool_call_end") {
      recovery.anchors.push({ type: "mcpToolCall", order });
      if (callId) recovery.responseOrder.set(callId, order);
    } else if (payload.type === "patch_apply_end") {
      recovery.anchors.push({ type: "fileChange", order });
      if (callId) recovery.responseOrder.set(callId, order);
    }
    return;
  }
  if (rowType === "response_item" && payloadType === "message" && payload.role === "user") {
    const answeredIds = desktopQuestionReplyIds(payload);
    if (answeredIds.length) {
      for (const turn of state.cache.recoveredTurns.values()) {
        for (const entry of turn.items.values()) {
          if (!desktopAsyncQuestionItem(entry.item)) continue;
          entry.item = { ...entry.item, androidRemoteAnsweredQuestionIds: [
            ...(Array.isArray(entry.item.androidRemoteAnsweredQuestionIds) ? entry.item.androidRemoteAnsweredQuestionIds : []),
            ...answeredIds,
          ] };
        }
      }
    }
    const metadata = record(payload.internal_chat_message_metadata_passthrough);
    const turnId = stringValue(metadata?.turn_id) || state.currentTurnId;
    const id = stringValue(payload.id).trim();
    const rawText = responseMessageText(payload);
    if (!turnId || !id || !rawText) return;
    const publicText = sanitizePublicTranscriptText(rawText);
    const content = responseUserMessageContent(payload);
    if (publicText === null || !publicText || content.length === 0) return;
    state.currentTurnId = turnId;
    state.cache.currentTurnId = turnId;
    const recovery = turnRecovery(state.cache.turns, turnId);
    recovery.anchors.push({ type: "userMessage", order });
    recovery.responseOrder.set(id, order);
    state.cache.pendingUserMessage = {
      turnId,
      order,
      item: {
        type: "userMessage",
        id,
        content,
      },
      comparisonText: canonicalUserMessageText(publicText),
    };
    return;
  }
  if (rowType !== "response_item" || !state.currentTurnId) return;

  const recovery = turnRecovery(state.cache.turns, state.currentTurnId);
  for (const id of responseIdentity(payload)) {
    if (!recovery.responseOrder.has(id)) recovery.responseOrder.set(id, order);
  }
  const type = payloadType;
  const name = stringValue(payload.name);
  if (type === "reasoning") {
    recovery.anchors.push({ type: "reasoning", order });
  } else if (type === "message") {
    const role = stringValue(payload.role);
    if (role === "user") recovery.anchors.push({ type: "userMessage", order });
    else if (role === "assistant") {
      const publicText = sanitizePublicTranscriptText(responseMessageText(payload));
      if (publicText) recovery.anchors.push({ type: "agentMessage", order });
    }
  }
  const callId = stringValue(payload.call_id) || stringValue(payload.id);
  if (!callId) return;
  const asyncQuestion = desktopAsyncQuestionItem(payload);
  if (asyncQuestion) {
    rememberRecoveredTurnItem(state.cache, state.currentTurnId, order, asyncQuestion, false);
    return;
  }

  const planUpdate = planUpdateFromToolCall(payload);
  if (planUpdate) {
    const itemId = `turn-plan-${state.currentTurnId}`;
    recovery.activities.set(itemId, {
      callId,
      itemId,
      order,
      item: {
        type: "planUpdate",
        id: itemId,
        status: "completed",
        plan: planUpdate.plan,
        ...(planUpdate.explanation ? { explanation: planUpdate.explanation } : {}),
      },
    });
    return;
  }

  const fileChanges = fileChangesFromToolCall(payload);
  if (fileChanges.length > 0) {
    if (!recovery.fileChanges.has(callId)) {
      recovery.fileChanges.set(callId, {
        callId,
        itemId: stringValue(payload.id) || callId,
        order,
        status: stringValue(payload.status) || "inProgress",
        changes: fileChanges,
      });
    }
    return;
  }

  let command: string | null = null;
  if (type === "function_call" && ["exec_command", "shell", "shell_command"].includes(name)) {
    command = commandFromFunctionCall(payload);
  } else if (type === "custom_tool_call" && name === "exec" && toolItem(payload)?.type !== "imageGeneration") {
    // New Codex sessions wrap every tool through a generic `exec` record.
    // Only the wrappers that actually call exec_command are terminal rows;
    // MCP calls and other nested tools must keep their own activity type.
    command = customExecCommand(payload);
  }
  if (command) {
    if (!recovery.commands.has(callId)) {
      recovery.commands.set(callId, {
        callId,
        itemId: stringValue(payload.id) || callId,
        order,
        command: bounded(command, MAX_COMMAND_BYTES),
        status: stringValue(payload.status) || "inProgress",
        output: null,
        exitCode: null,
        durationMs: null,
      });
    }
    return;
  }

  if (type === "function_call" || type === "custom_tool_call") {
    const waitingCell = imageGenerationWaitCell(payload);
    const waitingImage = waitingCell ? [...recovery.activities.values()].find(activity => activity.item.status === "inProgress" && activity.item.androidRemoteImageCellId === waitingCell) : undefined;
    if (waitingImage) {
      recovery.activities.delete(waitingImage.callId);
      waitingImage.callId = callId;
      recovery.activities.set(callId, waitingImage);
      return;
    }
    const recoveredTool = toolItem(payload);
    if (recoveredTool?.type === "dynamicToolCall" || recoveredTool?.type === "imageGeneration") {
      const recoveredToolName = stringValue(recoveredTool.tool);
      // MCP calls already have a durable first-class `mcpToolCall` item in
      // thread/read. Replaying their outer JavaScript router would duplicate
      // one visible action under a second generic tool id.
      if (!recoveredToolName.startsWith("mcp__")) {
        const toolToken = recoveredToolName.split("__").at(-1);
        const item = toolToken === "request_user_input"
          ? {
              type: "userInputRequest",
              id: stringValue(recoveredTool.id) || callId,
              status: "inProgress",
              questions: record(recoveredTool.arguments)?.questions,
            }
          : recoveredTool;
        recovery.activities.set(callId, {
          callId,
          itemId: stringValue(item.id) || callId,
          order,
          item,
        });
        if (item.type === "imageGeneration") rememberRecoveredTurnItem(state.cache, state.currentTurnId, order, item, false);
      }
    }
    return;
  }

  if (type !== "function_call_output" && type !== "custom_tool_call_output") return;
  const rawOutput = outputText(payload.output);
  const output = rawOutput === null ? null : parseCommandOutput(rawOutput);
  const failed = typeof output?.exitCode === "number" && output.exitCode !== 0;
  const recoveredActivity = recovery.activities.get(callId);
  if (recoveredActivity) {
    const runningCell = recoveredActivity.item.type === "imageGeneration" ? runningImageGenerationCell(rawOutput ?? "") : null;
    recoveredActivity.item = {
      ...recoveredActivity.item,
      status: runningCell ? "inProgress" : failed || recoveredActivity.item.androidRemoteImageFailed === true ? "failed" : "completed",
      ...(runningCell ? { androidRemoteImageCellId: runningCell } : {}),
      ...(recoveredActivity.item.type === "imageGeneration" ? { generatedImages: generatedImagePaths([recoveredActivity.item, payload]) } : {}),
    };
    if (recoveredActivity.item.type === "imageGeneration") rememberRecoveredTurnItem(state.cache, state.currentTurnId, recoveredActivity.order, recoveredActivity.item, true);
  }
  const recoveredFileChange = recovery.fileChanges.get(callId);
  if (recoveredFileChange) {
    recoveredFileChange.status = failed ? "failed" : "completed";
  }
  const recovered = recovery.commands.get(callId);
  if (!recovered || !output) return;
  recovered.output = output.output;
  recovered.exitCode = output.exitCode;
  recovered.durationMs = output.durationMs;
  recovered.status = failed ? "failed" : "completed";
}

async function scanSession(
  cache: SessionCache,
  startOffset: number,
  sourcePath = cache.canonicalPath,
  endOffset = cache.size,
  orderBase = 0,
  strict = false,
  fingerprint?: Hash,
): Promise<number> {
  const decoder = new TextDecoder();
  let absoluteOffset = startOffset;
  let lineStart = startOffset;
  let parts: Uint8Array[] = [];
  let lineBytes = 0;
  let oversized = false;
  let zeroFilled = true;
  const state = { currentTurnId: cache.currentTurnId, cache };

  const append = (bytes: Uint8Array) => {
    if (zeroFilled && bytes.some(byte => byte !== 0)) zeroFilled = false;
    lineBytes += bytes.byteLength;
    if (lineBytes > MAX_RECORD_BYTES) {
      oversized = true;
      parts = [];
    } else if (!oversized && bytes.byteLength > 0) {
      parts.push(bytes.slice());
    }
  };

  const emit = (nextOffset: number) => {
    if (strict && lineBytes > 0 && zeroFilled) {
      cache.lastDamagedRecordOrder = orderBase + lineStart;
      cache.pendingUserMessage = null;
      cache.currentTurnId = null;
      state.currentTurnId = null;
      lineStart = nextOffset;
      parts = [];
      lineBytes = 0;
      oversized = false;
      zeroFilled = true;
      return;
    }
    if (strict && oversized) throw new Error("Recovery record exceeds the safe read limit");
    if (!oversized && lineBytes > 0) {
      const joined = new Uint8Array(lineBytes);
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.byteLength;
      }
      try {
        const parsed = record(JSON.parse(decoder.decode(joined)));
        if (parsed) consumeRecord(parsed, orderBase + lineStart, state);
      } catch {
        if (strict) throw new Error("Recovery contains an unreadable record");
        // A malformed or concurrently incomplete line is ignored. The next
        // refresh rescans it because completeOffset advances only at newline.
      }
    }
    lineStart = nextOffset;
    parts = [];
    lineBytes = 0;
    oversized = false;
    zeroFilled = true;
  };

  const file = await open(sourcePath, "r");
  try {
    const buffer = new Uint8Array(READ_CHUNK_BYTES);
    // Bun's sliced file stream can overread its ending position on Windows.
    // Bound every read explicitly, including when the file grows during a scan.
    while (absoluteOffset < endOffset) {
      const { bytesRead } = await file.read(
        buffer, 0, Math.min(buffer.byteLength, endOffset - absoluteOffset), absoluteOffset,
      );
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      fingerprint?.update(chunk);
      let segmentStart = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        append(chunk.subarray(segmentStart, index));
        absoluteOffset += index - segmentStart + 1;
        emit(absoluteOffset);
        segmentStart = index + 1;
      }
      append(chunk.subarray(segmentStart));
      absoluteOffset += chunk.byteLength - segmentStart;
    }
  } finally {
    await file.close();
  }
  return lineStart;
}

async function sessionPrefixFingerprint(path: string, end: number): Promise<string> {
  const file = await open(path, "r");
  const digest = createHash("sha256");
  try {
    const bytes = new Uint8Array(READ_CHUNK_BYTES);
    let offset = 0;
    while (offset < end) {
      const { bytesRead } = await file.read(bytes, 0, Math.min(bytes.length, end - offset), offset);
      if (!bytesRead) throw new Error("History prefix was truncated");
      digest.update(bytes.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return digest.digest("hex");
  } finally {
    await file.close();
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function itemId(item: JsonRecord): string {
  return stringValue(item.id) || stringValue(item.callId) || stringValue(item.call_id);
}

function isUserMessageItem(item: JsonRecord): boolean {
  const type = itemType(item.type);
  return type === "userMessage"
    || (type === "message" && stringValue(item.role).toLowerCase() === "user");
}

function userMessageClientId(item: JsonRecord): string {
  return stringValue(
    item.clientId
    ?? item.client_id
    ?? item.clientUserMessageId
    ?? item.client_user_message_id,
  ).trim();
}

function commandText(item: JsonRecord): string {
  return stringValue(item.command).trim();
}

function terminalTurnStatus(value: unknown): boolean {
  return ["completed", "interrupted", "failed"].includes(stringValue(value));
}

function mergeRecoveredTurnItems(
  existingValue: unknown,
  recovered: RecoveredTurn,
): JsonRecord[] {
  const existing = Array.isArray(existingValue)
    ? existingValue.flatMap(value => record(value) ? [record(value)!] : [])
    : [];
  if (recovered.items.size === 0) return existing;
  const unmatchedExisting = new Set(existing);
  const recoveredItems = [...recovered.items.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ item }) => {
      const clientId = isUserMessageItem(item) ? userMessageClientId(item) : "";
      const current = clientId
        ? existing.find(candidate =>
            unmatchedExisting.has(candidate)
            && isUserMessageItem(candidate)
            && userMessageClientId(candidate) === clientId)
        : existing.find(candidate =>
            unmatchedExisting.has(candidate) && itemId(candidate) === itemId(item));
      if (current) unmatchedExisting.delete(current);
      return current ? { ...current, ...item } : item;
    });
  // Durable rollout user-message records are authoritative. Once at least one
  // exists for a turn, unmatched app-server-only user previews are discarded
  // instead of becoming permanent duplicate/failed prompt bubbles.
  return [
    ...recoveredItems,
    ...existing.filter(item =>
      unmatchedExisting.has(item)
      && (!recovered.durableUserMessages || !isUserMessageItem(item))),
  ];
}

function mergeRecoveredTurns(thread: JsonRecord, cache: SessionCache): JsonRecord {
  if (cache.threadId !== stringValue(thread.id) || cache.recoveredTurns.size === 0) return thread;
  const existing = Array.isArray(thread.turns)
    ? thread.turns.flatMap(value => record(value) ? [record(value)!] : [])
    : [];
  const existingById = new Map(existing.map(turn => [stringValue(turn.id), turn]));
  const merged = [...existing];
  let changed = false;

  for (const recovered of cache.recoveredTurns.values()) {
    const current = existingById.get(recovered.id);
    const currentStatus = stringValue(current?.status);
    const status = terminalTurnStatus(recovered.status)
      ? recovered.status
      : terminalTurnStatus(currentStatus)
        ? currentStatus
        : recovered.status;
    const next: JsonRecord = {
      ...(current ?? {}),
      id: recovered.id,
      status,
      startedAt: recovered.startedAt ?? finiteNumber(current?.startedAt),
      completedAt: terminalTurnStatus(status)
        ? recovered.completedAt ?? finiteNumber(current?.completedAt)
        : null,
      ...(recovered.durationMs !== null
        ? { durationMs: recovered.durationMs }
        : current?.durationMs === undefined
          ? {}
          : { durationMs: current.durationMs }),
      ...(recovered.error
        ? { error: recovered.error }
        : current?.error === undefined
          ? {}
          : { error: current.error }),
      ...(recovered.collaborationMode
        ? { collaborationMode: recovered.collaborationMode }
        : current?.collaborationMode === undefined
          ? {}
          : { collaborationMode: current.collaborationMode }),
      items: mergeRecoveredTurnItems(current?.items, recovered),
      _androidRemoteRecoveredOrder: recovered.order,
    };
    if (current) {
      const index = merged.indexOf(current);
      if (index >= 0) merged[index] = next;
    } else {
      merged.push(next);
    }
    changed = true;
  }

  if (!changed) return thread;
  const ordered = merged.sort((left, right) => {
    const leftStarted = finiteNumber(left.startedAt);
    const rightStarted = finiteNumber(right.startedAt);
    if (leftStarted !== null && rightStarted !== null && leftStarted !== rightStarted) {
      return leftStarted - rightStarted;
    }
    if (leftStarted !== null) return -1;
    if (rightStarted !== null) return 1;
    return (finiteNumber(left._androidRemoteRecoveredOrder) ?? Number.MAX_SAFE_INTEGER)
      - (finiteNumber(right._androidRemoteRecoveredOrder) ?? Number.MAX_SAFE_INTEGER);
  }).map(turn => {
    if (!("_androidRemoteRecoveredOrder" in turn)) return turn;
    const { _androidRemoteRecoveredOrder: _order, ...publicTurn } = turn;
    return publicTurn;
  });
  const latestStartedAt = Math.max(
    ...ordered.map(turn => finiteNumber(turn.startedAt) ?? Number.NEGATIVE_INFINITY),
  );
  const latestCompletedAt = Math.max(
    ...ordered.map(turn => finiteNumber(turn.completedAt) ?? Number.NEGATIVE_INFINITY),
  );
  const latestActivityAt = Math.max(latestStartedAt, latestCompletedAt);
  return {
    ...thread,
    turns: ordered,
    ...(Number.isFinite(latestActivityAt)
      ? {
          updatedAt: Math.max(
            finiteNumber(thread.updatedAt) ?? Number.NEGATIVE_INFINITY,
            latestActivityAt,
          ),
        }
      : {}),
  };
}

function mergeRecoveredCommands(thread: JsonRecord, cache: SessionCache): JsonRecord {
  if (cache.threadId !== stringValue(thread.id)) return thread;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  let changed = false;
  const mergedTurns = turns.map(value => {
    const turn = record(value);
    if (!turn) return value;
    const recovery = cache.turns.get(stringValue(turn.id));
    if (cache.recoveredTurns.get(stringValue(turn.id))?.canonicalItemEvents) return value;
    if (
      !recovery ||
      (
        recovery.commands.size === 0 &&
        recovery.fileChanges.size === 0 &&
        recovery.activities.size === 0
      )
    ) return value;
    const items = Array.isArray(turn.items) ? turn.items : [];
    const originalItems = items.flatMap(value => record(value) ? [record(value)!] : []);
    const recoveredFileChanges = [...recovery.fileChanges.values()];
    const usedFileChanges = new Set<string>();
    let hydratedFileChanges = false;
    const existingItems = originalItems.map(item => {
      if (item.type !== "fileChange" || recoveredFileChanges.length === 0) return item;
      const id = itemId(item);
      const recovered = recoveredFileChanges.find(candidate =>
        !usedFileChanges.has(candidate.callId) && (candidate.itemId === id || candidate.callId === id),
      ) ?? recoveredFileChanges.find(candidate => !usedFileChanges.has(candidate.callId));
      if (!recovered) return item;
      usedFileChanges.add(recovered.callId);
      if (Array.isArray(item.changes) && item.changes.length > 0) return item;
      changed = true;
      hydratedFileChanges = true;
      return { ...item, changes: recovered.changes };
    });
    const existingIds = new Set(existingItems.map(itemId).filter(Boolean));
    const existingCallIds = new Set(
      existingItems.flatMap(item => {
        const callId = stringValue(item.callId) || stringValue(item.call_id);
        return callId ? [callId] : [];
      }),
    );
    const existingCommands = new Set(
      existingItems.filter(item => item.type === "commandExecution").map(commandText).filter(Boolean),
    );
    const recoveredCommandItems = [...recovery.commands.values()].flatMap(command => {
      if (existingIds.has(command.itemId) || existingIds.has(command.callId)) return [];
      if (existingCommands.has(command.command.trim())) return [];
      return [{
        type: "commandExecution",
        id: command.itemId,
        command: command.command,
        cwd: stringValue(thread.cwd),
        status: command.status,
        exitCode: command.exitCode,
        aggregatedOutput: command.output,
        durationMs: command.durationMs,
        processId: null,
        commandActions: [],
        _androidRemoteRecoveredOrder: command.order,
      }];
    });
    const recoveredFileItems = recoveredFileChanges.flatMap(fileChange => {
      if (usedFileChanges.has(fileChange.callId)) return [];
      if (existingIds.has(fileChange.itemId) || existingIds.has(fileChange.callId)) return [];
      return [{
        type: "fileChange",
        id: fileChange.itemId,
        status: fileChange.status,
        changes: fileChange.changes,
        _androidRemoteRecoveredOrder: fileChange.order,
      }];
    });
    const recoveredActivityItems = [...recovery.activities.values()].flatMap(activity => {
      if (
        existingIds.has(activity.itemId) ||
        existingIds.has(activity.callId) ||
        existingCallIds.has(activity.callId)
      ) return [];
      if (
        activity.item.type === "contextCompaction" &&
        existingItems.some(item => item.type === "contextCompaction")
      ) return [];
      if (
        activity.item.type === "planUpdate" &&
        existingItems.some(item => item.type === "planUpdate")
      ) return [];
      return [{ ...activity.item, _androidRemoteRecoveredOrder: activity.order }];
    });
    const recoveredItems = [
      ...recoveredCommandItems,
      ...recoveredFileItems,
      ...recoveredActivityItems,
    ];
    if (recoveredItems.length === 0) {
      return hydratedFileChanges ? { ...turn, items: existingItems } : value;
    }
    changed = true;
    let anchorIndex = 0;
    const positioned = existingItems.map((item, index) => {
      let order = recovery.responseOrder.get(itemId(item)) ?? null;
      if (
        order === null &&
        (
          item.type === "userMessage" ||
          item.type === "agentMessage" ||
          item.type === "reasoning" ||
          item.type === "mcpToolCall" ||
          item.type === "fileChange"
        )
      ) {
        for (; anchorIndex < recovery.anchors.length; anchorIndex += 1) {
          const anchor = recovery.anchors[anchorIndex];
          if (anchor?.type !== item.type) continue;
          order = anchor.order;
          anchorIndex += 1;
          break;
        }
      }
      return { item, index, order };
    });
    for (const item of recoveredItems) {
      const order = typeof item._androidRemoteRecoveredOrder === "number"
        ? item._androidRemoteRecoveredOrder
        : Number.MAX_SAFE_INTEGER;
      const nextKnown = positioned.findIndex(entry => entry.order !== null && entry.order > order);
      if (nextKnown >= 0) {
        positioned.splice(nextKnown, 0, { item, index: positioned.length, order });
        continue;
      }
      let insertion = positioned.length;
      for (let index = positioned.length - 1; index >= 0; index -= 1) {
        const candidateOrder = positioned[index]?.order ?? null;
        if (candidateOrder !== null && candidateOrder <= order) {
          insertion = index + 1;
          while (
            insertion < positioned.length &&
            positioned[insertion]?.order !== null &&
            (positioned[insertion]?.order ?? Number.MAX_SAFE_INTEGER) <= order
          ) {
            insertion += 1;
          }
          break;
        }
      }
      positioned.splice(insertion, 0, { item, index: positioned.length, order });
    }
    return {
      ...turn,
      items: positioned.map(({ item }) => {
        if (!("_androidRemoteRecoveredOrder" in item)) return item;
        const { _androidRemoteRecoveredOrder: _order, ...publicItem } = item;
        return publicItem;
      }),
    };
  });
  return changed ? { ...thread, turns: mergedTurns } : thread;
}

export class AndroidRemoteSessionCommandRecovery implements AndroidRemoteCommandRecovery {
  private readonly caches = new Map<string, SessionCache>();
  private readonly headers = new Map<string, SessionCache>();
  private lineageReplay: { signature: string; cache: SessionCache } | null = null;
  private readonly codexHome: string;
  private readonly now: () => number;

  constructor(options: AndroidRemoteSessionCommandRecoveryOptions = {}) {
    this.codexHome = options.codexHome ?? getCodexHome();
    this.now = options.now ?? Date.now;
  }

  clear(): void {
    this.caches.clear();
    this.headers.clear();
    this.lineageReplay = null;
  }

  /** A Windows native reader can return an empty page for a populated task. */
  async enrichRecentThread(thread: JsonRecord, sourcePaths: readonly string[]): Promise<{ thread: JsonRecord; hasOlder: boolean } | null> {
    // Continuations and rollbacks still use the proven full-lineage reader.
    // Never guess which sibling or parent contains the authoritative history.
    if (sourcePaths.length !== 1) return null;
    try {
      const header = await this.updateCache(sourcePaths[0]!, true);
      if (!header || header.threadId !== thread.id || header.historyBaseThreadId) return null;
      let start = Math.max(0, header.size - RECENT_HISTORY_BYTES);
      if (start > 0) {
        const file = await open(header.canonicalPath, "r");
        try {
          const bytes = new Uint8Array(READ_CHUNK_BYTES);
          // Discard the first partial record without reading outside the tail.
          let found = false;
          while (start < header.size) {
            const { bytesRead } = await file.read(bytes, 0, Math.min(bytes.length, header.size - start), start);
            if (!bytesRead) break;
            const newline = bytes.subarray(0, bytesRead).indexOf(0x0a);
            start += newline >= 0 ? newline + 1 : bytesRead;
            if (newline >= 0) { found = true; break; }
          }
          if (!found) return null;
        } finally { await file.close(); }
      }
      const recent: SessionCache = {
        ...header, currentTurnId: null, nextTurnPlanMode: false,
        turnsInOrder: [], recoveredTurns: new Map(), turns: new Map(), pendingUserMessage: null,
        lastDamagedRecordOrder: undefined,
      };
      await scanSession(recent, start, header.canonicalPath, header.size);
      const result = mergeRecoveredCommands(mergeRecoveredTurns({ ...thread, turns: [] }, recent), recent);
      if (!(result.turns as JsonRecord[]).some(turn => Array.isArray(turn.items) && turn.items.length)) return null;
      return { thread: result, hasOlder: start > 0 };
    } catch { return null; }
  }

  async enrichThread(thread: JsonRecord, sourcePaths: readonly string[] = []): Promise<JsonRecord> {
    if (Object.hasOwn(thread, "androidRemoteVerifiedAsyncQuestionItemIds")) {
      thread = { ...thread };
      delete thread.androidRemoteVerifiedAsyncQuestionItemIds;
    }
    const threadId = stringValue(thread.id).trim();
    if (!threadId) return thread;
    try {
      const candidates = await this.resolveSourcePaths(threadId, [
        stringValue(thread.path),
        ...sourcePaths,
      ]);
      const caches: SessionCache[] = [];
      let unreadable = false;
      for (const sourcePath of candidates) {
        try {
          const cache = await this.updateCache(sourcePath, true);
          if (cache?.threadId === threadId) caches.push(cache);
          else unreadable = true;
        } catch {
          unreadable = true;
          // A continuation can be archived or rotated while the sibling set is
          // being traversed. Keep every other readable rollout in the merge.
        }
      }
      if (unreadable || candidates.length >= 512) {
        return { ...thread, androidRemoteHistoryRecoveryError: "Some saved history could not be verified. A source is unreadable or the recovery discovery limit was reached." };
      }
      if (caches.some(cache => cache.historyBaseThreadId)) {
        const enriched = await this.recoverLineage(thread, caches);
        this.prune();
        return enriched;
      }
      caches.sort((left, right) =>
        (left.firstTimestamp ?? Number.MAX_SAFE_INTEGER)
          - (right.firstTimestamp ?? Number.MAX_SAFE_INTEGER)
        || left.canonicalPath.localeCompare(right.canonicalPath));
      let enriched = thread;
      const fullCaches: SessionCache[] = [];
      for (const header of caches) {
        const cache = await this.updateCache(header.canonicalPath);
        if (cache?.threadId === threadId) fullCaches.push(cache);
      }
      for (const cache of fullCaches) enriched = mergeRecoveredTurns(enriched, cache);
      for (const cache of fullCaches) enriched = mergeRecoveredCommands(enriched, cache);
      this.prune();
      return enriched;
    } catch {
      // Session enrichment is optional. A missing, moving, or unreadable file
      // must never stop Android from receiving Codex's normal thread result.
      return thread;
    }
  }

  async resolveSourcePaths(threadId: string, explicit: readonly string[]): Promise<string[]> {
    return resolveThreadSourcePaths(threadId, explicit, {
      codexHome: this.codexHome,
      now: this.now,
      maxPaths: 512,
    });
  }

  private async recoverLineage(thread: JsonRecord, caches: SessionCache[]): Promise<JsonRecord> {
    try {
      // A clock can move backwards. Only parent links, or an explicit native
      // path identifying a leaf, establish which branch is authoritative.
      const parents = new Set(caches.map(cache => cache.historyBaseThreadId));
      const leaves = caches.filter(cache => !parents.has(cache.physicalId));
      const explicit = stringValue(thread.androidRemoteNativeSourcePath ?? thread.path);
      const explicitPath = explicit ? await realpath(resolve(explicit)).catch(() => "") : "";
      const leaf = leaves.length === 1 ? leaves[0] : leaves.find(cache => cache.canonicalPath === explicitPath);
      if (!leaf) throw new Error("Ambiguous continuation");
      const segments: Array<{ cache: SessionCache; end: number; fingerprint?: string }> = [];
      const seen = new Set<string>();
      let current: SessionCache = leaf;
      let end = current.completeOffset;
      for (;;) {
        if (seen.has(current.canonicalPath) || seen.size >= 128) throw new Error("Invalid continuation chain");
        seen.add(current.canonicalPath);
        segments.unshift({ cache: current, end });
        const parentId = current.historyBaseThreadId;
        if (!parentId) break;
        const cutoff = current.historyBaseEndByteOffset;
        if (cutoff === null || !Number.isSafeInteger(cutoff) || cutoff < 0) throw new Error("Missing continuation cutoff");
        const matches = caches.filter(cache => cache.physicalId === parentId);
        if (matches.length > 1) throw new Error("Ambiguous parent");
        const parent = matches[0] ?? await this.findPhysicalParent(parentId);
        if (!parent || cutoff > parent.completeOffset) throw new Error("Missing parent history");
        current = parent;
        end = cutoff;
      }
      // Replay into one isolated state, so rollbacks can remove inherited
      // turns too. Never mutate the incremental caches or the files on disk.
      const signature = JSON.stringify(segments.map(({ cache, end }) => [
        cache.canonicalPath, String(cache.device), String(cache.inode), cache.size, String(cache.mtimeNs), end,
      ]));
      const replay: SessionCache = this.lineageReplay?.signature === signature ? this.lineageReplay.cache : {
        ...leaf, threadId: stringValue(thread.id), currentTurnId: null,
        firstTimestamp: null, lastTimestamp: null, nextTurnPlanMode: false,
        turnsInOrder: [], recoveredTurns: new Map(), turns: new Map(), pendingUserMessage: null,
        lastDamagedRecordOrder: undefined,
      };
      if (this.lineageReplay?.signature !== signature) {
        let orderBase = 0;
        for (const segment of segments) {
          const digest = createHash("sha256");
          const offset = await scanSession(replay, 0, segment.cache.canonicalPath, segment.end, orderBase, true, digest);
          if (offset !== segment.end) throw new Error("Continuation cutoff is not a complete record");
          segment.fingerprint = digest.digest("hex");
          orderBase += segment.end;
        }
        // Don't publish a mixture if a parent was replaced or rewritten while
        // the chain was being replayed. A later refresh will retry normally.
        for (const { cache, end, fingerprint } of segments) {
          const source = await stat(cache.canonicalPath, { bigint: true });
          if (source.ino !== cache.inode || source.dev !== cache.device || Number(source.size) < cache.size) {
            throw new Error("History changed during recovery");
          }
          if (source.mtimeNs !== cache.mtimeNs || Number(source.size) !== cache.size) {
            if (Number(source.size) === cache.size || await sessionPrefixFingerprint(cache.canonicalPath, end) !== fingerprint) {
              throw new Error("History changed during recovery");
            }
          }
        }
        this.lineageReplay = { signature, cache: replay };
      }
      // Native snapshots may themselves contain an abandoned sibling. Build
      // this proven lineage from durable events, not from an additive union.
      let result = mergeRecoveredTurns({ ...thread, turns: [] }, replay);
      result = mergeRecoveredCommands(result, replay);
      const byId = new Map((result.turns as JsonRecord[]).map(turn => [stringValue(turn.id), turn]));
      result.turns = replay.turnsInOrder.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
      delete result.androidRemoteHistoryRecoveryError;
      delete result.androidRemoteVerifiedAsyncQuestionItemIds;
      if (replay.lastDamagedRecordOrder !== undefined) {
        result.androidRemoteHistoryRecoveryError = "Some older saved records are unreadable. Readable messages are shown; missing content has not been reconstructed.";
        result.androidRemoteVerifiedAsyncQuestionItemIds = [...replay.recoveredTurns.values()]
          .flatMap(turn => [...turn.items.values()])
          .filter(entry => entry.order > replay.lastDamagedRecordOrder!)
          .flatMap(entry => {
            const question = desktopAsyncQuestionItem(entry.item);
            return question ? [stringValue(question.id)] : [];
          });
      }
      return result;
    } catch {
      // A partial guessed merge is worse than an explicitly incomplete native
      // snapshot. This warning is surfaced through the existing session error.
      return { ...thread, androidRemoteVerifiedAsyncQuestionItemIds: [], androidRemoteHistoryRecoveryError: "Some saved history could not be verified. Showing the Codex history without combining uncertain continuations." };
    }
  }

  private async findPhysicalParent(physicalId: string): Promise<SessionCache | null> {
    if (!/^[a-zA-Z0-9-]{1,128}$/u.test(physicalId)) return null;
    const matches = new Map<string, SessionCache>();
    for (const root of ["sessions", "archived_sessions"]) {
      try {
        for await (const path of new Bun.Glob(`**/*${physicalId}.jsonl`).scan({
          cwd: resolve(this.codexHome, root), absolute: true, onlyFiles: true,
        })) {
          const cache = await this.updateCache(path, true);
          if (cache?.physicalId === physicalId) matches.set(cache.canonicalPath, cache);
          if (matches.size > 1) return null;
        }
      } catch { /* Missing archive or parent: do not guess. */ }
    }
    return matches.size === 1 ? [...matches.values()][0]! : null;
  }

  private async updateCache(sourcePath: string, metadataOnly = false): Promise<SessionCache | null> {
    if (!sourcePath.toLowerCase().endsWith(".jsonl")) return null;
    const [canonicalHome, canonicalPath] = await Promise.all([
      realpath(resolve(this.codexHome)),
      realpath(resolve(sourcePath)),
    ]);
    const sessionsRoot = resolve(canonicalHome, "sessions");
    const archivedRoot = resolve(canonicalHome, "archived_sessions");
    if (!inside(sessionsRoot, canonicalPath) && !inside(archivedRoot, canonicalPath)) return null;
    const source = await stat(canonicalPath, { bigint: true });
    if (!source.isFile() || source.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const size = Number(source.size);
    const entries = metadataOnly ? this.headers : this.caches;
    let cache = entries.get(canonicalPath);
    if (
      !cache ||
      cache.device !== source.dev ||
      cache.inode !== source.ino ||
      (size === cache.size && source.mtimeNs !== cache.mtimeNs) ||
      size < cache.completeOffset
      || (metadataOnly && (size !== cache.size || source.mtimeNs !== cache.mtimeNs))
    ) {
      cache = {
        canonicalPath,
        device: source.dev,
        inode: source.ino,
        size: 0,
        completeOffset: 0,
        firstTimestamp: null,
        lastTimestamp: null,
        threadId: null,
        physicalId: null,
        historyBaseThreadId: null,
        historyBaseEndByteOffset: null,
        mtimeNs: source.mtimeNs,
        currentTurnId: null,
        nextTurnPlanMode: false,
        turnsInOrder: [],
        recoveredTurns: new Map(),
        turns: new Map(),
        pendingUserMessage: null,
        touchedAt: this.now(),
      };
      entries.set(canonicalPath, cache);
    }
    if (metadataOnly && cache.threadId === null) {
      // Explicit positional reads respect the bound on Windows too. Bun's
      // sliced file reader can read past its end into the entire transcript.
      const file = await open(canonicalPath, "r");
      const chunks: Buffer[] = [];
      try {
        let offset = 0;
        while (offset < Math.min(size, MAX_METADATA_BYTES)) {
          const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - offset, MAX_METADATA_BYTES - offset));
          const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
          if (!bytesRead) break;
          const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
          chunks.push(chunk.subarray(0, newline >= 0 ? newline + 1 : bytesRead));
          offset += bytesRead;
          if (newline >= 0) break;
        }
      } finally { await file.close(); }
      const prefix = Buffer.concat(chunks).toString("utf8");
      const newline = prefix.indexOf("\n");
      if (newline < 0) return null;
      const parsed = record(JSON.parse(prefix.slice(0, newline)));
      if (parsed?.type !== "session_meta") return null;
      consumeRecord(parsed, 0, { currentTurnId: null, cache });
      cache.completeOffset = size;
      cache.size = size;
    } else if (!metadataOnly && size > cache.completeOffset) {
      cache.completeOffset = await scanSession(cache, cache.completeOffset, canonicalPath, size);
      cache.size = size;
    }
    // The filename is only a hint. The session metadata read by scanSession is
    // authoritative, and is needed because continuation files can have a
    // different physical id from the logical thread id.
    if (cache.physicalId === null && cache.threadId) {
      const fileName = basename(canonicalPath);
      const marker = `-${cache.threadId}`;
      const markerIndex = fileName.lastIndexOf(marker);
      const suffix = markerIndex >= 0 ? fileName.slice(markerIndex + marker.length) : "";
      cache.physicalId = suffix.startsWith("_")
        ? suffix.slice(1).replace(/\.jsonl$/iu, "") || cache.threadId
        : cache.threadId;
    }
    cache.touchedAt = this.now();
    cache.mtimeNs = source.mtimeNs;
    return cache;
  }

  private prune(): void {
    while (this.headers.size > 128) this.headers.delete(this.headers.keys().next().value!);
    if (this.caches.size <= MAX_CACHE_ENTRIES) return;
    const oldest = [...this.caches.entries()]
      .sort((first, second) => first[1].touchedAt - second[1].touchedAt)
      .slice(0, this.caches.size - MAX_CACHE_ENTRIES);
    for (const [path] of oldest) this.caches.delete(path);
  }
}
