/**
 * Small, owner-local signal used by the Windows service supervisor.
 *
 * Task Scheduler and WinSW can start a service again after its child exits.  A
 * normal process exit does not tell either supervisor whether the user asked us
 * to stop or whether Bun crashed.  This marker supplies that missing bit of
 * information without putting a command, token, or PID in a service command
 * line.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config";

export const SERVICE_STOP_MARKER_FILENAME = "service-stop-requested";

export function serviceStopMarkerPath(configDir = getConfigDir()): string {
  return join(configDir, SERVICE_STOP_MARKER_FILENAME);
}

/** Record an intentional Windows service stop before terminating its child. */
export function requestServiceStop(configDir = getConfigDir()): void {
  if (process.platform !== "win32") return;
  const path = serviceStopMarkerPath(configDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The contents are deliberately non-sensitive.  The file's existence is the
  // signal; a timestamp makes a damaged/empty file easy to inspect by hand.
  writeFileSync(path, `${Date.now()}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Remove the stop signal so an explicit service start may run normally. */
export function clearServiceStopRequest(configDir = getConfigDir()): void {
  if (process.platform !== "win32") return;
  try {
    unlinkSync(serviceStopMarkerPath(configDir));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code !== "ENOENT") throw error;
  }
}

export function isServiceStopRequested(configDir = getConfigDir()): boolean {
  if (process.platform !== "win32") return false;
  return existsSync(serviceStopMarkerPath(configDir));
}
