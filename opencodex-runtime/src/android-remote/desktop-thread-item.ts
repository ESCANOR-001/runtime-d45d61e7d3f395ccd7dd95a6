import { fileURLToPath } from "node:url";
import { generatedImagePaths } from "./generated-images";
import { isPrivateTranscriptRole, sanitizePublicTranscriptText } from "./user-message-identity";
type JsonRecord = Record<string, unknown>;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

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

export function durationMilliseconds(value: unknown): number | null {
  const direct = finiteNumber(value);
  if (direct !== null) return Math.max(0, Math.round(direct));
  const row = record(value);
  if (!row) return null;
  const seconds = finiteNumber(row.secs) ?? finiteNumber(row.seconds) ?? 0;
  const nanos = finiteNumber(row.nanos) ?? finiteNumber(row.nanoseconds) ?? 0;
  return Math.max(0, Math.round(seconds * 1_000 + nanos / 1_000_000));
}

function camelKey(value: string): string {
  return value.replace(/_([a-z0-9])/gu, (_match, letter: string) => letter.toUpperCase());
}

function camelEnum(value: string): string {
  return camelKey(value.toLowerCase());
}

function normalizedStatus(value: unknown, fallback = ""): string {
  const status = stringValue(value).trim();
  if (!status) return fallback;
  // Both Rust snake_case and public/PascalCase variants occur in saved events.
  if (status.replaceAll("_", "").toLowerCase() === "inprogress") return "inProgress";
  return camelEnum(status);
}

export function deepCamelValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.slice(0, 256).map(entry => deepCamelValue(entry, depth + 1));
  const row = record(value);
  if (!row) return value;
  const output: JsonRecord = {};
  for (const [key, entry] of Object.entries(row).slice(0, 256)) {
    output[camelKey(key)] = deepCamelValue(entry, depth + 1);
  }
  return output;
}

function localPath(value: unknown): string {
  const path = stringValue(value).trim();
  if (!path.toLowerCase().startsWith("file://")) return path;
  try {
    return fileURLToPath(path);
  } catch {
    return path;
  }
}

export function itemType(value: unknown): string {
  const raw = stringValue(value).trim();
  const known: Record<string, string> = {
    AgentMessage: "agentMessage",
    CollabAgentToolCall: "collabAgentToolCall",
    CommandExecution: "commandExecution",
    ContextCompaction: "contextCompaction",
    DynamicToolCall: "dynamicToolCall",
    EnteredReviewMode: "reviewMarker",
    ExitedReviewMode: "reviewMarker",
    FileChange: "fileChange",
    ImageGeneration: "imageGeneration",
    ImageView: "imageView",
    McpToolCall: "mcpToolCall",
    Plan: "plan",
    Reasoning: "reasoning",
    ReviewMarker: "reviewMarker",
    SubAgentActivity: "subAgentActivity",
    UserInputRequest: "userInputRequest",
    UserMessage: "userMessage",
    WebSearch: "webSearch",
  };
  return known[raw] ?? (raw ? `${raw.charAt(0).toLowerCase()}${raw.slice(1)}` : "");
}

function normalizedFileChanges(value: unknown): JsonRecord[] {
  const changes = record(value);
  if (changes) {
    return Object.entries(changes).slice(0, 64).flatMap(([path, rawChange]) => {
      const change = record(deepCamelValue(rawChange));
      if (!path || !change) return [];
      const kind = stringValue(change.type).trim() || "update";
      const diff = stringValue(change.unifiedDiff).trim();
      const movePath = stringValue(change.movePath).trim();
      return [{
        path,
        kind: {
          type: kind,
          ...(movePath ? { movePath } : {}),
        },
        ...(diff ? { diff: bounded(diff, 1024 * 1024) } : {}),
      }];
    });
  }
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap(rawChange => {
    const change = record(deepCamelValue(rawChange));
    return change ? [change] : [];
  });
}

/**
 * `item_completed` rollout events contain Codex's already-structured public
 * ThreadItem snapshot, but use Rust's persisted enum/key spelling. Normalize
 * that durable snapshot instead of trying to infer UI rows from raw tool JSON.
 */
