import { watch, type FSWatcher } from "node:fs";
import { generatedImagePaths, isImageGenerationTool, imageGenerationWaitCell, runningImageGenerationCell } from "./generated-images";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getCodexHome } from "../codex/paths";
import type { CodexJsonRpcMessage } from "./codex-app-server";
import { fileChangesFromToolCall } from "./file-change-parser";
import {
  canonicalUserMessageText,
  publicUserMessageText,
  sanitizePublicTranscriptText,
} from "./user-message-identity";
import { boundedTurnErrorMessage } from "./turn-activity";
import { normalizedCompletedItem } from "./desktop-thread-item";

type JsonRecord = Record<string, unknown>;

const INITIAL_TAIL_BYTES = 16 * 1024 * 1024;
// Tool results in real Codex sessions can exceed 2 MiB. The projected Android
// row is bounded later, so accept a reasonably large source record here rather
// than silently losing the tool completion (or a long assistant message).
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_NESTED_TOOL_INPUT_BYTES = 128 * 1024;
const RECOVERY_POLL_MS = 1_000;

type SessionWatch = {
  canonicalPath: string;
  device: number;
  inode: number;
  onMessage: (message: CodexJsonRpcMessage) => void;
  offset: number;
  watcher: FSWatcher;
  poller: ReturnType<typeof setInterval>;
  projector: DesktopSessionRecordProjector;
  draining: boolean;
  pending: boolean;
};

