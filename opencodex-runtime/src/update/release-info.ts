import { readBoundedResponseBody } from "../lib/bounded-body";
import { RELEASE_NOTES_REPOSITORY } from "./release-notes";
export type UpdateReleaseInfo = { urgency: "normal" | "urgent"; message: string };
const normal: UpdateReleaseInfo = { urgency: "normal", message: "" };
export function parseUpdateReleaseInfo(value: unknown, target: string, current: string): UpdateReleaseInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return normal;
  const info = value as Record<string, unknown>;
  if (info.version !== target || info.urgency !== "urgent" || typeof info.message !== "string"
    || info.message.length > 1_000 || !info.message.trim()
    || !Array.isArray(info.affectedVersions) || info.affectedVersions.length > 200
    || !info.affectedVersions.every(v => typeof v === "string" && v.length <= 64)) return normal;
  if (!info.affectedVersions.includes(current) && !info.affectedVersions.includes("*")) return normal;
  return { urgency: "urgent", message: info.message.replace(/[\u0000-\u001f\u007f]/g, " ").trim() };
}
/** Optional display-only asset. It cannot change the registry target or force installation. */
export async function fetchUpdateReleaseInfo(target: string, current: string, fetchFn: typeof fetch = fetch): Promise<UpdateReleaseInfo> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(target) || target.length > 64) return normal;
  try {
    const response = await fetchFn(`https://github.com/${RELEASE_NOTES_REPOSITORY}/releases/download/v${encodeURIComponent(target)}/remodex-update.json`, {
      signal: AbortSignal.timeout(6_000), headers: { Accept: "application/json" },
    });
    if (!response.ok) return normal;
    const body = await readBoundedResponseBody(response, { maxBytes: 20 * 1024, totalTimeoutMs: 5_000, inactivityTimeoutMs: 3_000 });
    if (!body.displaySafe || body.oversized || body.timedOut) return normal;
    return parseUpdateReleaseInfo(JSON.parse(body.text), target, current);
  } catch { return normal; }
}
