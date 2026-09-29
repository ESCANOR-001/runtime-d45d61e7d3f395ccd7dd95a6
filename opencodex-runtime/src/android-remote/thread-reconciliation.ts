type JsonRecord = Record<string, unknown>;

export type CodexThreadListCandidate = {
  thread: JsonRecord;
  archived: boolean;
};

export type CanonicalCodexThread = {
  thread: JsonRecord;
  archived: boolean;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestamp(thread: JsonRecord, key: "createdAt" | "updatedAt" | "recencyAt"): number {
  return finiteNumber(thread[key]) ?? Number.NEGATIVE_INFINITY;
}

function candidateRecency(candidate: CodexThreadListCandidate): number {
  const recencyAt = finiteNumber(candidate.thread.recencyAt);
  if (recencyAt !== null) return recencyAt;
  const updatedAt = finiteNumber(candidate.thread.updatedAt);
  if (updatedAt !== null) return updatedAt;
  return timestamp(candidate.thread, "createdAt");
}

function compareCandidates(
  left: CodexThreadListCandidate,
  right: CodexThreadListCandidate,
): number {
  const recency = candidateRecency(left) - candidateRecency(right);
  if (recency !== 0) return recency;
  const updated = timestamp(left.thread, "updatedAt") - timestamp(right.thread, "updatedAt");
  if (updated !== 0) return updated;
  const created = timestamp(left.thread, "createdAt") - timestamp(right.thread, "createdAt");
  if (created !== 0) return created;
  return stringValue(left.thread.path).localeCompare(stringValue(right.thread.path));
}

function maximumTimestamp(
  candidates: readonly CodexThreadListCandidate[],
  key: "updatedAt" | "recencyAt",
): number | undefined {
  const values = candidates
    .map(candidate => finiteNumber(candidate.thread[key]))
    .filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : undefined;
}

function minimumCreatedAt(candidates: readonly CodexThreadListCandidate[]): number | undefined {
  const values = candidates
    .map(candidate => finiteNumber(candidate.thread.createdAt))
    .filter((value): value is number => value !== null);
  return values.length > 0 ? Math.min(...values) : undefined;
}

function sourcePaths(candidates: readonly CodexThreadListCandidate[]): string[] {
  const paths = new Set<string>();
  for (const candidate of [...candidates].sort(compareCandidates)) {
    const path = stringValue(candidate.thread.path);
    if (path) paths.add(path);
  }
  return [...paths];
}

/**
 * Codex can retain more than one physical rollout for one logical thread
 * (resume/revert/history repair). Android has one row per logical thread, so
 * reconcile those physical records before applying aliases or projecting UI.
 */
export function canonicalizeCodexThreadCandidates(
  candidates: readonly CodexThreadListCandidate[],
): CanonicalCodexThread[] {
  const grouped = new Map<string, CodexThreadListCandidate[]>();
  for (const candidate of candidates) {
    const id = stringValue(candidate.thread.id);
    if (!id) continue;
    const rows = grouped.get(id) ?? [];
    rows.push(candidate);
    grouped.set(id, rows);
  }

  const canonical: CanonicalCodexThread[] = [];
  for (const rows of grouped.values()) {
    const active = rows.filter(candidate => !candidate.archived);
    const selectable = active.length > 0 ? active : rows;
    const preferred = [...selectable].sort(compareCandidates).at(-1)!;
    const paths = sourcePaths(rows);
    const createdAt = minimumCreatedAt(rows);
    const updatedAt = maximumTimestamp(rows, "updatedAt");
    const recencyAt = maximumTimestamp(rows, "recencyAt");
    const preferredPath = stringValue(preferred.thread.path);
    canonical.push({
      archived: active.length === 0,
      thread: {
        ...preferred.thread,
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(updatedAt === undefined ? {} : { updatedAt }),
        ...(recencyAt === undefined ? {} : { recencyAt }),
        ...(paths.length > 0
          ? {
              path: preferredPath || paths.at(-1),
              androidRemoteSourcePaths: paths,
            }
          : {}),
      },
    });
  }

  return canonical.sort((left, right) => compareCandidates(right, left));
}

export function codexThreadSourcePaths(thread: JsonRecord): string[] {
  const paths = new Set<string>();
  if (Array.isArray(thread.androidRemoteSourcePaths)) {
    for (const value of thread.androidRemoteSourcePaths) {
      const path = stringValue(value);
      if (path) paths.add(path);
    }
  }
  const primary = stringValue(thread.path);
  if (primary) {
    paths.delete(primary);
    paths.add(primary);
  }
  return [...paths];
}