export interface AndroidDesktopSessionStream {
  watchThread(input: {
    threadId: string;
    sourcePath: string;
    onMessage: (message: CodexJsonRpcMessage) => void;
  }): Promise<boolean>;
  isWatching(threadId: string): boolean;
  /**
   * Returns the projector's bounded live-turn identity without rereading the
   * rollout or asking the Desktop IPC writer.  This is intentionally optional
   * so older test/dummy streams can continue to implement the interface.
   */
  activeTurnId?(threadId: string): string | null;
  unwatchThread(threadId: string): void;
  close(): void;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function timestampMs(value: unknown): number {
  const parsed = Date.parse(stringValue(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function turnIdFromPayload(payload: JsonRecord, fallback: string | null): string | null {
  const metadata = record(payload.internal_chat_message_metadata_passthrough);
  return stringValue(metadata?.turn_id) || stringValue(payload.turn_id) || fallback;
}

function responseText(payload: JsonRecord): string {
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .flatMap((value) => {
      const row = record(value);
      const part = row && typeof row.text === "string"
        ? row.text
        : row && typeof row.value === "string"
          ? row.value
          : "";
      return part ? [part] : [];
    })
    .join("");
}

function normalizedItemType(value: unknown): string {
  return stringValue(value)
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase();
}

function userMessageContent(payload: JsonRecord): JsonRecord[] {
  if (!Array.isArray(payload.content)) return [];
  return payload.content.flatMap((value) => {
    const row = record(value);
    const text = publicUserMessageText(row?.text ?? row?.value);
    return text ? [{ type: "text", text }] : [];
  });
}

function reasoningSummary(payload: JsonRecord): string[] {
  if (!Array.isArray(payload.summary)) return [];
  return payload.summary.flatMap((value) => {
    if (typeof value === "string" && value.trim()) return [value.trim()];
    const row = record(value);
    const text = stringValue(row?.text).trim();
    return text ? [text] : [];
  });
}

function decodeQuoted(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

function nestedCommand(input: string): string | null {
  const command = /\bcmd\s*:\s*"((?:\\.|[^"\\])*)"/su.exec(input)?.[1];
  if (command) return decodeQuoted(command);
  const sessionId = /\bsession_id\s*:\s*(\d+)/u.exec(input)?.[1];
  if (/\btools\.write_stdin\s*\(/u.test(input)) {
    return sessionId ? `Continue command session ${sessionId}` : "Continue command";
  }
  return null;
}

function parsedArguments(payload: JsonRecord): JsonRecord {
  const direct = record(payload.arguments);
  if (direct) return direct;
  const encoded = stringValue(payload.arguments);
  if (!encoded) return {};
  try {
    return record(JSON.parse(encoded)) ?? {};
  } catch {
    return {};
  }
}

function nestedToolName(input: string): string {
  return /\btools\.([A-Za-z0-9_]+)\s*\(/u.exec(input)?.[1] ?? "";
}

function decodedStringProperty(input: string, property: string): string {
  const boundedInput = input.slice(0, MAX_NESTED_TOOL_INPUT_BYTES);
  const match = new RegExp(
    `\\b${property}\\s*:\\s*(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|\`((?:\\\\.|[^\`\\\\])*)\`)`,
    "u",
  ).exec(boundedInput);
  const body = match?.[1] ?? match?.[2] ?? match?.[3];
  if (body === undefined) return "";
  if (match?.[1] !== undefined) return decodeQuoted(body);
  const quote = match?.[2] !== undefined ? "'" : "`";
  return body
    .replaceAll(`\\${quote}`, quote)
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t")
    .replaceAll("\\\\", "\\");
}

export function planUpdateFromToolCall(
  payload: JsonRecord,
): { plan: JsonRecord[]; explanation?: string } | null {
  const input = stringValue(payload.input).slice(0, MAX_NESTED_TOOL_INPUT_BYTES);
  const tool = nestedToolName(input) || stringValue(payload.name);
  if (tool.split("__").at(-1) !== "update_plan") return null;
  const direct = parsedArguments(payload);
  const directPlan = Array.isArray(direct.plan) ? direct.plan : [];
  const plan = directPlan.flatMap((value) => {
    const step = record(value);
    const title = stringValue(step?.step).trim();
    const status = stringValue(step?.status).trim();
    return title && status ? [{ step: title, status }] : [];
  });
  if (plan.length === 0) {
    for (const match of input.matchAll(/\{([^{}]{0,8192})\}/gu)) {
      const body = match[1] ?? "";
      const step = decodedStringProperty(body, "step").trim();
      const status = decodedStringProperty(body, "status").trim();
      if (step && status) plan.push({ step, status });
    }
  }
  const explanation =
    stringValue(direct.explanation).trim() || decodedStringProperty(input, "explanation").trim();
  return { plan, ...(explanation ? { explanation } : {}) };
}

function nestedToolArguments(input: string, tool: string, direct: JsonRecord): JsonRecord {
  const boundedInput = input.slice(0, MAX_NESTED_TOOL_INPUT_BYTES);
  const augmented: JsonRecord = { ...direct };
  for (const property of [
    "path",
    "query",
    "task_name",
    "taskName",
    "agent_name",
    "agentName",
    "target",
  ] as const) {
    if (augmented[property] !== undefined) continue;
    const value = decodedStringProperty(boundedInput, property).trim();
    if (value) augmented[property] = value;
  }
  const reviewTarget =
    tool.split("__").at(-1) === "open_in_codex" &&
    /\btarget\s*:\s*\{[^{}]{0,8192}\btype\s*:\s*["'`]review["'`]/u.test(boundedInput)
      ? { type: "review" }
      : null;
  if (reviewTarget) augmented.target = reviewTarget;
  return augmented;
}

export function toolItem(payload: JsonRecord): JsonRecord | null {
  const input = stringValue(payload.input);
  const name = stringValue(payload.name);
  const nestedTool = nestedToolName(input);
  const args = parsedArguments(payload);
  const id = stringValue(payload.id) || stringValue(payload.call_id);
  if (!id) return null;
  const imageTool = [...input.matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/gu)].some(match => isImageGenerationTool(match[1]));
  if (isImageGenerationTool(name) || imageTool) {
    return { type: "imageGeneration", id, callId: stringValue(payload.call_id), status: "inProgress" };
  }
  if (
    (name === "exec" && nestedTool !== "apply_patch" && /\btools\.(?:exec_command|write_stdin)\s*\(/u.test(input)) ||
    ["exec_command", "write_stdin", "shell", "shell_command"].includes(name)
  ) {
    const directCommand =
      typeof args.cmd === "string"
        ? args.cmd
        : Array.isArray(args.cmd)
          ? args.cmd.flatMap((value) => (typeof value === "string" ? [value] : [])).join(" ")
          : "";
    const sessionId =
      typeof args.session_id === "number" || typeof args.session_id === "string"
        ? String(args.session_id)
        : "";
    return {
      type: "commandExecution",
      id,
      command:
        directCommand ||
        nestedCommand(input) ||
        (name === "write_stdin" && sessionId
          ? `Continue command session ${sessionId}`
          : "Command Execution"),
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
      processId: null,
      commandActions: [],
    };
  }
  if (name === "apply_patch" || (name === "exec" && /\btools\.apply_patch\s*\(/u.test(input))) {
    return {
      type: "fileChange",
      id,
      status: "inProgress",
      changes: fileChangesFromToolCall(payload),
    };
  }
  // A bare custom `exec` record is Codex's internal orchestration wrapper
  // (for example, tool discovery through ALL_TOOLS).  It has no stable public
  // activity name, so do not turn it into a misleading "Using Exec" row.
  if (name === "exec" && !nestedTool) return null;
  const tool = nestedTool || name || "tool";
  return {
    type: "dynamicToolCall",
    id,
    callId: stringValue(payload.call_id),
    tool,
    namespace: tool.includes("__") ? tool.split("__")[0] : "",
    status: "inProgress",
    arguments: nestedToolArguments(input, tool, args),
  };
}

function outputString(payload: JsonRecord): string {
  if (typeof payload.output === "string") return payload.output;
  if (!Array.isArray(payload.output)) return "";
  return payload.output
    .flatMap((value) => {
      const row = record(value);
      return row && typeof row.text === "string" ? [row.text] : [];
    })
    .join("");
}

function failedOutput(output: string): boolean {
  return /(?:Process|Command|Script) (?:exited|failed) with (?:code|exit code) (?!0\b)-?\d+/u.test(
    output,
  );
}

/** Converts append-only Codex session records into the same small notifications used by app-server. */
export class DesktopSessionRecordProjector {
  private readonly structuredItemIds = new Set<string>();
  private readonly structuredToolCalls = new Set<string>();
  private readonly inferredToolWrappers = new Set<string>();
  private hasStructuredTools = false;
  private contextTurnId: string | null = null;
  private currentTurnId: string | null = null;
  private currentTurnPlanMode = false;
  private nextTurnPlanMode = false;
  private settingsModel = "";
  private settingsModelProviderId = "";
  private settingsReasoningEffort = "";
  private settingsServiceTier = "";
  private settingsServiceTierKnown = false;
  private lastPublishedSettings = "";
  private readonly pendingTools = new Map<string, JsonRecord>();
  private pendingFinalMessage: {
    turnId: string;
    item: JsonRecord;
    completedAtMs: number;
  } | null = null;
  /**
   * A Codex rollout writes one submitted user message twice in adjacent forms:
   * first as the public response item, then as either a `user_message` identity
   * event or a structured `item_completed` event carrying the durable
   * Android/Desktop client id. Hold the first row long enough to join that
   * identity instead of publishing two unrelated Android bubbles.
   */
  private pendingUserMessage: {
    turnId: string;
    item: JsonRecord;
    completedAtMs: number;
    comparisonText: string;
  } | null = null;
  private pendingCompactionId: string | null = null;

  constructor(
    private readonly threadId: string,
    private readonly emit: (message: CodexJsonRpcMessage) => void,
  ) {}

  /**
   * The canonical turn currently observed in the append-only rollout.
   *
   * Returning only the id keeps the recovery path metadata-only and avoids
   * retaining or cloning any transcript content.
   */
  activeTurnId(): string | null {
    return this.currentTurnId;
  }

  private flushPendingFinalMessage(): void {
    const pending = this.pendingFinalMessage;
    if (!pending) return;
    this.pendingFinalMessage = null;
    this.emit({
      method: "item/completed",
      params: {
        threadId: this.threadId,
        turnId: pending.turnId,
        item: pending.item,
        completedAtMs: pending.completedAtMs,
      },
    });
  }

  private flushPendingUserMessage(clientId = ""): void {
    const pending = this.pendingUserMessage;
    if (!pending) return;
    this.pendingUserMessage = null;
    // A private bootstrap/control response can arrive in the same slot as a
    // normal user response item. Once its text parts are removed there is no
    // public row to publish (and emitting an empty row would still create a
    // misleading bubble on Android).
    if (!Array.isArray(pending.item.content) || pending.item.content.length === 0) return;
    this.emit({
      method: "item/completed",
      params: {
        threadId: this.threadId,
        turnId: pending.turnId,
        item: {
          ...pending.item,
          ...(clientId ? { clientId } : {}),
        },
        completedAtMs: pending.completedAtMs,
      },
    });
  }

  private publishThreadSettings(
    source: JsonRecord,
    turnId: string | null,
    updatedAtMs: number,
  ): void {
    const model = stringValue(source.model).trim().slice(0, 256);
    const modelProviderId = stringValue(source.model_provider_id ?? source.model_provider
      ?? source.modelProviderId ?? source.modelProvider).trim().slice(0, 64);
    const reasoningEffort = stringValue(source.reasoning_effort ?? source.effort)
      .trim()
      .slice(0, 64);
    const serviceTierPresent = Object.hasOwn(source, "service_tier")
      || Object.hasOwn(source, "serviceTier");
    const rawServiceTier = serviceTierPresent
      ? stringValue(source.service_tier ?? source.serviceTier).trim().slice(0, 64)
      : "";
    const serviceTier = rawServiceTier === "fast"
      ? "priority"
      : rawServiceTier || "default";
    const modelIdentityChanged = (
      Boolean(model && this.settingsModel && model !== this.settingsModel)
      || Boolean(
        modelProviderId
        && this.settingsModelProviderId
        && modelProviderId !== this.settingsModelProviderId,
      )
    );
    if (modelIdentityChanged && !serviceTierPresent) {
      // Never carry a prior model's Fast selection onto a new model when the
      // new Desktop context provides no service-tier evidence.
      this.settingsServiceTier = "";
      this.settingsServiceTierKnown = false;
    }
    if (model) this.settingsModel = model;
    if (modelProviderId) this.settingsModelProviderId = modelProviderId;
    if (reasoningEffort) this.settingsReasoningEffort = reasoningEffort;
    if (serviceTierPresent) {
      this.settingsServiceTier = serviceTier;
      this.settingsServiceTierKnown = true;
    }
    if (!this.settingsModel) return;
    const fingerprint = JSON.stringify([
      this.settingsModel,
      this.settingsModelProviderId,
      this.settingsReasoningEffort,
      this.settingsServiceTierKnown ? this.settingsServiceTier : null,
    ]);
    if (fingerprint === this.lastPublishedSettings) return;
    this.lastPublishedSettings = fingerprint;
    this.emit({
      method: "thread/settings/updated",
      params: {
        threadId: this.threadId,
        turnId,
        model: this.settingsModel,
        ...(this.settingsModelProviderId ? { modelProviderId: this.settingsModelProviderId } : {}),
        ...(this.settingsReasoningEffort ? { reasoningEffort: this.settingsReasoningEffort } : {}),
        ...(this.settingsServiceTierKnown ? { serviceTier: this.settingsServiceTier } : {}),
        updatedAtMs,
      },
    });
  }

  consume(value: unknown): void {
    const row = record(value);
    const payload = record(row?.payload);
    if (!row || !payload) return;
    const rowType = stringValue(row.type);
    const payloadType = stringValue(payload.type);
    const at = timestampMs(row.timestamp);
    // The structured item and raw response are two representations of one
    // visible row. A raw echo must not flush a pending private compaction answer.
    if (rowType === "response_item" && this.structuredItemIds.has(stringValue(payload.id))) return;
    // Attachment notices can sit between the public response and its client-id
    // echo. Keep that pair pending across private context on every platform.
    const privateContextMessage = rowType === "response_item" && payloadType === "message"
      && (payload.role === "developer" || payload.role === "system");
    if (rowType === "session_meta") {
      this.publishThreadSettings(payload, null, at);
      return;
    }
    const userMessageEvent = rowType === "event_msg" && payloadType === "user_message";
    const structuredCompletedItem =
      rowType === "event_msg" && payloadType === "item_completed" ? record(payload.item) : null;
    const structuredItemType = normalizedItemType(structuredCompletedItem?.type);
    const structuredUserMessageEvent =
      structuredCompletedItem !== null &&
      (structuredItemType === "usermessage" ||
        (structuredItemType === "message" &&
          stringValue(structuredCompletedItem.role).toLowerCase() === "user"));
    const userMessageIdentityEvent = userMessageEvent || structuredUserMessageEvent;

    if (this.pendingUserMessage && !privateContextMessage) {
      const clientId = userMessageEvent
        ? stringValue(payload.client_id ?? payload.clientId).trim()
        : stringValue(
            structuredCompletedItem?.clientId ??
              structuredCompletedItem?.client_id ??
              structuredCompletedItem?.clientUserMessageId ??
              structuredCompletedItem?.client_user_message_id,
          ).trim();
      const comparisonText = userMessageEvent
        ? canonicalUserMessageText(payload.message)
        : canonicalUserMessageText(responseText(structuredCompletedItem ?? {}));
      const identityTurnId = structuredUserMessageEvent
        ? stringValue(payload.turn_id ?? payload.turnId) || this.currentTurnId
        : this.pendingUserMessage.turnId;
      if (
        userMessageIdentityEvent &&
        clientId &&
        identityTurnId === this.pendingUserMessage.turnId &&
        comparisonText === this.pendingUserMessage.comparisonText
      ) {
        this.flushPendingUserMessage(clientId);
        return;
      }
      // Older Codex rollouts may not include the identity event. Preserve
      // ordering by releasing the user row immediately before the next record.
      this.flushPendingUserMessage();
    }
    // These records enrich the immediately preceding response item. They have
    // no independent Android row, even when an older rollout omits an id.
    if (userMessageIdentityEvent) return;

    if (rowType === "event_msg" && (payloadType === "item_started" || payloadType === "item_completed")) {
      const completed = payloadType === "item_completed";
      const item = normalizedCompletedItem(payload.item, completed);
      const turnId = stringValue(payload.turn_id ?? payload.turnId) || this.currentTurnId;
      if (!item || !turnId || item.type === "userMessage") return;
      if (item.type === "imageGeneration") {
        const pendingImages = [...this.pendingTools.entries()].filter(([, pending]) => pending.type === "imageGeneration");
        if (pendingImages.length === 1) {
          const [callId, pending] = pendingImages[0]!;
          const updated = { ...pending, generatedImages: generatedImagePaths([pending, item]),
            ...(item.status === "failed" ? { androidRemoteImageFailed: true } : {}) };
          this.pendingTools.set(callId, updated);
          this.emit({ method: "item/started", params: { threadId: this.threadId, turnId, item: updated, startedAtMs: at } });
          return;
        }
      }
      if (!["agentMessage", "reasoning", "contextCompaction"].includes(stringValue(item.type))) this.hasStructuredTools = true;
      const id = stringValue(item.id);
      if (!completed && this.structuredItemIds.has(id)) return;
      let replacesItemId = "";
      // Replace only an unambiguous inferred row. Different commands, parallel
      // calls, and additional commands inside one wrapper retain their own ids.
      let candidates = [...this.pendingTools.entries()].filter(([callId, pending]) =>
        !this.structuredToolCalls.has(callId) && pending.type === item.type && (
          pending.id === id || (item.type === "commandExecution"
            && stringValue(pending.command).trim() === stringValue(item.command).trim())
        ));
      if (candidates.length === 0 && !["agentMessage", "reasoning", "userMessage", "contextCompaction"].includes(stringValue(item.type))) {
        // Code-mode wrappers can contain several different tools (or poll an
        // existing command). Their guessed row is only a placeholder for the
        // first real tool, not an additional Desktop command. Pair only while
        // one such wrapper is pending, and never merge two canonical items.
        candidates = [...this.pendingTools.entries()].filter(([callId, pending]) =>
          pending.type !== "imageGeneration" && this.inferredToolWrappers.has(callId) && !this.structuredToolCalls.has(callId));
      }
      if (candidates.length === 1) {
        const [callId, pending] = candidates[0]!;
        if (pending.id !== id) replacesItemId = stringValue(pending.id);
        this.pendingTools.set(callId, item);
        this.structuredToolCalls.add(callId);
      }
      if (completed) {
        this.structuredItemIds.add(id);
        if (this.structuredItemIds.size > 4096) this.structuredItemIds.delete(this.structuredItemIds.values().next().value!);
      }
      const startedAtMs = typeof payload.started_at_ms === "number" ? payload.started_at_ms : at;
      const completedAtMs = typeof payload.completed_at_ms === "number" ? payload.completed_at_ms : at;
      if (item.type === "agentMessage" && item.phase === "final_answer" && completed) {
        this.pendingFinalMessage = { turnId, item, completedAtMs };
      } else {
        this.emit({
          method: completed ? "item/completed" : "item/started",
          params: { threadId: this.threadId, turnId, item, startedAtMs,
            ...(completed ? { completedAtMs } : {}), ...(replacesItemId ? { replacesItemId } : {}) },
        });
      }
      return;
    }

    if (rowType === "event_msg" && payloadType === "thread_settings_applied") {
      const settings = record(payload.thread_settings);
      this.nextTurnPlanMode = stringValue(record(settings?.collaboration_mode)?.mode) === "plan";
      if (settings) {
        this.publishThreadSettings(
          settings,
          stringValue(payload.turn_id) || this.currentTurnId,
          at,
        );
      }
      return;
    }

    // Codex writes the private compaction answer as an ordinary-looking final
    // assistant item immediately before the top-level `compacted` record. Hold
    // final answers briefly so that private handoff text never reaches Android.
    // Ordinary final answers are released before turn/completed below.
    if (rowType === "compacted") {
      this.pendingFinalMessage = null;
      const turnId = this.currentTurnId;
      if (turnId) {
        const id = `context-compaction-${turnId}-${at}`;
        // `compacted` is the replacement-history record written after Codex
        // has finished compacting. Treating it as a start leaves Android stuck
        // on "Compacting context" because current Codex rollouts do not also
        // emit the older `context_compacted` event. Retain the id only to
        // suppress that optional legacy duplicate when it is present.
        this.pendingCompactionId = id;
        this.emit({
          method: "item/completed",
          params: {
            threadId: this.threadId,
            turnId,
            item: { type: "contextCompaction", id, status: "completed" },
            completedAtMs: at,
          },
        });
      }
      return;
    }
    if (
      this.pendingFinalMessage &&
      !(
        (rowType === "event_msg" && payloadType === "token_count") ||
        // Current rollouts write this top-level usage row before both
        // `compacted` and ordinary `task_complete` boundaries.
        rowType === "token_usage_record" ||
        rowType === "world_state" ||
        rowType === "turn_context" ||
        (rowType === "event_msg" && payloadType === "context_compacted")
      )
    ) {
      this.flushPendingFinalMessage();
    }

    if (rowType === "turn_context") {
      const turnId = stringValue(payload.turn_id) || this.currentTurnId;
      this.contextTurnId = turnId;
      // `turn_context` is durable settings metadata, not a lifecycle start.
      // Completed tasks replay their last context so Android can restore the
      // model and reasoning picker; treating that replay as active resurrects
      // the completed turn and converts an ordinary phone send into Queue.
      // A live append has already published `task_started`, so it may still
      // refine that active turn's id without allowing idle metadata to start it.
      if (this.currentTurnId !== null && turnId) this.currentTurnId = turnId;
      const collaborationMode = record(payload.collaboration_mode);
      if (collaborationMode) {
        this.currentTurnPlanMode = stringValue(collaborationMode.mode) === "plan";
      }
      this.publishThreadSettings(payload, turnId, at);
      return;
    }
    if (rowType === "event_msg" && payloadType === "token_count") {
      const tokenUsage = record(payload.info);
      if (!tokenUsage) return;
      this.emit({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: this.threadId,
          turnId: stringValue(payload.turn_id) || this.currentTurnId || this.contextTurnId,
          tokenUsage,
        },
      });
      return;
    }
    if (rowType === "event_msg" && payloadType === "context_compacted") {
      const turnId = stringValue(payload.turn_id) || this.currentTurnId;
      this.pendingFinalMessage = null;
      if (!turnId) return;
      if (this.pendingCompactionId) {
        this.pendingCompactionId = null;
        return;
      }
      const id = `context-compaction-${turnId}-${at}`;
      this.pendingCompactionId = null;
      this.emit({
        method: "item/completed",
        params: {
          threadId: this.threadId,
          turnId,
          item: {
            type: "contextCompaction",
            id,
          },
          completedAtMs: at,
        },
      });
      return;
    }
    if (rowType === "event_msg" && payloadType === "task_started") {
      const turnId = stringValue(payload.turn_id);
      if (!turnId) return;
      this.currentTurnId = turnId;
      this.contextTurnId = turnId;
      this.structuredItemIds.clear();
      this.structuredToolCalls.clear();
      this.inferredToolWrappers.clear();
      this.hasStructuredTools = false;
      this.pendingTools.clear();
      this.currentTurnPlanMode =
        stringValue(payload.collaboration_mode_kind) === "plan" || this.nextTurnPlanMode;
      this.nextTurnPlanMode = false;
      this.emit({
        method: "turn/started",
        params: {
          threadId: this.threadId,
          turnId,
          turn: { id: turnId, status: "inProgress" },
          startedAtMs: at,
        },
      });
      return;
    }
    if (rowType === "event_msg" && ["task_complete", "turn_aborted"].includes(payloadType)) {
      const turnId = stringValue(payload.turn_id) || this.currentTurnId;
      if (!turnId) return;
      // A delayed completion for the previous turn cannot stop the current
      // turn or release its pending final message.
      if (this.currentTurnId && this.currentTurnId !== turnId) return;
      this.flushPendingFinalMessage();
      const interrupted = payloadType === "turn_aborted";
      const errorMessage =
        payloadType === "task_complete" ? boundedTurnErrorMessage(payload.error) : "";
      this.emit({
        method: "turn/completed",
        params: {
          threadId: this.threadId,
          turnId,
          turn: {
            id: turnId,
            status: interrupted ? "interrupted" : errorMessage ? "failed" : "completed",
            ...(errorMessage ? { error: { message: errorMessage } } : {}),
          },
          completedAtMs: at,
        },
      });
      if (this.currentTurnId === turnId) {
        this.currentTurnId = null;
        this.currentTurnPlanMode = false;
        this.pendingTools.clear();
        this.structuredToolCalls.clear();
        this.inferredToolWrappers.clear();
        this.pendingCompactionId = null;
      }
      return;
    }
    if (rowType !== "response_item") return;
    const turnId = turnIdFromPayload(payload, this.currentTurnId);
    if (!turnId) return;
    this.currentTurnId = turnId;
    const id = stringValue(payload.id);

    if (payloadType === "message" && payload.role === "user" && id) {
      const text = responseText(payload);
      if (!text) return;
      const content = userMessageContent(payload);
      const publicText = sanitizePublicTranscriptText(text);
      if (publicText === null || content.length === 0) return;
      const metadata = record(payload.internal_chat_message_metadata_passthrough);
      const embeddedClientId = stringValue(metadata?.client_id).trim();
      this.pendingUserMessage = {
        turnId,
        item: {
          type: "userMessage",
          id,
          content,
        },
        completedAtMs: at,
        comparisonText: canonicalUserMessageText(text),
      };
      // Some runtimes already put the durable id on the response item. There
      // is nothing left to join in that case.
      if (embeddedClientId) this.flushPendingUserMessage(embeddedClientId);
      return;
    }
    if (payloadType === "message" && payload.role === "assistant" && id) {
      const text = responseText(payload);
      if (!text) return;
      const publicText = sanitizePublicTranscriptText(text);
      if (publicText === null || !publicText) return;
      const item = {
        type: "agentMessage",
        id,
        text: publicText,
        phase: stringValue(payload.phase) || null,
        ...(this.currentTurnPlanMode ? { androidRemotePlanMode: true } : {}),
      };
      if (payload.phase === "final_answer") {
        this.pendingFinalMessage = { turnId, item, completedAtMs: at };
      } else {
        this.emit({
          method: "item/completed",
          params: { threadId: this.threadId, turnId, item, completedAtMs: at },
        });
      }
      return;
    }
    if (payloadType === "reasoning" && id) {
      const summary = reasoningSummary(payload);
      this.emit({
        method: "item/completed",
        params: {
          threadId: this.threadId,
          turnId,
          item: { type: "reasoning", id, summary },
          completedAtMs: at,
        },
      });
      return;
    }
    if (["custom_tool_call", "function_call"].includes(payloadType)) {
      const wrappedToolNames = stringValue(payload.input).matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/gu);
      const names = [...wrappedToolNames].map(match => match[1]);
      const onlyPollsCommand = payload.name === "write_stdin" || (payload.name === "exec"
        && names.length > 0 && names.every(name => name === "write_stdin"));
      // Polling an existing process is not another command in Desktop's
      // timeline. Its canonical item will update if there is new output/state.
      if (this.hasStructuredTools && onlyPollsCommand) return;
      const planUpdate = planUpdateFromToolCall(payload);
      if (planUpdate) {
        this.emit({
          method: "turn/plan/updated",
          params: { threadId: this.threadId, turnId, ...planUpdate },
        });
        return;
      }
      const waitingCell = imageGenerationWaitCell(payload);
      const waitingImage = waitingCell ? [...this.pendingTools.entries()].find(([, item]) => item.androidRemoteImageCellId === waitingCell) : undefined;
      const item = waitingImage?.[1] ?? toolItem(payload);
      const callId = stringValue(payload.call_id) || id;
      if (!item || !callId) return;
      if (waitingImage) this.pendingTools.delete(waitingImage[0]);
      this.pendingTools.set(callId, item);
      if (stringValue(payload.name) === "exec") this.inferredToolWrappers.add(callId);
      this.emit({
        method: "item/started",
        params: { threadId: this.threadId, turnId, item, startedAtMs: at },
      });
      return;
    }
    if (["custom_tool_call_output", "function_call_output"].includes(payloadType)) {
      const callId = stringValue(payload.call_id);
      const pending = this.pendingTools.get(callId);
      if (!pending) return;
      const runningCell = pending.type === "imageGeneration" ? runningImageGenerationCell(outputString(payload)) : null;
      if (runningCell) {
        this.pendingTools.set(callId, { ...pending, androidRemoteImageCellId: runningCell });
        return;
      }
      this.pendingTools.delete(callId);
      this.inferredToolWrappers.delete(callId);
      if (this.structuredToolCalls.delete(callId) && pending.type !== "imageGeneration") return;
      const output = outputString(payload);
      const failed = failedOutput(output) || pending.androidRemoteImageFailed === true;
      this.emit({
        method: "item/completed",
        params: {
          threadId: this.threadId,
          turnId,
          item: {
            ...pending,
            status: failed ? "failed" : "completed",
            ...(pending.type === "imageGeneration" ? { generatedImages: generatedImagePaths([pending, payload]) } : {}),
            ...(pending.type === "commandExecution"
              ? { aggregatedOutput: output.slice(-64 * 1024), exitCode: failed ? 1 : 0 }
              : {}),
          },
          completedAtMs: at,
        },
      });
    }
  }
}

async function consumeRange(
  path: string,
  startOffset: number,
  projector: DesktopSessionRecordProjector,
): Promise<number> {
  const decoder = new TextDecoder();
  const reader = Bun.file(path).slice(startOffset).stream().getReader();
  let absoluteOffset = startOffset;
  let lineStart = startOffset;
  let parts: Uint8Array[] = [];
  let lineBytes = 0;
  let oversized = false;
  const append = (bytes: Uint8Array) => {
    lineBytes += bytes.byteLength;
    if (lineBytes > MAX_RECORD_BYTES) {
      oversized = true;
      parts = [];
    } else if (!oversized && bytes.byteLength > 0) {
      parts.push(bytes.slice());
    }
  };
  const emitLine = (nextOffset: number) => {
    if (!oversized && lineBytes > 0) {
      const joined = new Uint8Array(lineBytes);
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.byteLength;
      }
      try {
        projector.consume(JSON.parse(decoder.decode(joined)));
      } catch {
        /* incomplete or malformed records are retried from the last newline */
      }
    }
    lineStart = nextOffset;
    parts = [];
    lineBytes = 0;
    oversized = false;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      let segmentStart = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        append(chunk.subarray(segmentStart, index));
        absoluteOffset += index - segmentStart + 1;
        emitLine(absoluteOffset);
        segmentStart = index + 1;
      }
      append(chunk.subarray(segmentStart));
      absoluteOffset += chunk.byteLength - segmentStart;
    }
  } finally {
    reader.releaseLock();
  }
  return lineStart;
}

function isThreadSettingsRecord(row: JsonRecord | null, payload: JsonRecord | null): boolean {
  if (!row || !payload) return false;
  if (row.type === "turn_context") return stringValue(payload.model).trim().length > 0;
  if (row.type !== "event_msg" || stringValue(payload.type) !== "thread_settings_applied") {
    return false;
  }
  return stringValue(record(payload.thread_settings)?.model).trim().length > 0;
}

function isTokenUsageRecord(row: JsonRecord | null, payload: JsonRecord | null): boolean {
  return (
    row?.type === "event_msg" &&
    stringValue(payload?.type) === "token_count" &&
    record(payload?.info) !== null
  );
}

function recentActiveRows(
  text: string,
  startsInsideRecord: boolean,
): {
  boundaryFound: boolean;
  settingsFound: boolean;
  tokenUsageFound: boolean;
  rows: unknown[];
} {
  const lines = text.split("\n");
  if (startsInsideRecord) lines.shift();
  const rows = lines.flatMap((line) => {
    if (!line) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
  let boundary = -1;
  let latestSettings = -1;
  let latestTokenUsage = -1;
  let settingsSinceTerminal = -1;
  let active = false;
  let boundaryFound = false;
  for (let index = 0; index < rows.length; index += 1) {
    const row = record(rows[index]);
    const payload = record(row?.payload);
    if (isThreadSettingsRecord(row, payload)) {
      latestSettings = index;
      settingsSinceTerminal = index;
    }
    if (isTokenUsageRecord(row, payload)) latestTokenUsage = index;
    if (row?.type !== "event_msg" || !payload) continue;
    const type = stringValue(payload.type);
    if (type === "task_started") {
      boundary = settingsSinceTerminal >= 0 ? settingsSinceTerminal : index;
      active = true;
      boundaryFound = true;
    }
    if (["task_complete", "turn_aborted"].includes(type)) {
      boundary = index;
      active = false;
      boundaryFound = true;
      settingsSinceTerminal = -1;
    }
  }
  const selected = new Set<number>();
  if (active && boundary >= 0) {
    for (let index = boundary; index < rows.length; index += 1) selected.add(index);
  }
  if (latestSettings >= 0) selected.add(latestSettings);
  if (latestTokenUsage >= 0) selected.add(latestTokenUsage);
  return {
    boundaryFound,
    settingsFound: latestSettings >= 0,
    tokenUsageFound: latestTokenUsage >= 0,
    // Completed Desktop tasks still own their last model/reasoning selection
    // and their last context-window reading. Replaying only active turns
    // discarded that durable metadata after every Remodex restart, so
    // Android fell back to defaults and "Waiting for context usage" until a
    // new turn happened to publish another token-count record.
    rows: [...selected].sort((left, right) => left - right).map((index) => rows[index]!),
  };
}

async function scanSessionReplayState(
  path: string,
  size: number,
): Promise<{
  activeTurnStartOffset: number | null;
  latestSettingsRecord: unknown | null;
  latestTokenUsageRecord: unknown | null;
  latestTokenUsageOffset: number | null;
}> {
  const reader = Bun.file(path).slice(0, size).stream().getReader();
  let absoluteOffset = 0;
  let lineStart = 0;
  let parts: Uint8Array[] = [];
  let lineBytes = 0;
  let oversized = false;
  let activeTurnStartOffset: number | null = null;
  let latestSettingsRecord: unknown | null = null;
  let latestTokenUsageRecord: unknown | null = null;
  let latestTokenUsageOffset: number | null = null;
  let active = false;
  const decoder = new TextDecoder();
  const append = (bytes: Uint8Array) => {
    lineBytes += bytes.byteLength;
    // A turn_context record can contain a large environment snapshot. Keep the
    // same hard cap as ordinary replay so older sessions without the compact
    // thread_settings_applied record can still recover their picker state.
    if (lineBytes > MAX_RECORD_BYTES) {
      oversized = true;
      parts = [];
    } else if (!oversized && bytes.byteLength > 0) {
      parts.push(bytes.slice());
    }
  };
  const inspectLine = (nextOffset: number) => {
    if (!oversized && lineBytes > 0) {
      const joined = new Uint8Array(lineBytes);
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.byteLength;
      }
      try {
        const row = record(JSON.parse(decoder.decode(joined)));
        const payload = record(row?.payload);
        if (isThreadSettingsRecord(row, payload)) latestSettingsRecord = row;
        if (isTokenUsageRecord(row, payload)) {
          latestTokenUsageRecord = row;
          latestTokenUsageOffset = lineStart;
        }
        if (row?.type === "event_msg" && payload) {
          const type = stringValue(payload.type);
          if (type === "task_started") {
            activeTurnStartOffset = lineStart;
            active = true;
          } else if (["task_complete", "turn_aborted"].includes(type)) {
            activeTurnStartOffset = null;
            active = false;
          }
        }
      } catch {
        /* malformed boundary candidates are ignored */
      }
    }
    lineStart = nextOffset;
    parts = [];
    lineBytes = 0;
    oversized = false;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      let segmentStart = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        append(chunk.subarray(segmentStart, index));
        absoluteOffset += index - segmentStart + 1;
        inspectLine(absoluteOffset);
        segmentStart = index + 1;
      }
      append(chunk.subarray(segmentStart));
      absoluteOffset += chunk.byteLength - segmentStart;
    }
  } finally {
    reader.releaseLock();
  }
  return {
    activeTurnStartOffset: active ? activeTurnStartOffset : null,
    latestSettingsRecord,
    latestTokenUsageRecord,
    latestTokenUsageOffset,
  };
}

async function replayActiveTail(
  path: string,
  size: number,
  projector: DesktopSessionRecordProjector,
): Promise<number> {
  const start = Math.max(0, size - INITIAL_TAIL_BYTES);
  const bytes = new Uint8Array(await Bun.file(path).slice(start, size).arrayBuffer());
  // Never advance past a half-written JSON record: its remainder belongs to
  // the next append, including when it carries the turn's completion signal.
  const newline = bytes.lastIndexOf(0x0a);
  const completeText = new TextDecoder().decode(bytes.subarray(0, newline + 1));
  const completeOffset = start + newline + 1;
  const recent = recentActiveRows(completeText, start > 0);
  if (start === 0 || (recent.boundaryFound && recent.settingsFound && recent.tokenUsageFound)) {
    for (const row of recent.rows) projector.consume(row);
    return completeOffset;
  }
  // A long live or completed turn can push its model settings outside the fast
  // 16 MiB tail. Find both pieces in one bounded-memory pass: publish only the
  // latest durable settings and context usage, then replay the active turn (if
  // any). Completed message history remains on the authoritative thread/read
  // path and is not duplicated.
  const scan = await scanSessionReplayState(path, size);
  if (scan.latestSettingsRecord) projector.consume(scan.latestSettingsRecord);
  if (
    scan.latestTokenUsageRecord &&
    (scan.activeTurnStartOffset === null ||
      scan.latestTokenUsageOffset === null ||
      scan.latestTokenUsageOffset < scan.activeTurnStartOffset)
  ) {
    projector.consume(scan.latestTokenUsageRecord);
  }
  if (scan.activeTurnStartOffset !== null) {
    return consumeRange(path, scan.activeTurnStartOffset, projector);
  }
  return completeOffset;
}

export class DesktopSessionStream implements AndroidDesktopSessionStream {
  private readonly watches = new Map<string, SessionWatch>();
  private readonly codexHome: string | undefined;

