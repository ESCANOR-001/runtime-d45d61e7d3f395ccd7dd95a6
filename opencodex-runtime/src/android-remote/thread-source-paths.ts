import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getCodexHome } from "../codex/paths";

type JsonRecord = Record<string, unknown>;

const DISCOVERY_TTL_MS = 30_000;
const MAX_PATHS_PER_THREAD = 16;
const MAX_DISCOVERY_METADATA_BYTES = 128 * 1024;

type SourceCandidate = {
  path: string;
  chronologyMs: number;
  statMtimeMs: number;
};

type CachedDiscovery = {
  expiresAt: number;
  paths: string[];
};

const discoveryCache = new Map<string, CachedDiscovery>();

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown, maximum = 512): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function finiteTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Codex metadata has appeared in both seconds and milliseconds.
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function rawJsonString(
  text: string,
  key: string,
  start = 0,
  end = text.length,
): string {
  const bounded = text.slice(Math.max(0, start), Math.max(start, end));
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\]){0,4096})"`,
    "u",
  ).exec(bounded);
  const body = match?.[1];
  if (body === undefined) return "";
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    // The bounded prefix can end in the middle of an escape sequence. A
    // partially decoded value is not safe evidence for thread ownership.
    return "";
  }
}

/**
 * `session_meta` contains the Desktop system instructions and can exceed the
 * bounded metadata read by several orders of magnitude. We still only inspect
 * the prefix: the session type and payload identity are written before the
 * large instruction field, so no transcript content is needed to establish
 * ownership or chronology.
 */
function readTruncatedSessionMetadata(
  text: string,
  threadId: string,
): { chronologyMs: number | null; ownsThread: boolean } | null {
  const marker = /"type"\s*:\s*"session_meta"/u.exec(text);
  if (!marker || marker.index === undefined) return null;
  const payloadMarker = /"payload"\s*:\s*\{/u.exec(text.slice(marker.index));
  const payloadStart = payloadMarker
    ? marker.index + payloadMarker.index
    : marker.index;
  const payloadEnd = Math.min(text.length, payloadStart + MAX_DISCOVERY_METADATA_BYTES);
  const ids = [
    rawJsonString(text, "session_id", payloadStart, payloadEnd),
    rawJsonString(text, "sessionId", payloadStart, payloadEnd),
    rawJsonString(text, "id", payloadStart, payloadEnd),
  ].filter(Boolean);
  if (ids.length === 0) return null;
  const chronologyMs =
    finiteTimestamp(rawJsonString(text, "timestamp", payloadStart, payloadEnd))
    ?? finiteTimestamp(rawJsonString(text, "timestamp", 0, marker.index));
  return {
    chronologyMs,
    ownsThread: ids.includes(threadId),
  };
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function cacheKey(home: string, threadId: string): string {
  return `${home}\u0000${threadId}`;
}

function evictCache(nowMs: number): void {
  for (const [key, entry] of discoveryCache) {
    if (entry.expiresAt <= nowMs) discoveryCache.delete(key);
  }
  // A bounded cache is important because thread ids are user-controlled
  // inputs at the Android gateway boundary.
  while (discoveryCache.size > 128) {
    const oldest = discoveryCache.keys().next().value;
    if (typeof oldest !== "string") break;
    discoveryCache.delete(oldest);
  }
}

async function readSessionMetadata(
  path: string,
  threadId: string,
): Promise<{ chronologyMs: number | null; ownsThread: boolean }> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_DISCOVERY_METADATA_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    let fallbackTimestamp: number | null = null;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: JsonRecord | null;
      try {
        row = record(JSON.parse(line));
      } catch {
        continue;
      }
      if (!row) continue;
      fallbackTimestamp ??= finiteTimestamp(row.timestamp);
      if (row.type !== "session_meta") continue;
      const payload = record(row.payload);
      const ids = [
        payload?.session_id,
        payload?.sessionId,
        payload?.id,
        row.session_id,
        row.sessionId,
        row.id,
      ]
        .map(value => stringValue(value, 128))
        .filter(Boolean);
      const ownsThread = ids.includes(threadId);
      const chronologyMs =
        finiteTimestamp(payload?.timestamp)
        ?? finiteTimestamp(row.timestamp)
        ?? fallbackTimestamp;
      return { chronologyMs, ownsThread };
    }
    const truncated = readTruncatedSessionMetadata(text, threadId);
    if (truncated) return truncated;
    return { chronologyMs: fallbackTimestamp, ownsThread: false };
  } finally {
    await file.close();
  }
}

