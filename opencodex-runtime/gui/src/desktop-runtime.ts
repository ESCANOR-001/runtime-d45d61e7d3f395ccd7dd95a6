export type DesktopRuntimeState = "offline" | "starting" | "stopping" | "ready" | "degraded";

export interface DesktopRuntimeStatus {
  state: DesktopRuntimeState;
  endpoint?: {
    port: number;
    host: string;
    pid?: number;
    ready: boolean;
  } | null;
}

export interface DesktopDiagnosticsSnapshot {
  reportVersion: 1;
  generatedAtMs: number;
  appVersion: string;
  platform: string;
  architecture: string;
  runtime: DesktopRuntimeStatus;
  logPath: string;
  logExists: boolean;
  sourceBytes: number;
  includedBytes: number;
  truncated: boolean;
  log: string;
}

export interface DesktopFrontendError {
  kind: string;
  message: string;
  stack?: string;
  source?: string;
  componentStack?: string;
  page?: string;
}

interface TauriInternals {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

function tauriInternals(): TauriInternals | null {
  const candidate = (globalThis as typeof globalThis & {
    __TAURI_INTERNALS__?: Partial<TauriInternals>;
  }).__TAURI_INTERNALS__;
  return typeof candidate?.invoke === "function" ? candidate as TauriInternals : null;
}

export function desktopRuntimeBridgeAvailable(): boolean {
  return tauriInternals() !== null;
}

function isRuntimeStatus(value: unknown): value is DesktopRuntimeStatus {
  if (!value || typeof value !== "object" || !("state" in value)) return false;
  const state = (value as { state?: unknown }).state;
  return state === "offline"
    || state === "starting"
    || state === "stopping"
    || state === "ready"
    || state === "degraded";
}

function isDesktopDiagnosticsSnapshot(value: unknown): value is DesktopDiagnosticsSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DesktopDiagnosticsSnapshot>;
  return candidate.reportVersion === 1
    && Number.isFinite(candidate.generatedAtMs)
    && typeof candidate.appVersion === "string"
    && typeof candidate.platform === "string"
    && typeof candidate.architecture === "string"
    && isRuntimeStatus(candidate.runtime)
    && typeof candidate.logPath === "string"
    && typeof candidate.logExists === "boolean"
    && Number.isFinite(candidate.sourceBytes)
    && Number.isFinite(candidate.includedBytes)
    && typeof candidate.truncated === "boolean"
    && typeof candidate.log === "string";
}

/** Returns null in an ordinary browser or when the desktop bridge is unavailable. */
export async function readDesktopRuntimeStatus(): Promise<DesktopRuntimeStatus | null> {
  const internals = tauriInternals();
  if (!internals) return null;
  try {
    const status = await internals.invoke<unknown>("runtime_status");
    return isRuntimeStatus(status) ? status : null;
  } catch {
    return null;
  }
}

export async function setDesktopProxyRunning(running: boolean): Promise<DesktopRuntimeStatus> {
  const internals = tauriInternals();
  if (!internals) throw new Error("Desktop lifecycle bridge is unavailable.");
  const status = await internals.invoke<unknown>("set_proxy_running", { running });
  if (!isRuntimeStatus(status)) throw new Error("Desktop lifecycle returned an invalid status.");
  return status;
}

/** Reads a bounded, redacted snapshot from the native shell or npm runtime. */
export async function readDesktopDiagnostics(): Promise<DesktopDiagnosticsSnapshot | null> {
  const internals = tauriInternals();
  if (!internals) {
    // The npm/localhost dashboard has no Tauri bridge. Its owning runtime
    // exposes the same bounded report through the authenticated management API.
    const response = await fetch("/api/diagnostics/desktop-log", {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Desktop diagnostics request failed (${response.status}).`);
    const snapshot = await response.json() as unknown;
    if (!isDesktopDiagnosticsSnapshot(snapshot)) {
      throw new Error("Desktop diagnostics returned an invalid response.");
    }
    return snapshot;
  }
  const snapshot = await internals.invoke<unknown>("read_desktop_diagnostics");
  if (!isDesktopDiagnosticsSnapshot(snapshot)) {
    throw new Error("Desktop diagnostics returned an invalid response.");
  }
  return snapshot;
}

/** Opens a fixed Gmail draft addressed to Remodex support with the redacted report. */
export async function openDesktopSupportEmail(report: string): Promise<void> {
  const internals = tauriInternals();
  if (!internals) throw new Error("Desktop support email bridge is unavailable.");
  await internals.invoke<void>("open_support_email", { report });
}

/**
 * Best-effort frontend error recording. This deliberately absorbs bridge failures:
 * reporting an error must never create another unhandled error.
 */
export async function recordDesktopFrontendError(event: DesktopFrontendError): Promise<boolean> {
  const internals = tauriInternals();
  if (!internals) return false;
  try {
    await internals.invoke<void>("record_desktop_frontend_error", { event });
    return true;
  } catch {
    return false;
  }
}
