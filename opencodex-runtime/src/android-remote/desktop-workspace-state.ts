import { open, readFile } from "node:fs/promises";
import { isImageGenerationTool, runningImageGenerationCell } from "./generated-images";
import { basename, join, posix, win32 } from "node:path";
import { getCodexHome } from "../codex/paths";
import { resolveThreadSourcePaths } from "./thread-source-paths";
import { boundedTurnErrorMessage } from "./turn-activity";
import { desktopAsyncQuestionItem, desktopQuestionReplyIds, readDesktopInteractions } from "./desktop-interactions";

type JsonRecord = Record<string, unknown>;

export const DESKTOP_CODEX_PROJECT_ID_PREFIX = "codex-desktop-project-";
const SESSION_ACTIVITY_SCAN_CHUNK_BYTES = 256 * 1024;
const SESSION_ACTIVITY_SCAN_LIMIT = 50;
const DESKTOP_RUNNING_MARKER_FRESH_MS = 30_000;

export type DesktopTaskActivityOptions = {
  /** Codex home whose sessions/ directory contains the rollout files. */
  codexHome?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  isThreadActive?: (threadId: string) => Promise<boolean | null>;
  runningMarkerFreshMs?: number;
};

/** The small, presentation-safe project shape exposed by Codex Desktop. */
export type DesktopWorkspaceProject = {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createdAt?: string;
};

export type DesktopWorkspaceSnapshot = {
  readonly threads: JsonRecord[];
  readonly projects: DesktopWorkspaceProject[];
};

type DesktopTaskActivity = {
  state: "running" | "completed" | "interrupted" | "error";
  turnId: string;
  occurredAt: string;
  /** Actual assistant/tool work after the marker, never a file/metadata timestamp. */
  lastProgressAt?: string;
  pendingImageGeneration?: { callId: string; startedAt: string } | undefined;
  errorMessage: string | null;
  waitingOnUserInput: boolean;
  pendingUserInput: DesktopPendingUserInput | null;
  pendingAsyncUserInputs?: DesktopPendingUserInput[];
};

type DesktopPendingUserInput = {
  itemId: string;
  callId: string;
  requestedAt: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: false;
  }>;
};

const desktopTaskActivityCache = new Map<string, {
  size: number;
  activity: DesktopTaskActivity | null;
}>();

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function workspaceRootKey(value: unknown): string {
  const path = text(value);
  // Windows paths are case-insensitive and can arrive with either separator.
  // Do not resolve relative paths against the npm server's working directory.
  if (/^[a-z]:[\\/]|^[\\/]{2}[^\\/]/i.test(path)) {
    return win32.normalize(path).replace(/[\\/]+$/u, "").toLowerCase();
  }
  return posix.isAbsolute(path) ? posix.normalize(path).replace(/\/+$/u, "") || "/" : "";
}

function desktopProjectsFromState(stateValue: unknown): DesktopWorkspaceProject[] {
  const state = record(stateValue);
  const projects = record(state?.["local-projects"]);
  if (!projects) return [];
  const result: DesktopWorkspaceProject[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(projects)) {
    const project = record(value);
    if (!project) continue;
    const id = text(project.id) || key;
    const roots = Array.isArray(project.rootPaths)
      ? project.rootPaths.flatMap(candidate => text(candidate) ? [text(candidate)] : [])
      : [];
    const workspaceRoot = roots[0] ?? "";
    if (!id || !workspaceRoot) continue;
    const projectId = `${DESKTOP_CODEX_PROJECT_ID_PREFIX}${id}`;
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    result.push({
      id: projectId,
      title: text(project.name) || basename(workspaceRoot),
      workspaceRoot,
      ...(text(project.createdAt) ? { createdAt: text(project.createdAt) } : {}),
    });
  }
  return result;
}

