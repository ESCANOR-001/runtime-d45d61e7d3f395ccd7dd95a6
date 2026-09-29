import { readBoundedResponseBody } from "../lib/bounded-body";

/** Public repository that carries the release notes for the npm package. */
export const RELEASE_NOTES_REPOSITORY = "ESCANOR-001/remodex-android";
const RELEASE_NOTES_API_URL = `https://api.github.com/repos/${RELEASE_NOTES_REPOSITORY}/releases/tags`;
export const RELEASE_NOTES_MAX_BYTES = 32 * 1024;
const RELEASE_RESPONSE_MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 6_000;
const BODY_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 10 * 60_000;

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface CacheEntry {
  body: string;
  expiresAt: number;
}

const notesCache = new Map<string, CacheEntry>();

function isReleaseVersion(value: string): boolean {
  return value.length <= 64 && VERSION_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeReleaseNotes(value: string): string {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    // Keep markdown and whitespace, but never let terminal/control bytes reach the GUI.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (Buffer.byteLength(normalized, "utf8") <= RELEASE_NOTES_MAX_BYTES) return normalized;

  // The response reader already enforces a byte ceiling. This second guard accounts for the
  // JSON envelope and makes the field safe even when this function is called directly in tests.
  const clipped = Buffer.from(normalized, "utf8")
    .subarray(0, RELEASE_NOTES_MAX_BYTES)
    .toString("utf8")
    .replace(/\uFFFD$/u, "")
    .trimEnd();
  return `${clipped}\n…`;
}

/** Clear the in-memory release-note cache. Intended for focused tests and development reloads. */
export function clearReleaseNotesCacheForTests(): void {
  notesCache.clear();
}

/**
 * Fetch the exact GitHub Release body for a version.
 *
 * Release notes are display-only metadata. A registry/API failure therefore returns `null` and
 * leaves the npm version check usable. The response is bounded, rendered as text by React, and
 * accepted only when GitHub confirms the requested tag.
 */
export async function fetchReleaseNotesForVersion(
  version: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  if (!isReleaseVersion(version)) return null;

  const now = Date.now();
  const cached = notesCache.get(version);
  if (cached && cached.expiresAt > now) return cached.body;
  if (cached) notesCache.delete(version);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(`${RELEASE_NOTES_API_URL}/v${encodeURIComponent(version)}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Remodex-update-check",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const bounded = await readBoundedResponseBody(response, {
      // The JSON envelope and escaping can be larger than the final note body.
      maxBytes: RELEASE_RESPONSE_MAX_BYTES,
      totalTimeoutMs: BODY_TIMEOUT_MS,
      inactivityTimeoutMs: BODY_TIMEOUT_MS,
    });
    if (!bounded.displaySafe || bounded.oversized || bounded.timedOut) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(bounded.text);
    } catch {
      return null;
    }
    if (!isRecord(parsed) || parsed.tag_name !== `v${version}` || typeof parsed.body !== "string") {
      return null;
    }

    const body = normalizeReleaseNotes(parsed.body);
    if (!body) return null;
    notesCache.set(version, { body, expiresAt: Date.now() + CACHE_TTL_MS });
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