  constructor(options: { codexHome?: string } = {}) {
    // Resolving CODEX_HOME validates that the directory already exists. Keep
    // construction side-effect free so a disabled Android gateway cannot make
    // unrelated Remodex management routes fail during server startup.
    this.codexHome = options.codexHome;
  }

  isWatching(threadId: string): boolean {
    return this.watches.has(threadId);
  }

  activeTurnId(threadId: string): string | null {
    return this.watches.get(threadId)?.projector.activeTurnId() ?? null;
  }

  async watchThread(input: {
    threadId: string;
    sourcePath: string;
    onMessage: (message: CodexJsonRpcMessage) => void;
  }): Promise<boolean> {
    const existing = this.watches.get(input.threadId);
    try {
      const [home, canonicalPath] = await Promise.all([
        realpath(resolve(this.codexHome ?? getCodexHome())),
        realpath(resolve(input.sourcePath)),
      ]);
      const sessions = resolve(home, "sessions");
      const archived = resolve(home, "archived_sessions");
      if (!inside(sessions, canonicalPath) && !inside(archived, canonicalPath)) return false;
      if (existing?.canonicalPath === canonicalPath) return true;
      this.unwatchThread(input.threadId);
      const source = await stat(canonicalPath);
      if (!source.isFile()) return false;
      const projector = new DesktopSessionRecordProjector(input.threadId, input.onMessage);
      const offset = await replayActiveTail(canonicalPath, source.size, projector);
      const watcher = watch(canonicalPath, { persistent: false }, () =>
        this.queueDrain(input.threadId),
      );
      const poller = setInterval(() => this.queueDrain(input.threadId), RECOVERY_POLL_MS);
      poller.unref?.();
      this.watches.set(input.threadId, {
        canonicalPath,
        device: source.dev,
        inode: source.ino,
        onMessage: input.onMessage,
        offset,
        watcher,
        poller,
        projector,
        draining: false,
        pending: false,
      });
      // Close the stat/watch race: anything appended after the stat is read now.
      this.queueDrain(input.threadId);
      return true;
    } catch {
      return false;
    }
  }