function desktopWorkspaceSnapshotFromState(
  threads: readonly JsonRecord[],
  stateValue: unknown,
): DesktopWorkspaceSnapshot {
  const state = record(stateValue);
  const projects = record(state?.["local-projects"]);
  const assignments = record(state?.["thread-project-assignments"]);
  const projectByRoot = new Map<string, { id: string; project: JsonRecord } | null>();
  for (const [id, value] of Object.entries(projects ?? {})) {
    const project = record(value);
    if (!project || !Array.isArray(project.rootPaths)) continue;
    for (const path of project.rootPaths) {
      const key = workspaceRootKey(path);
      if (!key) continue;
      const existing = projectByRoot.get(key);
      // Two saved projects can share a root. Only an explicit assignment can
      // choose between them; repeated roots within one project are harmless.
      projectByRoot.set(key, existing === undefined || existing?.id === id ? { id, project } : null);
    }
  }
  const projectlessThreadIds = new Set(
    Array.isArray(state?.["projectless-thread-ids"])
      ? state["projectless-thread-ids"].flatMap(value => {
          const id = text(value);
          return id ? [id] : [];
        })
      : [],
  );
  const projectlessOutputDirectories = record(state?.["thread-projectless-output-directories"]);
  if (projectlessOutputDirectories) {
    for (const id of Object.keys(projectlessOutputDirectories)) projectlessThreadIds.add(id);
  }

  const projectedThreads = threads.map(thread => {
    const nativeThreadId = text(thread.androidRemoteNativeThreadId) || text(thread.id);
    // Desktop's explicit projectless list is authoritative.  This check must
    // happen before project assignments because an older state file can retain
    // both records while a conversation is being moved out of a project.
    if (
      projectlessThreadIds.has(nativeThreadId)
      || thread.androidRemoteWorkspaceKind === "projectless"
      || thread.androidRemoteProjectless === true
    ) {
      return {
        ...thread,
        androidRemoteWorkspaceKind: "projectless",
        androidRemoteProjectId: "codex-project-chats",
        androidRemoteProjectTitle: "Chats",
      };
    }
    const assignment = record(assignments?.[nativeThreadId]);
    if (assignment && text(assignment.projectKind) !== "local") return thread;
    // New/forked tasks can be listed before Desktop saves their membership.
    // Match an exact, unique registered root, preserving explicit Android
    // choices and never overriding a missing/conflicting Desktop assignment.
    const fallback = !assignment && !text(thread.androidRemoteProjectId)
      ? projectByRoot.get(workspaceRootKey(thread.cwd))
      : null;
    const desktopProjectId = assignment ? text(assignment.projectId) : fallback?.id ?? "";
    const project = assignment ? record(projects?.[desktopProjectId]) : fallback?.project;
    if (!desktopProjectId || !project) return thread;
    const rootPaths = Array.isArray(project.rootPaths)
      ? project.rootPaths.flatMap(value => text(value) ? [text(value)] : [])
      : [];
    return {
      ...thread,
      androidRemoteProjectId: `${DESKTOP_CODEX_PROJECT_ID_PREFIX}${desktopProjectId}`,
      androidRemoteProjectTitle: text(project.name) || "Codex project",
      androidRemoteProjectWorkspaceRoot: text(assignment?.cwd) || rootPaths[0] || text(thread.cwd),
    };
  });
  return { threads: projectedThreads, projects: desktopProjectsFromState(stateValue) };
}

function parsedLine(line: string): JsonRecord | null {
  let row: JsonRecord | null;
  try {
    row = record(JSON.parse(line));
  } catch {
    return null;
  }
  return row;
}

function activityFromRow(
  row: JsonRecord,
  waitingOnUserInput: boolean,
  pendingUserInput: DesktopPendingUserInput | null,
): DesktopTaskActivity | null {
  if (row?.type !== "event_msg") return null;
  const payload = record(row.payload);
  const event = text(payload?.type);
  const errorMessage = event === "task_complete"
    ? boundedTurnErrorMessage(payload?.error)
    : "";
  const state = event === "task_started"
    ? "running"
    : event === "task_complete"
      ? errorMessage ? "error" : "completed"
      : event === "turn_aborted"
        ? "interrupted"
        : null;
  if (!state) return null;
  return {
    state,
    turnId: text(payload?.turn_id),
    occurredAt: text(row.timestamp),
    errorMessage: errorMessage || null,
    waitingOnUserInput: state === "running" && waitingOnUserInput,
    pendingUserInput: state === "running" && waitingOnUserInput ? pendingUserInput : null,
  };
}