export function normalizedCompletedItem(value: unknown, completed: boolean): JsonRecord | null {
  const raw = record(value);
  const type = itemType(raw?.type);
  const id = stringValue(raw?.id).trim();
  if (!raw || !type || !id) return null;
  if (type === "imageGeneration" || (type === "extension" && raw.kind === "image_gen.generation")) {
    return { type: "imageGeneration", id,
      status: normalizedStatus(raw.status, completed ? "completed" : "inProgress"),
      generatedImages: generatedImagePaths(raw),
    };
  }
  if (
    isPrivateTranscriptRole(raw.role)
    || type === "developerMessage"
    || type === "systemMessage"
    || type === "toolMessage"
  ) return null;
  const common = record(deepCamelValue(raw)) ?? {};

  if (type === "userMessage") {
    const rawText = Array.isArray(raw.content)
      ? raw.content.flatMap(entry => {
          const row = record(entry);
          const part = typeof row?.text === "string"
            ? row.text
            : typeof row?.value === "string"
              ? row.value
              : "";
          return part ? [part] : [];
        }).join("")
      : stringValue(raw.text);
    const publicText = rawText ? sanitizePublicTranscriptText(rawText) : "";
    if (publicText === null) return null;
    const content = normalizedPublicMessageContent(raw.content);
    if (publicText && !messageContentText(content)) {
      content.unshift({ type: "text", text: publicText });
    }
    if (rawText && content.length === 0) return null;
    return {
      type,
      id,
      clientId: stringValue(raw.client_id ?? raw.clientId).trim() || null,
      content,
    };
  }
  if (type === "agentMessage") {
    const content = Array.isArray(raw.content) ? raw.content : [];
    const text = content.flatMap(entry => {
      const row = record(entry);
      const part = stringValue(row?.text ?? row?.value);
      return part ? [part] : [];
    }).join("");
    const rawText = text || stringValue(raw.text);
    const publicText = rawText ? sanitizePublicTranscriptText(rawText) : "";
    if (publicText === null || (rawText && publicText.length === 0)) return null;
    return {
      type,
      id,
      text: bounded(publicText ?? "", 2 * 1024 * 1024),
      phase: stringValue(raw.phase).trim() || null,
      memoryCitation: deepCamelValue(raw.memory_citation ?? raw.memoryCitation) ?? null,
      ...(Array.isArray(raw.questions) ? { questions: deepCamelValue(raw.questions) } : {}),
    };
  }
  if (type === "reasoning") {
    const summary = Array.isArray(raw.summary_text ?? raw.summary)
      ? (raw.summary_text ?? raw.summary) as unknown[]
      : [];
    const content = Array.isArray(raw.raw_content ?? raw.content)
      ? (raw.raw_content ?? raw.content) as unknown[]
      : [];
    return {
      type,
      id,
      summary: summary.flatMap(entry => typeof entry === "string" ? [entry] : []),
      content: content.flatMap(entry => typeof entry === "string" ? [entry] : []),
    };
  }
  if (type === "commandExecution") {
    const command = Array.isArray(raw.command)
      ? raw.command.flatMap(entry => typeof entry === "string" ? [entry] : []).join(" ")
      : stringValue(raw.command);
    const rawCommandActions = raw.parsed_cmd ?? raw.commandActions;
    const output = stringValue(raw.aggregated_output ?? raw.aggregatedOutput)
      || [stringValue(raw.stdout), stringValue(raw.stderr)].filter(Boolean).join("\n");
    return {
      type,
      id,
      pluginId: stringValue(raw.plugin_id ?? raw.pluginId).trim() || null,
      scriptPath: stringValue(raw.script_path ?? raw.scriptPath).trim() || null,
      command: bounded(command, MAX_COMMAND_BYTES),
      cwd: localPath(raw.cwd),
      processId: stringValue(raw.process_id ?? raw.processId).trim() || null,
      source: camelEnum(stringValue(raw.source)),
      status: normalizedStatus(raw.status, completed ? "completed" : "inProgress"),
      commandActions: Array.isArray(rawCommandActions)
        ? rawCommandActions.slice(0, 128).map(entry => deepCamelValue(entry))
        : [],
      aggregatedOutput: bounded(output, MAX_OUTPUT_BYTES),
      exitCode: finiteNumber(raw.exit_code ?? raw.exitCode),
      durationMs: durationMilliseconds(raw.duration_ms ?? raw.durationMs ?? raw.duration),
    };
  }
  if (type === "fileChange") {
    return {
      type,
      id,
      status: normalizedStatus(raw.status, completed ? "completed" : "inProgress"),
      changes: normalizedFileChanges(raw.changes),
    };
  }
  if (type === "imageView") {
    return { type, id, path: localPath(raw.path) };
  }
  if (type === "contextCompaction") {
    return { type, id, status: completed ? "completed" : "inProgress" };
  }
  if (type === "reviewMarker") {
    return {
      type,
      id,
      state: raw.type === "EnteredReviewMode"
        ? "entered"
        : raw.type === "ExitedReviewMode"
          ? "exited"
          : stringValue(raw.state).trim(),
    };
  }

  const normalized: JsonRecord = {
    ...common,
    type,
    id,
  };
  if ("status" in raw || ["dynamicToolCall", "mcpToolCall", "collabAgentToolCall", "imageGeneration", "userInputRequest"].includes(type)) {
    normalized.status = normalizedStatus(raw.status, completed ? "completed" : "inProgress");
  }
  const durationMs = durationMilliseconds(raw.duration_ms ?? raw.durationMs ?? raw.duration);
  if (durationMs !== null) normalized.durationMs = durationMs;
  delete normalized.duration;
  return normalized;
}

function normalizedPublicMessageContent(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 128).flatMap(entryValue => {
    const entry = record(deepCamelValue(entryValue));
    if (!entry) return [];
    // Persisted enum values use underscores; deepCamelValue only converts keys.
    if (entry.type === "local_image") entry.type = "localImage";
    if (entry.type === "local_audio") entry.type = "localAudio";
    const transcriptFields = (["text", "value"] as const).filter(key =>
      typeof entry[key] === "string");
    if (transcriptFields.length === 0) return [entry];
    const sanitized: JsonRecord = { ...entry };
    let hasPublicText = false;
    for (const key of transcriptFields) {
      const publicText = sanitizePublicTranscriptText(entry[key]);
      if (publicText === null || publicText.length === 0) delete sanitized[key];
      else {
        sanitized[key] = publicText;
        hasPublicText = true;
      }
    }
    if (!hasPublicText) return [];
    const normalizedType = stringValue(entry.type).replace(/[^a-z0-9]/giu, "").toLowerCase();
    const textEntry = normalizedType === "text" || normalizedType === "inputtext" || normalizedType === "outputtext";
    const normalizedText = typeof sanitized.text === "string"
      ? sanitized.text
      : typeof sanitized.value === "string"
        ? sanitized.value
        : "";
    if (textEntry) delete sanitized.value;
    return [{
      ...sanitized,
      ...(textEntry
        ? { type: "text", text: normalizedText }
        : {}),
    }];
  });
}

function messageContentText(value: readonly JsonRecord[]): string {
  return value.flatMap(entry => {
    const part = typeof entry.text === "string"
      ? entry.text
      : typeof entry.value === "string"
        ? entry.value
        : "";
    return part ? [part] : [];
  }).join("");
}
