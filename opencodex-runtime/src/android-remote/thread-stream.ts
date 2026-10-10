import { compactProjectedWork } from "./thread-work-page";
type JsonRecord = Record<string, unknown>;

export class ProjectedHistoryCursorExpiredError extends Error {}

export const PROJECTED_THREAD_RECENT_PROMPT_LIMIT = 10;
// Retain the export for callers compiled against the earlier page helper.
export const PROJECTED_THREAD_RECENT_BLOCK_LIMIT = PROJECTED_THREAD_RECENT_PROMPT_LIMIT;
export const PROJECTED_THREAD_REPLAY_LIMIT = 256;

export type ProjectedThreadHistoryPage = {
  threadId: string;
  messages: JsonRecord[];
  activities: JsonRecord[];
  proposedPlans: JsonRecord[];
  pageInfo: {
    hasOlder: boolean;
    olderCursor: string | null;
  };
};

export type ProjectedThreadStreamState = {
  detail: JsonRecord;
  sequence: number;
  replay: JsonRecord[];
  touchedAt: number;
};

export type ProjectedThreadStreamAdvance = {
  state: ProjectedThreadStreamState;
  items: JsonRecord[];
  usedSnapshot: boolean;
};

type TimelineBlock = {
  key: string;
  kind: "message" | "activity" | "plan";
  id: string;
  turnId: string | null;
  sequence: number | null;
  createdAt: string;
  rank: number;
  queuePosition: number | null;
  value: JsonRecord;
};

type EventDraft = {
  order: number;
  event: JsonRecord;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rows(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.flatMap(row => record(row) ? [record(row)!] : []) : [];
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function threadOf(detail: JsonRecord): JsonRecord {
  const thread = record(detail.thread);
  if (!thread) throw new TypeError("Projected task detail is missing its task");
  return thread;
}

function blockFor(
  kind: TimelineBlock["kind"],
  value: JsonRecord,
  fallbackRank: number,
): TimelineBlock | null {
  const id = stringValue(value.id).trim();
  if (!id) return null;
  const role = stringValue(value.role);
  const rank = kind === "message"
    ? role === "user" ? 0 : role === "system" ? 1 : 3
    : fallbackRank;
  return {
    key: `${kind}:${id}`,
    kind,
    id,
    turnId: stringValue(value.turnId).trim() || null,
    sequence: numberValue(value.sequence),
    createdAt: stringValue(value.createdAt),
    rank,
    queuePosition:
      kind === "message" && value.phase === "queued" ? numberValue(value.queuePosition) : null,
    value,
  };
}

function compareBlocks(left: TimelineBlock, right: TimelineBlock): number {
  if (
    left.queuePosition !== null &&
    right.queuePosition !== null &&
    left.queuePosition !== right.queuePosition
  ) {
    return left.queuePosition - right.queuePosition;
  }
  if (left.turnId !== null && left.turnId === right.turnId) {
    if (
      left.sequence !== null &&
      right.sequence !== null &&
      left.sequence !== right.sequence
    ) {
      return left.sequence - right.sequence;
    }
    if (left.rank !== right.rank) return left.rank - right.rank;
  }
  const time = left.createdAt.localeCompare(right.createdAt);
  if (time !== 0) return time;
  if (left.rank !== right.rank) return left.rank - right.rank;
  return left.key.localeCompare(right.key);
}

function isThreadStatusActivity(value: JsonRecord): boolean {
  return value.kind === "context-window.updated" || value.kind === "provider.usage.updated";
}

function currentStatusActivities(thread: JsonRecord): JsonRecord[] {
  const latest = new Map<unknown, JsonRecord>();
  for (const activity of rows(thread.activities)) {
    if (!isThreadStatusActivity(activity)) continue;
    const previous = latest.get(activity.kind);
    if (!previous || stringValue(activity.createdAt) >= stringValue(previous.createdAt)) {
      latest.set(activity.kind, activity);
    }
  }
  return [...latest.values()];
}

function timelineBlocks(thread: JsonRecord): TimelineBlock[] {
  return [
    ...rows(thread.messages).flatMap(value => {
      const block = blockFor("message", value, 3);
      return block ? [block] : [];
    }),
    ...rows(thread.activities).flatMap(value => {
      if (isThreadStatusActivity(value)) return [];
      const block = blockFor("activity", value, 2);
      return block ? [block] : [];
    }),
    ...rows(thread.proposedPlans).flatMap(value => {
      const block = blockFor("plan", value, 4);
      return block ? [block] : [];
    }),
  ].sort(compareBlocks);
}

/** Page by visible prompts, never by the number of tool events. */
function selectionStart(blocks: TimelineBlock[], end: number, limit: number): number {
  let prompts = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind !== "message" || block.value.role !== "user") continue;
    if (String(block.value.text).trimStart().startsWith("<send_user_message_question_reply>")) continue;
    prompts += 1;
    if (prompts >= limit) return index;
  }
  return 0;
}

