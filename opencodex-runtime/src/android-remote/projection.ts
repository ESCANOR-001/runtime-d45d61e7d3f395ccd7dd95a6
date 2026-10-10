import { createHash } from "node:crypto";
import { generatedImagePaths } from "./generated-images";
import { normalizedCompletedItem } from "./desktop-thread-item";
import { codexRuntimeStatus } from "./thread-runtime-status";
import { Buffer } from "node:buffer";
import { basename } from "node:path";
import {
  attachmentUserMessageIdentityKey,
  isPrivateTranscriptRole,
  sanitizePublicTranscriptText,
  publicUserMessageText,
} from "./user-message-identity";
import {
  boundedTurnErrorMessage,
  canonicalTurnActivitySnapshot,
  canonicalTurnStatusIsActive,
  canonicalTurnStatusIsTerminal,
  canonicalTurnsNewestFirst,
  normalizedCanonicalTurnStatus,
  projectedTurnLifecycleWins,
} from "./turn-activity";

type JsonRecord = Record<string, unknown>;

export const ANDROID_REMOTE_TOOL_TEXT_LIMIT_BYTES = 64 * 1024;
const ANDROID_REMOTE_FILE_DIFF_TOTAL_LIMIT_BYTES = 512 * 1024;
const ANDROID_REMOTE_FILE_DIFF_LIMIT_BYTES = 64 * 1024;
const TRUNCATION_SUFFIX = "\n[truncated]";

type PublicFileChange = {
  path: string;
  additions: number;
  deletions: number;
  diff?: string;
  diffTruncated?: boolean;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number >= 0 ? Math.floor(number) : null;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && end < value.length) {
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}

function boundedText(value: unknown, maximumBytes = ANDROID_REMOTE_TOOL_TEXT_LIMIT_BYTES): {
  value: string;
  truncated: boolean;
} {
  const source = typeof value === "string" ? value : "";
  if (Buffer.byteLength(source, "utf8") <= maximumBytes) {
    return { value: source, truncated: false };
  }
  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
  return {
    value: `${utf8Prefix(source, Math.max(0, maximumBytes - suffixBytes))}${TRUNCATION_SUFFIX}`,
    truncated: true,
  };
}