function responseCall(row: JsonRecord): {
  type: string;
  name: string;
  itemId: string;
  callId: string;
  arguments: unknown;
} | null {
  // Codex Desktop has emitted both response_item/function_call records and
  // newer dynamic_tool_call records across app-server versions.
  if (row.type !== "response_item" && row.type !== "response_item_event") return null;
  const payload = record(row.payload);
  if (!payload) return null;
  const rawType = text(payload.type);
  const normalizedType = rawType.replace(/[^a-z0-9_]/giu, "_").toLowerCase();
  const name = text(payload.name) || text(payload.tool);
  return {
    type: normalizedType,
    name,
    itemId: text(payload.id),
    callId: text(payload.call_id),
    arguments: payload.arguments,
  };
}

function pendingUserInputFromCall(row: JsonRecord, call: NonNullable<ReturnType<typeof responseCall>>): DesktopPendingUserInput | null {
  let args: JsonRecord | null = record(call.arguments);
  if (!args && typeof call.arguments === "string") {
    try { args = record(JSON.parse(call.arguments)); }
    catch { return null; }
  }
  const questions = (Array.isArray(args?.questions) ? args.questions : []).flatMap(value => {
    const question = record(value);
    const id = text(question?.id).slice(0, 128);
    const prompt = text(question?.question).slice(0, 2048);
    if (!id || !prompt) return [];
    const options = (Array.isArray(question?.options) ? question.options : []).flatMap(optionValue => {
      const option = record(optionValue);
      const label = text(option?.label).slice(0, 256);
      if (!label) return [];
      return [{
        label,
        description: text(option?.description).slice(0, 1024) || label,
      }];
    });
    return [{
      id,
      header: text(question?.header).slice(0, 256) || "Question",
      question: prompt,
      options,
      multiSelect: false as const,
    }];
  });
  if (!call.itemId || !call.callId || questions.length === 0) return null;
  return {
    itemId: call.itemId.slice(0, 128),
    callId: call.callId.slice(0, 128),
    requestedAt: text(row.timestamp),
    questions,
  };
}