function cursorFor(block: TimelineBlock): string {
  return Buffer.from(JSON.stringify({ v: 1, before: block.key }), "utf8").toString("base64url");
}

function blockKeyFromCursor(cursor: string): string | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const row = record(decoded);
    return row?.v === 1 ? stringValue(row.before).trim() || null : null;
  } catch {
    return null;
  }
}

function pageFromRange(
  thread: JsonRecord,
  blocks: TimelineBlock[],
  start: number,
  end: number,
): ProjectedThreadHistoryPage {
  const selected = blocks.slice(start, end);
  const messages: JsonRecord[] = [];
  const activities: JsonRecord[] = [];
  const proposedPlans: JsonRecord[] = [];
  for (const block of selected) {
    if (block.kind === "message") messages.push(block.value);
    else if (block.kind === "activity") activities.push(block.value);
    else proposedPlans.push(block.value);
  }
  const sourceCursor = stringValue(record(thread.historyPage)?.olderCursor) || null;
  return compactProjectedWork({
    threadId: stringValue(thread.id),
    messages,
    activities,
    proposedPlans,
    pageInfo: {
      hasOlder: start > 0 || sourceCursor !== null,
      olderCursor: start > 0 && blocks[start] ? cursorFor(blocks[start]!) : sourceCursor,
    },
  }, stringValue(record(thread.session)?.activeTurnId) || null);
}

export function projectedThreadRecentPage(
  detail: JsonRecord,
  limit = PROJECTED_THREAD_RECENT_BLOCK_LIMIT,
): ProjectedThreadHistoryPage {
  const thread = threadOf(detail);
  const blocks = timelineBlocks(thread);
  const start = selectionStart(blocks, blocks.length, limit);
  const page = pageFromRange(thread, blocks, start, blocks.length);
  // Status describes the current task/account, not the selected history range.
  // Always include it in reconnect snapshots, even when only one prompt loads.
  return { ...page, activities: [...page.activities, ...currentStatusActivities(thread)] };
}

export function projectedThreadOlderPage(
  state: ProjectedThreadStreamState,
  cursor: string,
  limit = PROJECTED_THREAD_RECENT_BLOCK_LIMIT,
): ProjectedThreadHistoryPage {
  const thread = threadOf(state.detail);
  const blocks = timelineBlocks(thread);
  const beforeKey = blockKeyFromCursor(cursor);
  if (!beforeKey) throw new Error("The older-message cursor is invalid");
  const end = blocks.findIndex(block => block.key === beforeKey);
  if (end < 0) throw new ProjectedHistoryCursorExpiredError("The saved history no longer contains this page boundary. Refresh the chat and retry.");
  const start = selectionStart(blocks, end, limit);
  return pageFromRange(thread, blocks, start, end);
}

export async function readProjectedOlderPage(
  state: ProjectedThreadStreamState,
  cursor: string,
  recoverDetail: () => Promise<JsonRecord>,
  limit = PROJECTED_THREAD_RECENT_PROMPT_LIMIT,
): Promise<ProjectedThreadHistoryPage> {
  try {
    return projectedThreadOlderPage(state, cursor, limit);
  } catch (error) {
    if (!(error instanceof ProjectedHistoryCursorExpiredError)) throw error;
    const detail = await recoverDetail();
    if (threadOf(detail).id !== threadOf(state.detail).id) throw new Error("History belongs to a different task");
    return projectedThreadOlderPage(createProjectedThreadStreamState(detail), cursor, limit);
  }
}

