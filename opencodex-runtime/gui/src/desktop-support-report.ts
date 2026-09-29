import type { DesktopDiagnosticsSnapshot } from "./desktop-runtime";

/** Filesystem-safe name; the .txt extension is a file format, not UI copy. */
export function desktopDiagnosticsFilename(snapshot: DesktopDiagnosticsSnapshot): string {
  return `remodex-report-${new Date(snapshot.generatedAtMs).toISOString().replace(/[:.]/g, "-")}.txt`;
}

function generatedAt(snapshot: DesktopDiagnosticsSnapshot): string {
  const date = new Date(snapshot.generatedAtMs);
  return Number.isNaN(date.getTime()) ? String(snapshot.generatedAtMs) : date.toISOString();
}

function endpointSummary(snapshot: DesktopDiagnosticsSnapshot): string {
  const endpoint = snapshot.runtime.endpoint;
  if (!endpoint) return "none";
  const pid = typeof endpoint.pid === "number" ? `, pid ${endpoint.pid}` : "";
  return `${endpoint.host}:${endpoint.port}${pid}, ready=${endpoint.ready ? "yes" : "no"}`;
}

export function buildDesktopDiagnosticsReport(snapshot: DesktopDiagnosticsSnapshot): string {
  const log = snapshot.log.trim()
    || (snapshot.logExists ? "[No readable desktop log entries]" : "[Desktop log has not been created yet]");
  return [
    "Remodex desktop diagnostics",
    `Report format: ${snapshot.reportVersion}`,
    `Generated: ${generatedAt(snapshot)}`,
    `App version: ${snapshot.appVersion}`,
    `Platform: ${snapshot.platform}/${snapshot.architecture}`,
    `Runtime state: ${snapshot.runtime.state}`,
    `Runtime endpoint: ${endpointSummary(snapshot)}`,
    `Log source: ${snapshot.logPath}`,
    `Source bytes: ${snapshot.sourceBytes}`,
    `Included bytes: ${snapshot.includedBytes}`,
    `Tail truncated: ${snapshot.truncated ? "yes" : "no"}`,
    "Privacy: credentials, tokens, cookies, prompts, request bodies, email addresses, and user-home paths are redacted.",
    "",
    "----- redacted desktop log -----",
    log,
    "",
  ].join("\n");
}