async function scanLatestDesktopTaskActivity(
  file: Awaited<ReturnType<typeof open>>,
  lowerBound: number,
  fileSize: number,
  previousActivity: DesktopTaskActivity | null = null,
): Promise<DesktopTaskActivity | null> {
  let end = fileSize;
  let suffix = "";
  let waitingOnUserInput = false;
  let pendingUserInput: DesktopPendingUserInput | null = null;
  const resolvedCallIds = new Set<string>();
  const answeredAsyncQuestions = new Set<string>();
  const pendingAsyncInputs = new Map<string, DesktopPendingUserInput>();
  let lastProgressAt: string | undefined;
  let pendingImageGeneration: DesktopTaskActivity["pendingImageGeneration"];
  while (end > lowerBound) {
    const length = Math.min(SESSION_ACTIVITY_SCAN_CHUNK_BYTES, end - lowerBound);
    const start = end - length;
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(chunk, 0, length, start);
    const source = chunk.subarray(0, bytesRead).toString("utf8") + suffix;
    const lines = source.split("\n");
    // The first line may start in the middle of a UTF-8 or JSON record.
    const firstCompleteLine = start === lowerBound && lowerBound === 0 ? 0 : 1;
    for (let index = lines.length - 1; index >= firstCompleteLine; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      const row = parsedLine(line);
      if (!row) continue;
      const payload = record(row.payload);
      const inputItem = row.type === "event_msg" && ["item_started", "item_completed"].includes(text(payload?.type))
        ? record(payload?.item)
        : row.type === "response_item" || row.type === "response_item_event" ? payload : null;
      for (const id of desktopQuestionReplyIds(inputItem)) answeredAsyncQuestions.add(id);
      const asyncItem = desktopAsyncQuestionItem(inputItem);
      if (asyncItem) {
        const group = readDesktopInteractions({ turns: [{ items: [asyncItem] }] }).questions[0];
        if (group && !pendingAsyncInputs.has(group.itemId)) {
          const questions = group.questions.filter(question => !answeredAsyncQuestions.has(question.id));
          if (questions.length) pendingAsyncInputs.set(group.itemId, {
            itemId: group.itemId, callId: group.itemId, questions, requestedAt: text(row.timestamp),
          });
        }
      }
      const progress = row.type === "event_msg"
        ? payload?.type === "agent_message" || payload?.type === "agent_reasoning"
          || payload?.type === "item_started" || payload?.type === "item_completed"
        : (row.type === "response_item" || row.type === "response_item_event") && (
          (payload?.type === "message" && payload.role === "assistant")
          || payload?.type === "reasoning"
          || payload?.type === "function_call" || payload?.type === "function_call_output"
          || payload?.type === "custom_tool_call" || payload?.type === "custom_tool_call_output"
          || payload?.type === "dynamic_tool_call" || payload?.type === "dynamic_tool_call_output"
          || payload?.type === "dynamicToolCall" || payload?.type === "dynamicToolCallOutput"
        );
      if (progress && !lastProgressAt && Number.isFinite(Date.parse(text(row.timestamp)))) {
        lastProgressAt = text(row.timestamp);
      }
      const call = responseCall(row);
      if ((call?.type === "function_call_output" || call?.type === "custom_tool_call_output") && call.callId) {
        const output = typeof payload?.output === "string" ? payload.output
          : Array.isArray(payload?.output) ? payload.output.map(part => text(record(part)?.text)).join("\n") : "";
        if (!runningImageGenerationCell(output)) resolvedCallIds.add(call.callId);
      } else if (
        (call?.type === "function_call" || call?.type === "dynamic_tool_call" || call?.type === "dynamictoolcall")
        && call.name === "request_user_input"
        && call.callId
        && !resolvedCallIds.has(call.callId)
      ) {
        waitingOnUserInput = true;
        pendingUserInput ??= pendingUserInputFromCall(row, call);
      }
      if (call && ["function_call", "custom_tool_call"].includes(call.type) && call.callId
        && !resolvedCallIds.has(call.callId) && (isImageGenerationTool(call.name)
          || [...text(payload?.input).matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/gu)].some(match => isImageGenerationTool(match[1])))) {
        pendingImageGeneration ??= { callId: call.callId, startedAt: text(row.timestamp) };
      }
      const asyncInputs = [...pendingAsyncInputs.values()];
      const activity = activityFromRow(row, waitingOnUserInput || asyncInputs.length > 0, pendingUserInput ?? asyncInputs[0] ?? null);
      if (activity) return { ...activity, ...(activity.state === "running" ? {
        lastProgressAt, pendingImageGeneration,
        ...(asyncInputs.length ? { pendingAsyncUserInputs: asyncInputs } : {}),
      } : {}) };
    }
    suffix = lines[0]?.slice(0, SESSION_ACTIVITY_SCAN_CHUNK_BYTES) ?? "";
    end = start;
  }
  // Incremental scans can contain work without another task_started marker.
  // Carry it forward only for the still-open turn, never after a real stop.
  return previousActivity?.state === "running" && lastProgressAt
    ? { ...previousActivity, lastProgressAt, pendingImageGeneration: pendingImageGeneration
      ?? (resolvedCallIds.has(previousActivity.pendingImageGeneration?.callId ?? "") ? undefined : previousActivity.pendingImageGeneration) }
    : previousActivity;
}