/** Bookmark the beginning of a recent saved-file tail before older work arrives. */
export function projectedThreadStartCursor(detail: JsonRecord): string | null {
  const first = timelineBlocks(threadOf(detail))[0];
  return first ? cursorFor(first) : null;
}

export function projectedThreadBoundedSnapshot(state: ProjectedThreadStreamState, promptLimit = PROJECTED_THREAD_RECENT_PROMPT_LIMIT): JsonRecord {
  const page = projectedThreadRecentPage(state.detail, promptLimit);
  const thread = threadOf(state.detail);
  return {
    kind: "snapshot",
    snapshot: {
      ...state.detail,
      snapshotSequence: state.sequence,
      historyPage: page.pageInfo,
      thread: {
        ...thread,
        messages: page.messages,
        activities: page.activities,
        proposedPlans: page.proposedPlans,
      },
    },
  };
}

function baseEvent(threadId: string, occurredAt: string, type: string, payload: JsonRecord): JsonRecord {
  return {
    type,
    payload,
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
}

function idsArePrefix(previous: JsonRecord[], next: JsonRecord[]): boolean {
  if (next.length < previous.length) return false;
  return previous.every((row, index) => stringValue(next[index]?.id) === stringValue(row.id));
}

function changedMessageDrafts(
  threadId: string,
  occurredAt: string,
  previous: JsonRecord[],
  next: JsonRecord[],
): EventDraft[] | null {
  if (!idsArePrefix(previous, next)) return null;
  const drafts: EventDraft[] = [];
  for (let index = 0; index < next.length; index += 1) {
    const after = next[index]!;
    const before = previous[index];
    if (before && same(before, after)) continue;
    if (
      before &&
      same(
        { ...before, updatedAt: undefined },
        { ...after, updatedAt: undefined },
      )
    ) continue;
    const afterText = stringValue(after.text);
    let eventText = afterText;
    if (before) {
      if (
        before.role !== after.role ||
        before.turnId !== after.turnId ||
        before.createdAt !== after.createdAt ||
        before.sequence !== after.sequence
      ) return null;
      const beforeText = stringValue(before.text);
      if (after.streaming === true && before.streaming === true) {
        if (!afterText.startsWith(beforeText)) return null;
        eventText = afterText.slice(beforeText.length);
      } else if (before.streaming !== true && afterText !== beforeText) {
        return null;
      }
    }
    drafts.push({
      order: numberValue(after.sequence) ?? index,
      event: baseEvent(threadId, occurredAt, "thread.message-sent", {
        threadId,
        messageId: after.id,
        role: after.role,
        text: eventText,
        ...(after.phase === undefined ? {} : { phase: after.phase }),
        ...(after.attachments === undefined ? {} : { attachments: after.attachments }),
        turnId: after.turnId ?? null,
        ...(after.sequence === undefined ? {} : { sequence: after.sequence }),
        streaming: after.streaming === true,
        createdAt: after.createdAt,
        updatedAt: after.updatedAt,
      }),
    });
  }
  return drafts;
}

function changedAppendOnlyDrafts(
  threadId: string,
  occurredAt: string,
  type: "activity" | "plan",
  previous: JsonRecord[],
  next: JsonRecord[],
): EventDraft[] | null {
  if (!idsArePrefix(previous, next)) return null;
  const drafts: EventDraft[] = [];
  for (let index = 0; index < next.length; index += 1) {
    const value = next[index]!;
    if (previous[index] && same(previous[index], value)) continue;
    drafts.push({
      order: numberValue(value.sequence) ?? index,
      event: type === "activity"
        ? baseEvent(threadId, occurredAt, "thread.activity-appended", {
            threadId,
            activity: value,
          })
        : baseEvent(threadId, occurredAt, "thread.proposed-plan-upserted", {
            threadId,
            proposedPlan: value,
          }),
    });
  }
  return drafts;
}

function changedActivityDrafts(
  threadId: string,
  occurredAt: string,
  previous: JsonRecord[],
  next: JsonRecord[],
): EventDraft[] | null {
  // Question resolution removes transient request rows. Send keyed removals,
  // not a truncated replacement snapshot that can discard loaded conversation.
  const nextIds = new Set(next.map(value => stringValue(value.id)));
  const previousById = new Map(previous.map(value => [stringValue(value.id), value]));
  const drafts: EventDraft[] = previous.filter(value => !nextIds.has(stringValue(value.id))).map(value => ({
    order: numberValue(value.sequence) ?? 0,
    event: baseEvent(threadId, occurredAt, "thread.activity-appended", {
      threadId, activity: { ...value, kind: "activity.removed", summary: "", payload: {} },
    }),
  }));
  for (let index = 0; index < next.length; index += 1) {
    const value = next[index]!;
    const before = previousById.get(stringValue(value.id));
    if (before && same(before, value)) continue;
    drafts.push({
      order: numberValue(value.sequence) ?? index,
      event: baseEvent(threadId, occurredAt, "thread.activity-appended", {
        threadId,
        activity: value,
      }),
    });
  }
  return drafts;
}

function metadataDrafts(
  threadId: string,
  occurredAt: string,
  previous: JsonRecord,
  next: JsonRecord,
): EventDraft[] | null {
  if (
    previous.id !== next.id ||
    previous.projectId !== next.projectId ||
    previous.createdAt !== next.createdAt ||
    previous.deletedAt !== next.deletedAt
  ) return null;
  const drafts: EventDraft[] = [];
  const metaPayload: JsonRecord = { threadId, updatedAt: occurredAt };
  for (const field of ["title", "modelSelection", "branch", "worktreePath"] as const) {
    if (!same(previous[field], next[field])) metaPayload[field] = next[field];
  }
  if (Object.keys(metaPayload).length > 2) {
    drafts.push({ order: -4, event: baseEvent(threadId, occurredAt, "thread.meta-updated", metaPayload) });
  }
  if (previous.runtimeMode !== next.runtimeMode) {
    drafts.push({
      order: -3,
      event: baseEvent(threadId, occurredAt, "thread.runtime-mode-set", {
        threadId,
        runtimeMode: next.runtimeMode,
        updatedAt: occurredAt,
      }),
    });
  }
  if (previous.interactionMode !== next.interactionMode) {
    drafts.push({
      order: -2,
      event: baseEvent(threadId, occurredAt, "thread.interaction-mode-set", {
        threadId,
        interactionMode: next.interactionMode,
        updatedAt: occurredAt,
      }),
    });
  }
  if (previous.archivedAt !== next.archivedAt) {
    drafts.push({
      order: -1,
      event: next.archivedAt
        ? baseEvent(threadId, occurredAt, "thread.archived", {
            threadId,
            archivedAt: next.archivedAt,
            updatedAt: occurredAt,
          })
        : baseEvent(threadId, occurredAt, "thread.unarchived", { threadId, updatedAt: occurredAt }),
    });
  }
  return drafts;
}

function diffDrafts(previousDetail: JsonRecord, nextDetail: JsonRecord): EventDraft[] | null {
  const previous = threadOf(previousDetail);
  const next = threadOf(nextDetail);
  const threadId = stringValue(next.id);
  const occurredAt = stringValue(next.updatedAt) || new Date().toISOString();
  const metadata = metadataDrafts(threadId, occurredAt, previous, next);
  if (metadata === null) return null;
  const messages = changedMessageDrafts(
    threadId,
    occurredAt,
    rows(previous.messages),
    rows(next.messages),
  );
  const activities = changedActivityDrafts(
    threadId,
    occurredAt,
    rows(previous.activities),
    rows(next.activities),
  );
  const plans = changedAppendOnlyDrafts(
    threadId,
    occurredAt,
    "plan",
    rows(previous.proposedPlans),
    rows(next.proposedPlans),
  );
  if (messages === null || activities === null || plans === null) return null;
  if (!same(previous.checkpoints, next.checkpoints)) return null;
  const drafts = [...metadata, ...messages, ...activities, ...plans];
  if (!same(previous.session, next.session)) {
    const session = record(next.session);
    if (!session) return null;
    const status = stringValue(session.status);
    drafts.push({
      order: status === "running" || status === "starting" ? -0.5 : Number.MAX_SAFE_INTEGER,
      event: baseEvent(threadId, occurredAt, "thread.session-set", { threadId, session }),
    });
  }
  return drafts.sort((left, right) => left.order - right.order);
}

function sequenceItems(
  drafts: EventDraft[],
  initialSequence: number,
): { items: JsonRecord[]; sequence: number } {
  let sequence = initialSequence;
  const items = drafts.map(draft => {
    sequence += 1;
    const aggregateId = stringValue(draft.event.aggregateId) || "thread";
    const event = {
      ...draft.event,
      sequence,
      eventId: `ocx-thread-event-${aggregateId}-${sequence}`,
    };
    return { kind: "event", event };
  });
  return { items, sequence };
}

/** Preserve fetched prefixes and in-flight messages across a bounded owner read. */
export function mergeBoundedThreadDetail(previousDetail: JsonRecord, nextDetail: JsonRecord): JsonRecord {
  const previous = threadOf(previousDetail);
  const next = threadOf(nextDetail);
  if (previous.id !== next.id) return nextDetail;
  const incoming = timelineBlocks(next);
  const first = incoming[0];
  if (!first) return nextDetail;
  const turns = new Set(incoming.flatMap(block => block.turnId ? [block.turnId] : []));
  const hasOlder = Boolean(record(next.historyPage)?.olderCursor);
  const activeTurn = stringValue(record(next.session)?.activeTurnId);
  const merge = (field: "messages" | "activities" | "proposedPlans") => {
    const fresh = rows(next[field]);
    const ids = new Set(fresh.map(row => row.id));
    const retained = rows(previous[field]).filter(row => !ids.has(row.id) && row.phase !== "queued"
      && !(field === "activities" && isThreadStatusActivity(row)) && (
      (hasOlder && !turns.has(stringValue(row.turnId)) && stringValue(row.createdAt) <= first.createdAt)
      || (field === "messages" && activeTurn && row.turnId === activeTurn)
    ));
    const kind = field === "messages" ? "message" : field === "activities" ? "activity" : "plan";
    return [...retained, ...fresh].flatMap(row => {
      const block = blockFor(kind, row, 0);
      return block ? [block] : [];
    }).sort(compareBlocks).map(block => block.value);
  };
  const messages = merge("messages");
  const retainedPrefix = messages.some(row => !turns.has(stringValue(row.turnId)));
  return { ...nextDetail, thread: { ...next, messages,
    ...(retainedPrefix ? { historyPage: previous.historyPage } : {}),
    activities: merge("activities"), proposedPlans: merge("proposedPlans") } };
}

export function createProjectedThreadStreamState(
  detail: JsonRecord,
  now = Date.now(),
): ProjectedThreadStreamState {
  return { detail, sequence: 1, replay: [], touchedAt: now };
}

export function advanceProjectedThreadStream(
  current: ProjectedThreadStreamState,
  detail: JsonRecord,
  now = Date.now(),
): ProjectedThreadStreamAdvance {
  // Projection read counters are delivery details, not task mutations.
  if (same(threadOf(current.detail), threadOf(detail))) {
    return { state: { ...current, touchedAt: now }, items: [], usedSnapshot: false };
  }
  const drafts = diffDrafts(current.detail, detail);
  if (drafts === null) {
    const state = {
      detail,
      sequence: current.sequence + 1,
      replay: current.replay,
      touchedAt: now,
    };
    return { state, items: [projectedThreadBoundedSnapshot(state)], usedSnapshot: true };
  }
  if (drafts.length === 0) {
    return {
      state: { ...current, detail, touchedAt: now },
      items: [],
      usedSnapshot: false,
    };
  }
  const sequenced = sequenceItems(drafts, current.sequence);
  const replay = [...current.replay, ...sequenced.items].slice(-PROJECTED_THREAD_REPLAY_LIMIT);
  return {
    state: {
      detail,
      sequence: sequenced.sequence,
      replay,
      touchedAt: now,
    },
    items: sequenced.items,
    usedSnapshot: false,
  };
}

export function replayProjectedThreadAfter(
  state: ProjectedThreadStreamState,
  afterSequence: number,
): JsonRecord[] | null {
  if (afterSequence < 0 || afterSequence > state.sequence) return null;
  if (afterSequence === state.sequence) return [];
  const items = state.replay.filter(item => {
    const event = record(item.event);
    return numberValue(event?.sequence) !== null && numberValue(event?.sequence)! > afterSequence;
  });
  const first = record(items[0]?.event);
  if (numberValue(first?.sequence) !== afterSequence + 1) return null;
  return items;
}