function countUnifiedDiffLines(value: unknown): { additions: number; deletions: number } {
  if (typeof value !== "string") return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of value.split(/\r?\n/u)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function publicFileChanges(item: JsonRecord): PublicFileChange[] {
  if (!Array.isArray(item.changes)) return [];
  const changes = item.changes.slice(0, 64);
  const perFileDiffLimit = Math.min(
    ANDROID_REMOTE_FILE_DIFF_LIMIT_BYTES,
    Math.max(8 * 1024, Math.floor(ANDROID_REMOTE_FILE_DIFF_TOTAL_LIMIT_BYTES / changes.length)),
  );
  let remainingDiffBytes = ANDROID_REMOTE_FILE_DIFF_TOTAL_LIMIT_BYTES;
  return changes.flatMap((value) => {
    const change = record(value);
    const path = text(change?.path).trim()
      || text(change?.filePath).trim()
      || text(change?.relativePath).trim();
    if (!path) return [];
    const rawDiffValue = change?.diff ?? change?.patch ?? change?.unifiedDiff ?? change?.content;
    const diffCounts = countUnifiedDiffLines(rawDiffValue);
    const rawDiff = typeof rawDiffValue === "string" && rawDiffValue.trim().length > 0
      ? rawDiffValue
      : null;
    const projectedDiff = rawDiff && remainingDiffBytes > 0
      ? boundedText(rawDiff, Math.min(perFileDiffLimit, remainingDiffBytes))
      : null;
    if (projectedDiff) {
      remainingDiffBytes -= Buffer.byteLength(projectedDiff.value, "utf8");
    }
    return [{
      path: boundedText(path, 8 * 1024).value,
      additions: Math.max(0, Math.floor(finite(change?.additions) ?? diffCounts.additions)),
      deletions: Math.max(0, Math.floor(finite(change?.deletions) ?? diffCounts.deletions)),
      ...(projectedDiff
        ? {
            diff: projectedDiff.value,
            ...(projectedDiff.truncated ? { diffTruncated: true } : {}),
          }
        : {}),
    }];
  });
}

function humanizeToolToken(value: unknown): string {
  const raw = text(value).trim();
  if (!raw) return "";
  const token = raw
    .split(/__|[./:]/u)
    .filter(Boolean)
    .at(-1)
    ?.replace(/^(?:mcp|functions?|tools?)_+/iu, "")
    .replace(/[_-]+/gu, " ")
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replace(/\s+/gu, " ")
    .trim() ?? "";
  return token ? `${token.charAt(0).toUpperCase()}${token.slice(1)}` : "";
}

function concisePublicText(value: unknown, maximumCharacters = 64): string {
  const normalized = text(value).replace(/\s+/gu, " ").trim();
  if (normalized.length <= maximumCharacters) return normalized;
  return `${normalized.slice(0, Math.max(1, maximumCharacters - 1)).trimEnd()}…`;
}

function concisePublicBasename(value: unknown): string {
  const normalized = text(value)
    .trim()
    .replace(/^["'`(<]+|["'`>),;]+$/gu, "")
    .replace(/:\d+(?::\d+)?$/u, "");
  if (!normalized || /^[a-z][a-z\d+.-]*:\/\//iu.test(normalized)) return "";
  const basename = normalized.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
  if (!basename || basename === "." || basename === "..") return "";
  return concisePublicText(basename, 48);
}

function publicReadFileBasename(value: unknown): string {
  const normalized = text(value)
    .trim()
    .replace(/^["'`(<]+|["'`>),;]+$/gu, "")
    .replace(/:\d+(?::\d+)?$/u, "");
  if (!normalized || /^[a-z][a-z\d+.-]*:\/\//iu.test(normalized)) return "";
  const name = normalized.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
  if (!name || name === "." || name === "..") return "";
  // Normal filesystem names fit comfortably inside this safety bound. Unlike
  // the compact labels used by other activity types, reading activity labels
  // retain the complete filename so Android never has to replace it with +N.
  return boundedText(name, 1024).value;
}

function withConciseDetail(title: string, detail: string): string {
  const normalized = concisePublicText(detail, Math.max(16, 92 - title.length));
  return normalized ? `${title} · ${normalized}` : title;
}

function commandReadFileNames(command: string): string[] {
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^\s;&|]+/gu) ?? [];
  const names: string[] = [];
  for (const rawToken of tokens) {
    const token = rawToken
      .replace(/^["'`]+|["'`,)]+$/gu, "")
      .replaceAll("\\\"", "\"")
      .trim();
    if (
      !token ||
      token.startsWith("-") ||
      token.includes("*") ||
      token.includes("${") ||
      /^\d+(?:\.\d+)?$/u.test(token) ||
      /^(?:\d*>)?\/(?:dev\/(?:null|zero|random|urandom|stdin|stdout|stderr|fd(?:\/.*)?)|proc\/[^/]+\/(?:cwd|root|exe|fd(?:\/.*)?))$/u.test(token) ||
      /^[a-z][a-z\d+.-]*:\/\//iu.test(token)
    ) continue;
    const fileName = publicReadFileBasename(token);
    if (!fileName) continue;
    const pathLike = /[\\/]/u.test(token)
      || /\.[a-z\d]{1,12}(?::\d+(?::\d+)?)?$/iu.test(token)
      || /^(?:AGENTS|CHANGELOG|Dockerfile|LICENSE|Makefile|README)(?:\.[a-z\d]+)?$/iu.test(fileName);
    if (!pathLike || names.includes(fileName)) continue;
    names.push(fileName);
  }
  return names;
}

function argumentPathNames(argumentsRecord: JsonRecord | null): string[] {
  if (!argumentsRecord) return [];
  const values: unknown[] = [];
  for (const key of ["path", "file", "filePath", "filename", "paths", "files"] as const) {
    const value = argumentsRecord[key];
    if (Array.isArray(value)) values.push(...value);
    else if (value !== undefined) values.push(value);
  }
  return values
    .flatMap(value => typeof value === "string" ? [publicReadFileBasename(value)] : [])
    .filter((value, index, all) => value && all.indexOf(value) === index);
}

function argumentPathDetail(argumentsRecord: JsonRecord | null): string {
  const names = argumentPathNames(argumentsRecord);
  if (names.length === 0) return "";
  return names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`;
}

function readingFilesTitle(fileNames: readonly string[]): string {
  if (fileNames.length === 0) return "Reading files";
  return boundedText(`Reading ${fileNames.join(", ")}`, 16 * 1024).value;
}

function collaborationSubject(item: JsonRecord): string {
  const argumentsRecord = toolArguments(item.arguments);
  const target = record(argumentsRecord?.target);
  const candidates: unknown[] = [
    argumentsRecord?.task_name,
    argumentsRecord?.taskName,
    argumentsRecord?.agent_name,
    argumentsRecord?.agentName,
    target?.task_name,
    target?.name,
    typeof argumentsRecord?.target === "string" ? argumentsRecord.target : undefined,
    item.taskName,
    item.agentName,
  ];
  for (const candidate of candidates) {
    const value = concisePublicText(candidate, 48);
    if (!value || /^[\da-f-]{16,}$/iu.test(value)) continue;
    return value.startsWith("/") ? concisePublicBasename(value) : value;
  }
  return "";
}

function collaborationLabel(value: unknown, item: JsonRecord = {}): string {
  const normalized = text(value).toLowerCase().replace(/[^a-z\d]+/gu, "_");
  const title = normalized.includes("spawn") || normalized.includes("create_agent")
    ? "Starting agent"
    : normalized.includes("wait")
      ? "Waiting for agent"
      : normalized.includes("send_message") || normalized.includes("followup")
        ? "Messaging agent"
        : normalized.includes("interrupt")
          ? "Interrupting agent"
          : normalized.includes("close") || normalized.includes("finish")
            ? "Closing agent"
            : normalized.includes("list_agents")
              ? "Listing agents"
              : "Agent activity";
  return withConciseDetail(title, collaborationSubject(item));
}

type ToolPresentation = {
  itemType:
    | "codebase-search"
    | "collab_agent_tool_call"
    | "command_execution"
    | "dynamic_tool_call"
    | "file-read"
    | "image-generation"
    | "image_view"
    | "review-marker"
    | "web_search";
  title: string;
  fileNames?: string[];
  requestKind?: "command" | "file-read";
};

function normalizedToolName(value: unknown): string {
  return text(value)
    .split(/__|[./:]/u)
    .filter(Boolean)
    .at(-1)
    ?.replace(/[^a-z\d]+/giu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase() ?? "";
}

function hiddenDynamicTool(item: JsonRecord): boolean {
  const tool = normalizedToolName(item.tool);
  // These calls have a richer first-class event emitted alongside the router
  // row. Keeping both produced duplicate generic activities on Android.
  return tool === "exec"
    || tool === "exec_command"
    || tool === "write_stdin"
    || tool === "update_plan"
    || tool === "request_user_input";
}

function toolArguments(value: unknown): JsonRecord | null {
  const direct = record(value);
  if (direct) return direct;
  if (typeof value !== "string" || value.length > ANDROID_REMOTE_TOOL_TEXT_LIMIT_BYTES) return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function mcpToolTitle(serverValue: unknown, toolValue: unknown): string {
  const server = humanizeToolToken(serverValue);
  const tool = humanizeToolToken(toolValue);
  if (server && tool && server.toLowerCase() !== tool.toLowerCase()) {
    return withConciseDetail(`Using ${server}`, tool);
  }
  return server || tool ? `Using ${server || tool}` : "Using connected tool";
}

function dynamicToolPresentation(item: JsonRecord): ToolPresentation | null {
  const tool = normalizedToolName(item.tool);
  const argumentsRecord = toolArguments(item.arguments);
  const rawToolParts = text(item.tool).split("__").filter(Boolean);
  if (rawToolParts[0]?.toLowerCase() === "mcp" && rawToolParts.length >= 3) {
    return {
      itemType: "dynamic_tool_call",
      title: mcpToolTitle(rawToolParts.at(-2), rawToolParts.at(-1)),
    };
  }
  if (tool === "view_image" || tool === "image_view") {
    return {
      itemType: "image_view",
      title: withConciseDetail("Viewing Image", argumentPathDetail(argumentsRecord)),
    };
  }
  if (tool === "imagegen" || tool === "generate_image" || tool === "generated_image") {
    return { itemType: "image-generation", title: "Image generation" };
  }
  if (tool === "web_search" || tool === "search_web" || tool === "browse_web") {
    return {
      itemType: "web_search",
      title: withConciseDetail("Web Search", concisePublicText(argumentsRecord?.query, 56)),
    };
  }
  if (
    tool === "spawn_agent"
    || tool === "create_agent"
    || tool === "wait_agent"
    || tool === "close_agent"
    || tool === "send_message"
    || tool === "followup_task"
    || tool === "interrupt_agent"
    || tool === "list_agents"
  ) {
    return {
      itemType: "collab_agent_tool_call",
      title: collaborationLabel(tool, item),
    };
  }
  const target = record(argumentsRecord?.target);
  if (
    (tool === "open_in_codex" && text(target?.type).toLowerCase() === "review")
    || tool === "review"
    || tool === "start_review"
  ) {
    return {
      itemType: "review-marker",
      title: withConciseDetail("Review activity", argumentPathDetail(argumentsRecord)),
    };
  }
  if (tool === "read_file" || tool === "read_text_file" || tool === "read_many_files") {
    const fileNames = argumentPathNames(argumentsRecord);
    return {
      itemType: "file-read",
      title: readingFilesTitle(fileNames),
      fileNames,
      requestKind: "file-read",
    };
  }
  if (tool === "search_codebase" || tool === "search_files" || tool === "grep_search") {
    return {
      itemType: "codebase-search",
      title: "Searching the codebase",
      requestKind: "command",
    };
  }
  return null;
}

function commandText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter(entry => typeof entry === "string").join(" ");
  return "";
}

function decodeEmbeddedCommand(body: string, quote: '"' | "'" | "`"): string {
  if (quote === '"') {
    try { return JSON.parse(`"${body}"`) as string; }
    catch { return body; }
  }
  return body
    .replaceAll(`\\${quote}`, quote)
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t")
    .replaceAll("\\\\", "\\");
}

function publicCommandText(value: unknown): string {
  const command = commandText(value);
  const wrapperIndex = command.search(/\btools\.exec_command\s*\(/u);
  if (wrapperIndex < 0) return command;
  const wrapper = command.slice(wrapperIndex, wrapperIndex + 128 * 1024);
  const match = /\bcmd\s*:\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/u.exec(wrapper);
  const body = match?.[1] ?? match?.[2] ?? match?.[3];
  if (body === undefined) return command;
  const quote = match?.[1] !== undefined ? '"' : match?.[2] !== undefined ? "'" : "`";
  return decodeEmbeddedCommand(body, quote);
}

const FILE_READ_COMMAND_START = /^(?:(?:cat|head|tail|less|more|bat|wc|stat|file|readlink)\b|sed\s+-n\b)/iu;

function commandContainsOnlyFileReads(command: string): boolean {
  let foundRead = false;
  for (const rawSegment of command.split(/&&|\|\||[;|\n]/u)) {
    let segment = rawSegment.trim();
    if (!segment) continue;
    segment = segment.replace(/^(?:(?:then|do|else)\s+)+/iu, "");
    segment = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/u, "");
    if (!segment || /^(?:fi|done|then|do|else|true|:)$/iu.test(segment)) continue;
    if (!FILE_READ_COMMAND_START.test(segment)) return false;
    foundRead = true;
  }
  return foundRead;
}

function commandPresentation(item: JsonRecord): ToolPresentation {
  // Recovered Codex history can contain the JavaScript orchestration wrapper
  // rather than the inner shell command. Classify and label only its `cmd`
  // value so workdir, timeout, and output-limit metadata never look like files.
  const command = publicCommandText(item.command);
  if (
    /\bcmd\s*:\s*["'`]\s*(?:rg|ripgrep|grep|find|fd)\b/iu.test(command)
    || /(?:^|[;&|]\s*|\b)(?:rg|ripgrep|grep|find|fd)\b/iu.test(command)
  ) {
    return {
      itemType: "codebase-search",
      title: "Searching the codebase",
      requestKind: "command",
    };
  }
  if (
    commandContainsOnlyFileReads(command)
  ) {
    const fileNames = commandReadFileNames(command);
    if (fileNames.length > 0) {
      return {
        itemType: "file-read",
        title: readingFilesTitle(fileNames),
        fileNames,
        requestKind: "file-read",
      };
    }
  }
  return { itemType: "command_execution", title: "Command Execution", requestKind: "command" };
}

function publicToolTitle(kind: string, item: JsonRecord): string {
  if (kind === "commandExecution") return commandPresentation(item).title;
  if (kind === "fileChange") return "File Change";
  if (kind === "collabAgentToolCall") return collaborationLabel(item.tool, item);
  if (kind === "mcpToolCall") {
    return mcpToolTitle(item.server ?? item.namespace, item.tool);
  }
  if (kind === "dynamicToolCall") {
    const presentation = dynamicToolPresentation(item);
    if (presentation) return presentation.title;
    const action = humanizeToolToken(item.tool);
    return action ? `Using ${action}` : "Using tool";
  }
  if (kind === "webSearch") {
    return withConciseDetail("Web Search", concisePublicText(item.query, 56));
  }
  if (kind === "imageView") {
    return withConciseDetail("Viewing Image", concisePublicBasename(item.path));
  }
  if (kind === "subAgentActivity") return "Sub-agent activity";
  if (kind === "imageGeneration") return "Image generation";
  if (kind === "reviewMarker") return item.state === "entered" ? "Review started" : "Review completed";
  return "Tool Activity";
}

function findPublicNotificationText(value: unknown, depth = 0): string | null {
  if (depth > 5) return null;
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized && !normalized.startsWith("{") ? normalized : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findPublicNotificationText(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const valueRecord = record(value);
  if (!valueRecord) return null;
  for (const key of ["completed", "final_answer", "finalAnswer", "message", "result", "output", "text"]) {
    if (!(key in valueRecord)) continue;
    const found = findPublicNotificationText(valueRecord[key], depth + 1);
    if (found) return found;
  }
  for (const entry of Object.values(valueRecord)) {
    if (typeof entry !== "object" || entry === null) continue;
    const found = findPublicNotificationText(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

function sanitizeAgentMessage(value: unknown): string {
  const source = text(value);
  return source.replace(
    /<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/giu,
    (_match, body: string) => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const publicText = findPublicNotificationText(parsed)
        ?? body.replace(/<\/?[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
      return publicText || "An agent finished its task.";
    },
  );
}

/**
 * Apply the transcript boundary sanitizer after agent-notification markup has
 * been reduced to its public summary. A null result is a private/control row
 * and must never become an Android message bubble.
 */
function publicAgentMessageText(value: unknown): string | null {
  return sanitizePublicTranscriptText(sanitizeAgentMessage(value));
}

interface ExtractedProposedPlan {
  messageText: string;
  planMarkdown: string;
}

/** One Codex turn can expose its final plan through both a tagged assistant
 * answer and a native `plan` item. Android must treat those as one artifact. */
export function codexProposedPlanId(turnId: string | null, itemId: string): string {
  return turnId ? `${turnId}:proposed-plan` : `${itemId}:proposed-plan`;
}

/**
 * Newer Codex Desktop builds can persist the official Plan-mode result as a
 * final agentMessage instead of a dedicated `plan` item.  Keep the wire tags
 * private and recover the same first-class plan shape used by older builds.
 */
function extractTaggedProposedPlan(value: string): ExtractedProposedPlan | null {
  const match = /(?:^|\r?\n)[ \t]*<proposed_plan>[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*<\/proposed_plan>[ \t]*(?=\r?\n|$)/u.exec(value);
  const planMarkdown = match?.[1]?.trim();
  if (!match || !planMarkdown) return null;
  return {
    messageText: `${value.slice(0, match.index)}${value.slice(match.index + match[0].length)}`.trim(),
    planMarkdown,
  };
}

function collaborationModeOf(value: unknown): string {
  const mode = record(value);
  return text(mode?.mode).trim().toLowerCase();
}

function turnIsPlanMode(turn: JsonRecord): boolean {
  const params = record(turn.params);
  return collaborationModeOf(params?.collaborationMode) === "plan"
    || collaborationModeOf(turn.collaborationMode) === "plan";
}

function isPrivateSyntheticUserMessage(value: string): boolean {
  return sanitizePublicTranscriptText(value) === null;
}

function isoFromSeconds(value: unknown, fallback = Date.now()): string {
  const seconds = finite(value);
  return new Date(seconds === null ? fallback : seconds * 1000).toISOString();
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function cwdOf(thread: JsonRecord): string {
  return text(thread.cwd, "Unknown workspace");
}

const PROJECTLESS_ANDROID_CHAT_ID = "codex-project-chats";

function isProjectlessThread(thread: JsonRecord): boolean {
  return thread.androidRemoteWorkspaceKind === "projectless"
    || thread.androidRemoteProjectless === true
    || text(thread.androidRemoteProjectId).trim() === PROJECTLESS_ANDROID_CHAT_ID;
}

function projectIdOf(thread: JsonRecord, cwd: string): string {
  if (isProjectlessThread(thread)) return PROJECTLESS_ANDROID_CHAT_ID;
  return text(thread.androidRemoteProjectId).trim()
    || stableId("codex-project", cwd.toLowerCase());
}

function projectForThread(
  thread: JsonRecord,
  cwd: string,
  createdAt: string,
  updatedAt: string,
): JsonRecord {
  const title = basename(cwd.replace(/[\\/]+$/, "")) || cwd;
  const workspaceRoot = text(thread.androidRemoteProjectWorkspaceRoot).trim() || cwd;
  return {
    id: projectIdOf(thread, cwd),
    title: text(thread.androidRemoteProjectTitle).trim() || title,
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt,
    updatedAt,
  };
}

function providerInstanceId(thread: JsonRecord): string {
  return text(thread.androidRemoteProviderInstanceId).trim()
    || text(thread.modelProvider, "openai");
}

function modelSelection(thread: JsonRecord): JsonRecord {
  const revision = finite(thread.androidRemoteModelSelectionRevision);
  return {
    instanceId: providerInstanceId(thread),
    model: text(thread.androidRemoteModel).trim() || text(thread.model, "gpt-5.6-sol"),
    ...(thread.androidRemoteModelOptions ? { options: thread.androidRemoteModelOptions } : {}),
    ...(revision !== null ? { revision: Math.max(0, Math.floor(revision)) } : {}),
    ...(text(thread.androidRemoteModelSelectionUpdatedAt).trim()
      ? { updatedAt: text(thread.androidRemoteModelSelectionUpdatedAt).trim() }
      : {}),
  };
}

function titleOf(thread: JsonRecord): string {
  return text(thread.androidRemoteTitle).trim()
    || text(thread.name).trim()
    || text(thread.preview).trim().slice(0, 256)
    || "Codex task";
}

function turnRows(thread: JsonRecord): JsonRecord[] {
  return Array.isArray(thread.turns)
    ? thread.turns.flatMap(value => record(value) ? [record(value)!] : [])
    : [];
}

function turnState(turn: JsonRecord): "running" | "interrupted" | "completed" | "error" {
  const status = turn.status ?? turn.state ?? turn.turnStatus ?? turn.turn_status;
  const normalized = normalizedCanonicalTurnStatus(status);
  if (canonicalTurnStatusIsActive(status) || !canonicalTurnStatusIsTerminal(status)) {
    return "running";
  }
  if (normalized.includes("failed") || normalized.includes("error")) return "error";
  if (
    normalized.includes("interrupt")
    || normalized.includes("cancel")
    || normalized.includes("stopped")
    || normalized.includes("aborted")
  ) {
    return "interrupted";
  }
  return "completed";
}

function latestTurn(thread: JsonRecord): JsonRecord | null {
  const runtimeActive = thread.androidRemoteHistoryOnly !== true
    && codexRuntimeStatus(thread.status)?.type === "active";
  const projectedState = text(thread.androidRemoteLatestTurnState);
  const hasProjectedLifecycle =
    projectedState === "running" ||
    projectedState === "completed" ||
    projectedState === "interrupted" ||
    projectedState === "error";
  const turns = turnRows(thread);
  if (
    hasProjectedLifecycle && (!runtimeActive || projectedState === "running")
    && projectedTurnLifecycleWins(turns, {
      state: projectedState,
      turnId: thread.androidRemoteLatestTurnId,
      occurredAt: thread.androidRemoteLatestTurnAt,
      lastProgressAt: thread.androidRemoteActivityUnverified === true ? undefined : thread.androidRemoteLatestProgressAt,
      unverified: thread.androidRemoteActivityUnverified === true,
    })
  ) {
    // Keep the internal running marker for ownership safety, but avoid telling
    // the phone that unverified work is still progressing. The session carries
    // a visible, retryable connection error instead of a fabricated completion.
    if (thread.androidRemoteActivityUnverified === true && !runtimeActive) return null;
    const occurredAt = text(thread.androidRemoteLatestTurnAt)
      || isoFromSeconds(thread.updatedAt);
    return {
      turnId: text(
        thread.androidRemoteLatestTurnId,
        stableId("turn", `${text(thread.id)}:${occurredAt}`),
      ),
      state: projectedState,
      requestedAt: occurredAt,
      startedAt: projectedState === "running" ? occurredAt : null,
      completedAt: projectedState === "running" ? null : occurredAt,
      assistantMessageId: null,
    };
  }
  const turn = canonicalTurnsNewestFirst(turns)[0];
  if (!turn) return null;
  const state = turnState(turn);
  // A metadata-only active snapshot can precede its new turn details. Do not
  // expose the previous interrupted turn as the currently resumable task.
  if (runtimeActive && state !== "running") return null;
  return {
    turnId: text(turn.id, stableId("turn", `${text(thread.id)}:${turns.length}`)),
    state,
    requestedAt: isoFromSeconds(turn.startedAt, Date.parse(isoFromSeconds(thread.updatedAt))),
    startedAt: finite(turn.startedAt) === null ? null : isoFromSeconds(turn.startedAt),
    completedAt: finite(turn.completedAt) === null ? null : isoFromSeconds(turn.completedAt),
    assistantMessageId: lastAssistantMessageId(turn),
  };
}

function lastAssistantMessageId(turn: JsonRecord): string | null {
  if (!Array.isArray(turn.items)) return null;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = record(turn.items[index]);
    if (item?.type === "agentMessage") return text(item.id) || null;
  }
  return null;
}

function sessionOf(thread: JsonRecord, updatedAt: string): JsonRecord {
  const runtimeActive = thread.androidRemoteHistoryOnly !== true
    && codexRuntimeStatus(thread.status)?.type === "active";
  const status = record(thread.status);
  const type = text(status?.type);
  const turns = turnRows(thread);
  const activity = canonicalTurnActivitySnapshot(turns);
  const newestTurn = canonicalTurnsNewestFirst(turns)[0];
  const failed = newestTurn?.status === "failed" ? newestTurn : null;
  const error = failed ? record(failed.error) : null;
  const canonicalErrorMessage = boundedTurnErrorMessage(error);
  const projectedState = text(thread.androidRemoteLatestTurnState);
  const projectedTurnId = text(thread.androidRemoteLatestTurnId) || null;
  const projectedLifecycleWins = (!runtimeActive || projectedState === "running") && projectedTurnLifecycleWins(turns, {
    state: projectedState,
    turnId: projectedTurnId,
    occurredAt: thread.androidRemoteLatestTurnAt,
    lastProgressAt: thread.androidRemoteActivityUnverified === true ? undefined : thread.androidRemoteLatestProgressAt,
    unverified: thread.androidRemoteActivityUnverified === true,
  });
  const projectedRunning = projectedLifecycleWins && projectedState === "running";
  const projectedError = projectedLifecycleWins && projectedState === "error";
  const unverified = !runtimeActive && projectedLifecycleWins && thread.androidRemoteActivityUnverified === true;
  const historyWarning = boundedTurnErrorMessage(thread.androidRemoteHistoryRecoveryError);
  const projectedErrorMessage = projectedError
    ? boundedTurnErrorMessage(thread.androidRemoteLatestTurnError)
    : "";
  const canonicalRunning = runtimeActive || (!projectedLifecycleWins && activity.active);
  return {
    threadId: text(thread.id),
    // Public active runtime status is authoritative even without turn history
    // or waiting flags. Private mounted-view labels are not this protocol.
    status: unverified ? "error" : projectedRunning || canonicalRunning
      ? "running"
      : projectedError || type === "systemError"
        ? "error"
        : "idle",
    statusConfidence: unverified ? "unknown" : "confirmed",
    // Remodex uses providerName as the driver-kind lock and
    // providerInstanceId as the exact routing key. Every Android Remote task
    // is driven by the Codex bridge even when Remodex routes its selected
    // model to Anthropic, Gemini, a custom provider, or a combo.
    providerName: "codex",
    providerInstanceId: providerInstanceId(thread),
    runtimeMode: "full-access",
    activeTurnId: projectedRunning
      ? projectedTurnId
      : canonicalRunning
        ? activity.activeTurnId || null
        : null,
    lastError: !unverified && (projectedRunning || canonicalRunning) ? null : unverified
      ? "Task status is unavailable. Reconnect to check whether it is still running."
      : projectedError
      ? projectedErrorMessage || canonicalErrorMessage || null
      : canonicalErrorMessage || historyWarning || null,
    updatedAt,
  };
}

function userInputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  const contextReferences: string[] = [];
  for (const raw of content) {
    const input = record(raw);
    if (!input) continue;
    if (input.type === "text") parts.push(publicUserMessageText(input.text));
    else if (input.type === "localImage") parts.push(`[Image: ${text(input.path, "attachment")}]`);
    else if (input.type === "image") parts.push(`[Image: ${text(input.url, "attachment")}]`);
    else if (input.type === "localAudio" || input.type === "audio") parts.push("[Audio attachment]");
    else if (input.type === "mention" || input.type === "skill") {
      contextReferences.push(`$${text(input.name, "reference")}`);
    }
  }
  const visibleParts = parts.filter(Boolean).join("\n");
  const visibleContext = contextReferences.filter(Boolean).join(" ");
  if (visibleContext && visibleParts) return `${visibleContext}\n\n${visibleParts}`;
  return visibleContext || visibleParts;
}

type CollapsibleAndroidActivityType = "codebase-search" | "file-read";

function collapsibleAndroidActivityType(activity: JsonRecord): CollapsibleAndroidActivityType | null {
  const itemType = text(record(activity.payload)?.itemType);
  return itemType === "codebase-search" || itemType === "file-read" ? itemType : null;
}

function activityFileNames(activity: JsonRecord): string[] {
  const fileNames = record(activity.payload)?.fileNames;
  if (!Array.isArray(fileNames)) return [];
  return fileNames.flatMap(value => typeof value === "string" && value.trim() ? [value.trim()] : []);
}

function mergeConsecutiveAndroidActivities(
  previous: JsonRecord,
  next: JsonRecord,
  activityType: CollapsibleAndroidActivityType,
): JsonRecord {
  const previousPayload = record(previous.payload) ?? {};
  const nextPayload = record(next.payload) ?? {};
  const previousData = record(previousPayload.data) ?? {};
  const nextData = record(nextPayload.data) ?? {};
  const fileNames = activityType === "file-read"
    ? [...new Set([...activityFileNames(previous), ...activityFileNames(next)])]
    : [];
  const title = activityType === "file-read"
    ? readingFilesTitle(fileNames)
    : "Searching the codebase";
  const previousStatus = text(previousPayload.status);
  const nextStatus = text(nextPayload.status);
  const stillRunning = nextStatus === "inProgress" || nextStatus === "in_progress" || nextStatus === "running";
  const failed = previous.tone === "error"
    || next.tone === "error"
    || previousStatus === "failed"
    || nextStatus === "failed";
  const status = stillRunning ? nextStatus : failed ? "failed" : nextStatus || previousStatus;

  return {
    ...previous,
    ...next,
    // The first call owns the visual identity and timeline position. Later
    // calls update that same row while retaining their concise public details.
    id: previous.id,
    kind: previous.kind,
    summary: title,
    tone: failed && !stillRunning ? "error" : next.tone,
    turnId: previous.turnId,
    sequence: previous.sequence,
    createdAt: previous.createdAt,
    payload: {
      ...previousPayload,
      ...nextPayload,
      itemId: previousPayload.itemId ?? previous.id,
      itemType: activityType,
      title,
      ...(status ? { status } : {}),
      ...(fileNames.length > 0 ? { fileNames } : {}),
      data: {
        ...previousData,
        ...nextData,
        toolCallId: previousData.toolCallId ?? previous.id,
      },
    },
  };
}

function reasoningActivitySignature(activity: JsonRecord): string | null {
  if (text(activity.kind) !== "task.progress") return null;
  const payload = record(activity.payload) ?? {};
  return JSON.stringify({
    turnId: text(activity.turnId) || null,
    summary: text(activity.summary),
    summaryParts: Array.isArray(payload.summaryParts)
      ? payload.summaryParts.flatMap(value => typeof value === "string" ? [value] : [])
      : [],
    summaryAvailable: payload.summaryAvailable === true,
  });
}

function mergeConsecutiveReasoningActivities(
  previous: JsonRecord,
  next: JsonRecord,
): JsonRecord {
  const previousPayload = record(previous.payload) ?? {};
  const nextPayload = record(next.payload) ?? {};
  return {
    ...previous,
    ...next,
    id: previous.id,
    turnId: previous.turnId,
    sequence: previous.sequence,
    createdAt: previous.createdAt,
    payload: {
      ...previousPayload,
      ...nextPayload,
      itemId: previousPayload.itemId ?? previous.id,
    },
  };
}

function messagesAndActivity(
  thread: JsonRecord,
  options: { includeCompletedCommandActivities?: boolean; compactCompletedWork?: boolean } = {},
): {
  messages: JsonRecord[];
  activities: JsonRecord[];
  proposedPlans: JsonRecord[];
} {
  const messages: JsonRecord[] = [];
  const activities: JsonRecord[] = [];
  const proposedPlans: JsonRecord[] = [];
  let previousVisibleActivityIndex: number | null = null;
  let previousVisibleSemanticActivity: {
    index: number;
    itemType: CollapsibleAndroidActivityType;
    turnId: string | null;
  } | null = null;
  const resetSemanticActivityRun = (): void => {
    previousVisibleActivityIndex = null;
    previousVisibleSemanticActivity = null;
  };
  const appendActivity = (activity: JsonRecord): void => {
    const itemType = collapsibleAndroidActivityType(activity);
    const turnId = text(activity.turnId) || null;
    if (
      itemType !== null
      && previousVisibleSemanticActivity?.itemType === itemType
      && previousVisibleSemanticActivity.turnId === turnId
      && turnId !== null
    ) {
      const index = previousVisibleSemanticActivity.index;
      activities[index] = mergeConsecutiveAndroidActivities(activities[index]!, activity, itemType);
      previousVisibleActivityIndex = index;
      return;
    }
    if (previousVisibleActivityIndex !== null) {
      const previous = activities[previousVisibleActivityIndex];
      const previousSignature = previous ? reasoningActivitySignature(previous) : null;
      if (
        previousSignature !== null
        && previousSignature === reasoningActivitySignature(activity)
      ) {
        activities[previousVisibleActivityIndex] =
          mergeConsecutiveReasoningActivities(previous!, activity);
        previousVisibleSemanticActivity = null;
        return;
      }
    }
    activities.push(activity);
    previousVisibleActivityIndex = activities.length - 1;
    previousVisibleSemanticActivity = itemType === null
      ? null
      : { index: activities.length - 1, itemType, turnId };
  };
  const upsertProposedPlan = (plan: JsonRecord): void => {
    resetSemanticActivityRun();
    const id = text(plan.id);
    const index = proposedPlans.findIndex(candidate => text(candidate.id) === id);
    if (index < 0) {
      proposedPlans.push(plan);
      return;
    }
    const existing = proposedPlans[index]!;
    const existingMarkdown = text(existing.planMarkdown);
    const nextMarkdown = text(plan.planMarkdown);
    const existingSequence = finite(existing.sequence);
    const nextSequence = finite(plan.sequence);
    proposedPlans[index] = {
      ...existing,
      ...plan,
      sequence: existingSequence === null
        ? nextSequence
        : nextSequence === null
          ? existingSequence
          : Math.min(existingSequence, nextSequence),
      planMarkdown: nextMarkdown.length >= existingMarkdown.length ? nextMarkdown : existingMarkdown,
      createdAt: text(existing.createdAt) || text(plan.createdAt),
    };
  };
  const markLatestProposedPlanImplemented = (implementedAt: string): void => {
    for (let index = proposedPlans.length - 1; index >= 0; index -= 1) {
      const plan = proposedPlans[index]!;
      if (plan.implementedAt !== null) continue;
      proposedPlans[index] = {
        ...plan,
        implementedAt,
        implementationThreadId: text(thread.id) || null,
        updatedAt: implementedAt,
      };
      return;
    }
  };
  let sequence = 0;
  const turns = turnRows(thread);
  const hasCanonicalPlanInThread = turns.some((candidate) => {
    const candidateItems = Array.isArray(candidate.items) ? candidate.items : [];
    return candidateItems.some((raw) => {
      const item = record(raw);
      if (!item) return false;
      return item.type === "plan"
        || item.type === "agentMessage"
          && extractTaggedProposedPlan(sanitizeAgentMessage(item.text)) !== null;
    });
  });
  const hasImplementationRequestInThread = turns.some((candidate) => {
    const candidateItems = Array.isArray(candidate.items) ? candidate.items : [];
    return candidateItems.some((raw) => {
      const item = record(raw);
      return item?.type === "userMessage"
        && userInputText(item.content).trim() === "Implement this plan.";
    });
  });
  for (const [turnIndex, turn] of turns.entries()) {
    const turnId = text(turn.id) || null;
    const createdAt = isoFromSeconds(turn.startedAt, Date.parse(isoFromSeconds(thread.createdAt)));
    const updatedAt = isoFromSeconds(turn.completedAt, Date.parse(createdAt));
    const streaming = turn.status === "inProgress";
    const items = Array.isArray(turn.items) ? turn.items : [];
    const attachmentMessageIndexes = new Map<string, number>();
    const attachmentMessageClientIds = new Map<number, string>();
    const hasCanonicalPlanItem = items.some((raw) => {
      const item = record(raw);
      if (!item) return false;
      return item.type === "plan"
        || item.type === "agentMessage"
          && extractTaggedProposedPlan(sanitizeAgentMessage(item.text)) !== null;
    });
    // App-server currently omits per-turn collaboration metadata from some
    // thread/read responses. A thread-level Plan marker is only a last-resort
    // recovery for a first, malformed plan turn. Once a canonical plan or an
    // implementation request exists, later normal answers must stay messages.
    const planMode = turnIsPlanMode(turn)
      || turnIndex === turns.length - 1
        && text(thread.androidRemoteInteractionMode) === "plan"
        && !hasCanonicalPlanInThread
        && !hasImplementationRequestInThread;
    for (const raw of items) {
      const rawItem = record(raw);
      const item = rawItem?.type === "imageGeneration" || rawItem?.kind === "image_gen.generation"
        ? normalizedCompletedItem(rawItem, !streaming)
        : rawItem;
      if (!item) continue;
      const itemSequence = sequence++;
      const id = text(item.id, stableId("item", `${text(thread.id)}:${itemSequence}`));
      if (
        item.type === "commandExecution" &&
        !streaming &&
        commandPresentation(item).itemType === "command_execution" &&
        options.includeCompletedCommandActivities !== true &&
        options.compactCompletedWork !== true
      ) {
        continue;
      }
      if (item.type === "userMessage") {
        if (isPrivateTranscriptRole(item.role)) continue;
        const messageText = userInputText(item.content);
        if (!messageText || isPrivateSyntheticUserMessage(messageText)) continue;
        // The Android plan action intentionally writes this exact visible
        // prompt into Codex history. Recovering the relationship from that
        // durable transcript keeps the action card dismissed across Remodex
        // restarts, even though app-server does not persist source plan ids.
        if (messageText.trim() === "Implement this plan.") {
          markLatestProposedPlanImplemented(createdAt);
        }
        resetSemanticActivityRun();
        const messageId = text(item.clientId).trim() || id;
        const nextMessage: JsonRecord = {
          id: messageId,
          role: "user",
          text: messageText,
          attachments: [],
          turnId,
          sequence: itemSequence,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        };
        const attachmentIdentity = attachmentUserMessageIdentityKey(messageText);
        let duplicateIndex = attachmentIdentity === null
          ? undefined
          : attachmentMessageIndexes.get(attachmentIdentity);
        const clientId = text(item.clientId).trim();
        const existingClientId = duplicateIndex === undefined
          ? "" : attachmentMessageClientIds.get(duplicateIndex) ?? "";
        // Separate send actions remain separate even with identical text/files.
        if (clientId && existingClientId && clientId !== existingClientId) duplicateIndex = undefined;
        if (duplicateIndex === undefined) {
          messages.push(nextMessage);
          if (attachmentIdentity !== null) {
            attachmentMessageIndexes.set(attachmentIdentity, messages.length - 1);
            attachmentMessageClientIds.set(messages.length - 1, clientId);
          }
        } else {
          const existing = messages[duplicateIndex]!;
          const existingText = text(existing.text);
          // Prefer the public app-server form because Android can open its
          // path. Preserve the first/client id and timeline position.
          messages[duplicateIndex] = {
            ...nextMessage,
            id: existingClientId || clientId || text(existing.id) || messageId,
            text: messageText.includes("[Image:") ? messageText : existingText,
            sequence: existing.sequence,
            createdAt: existing.createdAt,
          };
          attachmentMessageClientIds.set(duplicateIndex, existingClientId || clientId);
        }
        continue;
      }
      if (item.type === "agentMessage") {
        if (isPrivateTranscriptRole(item.role)) continue;
        // Local compaction writes its generated handoff as a final-looking
        // assistant item immediately before the private `compacted` record.
        // It is context for Codex, not conversation content for the phone.
        const messageText = publicAgentMessageText(item.text);
        if (messageText === null || !messageText) continue;
        if (text(item.phase) === "final_answer" && /^[ \t]*#{1,6}[ \t]*Handoff Summary\b/iu.test(messageText)) {
          continue;
        }
        const taggedPlan = streaming ? null : extractTaggedProposedPlan(messageText);
        const fallbackPlan = !streaming
          && !taggedPlan
          && !hasCanonicalPlanItem
          && text(item.phase) === "final_answer"
          && messageText.trim()
          && (planMode || item.androidRemotePlanMode === true)
          ? messageText.trim()
          : null;
        if (taggedPlan || fallbackPlan) {
          upsertProposedPlan({
            id: codexProposedPlanId(turnId, id),
            turnId,
            sequence: itemSequence,
            planMarkdown: taggedPlan?.planMarkdown ?? fallbackPlan,
            implementedAt: null,
            implementationThreadId: null,
            createdAt,
            updatedAt,
          });
        }
        if (!fallbackPlan && (!taggedPlan || taggedPlan.messageText)) {
          resetSemanticActivityRun();
          messages.push({
            id,
            role: "assistant",
            text: taggedPlan?.messageText ?? messageText,
            // Codex marks intermediate commentary separately from the real
            // final answer.  Android needs this boundary so it never presents a
            // still-running response as completed between tool calls.
            phase: text(item.phase) || null,
            attachments: [],
            turnId,
            sequence: itemSequence,
            streaming,
            createdAt,
            updatedAt,
          });
        }
        continue;
      }
      if (item.type === "plan") {
        const planMarkdown = text(item.text).trim();
        if (planMarkdown) {
          if (streaming) {
            resetSemanticActivityRun();
            messages.push({
              id,
              role: "assistant",
              text: planMarkdown,
              phase: "commentary",
              attachments: [],
              turnId,
              sequence: itemSequence,
              streaming: true,
              createdAt,
              updatedAt,
            });
          } else {
            upsertProposedPlan({
              id: codexProposedPlanId(turnId, id),
              turnId,
              sequence: itemSequence,
              planMarkdown,
              implementedAt: null,
              implementationThreadId: null,
              createdAt,
              updatedAt,
            });
          }
        }
        continue;
      }
      const activity = activityFromItem(item, turn, id, turnId, createdAt, itemSequence);
      if (activity) {
        appendActivity(activity);
      }
    }
  }
  return { messages, activities, proposedPlans };
}

function activityFromItem(
  item: JsonRecord,
  turn: JsonRecord,
  id: string,
  turnId: string | null,
  createdAt: string,
  sequence: number,
): JsonRecord | null {
  const kind = text(item.type);
  const contextCompaction = kind === "contextCompaction";
  const reviewMarker = kind === "reviewMarker";
  const subAgentActivity = kind === "subAgentActivity";
  const imageGeneration = kind === "imageGeneration";
  const planUpdate = kind === "planUpdate";
  const userInputRequest = kind === "userInputRequest";
  const dynamicPresentation = kind === "dynamicToolCall" ? dynamicToolPresentation(item) : null;
  const commandToolPresentation = kind === "commandExecution" ? commandPresentation(item) : null;
  if (kind === "dynamicToolCall" && hiddenDynamicTool(item)) return null;
  const itemType = kind === "commandExecution"
    ? commandToolPresentation?.itemType ?? "command_execution"
    : kind === "fileChange"
      ? "file_change"
      : kind === "mcpToolCall"
        ? "mcp_tool_call"
        : kind === "dynamicToolCall"
          ? dynamicPresentation?.itemType ?? "dynamic_tool_call"
          : kind === "collabAgentToolCall"
            ? "collab_agent_tool_call"
            : kind === "webSearch"
            ? "web_search"
            : kind === "imageView"
              ? "image_view"
              : subAgentActivity
                ? "sub-agent-activity"
                : imageGeneration
                  ? "image-generation"
                  : planUpdate
                    ? "plan-update"
                  : reviewMarker
                    ? "review-marker"
                    : contextCompaction
                      ? "context-compaction"
                      : null;
  let tone: "info" | "tool" | "approval" | "error" = "tool";
  let summary = "";
  if (kind === "reasoning") {
    const rows = Array.isArray(item.summary)
      ? item.summary.flatMap(row => typeof row === "string" && row.trim() ? [row.trim()] : [])
      : [];
    const publicSummary = rows.at(-1)?.slice(0, 240);
    const turnState = text(turn.status).replace(/[^a-z0-9]/giu, "").toLowerCase();
    const itemState = text(item.status).replace(/[^a-z0-9]/giu, "").toLowerCase();
    const reasoningInProgress = (turnState === "inprogress" || turnState === "running")
      && (!itemState || itemState === "inprogress" || itemState === "running");
    if (!publicSummary && !reasoningInProgress) return null;
    summary = publicSummary || "Reasoning";
    tone = "info";
  } else if (contextCompaction) {
    summary = item.status === "inProgress"
      ? "Context automatically compacting"
      : "Context compacted";
    tone = "info";
  } else if (kind === "commandExecution") {
    summary = commandToolPresentation?.title ?? "Command Execution";
    tone = item.status === "failed" ? "error" : "tool";
  } else if (kind === "fileChange") {
    summary = "File Change";
    tone = item.status === "failed" ? "error" : "tool";
  } else if (kind === "mcpToolCall") {
    summary = publicToolTitle(kind, item);
    tone = item.status === "failed" ? "error" : "tool";
  } else if (kind === "dynamicToolCall") {
    // `exec` is Codex's internal JavaScript tool router, not a user-facing
    // activity name.  Nested real tools are projected under their own type;
    // exposing this wrapper produced the misleading "Using Exec" row.
    if (text(item.tool).trim().toLowerCase() === "exec") return null;
    summary = publicToolTitle(kind, item);
    tone = item.status === "failed" ? "error" : "tool";
  } else if (kind === "collabAgentToolCall") {
    summary = publicToolTitle(kind, item);
    tone = item.status === "failed" ? "error" : "tool";
  } else if (kind === "webSearch") {
    summary = publicToolTitle(kind, item);
    tone = item.status === "failed" ? "error" : "tool";
  } else if (kind === "imageView") {
    summary = publicToolTitle(kind, item);
    tone = item.status === "failed" ? "error" : "tool";
  } else if (subAgentActivity) {
    summary = text(item.activity).trim() || "Sub-agent activity";
    tone = "info";
  } else if (imageGeneration) {
    summary = item.status === "failed" ? "Image generation failed" : item.status === "inProgress" ? "Generating images" : "Images generated";
    tone = item.status === "failed" ? "error" : "tool";
  } else if (planUpdate) {
    summary = "Plan updated";
    tone = "info";
  } else if (userInputRequest) {
    summary = item.status === "inProgress" ? "User input requested" : "User input submitted";
    tone = item.status === "failed" ? "error" : "info";
  } else if (reviewMarker) {
    summary = item.state === "entered" ? "Review started" : "Review completed";
    tone = "info";
  } else {
    return null;
  }
  const status = text(item.status).trim() || undefined;
  const requestKind = commandToolPresentation?.requestKind ?? dynamicPresentation?.requestKind;
  const fileNames = commandToolPresentation?.fileNames ?? dynamicPresentation?.fileNames ?? [];
  const fileChanges = kind === "fileChange" ? publicFileChanges(item) : [];
  const turnDurationMs = finite(turn.durationMs);
  const turnTiming = turnDurationMs === null ? {} : { turnDurationMs };
  const title = kind === "reasoning" || contextCompaction || planUpdate || userInputRequest
    ? summary
    : publicToolTitle(kind, item);
  const detail = undefined;
  const payload: JsonRecord = kind === "reasoning"
    ? {
        itemId: id,
        title: summary,
        summaryParts: Array.isArray(item.summary)
          ? item.summary.flatMap(row => typeof row === "string" && row.trim() ? [row.trim()] : [])
          : [],
        summaryAvailable: Array.isArray(item.summary)
          && item.summary.some(row => typeof row === "string" && row.trim().length > 0),
        ...turnTiming,
      }
    : contextCompaction
      ? {
          itemId: id,
          title: summary,
          ...(status ? { status } : {}),
          ...turnTiming,
        }
    : userInputRequest
      ? {
          itemId: id,
          title: summary,
          requestId: id,
          ...(status ? { status } : {}),
          questions: Array.isArray(item.questions) ? item.questions.slice(0, 3) : [],
          ...turnTiming,
        }
    : itemType
    ? {
        itemId: id,
        itemType,
        ...(status ? { status } : {}),
        ...(requestKind ? { requestKind } : {}),
        title,
        ...(fileNames.length > 0 ? { fileNames } : {}),
        ...(detail ? { detail } : {}),
        ...(fileChanges.length > 0 ? { fileChanges } : {}),
        ...(planUpdate
          ? {
              plan: Array.isArray(item.plan) ? item.plan.slice(0, 64) : [],
              ...(text(item.explanation).trim()
                ? { explanation: boundedText(item.explanation, 8 * 1024).value }
                : {}),
            }
          : {}),
        data: {
          toolCallId: id,
          ...(reviewMarker ? { type: "reviewMarker", state: text(item.state) } : {}),
          ...(subAgentActivity ? { type: "subAgentActivity", activity: text(item.activity) } : {}),
          ...(imageGeneration ? { type: "imageGeneration", status: text(item.status), generatedImages: generatedImagePaths(item) } : {}),
        },
        ...turnTiming,
      }
    : { ...turnTiming };
  return {
    id,
    tone,
    kind: kind === "reasoning"
      ? "task.progress"
      : contextCompaction
        ? "context-compaction"
        : planUpdate
          ? "turn.plan.updated"
          : userInputRequest
            ? item.status === "inProgress" ? "user-input.requested" : "user-input.resolved"
        : kind,
    summary,
    payload,
    turnId,
    sequence,
    createdAt,
  };
}

/**
 * Reduce one projected activity to a fixed notification label. This consumes
 * the same projected row sent to the Android timeline, but never copies its
 * summary, command, path, tool arguments, or provider payload into a system
 * notification.
 */
export function projectCodexNotificationActivityLabel(activityValue: unknown): string | null {
  const activity = record(activityValue);
  if (!activity) return null;
  const kind = text(activity.kind);
  if (kind === "approval.requested" || kind === "user-input.requested") {
    return "Requires your input";
  }
  if (kind === "approval.resolved" || kind === "user-input.resolved") return "Reasoning";
  if (kind === "task.progress") return "Reasoning";
  if (kind === "turn.plan.updated") return "Plan";
  if (kind === "context-compaction") return "Compacting context";
  if (kind === "runtime.error" || kind === "tool.denied") return "Failed";

  const payload = record(activity.payload);
  switch (text(payload?.itemType)) {
    case "command_execution":
      return "Command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool";
    case "dynamic_tool_call":
      return "Dynamic tool";
    case "collab_agent_tool_call":
      return "Collaboration";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "sub-agent-activity":
      return "Sub-agent";
    case "image-generation":
      return "Image generation";
    case "file-read":
      return "File read";
    case "codebase-search":
      return "Codebase search";
    case "plan-update":
    case "plan":
      return "Plan";
    case "review-marker":
      return "Review";
    case "context-compaction":
      return "Compacting context";
    case "reasoning":
      return "Reasoning";
    default:
      return null;
  }
}

/**
 * Derive a notification label through the ordinary Android item projection so
 * the notification and in-app activity cannot classify the same tool
 * differently.
 */
export function projectCodexNotificationItemLabel(itemValue: unknown): string | null {
  const item = record(itemValue);
  if (!item) return null;
  const id = text(item.id).trim() || "notification-activity";
  const projected = projectCodexLiveTurnItem({
    threadId: "notification-thread",
    turnId: "notification-turn",
    item: { ...item, id },
    sequence: 0,
    createdAtMs: 0,
    completed: false,
  });
  return projectCodexNotificationActivityLabel(projected.activity);
}

function shellThread(thread: JsonRecord): JsonRecord {
  const createdAt = isoFromSeconds(thread.createdAt);
  const updatedAt = isoFromSeconds(thread.updatedAt, Date.parse(createdAt));
  const cwd = cwdOf(thread);
  const latest = latestTurn(thread);
  const session = sessionOf(thread, updatedAt);
  const projectless = isProjectlessThread(thread);
  const recencyAt = finite(thread.recencyAt) === null
    ? latest?.requestedAt ?? null
    : isoFromSeconds(thread.recencyAt, Date.parse(updatedAt));
  return {
    id: text(thread.id),
    projectId: projectIdOf(thread, cwd),
    title: titleOf(thread),
    modelSelection: modelSelection(thread),
    runtimeMode: text(thread.androidRemoteRuntimeMode, "full-access"),
    interactionMode: text(thread.androidRemoteInteractionMode, "default"),
    branch: null,
    // A projectless Chat has no user workspace.  Do not expose even the
    // neutral internal directory as a project worktree to the phone.
    worktreePath: projectless ? null : cwd,
    latestTurn: latest,
    createdAt,
    updatedAt,
    archivedAt: text(thread.androidRemoteArchivedAt).trim() || null,
    session,
    latestUserMessageAt: recencyAt,
    hasPendingApprovals: codexRuntimeStatus(thread.status)?.waitingOnApproval === true,
    hasPendingUserInput: thread.androidRemoteWaitingOnUserInput === true
      || codexRuntimeStatus(thread.status)?.waitingOnUserInput === true,
    hasActionableProposedPlan: false,
    source: { kind: "remodex-projected" },
  };
}

export function projectCodexShellSnapshot(threads: unknown[], sequence: number): JsonRecord {
  const rows = threads.flatMap(value => record(value) ? [record(value)!] : []);
  const projectMap = new Map<string, JsonRecord>();
  for (const thread of rows) {
    const createdAt = isoFromSeconds(thread.createdAt);
    const updatedAt = isoFromSeconds(thread.updatedAt, Date.parse(createdAt));
    const cwd = cwdOf(thread);
    const project = projectForThread(thread, cwd, createdAt, updatedAt);
    const existing = projectMap.get(text(project.id));
    if (!existing || text(existing.updatedAt) < updatedAt) projectMap.set(text(project.id), project);
  }
  return {
    snapshotSequence: sequence,
    projects: [...projectMap.values()],
    threads: rows.map(shellThread),
    nativeProjects: [],
    nativeThreads: [],
    updatedAt: new Date().toISOString(),
  };
}

export function projectCodexReadModel(threads: unknown[], sequence: number): JsonRecord {
  const shell = projectCodexShellSnapshot(threads, sequence);
  return {
    snapshotSequence: sequence,
    projects: shell.projects,
    threads: (shell.threads as JsonRecord[]).map(row => ({
      ...row,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    })),
    updatedAt: shell.updatedAt,
  };
}

export function projectCodexContextWindowActivity(input: {
  threadId: string;
  tokenUsage: unknown;
  createdAt: string;
  turnId?: string | null;
}): JsonRecord | null {
  const root = record(input.tokenUsage);
  const usage = record(root?.tokenUsage)
    ?? record(root?.tokenUsageInfo)
    ?? record(root?.usage)
    ?? root;
  const last = record(usage?.last)
    ?? record(usage?.lastUsage)
    ?? record(usage?.lastTokenUsage)
    ?? record(usage?.last_token_usage);
  const total = record(usage?.total)
    ?? record(usage?.totalUsage)
    ?? record(usage?.total_token_usage);
  const usedTokens = nonNegativeInteger(
    last?.totalTokens
      ?? last?.total_tokens
      ?? usage?.usedTokens
      ?? usage?.used_tokens
      ?? usage?.totalTokens,
  );
  const maxTokens = nonNegativeInteger(
    usage?.modelContextWindow
      ?? usage?.model_context_window
      ?? usage?.contextWindow
      ?? root?.modelContextWindow,
  );
  if (usedTokens === null || usedTokens <= 0 || maxTokens === null || maxTokens <= 0) return null;

  const totalProcessedTokens = nonNegativeInteger(total?.totalTokens ?? total?.total_tokens);
  const inputTokens = nonNegativeInteger(last?.inputTokens ?? last?.input_tokens);
  const cachedInputTokens = nonNegativeInteger(last?.cachedInputTokens ?? last?.cached_input_tokens);
  const outputTokens = nonNegativeInteger(last?.outputTokens ?? last?.output_tokens);
  const reasoningOutputTokens = nonNegativeInteger(
    last?.reasoningOutputTokens ?? last?.reasoning_output_tokens,
  );
  return {
    id: `context-window-${input.threadId}`,
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: {
      usedTokens,
      maxTokens,
      ...(totalProcessedTokens !== null && totalProcessedTokens > usedTokens
        ? { totalProcessedTokens }
        : {}),
      ...(inputTokens !== null ? { inputTokens, lastInputTokens: inputTokens } : {}),
      ...(cachedInputTokens !== null
        ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
        : {}),
      ...(outputTokens !== null ? { outputTokens, lastOutputTokens: outputTokens } : {}),
      ...(reasoningOutputTokens !== null
        ? { reasoningOutputTokens, lastReasoningOutputTokens: reasoningOutputTokens }
        : {}),
      lastUsedTokens: usedTokens,
      compactsAutomatically: true,
    },
    turnId: input.turnId ?? null,
    createdAt: input.createdAt,
  };
}

function boundedStatusLabel(value: unknown, fallback: string, maximum = 96): string {
  const normalized = text(value).trim().replace(/\s+/gu, " ").slice(0, maximum);
  return normalized || fallback;
}

function boundedPercent(value: unknown): number | null {
  const number = finite(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
}

function optionalTimestamp(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

/**
 * Project only presentation-safe provider quota data for Android. Raw provider
 * responses, credentials, account ids, plan metadata, and quota sources never
 * cross the remote boundary.
 */
export function projectProviderUsageActivity(input: {
  threadId: string;
  report: unknown;
  fallbackCreatedAt: string;
}): JsonRecord | null {
  const report = record(input.report);
  const quota = record(report?.quota);
  if (!report || !quota) return null;

  const windows: JsonRecord[] = [];
  const pushWindow = (label: string, percentValue: unknown, resetValue: unknown): void => {
    const usedPercent = boundedPercent(percentValue);
    if (usedPercent === null || windows.length >= 12) return;
    const resetAt = optionalTimestamp(resetValue);
    windows.push({
      label,
      usedPercent,
      remainingPercent: Math.max(0, Math.min(100, Math.round(100 - usedPercent))),
      ...(resetAt !== null ? { resetAt } : {}),
    });
  };
  pushWindow("5-hour", quota.fiveHourPercent, quota.fiveHourResetAt);
  pushWindow("Weekly", quota.weeklyPercent, quota.weeklyResetAt);
  pushWindow("Monthly", quota.monthlyPercent, quota.monthlyResetAt);
  if (Array.isArray(quota.customWindows)) {
    for (const value of quota.customWindows) {
      const window = record(value);
      if (!window) continue;
      pushWindow(
        boundedStatusLabel(window.label, "Limit", 64),
        window.percent,
        window.resetAt,
      );
    }
  }

  const rawCredits = record(quota.creditsUsd);
  const credits = rawCredits
    ? (() => {
        const unlimited = rawCredits.unlimited === true;
        const used = finite(rawCredits.used);
        const limit = finite(rawCredits.limit);
        const remaining = finite(rawCredits.remaining);
        const usedPercent = boundedPercent(rawCredits.percent);
        if (!unlimited && used === null && limit === null && remaining === null && usedPercent === null) {
          return null;
        }
        const expiresAt = optionalTimestamp(rawCredits.expiresAt);
        return {
          unlimited,
          ...(used !== null && used >= 0 ? { used } : {}),
          ...(limit !== null && limit >= 0 ? { limit } : {}),
          ...(remaining !== null && remaining >= 0 ? { remaining } : {}),
          ...(usedPercent !== null
            ? {
                usedPercent,
                remainingPercent: Math.max(0, Math.min(100, Math.round(100 - usedPercent))),
              }
            : {}),
          ...(expiresAt !== null ? { expiresAt } : {}),
        };
      })()
    : null;
  if (windows.length === 0 && credits === null) return null;

  const updatedAtValue = optionalTimestamp(report.updatedAt) ?? optionalTimestamp(quota.updatedAt);
  const updatedAtMs = updatedAtValue === null
    ? Date.parse(input.fallbackCreatedAt)
    : updatedAtValue < 10_000_000_000
      ? updatedAtValue * 1_000
      : updatedAtValue;
  const createdAt = Number.isFinite(updatedAtMs)
    ? new Date(updatedAtMs).toISOString()
    : input.fallbackCreatedAt;
  return {
    id: `provider-usage-${input.threadId}`,
    tone: "info",
    kind: "provider.usage.updated",
    summary: "Provider usage updated",
    payload: {
      providerId: boundedStatusLabel(report.provider, "provider", 64),
      providerLabel: boundedStatusLabel(report.label, "Provider"),
      windows,
      ...(credits ? { credits } : {}),
    },
    turnId: null,
    createdAt,
  };
}

export function projectCodexThreadDetail(
  threadValue: unknown,
  sequence: number,
  options: { readonly compactCompletedWork?: boolean } = {},
): JsonRecord {
  const thread = record(threadValue);
  if (!thread) throw new TypeError("Codex returned an invalid task");
  const shell = shellThread(thread);
  const detail = messagesAndActivity(thread, options);
  const statusUpdatedAt = text(shell.updatedAt);
  const contextWindow = projectCodexContextWindowActivity({
    threadId: text(thread.id),
    tokenUsage: thread.latestTokenUsageInfo,
    createdAt: statusUpdatedAt,
    turnId: text(latestTurn(thread)?.id).trim() || null,
  });
  return {
    snapshotSequence: sequence,
    thread: {
      ...shell,
      ...(record(thread.historyPage) ? { historyPage: record(thread.historyPage) } : {}),
      deletedAt: null,
      messages: detail.messages,
      proposedPlans: detail.proposedPlans,
      activities: [
        ...detail.activities,
        ...(contextWindow ? [contextWindow] : []),
      ],
      checkpoints: [],
      hasActionableProposedPlan: detail.proposedPlans.some(plan => plan.implementedAt === null),
    },
  };
}

/** Project one live Codex item without rereading and rebuilding the whole task. */
export function projectCodexLiveTurnItem(input: {
  threadId: string;
  turnId: string;
  item: JsonRecord;
  sequence: number;
  createdAtMs: number;
  completed: boolean;
}): {
  message: JsonRecord | null;
  activity: JsonRecord | null;
  proposedPlan: JsonRecord | null;
} {
  const seconds = input.createdAtMs / 1_000;
  const detail = messagesAndActivity({
    id: input.threadId,
    createdAt: seconds,
    updatedAt: seconds,
    turns: [{
      id: input.turnId,
      status: input.completed ? "completed" : "inProgress",
      startedAt: seconds,
      ...(input.completed ? { completedAt: seconds } : {}),
      items: [input.item],
    }],
  }, { includeCompletedCommandActivities: true });
  const withSequence = (value: JsonRecord | undefined): JsonRecord | null =>
    value ? { ...value, sequence: input.sequence } : null;
  return {
    message: withSequence(detail.messages[0]),
    activity: withSequence(detail.activities[0]),
    proposedPlan: withSequence(detail.proposedPlans[0]),
  };
}

export function codexThreadIdFromMessage(message: JsonRecord): string | null {
  const params = record(message.params);
  const direct = text(params?.threadId).trim();
  if (direct) return direct;
  const thread = record(params?.thread);
  return text(thread?.id).trim() || null;
}
