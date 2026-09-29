import type { AndroidCodexClient } from "./codex-app-server";

type JsonRecord = Record<string, unknown>;
const CURSOR_PREFIX = "native-turns:";
export const NATIVE_HISTORY_TURN_LIMIT = 1;

export function nativeHistoryCursor(threadId: string, cursor: string | null): string | null {
  return cursor ? CURSOR_PREFIX + Buffer.from(JSON.stringify({ threadId, cursor })).toString("base64url") : null;
}

export function decodeNativeHistoryCursor(threadId: string, value: string): string | null {
  if (!value.startsWith(CURSOR_PREFIX)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), "base64url").toString());
    if (decoded.threadId === threadId && typeof decoded.cursor === "string" && decoded.cursor) {
      return decoded.cursor;
    }
  } catch { /* Use the same public error for malformed and mismatched cursors. */ }
  throw new Error("The older-message cursor is invalid for this task");
}

export class NativeHistoryUnsupportedError extends Error {}

/** Windows Codex can reject a continuation's history while its own session files remain valid. */
export function windowsNativeHistoryNeedsSessionRecovery(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const value = error as { message?: unknown } | null;
  return typeof value?.message === "string"
    && /invalid paginated history lineage\b[\s\S]*source rollout belongs to another thread\b/iu.test(value.message);
}

export function nativeHistoryIsUnsupported(error: unknown): boolean {
  if (error instanceof NativeHistoryUnsupportedError) return true;
  const value = error as { code?: unknown; message?: unknown } | null;
  return value?.code === -32601
    || typeof value?.message === "string" && /method not found|unknown (?:method|variant).*thread\/turns\/list|unsupported method/iu.test(value.message);
}

/** Read complete items for a bounded page; Codex's default summary view omits all tools. */
export async function readNativeTurnsPage(
  client: AndroidCodexClient,
  threadId: string,
  cursor?: string,
): Promise<{ turns: JsonRecord[]; nextCursor: string | null }> {
  const result = await client.request<{ data?: unknown; nextCursor?: unknown }>("thread/turns/list", {
    threadId,
    limit: NATIVE_HISTORY_TURN_LIMIT,
    sortDirection: "desc",
    itemsView: "full",
    ...(cursor ? { cursor } : {}),
  });
  if (!Array.isArray(result?.data)) throw new NativeHistoryUnsupportedError("Codex does not support paged turn history");
  if (result.data.some(value => !value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("Codex returned an invalid history page");
  }
  const turns = result.data as JsonRecord[];
  if (turns.some(turn => turn.itemsView === "summary" || turn.itemsView === "notLoaded")) {
    throw new NativeHistoryUnsupportedError("Codex did not return complete history items");
  }
  return {
    turns: [...turns].reverse(),
    nextCursor: typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null,
  };
}