/** Read backwards until the most recent authoritative Desktop task marker is found. */
async function readLatestDesktopTaskActivity(path: string): Promise<DesktopTaskActivity | null> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const cached = desktopTaskActivityCache.get(path);
    if (cached?.size === size) return cached.activity;

    // Session files are append-only. Once the current marker is known, only
    // inspect newly appended records instead of rescanning a large transcript
    // on every five-second shell refresh.
    if (cached && size > cached.size) {
      const lowerBound = Math.max(0, cached.size - 1_024);
      const probe = Buffer.allocUnsafe(size - lowerBound);
      const { bytesRead } = await file.read(probe, 0, probe.length, lowerBound);
      const appendedText = probe.subarray(0, bytesRead).toString("utf8");
      // A question changes state without emitting a task marker. Re-scan the
      // current turn only for that rare transition so a submitted answer also
      // clears the sidebar badge before the turn completes.
      const questionStateChanged = appendedText.includes('request_user_input')
        || appendedText.includes('"questions"')
        || appendedText.includes('send_user_message_question_reply')
        || (cached.activity?.waitingOnUserInput === true
          && appendedText.includes('"type":"function_call_output"'));
      const appendedActivity = await scanLatestDesktopTaskActivity(
        file,
        questionStateChanged ? 0 : lowerBound,
        size,
        questionStateChanged ? null : cached.activity,
      );
      const activity = appendedActivity ?? cached.activity;
      desktopTaskActivityCache.set(path, { size, activity });
      return activity;
    }

    const activity = await scanLatestDesktopTaskActivity(file, 0, size);
    desktopTaskActivityCache.set(path, { size, activity });
    return activity;
  } finally {
    await file.close();
  }
}

/** Update fallback: inspect at most 1 MiB for terminal markers or recent progress. */
export async function readBoundedDesktopTaskActivity(path: string) {
  const file = await open(path, "r");
  try {
    const { size, mtimeMs, ino } = await file.stat();
    const activity = await scanLatestDesktopTaskActivity(file, Math.max(0, size - 1024 * 1024), size, {
      state: "running", turnId: "", occurredAt: "", waitingOnUserInput: false,
      pendingUserInput: null, errorMessage: null,
    });
    const after = await file.stat();
    if (after.size !== size || after.mtimeMs !== mtimeMs || after.ino !== ino) return null;
    // A long active turn may start before this bounded tail. Recent tool or
    // assistant progress is positive evidence of work, but silence proves nothing.
    return activity && Number.isFinite(Date.parse(activity.lastProgressAt ?? activity.occurredAt)) ? activity : null;
  } finally { await file.close(); }
}

/**
 * Codex's list response deliberately omits turns and reports Desktop-owned
 * tasks as `notLoaded`. The append-only session file still carries exact
 * task_started/task_complete markers, so project those into lightweight rows.
 */
