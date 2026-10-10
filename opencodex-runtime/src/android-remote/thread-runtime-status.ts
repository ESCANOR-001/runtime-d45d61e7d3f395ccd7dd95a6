type JsonRecord = Record<string, unknown>;

export type CodexRuntimeStatus = {
  type: "active" | "idle" | "notLoaded" | "systemError";
  waitingOnApproval: boolean;
  waitingOnUserInput: boolean;
};

/** Only the public structured runtime status, not private mounted-view labels. */
export function codexRuntimeStatus(value: unknown): CodexRuntimeStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value as JsonRecord;
  if (status.type !== "active" && status.type !== "idle"
    && status.type !== "notLoaded" && status.type !== "systemError") return null;
  const flags = status.type === "active" && Array.isArray(status.activeFlags)
    ? status.activeFlags : [];
  return {
    type: status.type,
    waitingOnApproval: flags.includes("waitingOnApproval"),
    waitingOnUserInput: flags.includes("waitingOnUserInput"),
  };
}

/** Apply an event only after the caller has checked which runtime owns the task. */
export function projectRuntimeStatus(
  thread: JsonRecord, threadId: string, value: unknown, observedAt: string,
): JsonRecord | null {
  const status = codexRuntimeStatus(value);
  if (!status) return null;
  const session = (thread.session ?? {}) as JsonRecord;
  const turn = (thread.latestTurn ?? {}) as JsonRecord;
  const active = status.type === "active";
  const wasRunning = session.status === "running" || session.status === "starting"
    || Boolean(session.activeTurnId) || turn.state === "running";
  // idle says execution ended, but not whether it completed, failed or was
  // interrupted. Keep uncertainty until the matching turn outcome is read.
  const uncertain = !active && wasRunning;
  const turnId = session.activeTurnId ?? (turn.state === "running" ? turn.turnId : null);
  return {
    ...thread,
    updatedAt: observedAt,
    hasPendingApprovals: status.waitingOnApproval,
    hasPendingUserInput: status.waitingOnUserInput,
    latestTurn: active || uncertain
      ? turn.state === "running" ? thread.latestTurn : null
      : thread.latestTurn ?? null,
    session: {
      ...session,
      threadId,
      providerName: "codex",
      providerInstanceId: session.providerInstanceId ?? "openai",
      runtimeMode: session.runtimeMode ?? "full-access",
      status: active ? "running" : uncertain || status.type === "systemError" ? "error" : "idle",
      statusConfidence: uncertain ? "unknown" : "confirmed",
      activeTurnId: active || uncertain ? turnId ?? null : null,
      lastError: active ? null : uncertain
        ? "Task status is unavailable. Reconnecting to the owning runtime."
        : status.type === "systemError" ? "The Codex runtime reported an error." : null,
      updatedAt: observedAt,
    },
  };
}