  unwatchThread(threadId: string): void {
    const current = this.watches.get(threadId);
    if (!current) return;
    current.watcher.close();
    clearInterval(current.poller);
    this.watches.delete(threadId);
  }

  close(): void {
    for (const threadId of [...this.watches.keys()]) this.unwatchThread(threadId);
  }

  private queueDrain(threadId: string): void {
    const current = this.watches.get(threadId);
    if (!current) return;
    if (current.draining) {
      current.pending = true;
      return;
    }
    current.draining = true;
    void this.drain(threadId).finally(() => {
      const latest = this.watches.get(threadId);
      if (latest !== current) return;
      latest.draining = false;
      if (latest.pending) {
        latest.pending = false;
        this.queueDrain(threadId);
      }
    });
  }

  private async drain(threadId: string): Promise<void> {
    const current = this.watches.get(threadId);
    if (!current) return;
    try {
      const source = await stat(current.canonicalPath);
      if (source.size < current.offset || source.dev !== current.device || source.ino !== current.inode) {
        // Windows can replace/truncate a rollout during history repair. An old
        // byte offset and active turn cannot be reused against the new file.
        current.projector = new DesktopSessionRecordProjector(threadId, current.onMessage);
        current.device = source.dev;
        current.inode = source.ino;
        current.offset = await replayActiveTail(current.canonicalPath, source.size, current.projector);
        current.onMessage({ method: "thread/history/changed", params: { threadId } });
        return;
      }
      if (source.size === current.offset) return;
      current.offset = await consumeRange(current.canonicalPath, current.offset, current.projector);
    } catch {
      // A transient rename or concurrent write is retried by the recovery poll.
    }
  }
}