export async function annotateDesktopTaskActivity(
  threads: readonly JsonRecord[],
  limit = SESSION_ACTIVITY_SCAN_LIMIT,
  options: DesktopTaskActivityOptions = {},
): Promise<JsonRecord[]> {
  return Promise.all(threads.map(async (thread, index) => {
    if (index >= limit) return thread;
    try {
      const threadId = text(thread.androidRemoteNativeThreadId) || text(thread.id);
      const explicitPaths = [
        text(thread.path),
        ...(Array.isArray(thread.androidRemoteSourcePaths)
          ? thread.androidRemoteSourcePaths.flatMap(value => {
              const path = text(value);
              return path ? [path] : [];
            })
          : []),
      ];
      if (!threadId || explicitPaths.length === 0) return thread;
      const sourcePaths = await resolveThreadSourcePaths(threadId, explicitPaths, {
        codexHome: options.codexHome,
        now: options.now,
        discover: true,
      });
      if (sourcePaths.length === 0) return thread;
      const activities = (
        await Promise.all(sourcePaths.map(path => readLatestDesktopTaskActivity(path)))
      ).flatMap(activity => activity ? [activity] : []);
      const activity = activities
        .map((candidate, candidateIndex) => ({
          candidate,
          candidateIndex,
          timestamp: Date.parse(candidate.occurredAt),
        }))
        .sort((left, right) => {
          const leftTimestamp = Number.isFinite(left.timestamp) ? left.timestamp : -Infinity;
          const rightTimestamp = Number.isFinite(right.timestamp) ? right.timestamp : -Infinity;
          return leftTimestamp - rightTimestamp || left.candidateIndex - right.candidateIndex;
        })
        .at(-1)?.candidate;
      if (!activity) return thread;
      if (
        activity.state === "running"
        && !activity.waitingOnUserInput
        && runningMarkerIsStale(thread, activity, options)
      ) {
        const liveState = await options.isThreadActive?.(threadId).catch(() => null) ?? null;
        if (liveState !== true) {
          // A missing/stale owner view is not a turn_aborted event. Expose
          // uncertainty instead of inventing a stop (and a Resume button).
          return {
            ...thread,
            androidRemoteLatestTurnState: "running",
            androidRemoteLatestTurnId: activity.turnId,
            androidRemoteLatestTurnAt: activity.occurredAt,
            androidRemoteWaitingOnUserInput: false,
            androidRemoteActivityUnverified: true,
            androidRemoteLatestTurnError: "The latest task state could not be verified.",
          };
        }
      }
      const annotated: JsonRecord = {
        ...thread,
        androidRemoteLatestTurnState: activity.state,
        androidRemoteLatestTurnId: activity.turnId,
        androidRemoteLatestTurnAt: activity.occurredAt,
        androidRemoteLatestProgressAt: activity.lastProgressAt,
        androidRemoteWaitingOnUserInput: activity.waitingOnUserInput,
        ...(activity.errorMessage
          ? { androidRemoteLatestTurnError: activity.errorMessage }
          : {}),
        ...(activity.pendingUserInput
          ? { androidRemotePendingUserInput: activity.pendingUserInput }
          : {}),
        ...(activity.pendingAsyncUserInputs
          ? { androidRemotePendingAsyncUserInputs: activity.pendingAsyncUserInputs }
          : {}),
      };
      delete annotated.androidRemoteActivityUnverified;
      if (!activity.errorMessage) delete annotated.androidRemoteLatestTurnError;
      if (!activity.pendingUserInput) delete annotated.androidRemotePendingUserInput;
      if (!activity.pendingAsyncUserInputs) delete annotated.androidRemotePendingAsyncUserInputs;
      return annotated;
    } catch {
      return thread;
    }
  }));
}

function runningMarkerIsStale(
  thread: JsonRecord,
  activity: DesktopTaskActivity,
  options: DesktopTaskActivityOptions,
): boolean {
  // A metadata refresh can update thread.updatedAt without any actual work.
  const updatedAt = Math.max(Date.parse(activity.occurredAt), Date.parse(activity.lastProgressAt ?? activity.occurredAt));
  if (!Number.isFinite(updatedAt)) return false;
  const freshMs = Math.max(0, options.runningMarkerFreshMs ?? DESKTOP_RUNNING_MARKER_FRESH_MS);
  if (activity.pendingImageGeneration && (options.now?.() ?? Date.now()) - Date.parse(activity.pendingImageGeneration.startedAt) < 10 * 60_000) return false;
  return (options.now?.() ?? Date.now()) - updatedAt >= freshMs;
}

/**
 * Apply Codex Desktop's explicit project membership to app-server thread rows.
 * Working-directory equality is not sufficient: projectless Chats can use the
 * same cwd as a real project.
 */
export function annotateDesktopWorkspaceMembership(
  threads: readonly JsonRecord[],
  stateValue: unknown,
): JsonRecord[] {
  return desktopWorkspaceSnapshotFromState(threads, stateValue).threads;
}

/**
 * Read Desktop's registry once and return both explicit projects (including
 * projects with no tasks yet) and the thread membership annotations.
 */
export async function readDesktopWorkspaceSnapshot(
  threads: readonly JsonRecord[],
  codexHome = getCodexHome(),
): Promise<DesktopWorkspaceSnapshot> {
  try {
    const raw = await readFile(join(codexHome, ".codex-global-state.json"), "utf8");
    return desktopWorkspaceSnapshotFromState(threads, JSON.parse(raw));
  } catch {
    // Older Codex builds and non-Desktop hosts may not expose this optional
    // state file. Keep the existing cwd projection in that case.
    return { threads: [...threads], projects: [] };
  }
}

export async function readDesktopWorkspaceMembership(
  threads: readonly JsonRecord[],
  codexHome = getCodexHome(),
): Promise<JsonRecord[]> {
  return (await readDesktopWorkspaceSnapshot(threads, codexHome)).threads;
}
