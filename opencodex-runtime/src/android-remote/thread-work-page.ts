import { createHash } from "node:crypto";

type Row = Record<string, unknown>;
export type WorkPage = {
  threadId: string; turnId: string; revision: string;
  messages: Row[]; activities: Row[]; proposedPlans: Row[];
  nextCursor: string | null;
};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const record = (value: unknown): Row => value && typeof value === "object" ? value as Row : {};
const workId = (turnId: string) => `deferred-work:${turnId}`;

function workForTurn(thread: Row, turnId: string) {
  const messages = rows(thread.messages).filter(row => row.turnId === turnId);
  const lastAssistant = messages.filter(row => row.role === "assistant").at(-1);
  const firstUser = messages.find(row => row.role === "user");
  const workMessages = messages.filter(row => row.role !== "user" && row !== lastAssistant);
  const activities = rows(thread.activities).filter(row => row.turnId === turnId
    && row.kind !== "context-window.updated" && row.kind !== "provider.usage.updated"
    && row.kind !== "work.deferred");
  const entries = [
    ...workMessages.map(row => ({ kind: "message" as const, row })),
    ...activities.map(row => ({ kind: "activity" as const, row })),
  ].sort((a, b) => Number(a.row.sequence ?? 0) - Number(b.row.sequence ?? 0)
    || String(a.row.createdAt).localeCompare(String(b.row.createdAt)));
  const revision = createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 24);
  return { entries, revision, lastAssistant, firstUser };
}

/** A collapsed completed turn sends a tiny disclosure instead of its entire work log. */
export function compactProjectedWork<T extends { messages: Row[]; activities: Row[] }>(page: T, activeTurnId: string | null): T {
  const turnIds = new Set(page.messages.flatMap(row => typeof row.turnId === "string" ? [row.turnId] : []));
  const hidden = new Set<string>();
  const placeholders: Row[] = [];
  for (const turnId of turnIds) {
    if (turnId === activeTurnId) continue;
    const work = workForTurn(page, turnId);
    const final = work.lastAssistant;
    // Do not collapse a pending question or a turn whose only answer is commentary.
    if (!final || final.streaming === true || (final.phase && final.phase !== "final_answer")
      || work.entries.some(entry => entry.row.kind === "user-input.requested") || !work.entries.length) continue;
    for (const entry of work.entries) hidden.add(`${entry.kind}:${entry.row.id}`);
    const first = work.entries[0]!.row;
    placeholders.push({
      id: workId(turnId), kind: "work.deferred", tone: "info", summary: "Load work details",
      turnId, sequence: first.sequence, createdAt: first.createdAt,
      payload: { revision: work.revision, cursor: null, remaining: work.entries.length },
    });
  }
  return { ...page,
    messages: page.messages.filter(row => !hidden.has(`message:${row.id}`)),
    activities: [...page.activities.filter(row => !hidden.has(`activity:${row.id}`)), ...placeholders],
  };
}

/** Cursor is tied to the exact turn contents; stale expansion can be retried safely. */
export function projectedTurnWorkPage(thread: Row, turnId: string, cursor?: string): WorkPage {
  const work = workForTurn(thread, turnId);
  let start = 0;
  if (cursor) {
    let token: Row;
    try { token = record(JSON.parse(Buffer.from(cursor, "base64url").toString())); }
    catch { throw new Error("Invalid work history cursor"); }
    if (token.threadId !== thread.id || token.turnId !== turnId || token.revision !== work.revision) {
      throw new Error("Work history changed. Close and reopen Work to reload it.");
    }
    start = Number(token.offset);
    if (!Number.isSafeInteger(start) || start < 0 || start > work.entries.length) throw new Error("Invalid work history offset");
  }
  let bytes = 0;
  let end = start;
  while (end < work.entries.length && end - start < 100) {
    const size = Buffer.byteLength(JSON.stringify(work.entries[end]));
    if (end > start && bytes + size > 512 * 1024) break;
    bytes += size;
    end += 1;
  }
  const selected = work.entries.slice(start, end);
  const nextCursor = end < work.entries.length
    ? Buffer.from(JSON.stringify({ threadId: thread.id, turnId, revision: work.revision, offset: end })).toString("base64url") : null;
  const last = selected.at(-1)?.row ?? work.lastAssistant ?? {};
  return {
    threadId: String(thread.id), turnId, revision: work.revision,
    messages: selected.filter(entry => entry.kind === "message").map(entry => entry.row),
    activities: [...selected.filter(entry => entry.kind === "activity").map(entry => entry.row), {
      id: workId(turnId), kind: "work.deferred", tone: "info", turnId,
      sequence: last.sequence, createdAt: last.createdAt,
      summary: nextCursor ? "Load more work" : "Work loaded",
      payload: { revision: work.revision, cursor: nextCursor, remaining: work.entries.length - end, loaded: true },
    }],
    proposedPlans: [], nextCursor,
  };
}
