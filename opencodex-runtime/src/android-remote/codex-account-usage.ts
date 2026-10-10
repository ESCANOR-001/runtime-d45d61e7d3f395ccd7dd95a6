type Row = Record<string, unknown>;
const record = (value: unknown): Row | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function windowLabel(minutes: number | null, fallback: string): string {
  if (minutes === 300) return "5-hour";
  if (minutes === 1_440) return "Daily";
  if (minutes === 10_080) return "Weekly";
  if (minutes === null || minutes === 0) return fallback;
  return minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
}

/** Allowlist only quota percentages/timing; never forward raw account metadata. */
export function codexAccountQuotaReport(value: unknown, now: number): Row | null {
  const response = record(value);
  if (!response) return null;
  const byId = record(response.rateLimitsByLimitId);
  const buckets = byId && Object.keys(byId).length > 0
    ? Object.entries(byId).slice(0, 12)
    : [["codex", response.rateLimits]] as [string, unknown][];
  const customWindows: Row[] = [];
  for (const [id, value] of buckets) {
    const bucket = record(value);
    if (!bucket) continue;
    const name = typeof bucket.limitName === "string" ? bucket.limitName : id;
    const prefix = buckets.length > 1 ? `${name.replace(/\s+/gu, " ").trim().slice(0, 40)} · ` : "";
    for (const key of ["primary", "secondary"] as const) {
      const window = record(bucket[key]);
      const percent = finite(window?.usedPercent);
      if (!window || percent === null || customWindows.length >= 12) continue;
      const resetsAt = finite(window.resetsAt);
      customWindows.push({
        label: prefix + windowLabel(finite(window.windowDurationMins), key === "primary" ? "Limit" : "Secondary limit"),
        percent: Math.min(100, percent),
        ...(resetsAt !== null && resetsAt > 0 ? { resetAt: resetsAt } : {}),
      });
    }
  }
  if (customWindows.length === 0) return null;
  return { provider: "openai", label: "ChatGPT account", updatedAt: now, quota: { customWindows } };
}