async function inspectCandidate(
  candidatePath: string,
  threadId: string,
  sessionsRoot: string,
  archivedRoot: string,
): Promise<SourceCandidate | null> {
  try {
    const canonicalPath = await realpath(resolve(candidatePath));
    if (
      !canonicalPath.toLowerCase().endsWith(".jsonl")
      || (!inside(sessionsRoot, canonicalPath) && !inside(archivedRoot, canonicalPath))
    ) {
      return null;
    }
    const details = await stat(canonicalPath);
    if (!details.isFile()) return null;
    const metadata = await readSessionMetadata(canonicalPath, threadId);
    // A filename match is only a discovery hint. Require a bounded metadata
    // read to confirm that the rollout belongs to this logical thread.
    if (!metadata.ownsThread) return null;
    return {
      path: canonicalPath,
      chronologyMs: metadata.chronologyMs ?? details.mtimeMs,
      statMtimeMs: details.mtimeMs,
    };
  } catch {
    return null;
  }
}

function compareCandidates(left: SourceCandidate, right: SourceCandidate): number {
  return left.chronologyMs - right.chronologyMs
    || left.statMtimeMs - right.statMtimeMs
    || left.path.localeCompare(right.path);
}

/**
 * Resolve every verified physical rollout for one logical Codex thread.
 *
 * Returned paths are canonical and ordered oldest → newest. Discovery is
 * bounded to the two Codex rollout roots, performs only a small metadata read
 * per candidate, and is cached briefly so shell refreshes do not repeatedly
 * walk a large history directory.
 */
export async function resolveThreadSourcePaths(
  threadId: string,
  explicitPaths: readonly string[] = [],
  options: {
    readonly codexHome?: string;
    readonly now?: () => number;
    readonly maxPaths?: number;
    /**
     * Search the bounded Codex rollout roots for sibling continuations. Callers
     * that already have an explicit, authoritative path list can disable this
     * scan to avoid walking a large history directory on every shell refresh.
     */
    readonly discover?: boolean;
  } = {},
): Promise<string[]> {
  const normalizedThreadId = threadId.trim().slice(0, 128);
  if (!normalizedThreadId) return [];
  const now = options.now?.() ?? Date.now();
  const maximum = Math.max(1, Math.min(MAX_PATHS_PER_THREAD * 32, Math.floor(options.maxPaths ?? MAX_PATHS_PER_THREAD)));
  let home: string;
  try {
    home = await realpath(resolve(options.codexHome ?? getCodexHome()));
  } catch {
    return [];
  }
  const sessionsRoot = resolve(home, "sessions");
  const archivedRoot = resolve(home, "archived_sessions");
  const key = cacheKey(home, normalizedThreadId);
  evictCache(now);

  const candidates = new Set<string>();
  for (const path of explicitPaths) {
    const trimmed = path.trim();
    if (trimmed) candidates.add(trimmed);
  }

  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) {
    for (const path of cached.paths) candidates.add(path);
  } else if (options.discover !== false) {
    const discovered: string[] = [];
    // The filename is only a bounded discovery hint. Every result is still
    // verified against session_meta below, so a forged/misnamed file cannot
    // become a source.
    const discoveryGlob = `**/*${normalizedThreadId}*.jsonl`;
    for (const root of [sessionsRoot, archivedRoot]) {
      try {
        for await (const path of new Bun.Glob(discoveryGlob).scan({
          cwd: root,
          absolute: true,
          onlyFiles: true,
        })) {
          // Keep the scan itself bounded. Metadata verification below is the
          // authority, not the filename.
          discovered.push(path);
          if (discovered.length >= MAX_PATHS_PER_THREAD * 32) break;
        }
      } catch {
        // The archive root may not exist, or a concurrent move may invalidate
        // the directory. Explicit paths can still be verified below.
      }
      if (discovered.length >= MAX_PATHS_PER_THREAD * 32) break;
    }
    for (const path of discovered) candidates.add(path);
  }

  const inspected = await Promise.all(
    [...candidates].slice(0, MAX_PATHS_PER_THREAD * 64).map(path =>
      inspectCandidate(path, normalizedThreadId, sessionsRoot, archivedRoot)),
  );
  const ordered = inspected
    .flatMap(value => value ? [value] : [])
    .sort(compareCandidates)
    .filter((candidate, index, values) =>
      index === values.findIndex(other => other.path === candidate.path))
    .map(candidate => candidate.path);

  if (options.discover !== false) {
    discoveryCache.set(key, {
      expiresAt: now + DISCOVERY_TTL_MS,
      paths: ordered.slice(-MAX_PATHS_PER_THREAD * 32),
    });
  }
  return ordered.slice(-maximum);
}

export function clearThreadSourcePathDiscoveryCache(): void {
  discoveryCache.clear();
}

export const THREAD_SOURCE_PATH_LIMIT = MAX_PATHS_PER_THREAD;
export const THREAD_SOURCE_PATH_DISCOVERY_TTL_MS = DISCOVERY_TTL_MS;
