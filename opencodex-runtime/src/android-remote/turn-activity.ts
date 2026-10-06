type JsonRecord = Record<string, unknown>;

export type CanonicalTurnActivitySnapshot = {
  active: boolean;
  activeTurnId: string;
  activeWithoutId: boolean;
  latestTurnId: string;
  hasTurns: boolean;
};

export type ProjectedTurnLifecycleMarker = {
  state: unknown;
  turnId?: unknown;
  occurredAt?: unknown;
  lastProgressAt?: unknown;
  unverified?: boolean;
};

export const ANDROID_REMOTE_TURN_ERROR_LIMIT = 4096;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown, maximum = 128): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

/**
 * Keep provider/runtime failures useful on the phone without projecting an
 * unbounded or structured upstream error object into shell and turn state.
 */
export function boundedTurnErrorMessage(value: unknown): string {
  const error = record(value);
  return stringValue(
    typeof value === "string" ? value : error?.message,
    ANDROID_REMOTE_TURN_ERROR_LIMIT,
  );
}

export function normalizedCanonicalTurnStatus(value: unknown): string {
  return stringValue(value, 64).replace(/[^a-z0-9]/giu, "").toLowerCase();
}

export function canonicalTurnStatusIsActive(value: unknown): boolean {
  const status = normalizedCanonicalTurnStatus(value);
  return status.includes("inprogress")
    || status.includes("running")
    || status.includes("pending")
    || status.includes("started")
    || status.includes("starting")
    || status === "active";
}

export function canonicalTurnStatusIsTerminal(value: unknown): boolean {
  const status = normalizedCanonicalTurnStatus(value);
  return status === "idle"
    || status === "notloaded"
    || status === "inactive"
    || status.includes("complete")
    || status.includes("failed")
    || status.includes("error")
    || status.includes("interrupt")
    || status.includes("cancel")
    || status.includes("stopped")
    || status.includes("aborted")
    || status === "ready"
    || status === "done";
}

export function canonicalTurnId(value: unknown): string {
  const turn = record(value);
  if (!turn) return "";
  const turnId = stringValue(turn.id ?? turn.turnId ?? turn.turn_id);
  return turnId && !turnId.startsWith("opencodex-pending-") ? turnId : "";
}

export function canonicalTurnIsHistoryCompactionMarker(value: unknown): boolean {
  const turn = record(value);
  if (!turn) return false;
  const turnId = canonicalTurnId(turn);
  return turn.remodexHistoryCompacted === true
    || turn.remodex_history_compacted === true
    || turnId.startsWith("remodex-history-compacted-");
}

export function canonicalTurnsNewestFirst(
  value: unknown,
  newestFirst = false,
): JsonRecord[] {
  const turns = (Array.isArray(value) ? value : []).flatMap(candidate => {
    const turn = record(candidate);
    return turn && !canonicalTurnIsHistoryCompactionMarker(turn) ? [turn] : [];
  });
  return newestFirst ? turns : turns.reverse();
}

function lifecycleTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalTurnLifecycleTimestampMs(turn: JsonRecord): number | null {
  const status = turn.status ?? turn.state ?? turn.turnStatus ?? turn.turn_status;
  const candidates = canonicalTurnStatusIsTerminal(status)
    ? [
        turn.completedAt,
        turn.completed_at,
        turn.endedAt,
        turn.ended_at,
        turn.finishedAt,
        turn.finished_at,
        turn.updatedAt,
        turn.updated_at,
        turn.startedAt,
        turn.started_at,
        turn.createdAt,
        turn.created_at,
      ]
    : [
        turn.startedAt,
        turn.started_at,
        turn.createdAt,
        turn.created_at,
        turn.updatedAt,
        turn.updated_at,
      ];
  for (const candidate of candidates) {
    const timestamp = lifecycleTimestampMs(candidate);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

/**
 * Decide whether a Desktop/session-file lifecycle marker is newer than the
 * bounded canonical turn history.
 *
 * A dated terminal state closes the same turn. An undated interrupted read
 * can be stale after connection recovery; newer saved work can supersede it.
 * A marker for an older canonical row cannot supersede the
 * latest row. Different-turn conflicts use lifecycle timestamps; when neither
 * side can prove ordering, the active side wins so Android cannot start a
 * competing writer.
 */
export function projectedTurnLifecycleWins(
  value: unknown,
  marker: ProjectedTurnLifecycleMarker,
  newestFirst = false,
): boolean {
  const markerActive = canonicalTurnStatusIsActive(marker.state);
  const markerTerminal = canonicalTurnStatusIsTerminal(marker.state);
  if (!markerActive && !markerTerminal) return false;

  const turns = canonicalTurnsNewestFirst(value, newestFirst);
  const latestTurn = turns[0];
  if (!latestTurn) return true;

  const latestStatus = latestTurn.status
    ?? latestTurn.state
    ?? latestTurn.turnStatus
    ?? latestTurn.turn_status;
  const canonicalTerminal = canonicalTurnStatusIsTerminal(latestStatus);
  const canonicalActive = canonicalTurnStatusIsActive(latestStatus) || !canonicalTerminal;
  const markerTurnId = stringValue(marker.turnId);
  const latestTurnId = canonicalTurnId(latestTurn);

  if (markerTurnId) {
    const canonicalIndex = turns.findIndex(turn => canonicalTurnId(turn) === markerTurnId);
    if (canonicalIndex > 0) return false;
    if (canonicalIndex === 0 || (latestTurnId && markerTurnId === latestTurnId)) {
      const progressAt = lifecycleTimestampMs(marker.lastProgressAt);
      const canonicalAt = canonicalTurnLifecycleTimestampMs(latestTurn);
      const hasTerminalTime = [latestTurn.completedAt, latestTurn.completed_at,
        latestTurn.endedAt, latestTurn.ended_at, latestTurn.finishedAt, latestTurn.finished_at]
        .some(value => lifecycleTimestampMs(value) !== null);
      if (markerActive && normalizedCanonicalTurnStatus(latestStatus).includes("interrupt")
        && !hasTerminalTime && marker.unverified === true) return true;
      if (markerActive && normalizedCanonicalTurnStatus(latestStatus).includes("interrupt")
        && !hasTerminalTime && progressAt !== null && canonicalAt !== null
        && progressAt > canonicalAt) return true;
      if (markerActive !== canonicalActive) return markerTerminal;
      return true;
    }
  }

  const markerAt = lifecycleTimestampMs(marker.occurredAt);
  const canonicalAt = canonicalTurnLifecycleTimestampMs(latestTurn);
  if (markerAt !== null && canonicalAt !== null && markerAt !== canonicalAt) {
    return markerAt > canonicalAt;
  }
  if (markerAt !== null && canonicalAt === null) return true;
  if (markerAt === null && canonicalAt !== null) return false;

  if (markerActive !== canonicalActive) return markerActive;
  return true;
}

/**
 * Resolve activity from a bounded canonical turn list.
 *
 * A terminal newest turn is a sequential-history boundary: an older running
 * or status-less row must not revive the task. A status-less newest row stays
 * conservatively active until the runtime publishes its terminal state.
 */
export function canonicalTurnActivitySnapshot(
  value: unknown,
  newestFirst = false,
): CanonicalTurnActivitySnapshot {
  const turns = canonicalTurnsNewestFirst(value, newestFirst);
  let latestTurnId = "";
  let encounteredTerminalBoundary = false;

  for (const turn of turns) {
    const turnId = canonicalTurnId(turn);
    if (!latestTurnId && turnId) latestTurnId = turnId;
    const status = turn.status ?? turn.state ?? turn.turnStatus ?? turn.turn_status;
    if (canonicalTurnStatusIsTerminal(status)) {
      encounteredTerminalBoundary = true;
      continue;
    }
    if (encounteredTerminalBoundary) continue;

    // Known active statuses and unknown/missing statuses are both potentially
    // interruptible. Only a recognized terminal status closes the boundary.
    return {
      active: true,
      activeTurnId: turnId,
      activeWithoutId: !turnId,
      latestTurnId,
      hasTurns: true,
    };
  }

  return {
    active: false,
    activeTurnId: "",
    activeWithoutId: false,
    latestTurnId,
    hasTurns: turns.length > 0,
  };
}
