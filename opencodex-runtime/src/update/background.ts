/** Lightweight checks; package replacement remains owned by the OS updater job. */
import { checkRemoteUpdate, type RemoteUpdateCheck } from "./remote-check";
import { currentVersion, defaultUpdateTag, detectInstall } from "./index";
import { readAutoUpdateState, requestAutomaticUpdate } from "./auto-scheduler";

export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;
export const UPDATE_RETRY_INTERVAL_MS = 2 * 60_000;
export type UpdateActivity = { known: boolean; running: number };
export type BackgroundUpdateStatus = {
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  status: "checking" | "current" | "available" | "waiting_for_idle" | "starting" | "check_failed" | "setup_failed" | "update_failed";
};
let status: BackgroundUpdateStatus = { lastCheckedAt: null, nextCheckAt: null, status: "checking" };
let stopCurrent: (() => void) | undefined;
let refreshCurrent: (() => void) | undefined;
export function backgroundUpdateStatus(): BackgroundUpdateStatus { return { ...status }; }
export function stopBackgroundUpdates(): void { stopCurrent?.(); stopCurrent = undefined; refreshCurrent = undefined; }
export function requestBackgroundUpdateCheck(): void { refreshCurrent?.(); }

export function startBackgroundUpdates(activity: () => UpdateActivity | Promise<UpdateActivity>, deps: {
  check?: () => Promise<RemoteUpdateCheck>;
  enabled?: () => boolean;
  start?: () => void | Promise<void>;
  blockedTarget?: () => string | null;
  random?: () => number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
} = {}): () => void {
  stopBackgroundUpdates();
  status = { lastCheckedAt: null, nextCheckAt: null, status: "checking" };
  // A source checkout must never schedule package replacement or perform background registry I/O.
  if (!deps.check && detectInstall() === "source") return () => {};
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const check = deps.check ?? (() => checkRemoteUpdate(readAutoUpdateState()?.channel ?? defaultUpdateTag(currentVersion()), true));
  const enabled = deps.enabled ?? (() => detectInstall() !== "source" && readAutoUpdateState()?.enabled === true);
  const blockedTarget = deps.blockedTarget ?? (() => {
    if (deps.check) return null;
    const state = readAutoUpdateState();
    return state?.rollback ? state.targetVersion ?? null : null;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  let idleSince: number | null = null;
  let checkedAt = 0;
  const schedule = (delay: number) => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    status.nextCheckAt = new Date(now() + delay).toISOString();
    timer = setTimer(() => { void tick(); }, delay);
    timer.unref?.();
  };
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    let delay = UPDATE_RETRY_INTERVAL_MS;
    status.status = "checking";
    try {
      const result = await check();
      if (stopped) return;
      checkedAt = now();
      status.lastCheckedAt = new Date(checkedAt).toISOString();
      if (!result.latestVersion) { status.status = "check_failed"; return; }
      delay = UPDATE_CHECK_INTERVAL_MS * (0.9 + (deps.random ?? Math.random)() * 0.2);
      status.status = result.updateAvailable ? "available" : "current";
      if (!result.updateAvailable || !result.canUpdate || !enabled()) { idleSince = null; return; }
      if (blockedTarget() === result.latestVersion) { idleSince = null; status.status = "update_failed"; return; }
      const tasks = await activity();
      if (stopped) return;
      delay = UPDATE_RETRY_INTERVAL_MS;
      if (!tasks.known || tasks.running > 0) {
        idleSince = null;
        status.status = "waiting_for_idle";
        return;
      }
      // Confirm idle twice rather than restarting between adjacent tool calls.
      if (idleSince === null) { idleSince = now(); status.status = "waiting_for_idle"; return; }
      if (now() - idleSince < 60_000) { status.status = "waiting_for_idle"; return; }
      try { await (deps.start ?? requestAutomaticUpdate)(); if (!stopped) status.status = "starting"; }
      catch { if (!stopped) status.status = "setup_failed"; }
      idleSince = null;
    } catch { if (!stopped) status.status = "check_failed"; }
    finally { running = false; schedule(delay); }
  };
  stopCurrent = () => { stopped = true; if (timer) clearTimer(timer); };
  refreshCurrent = () => { if (now() - checkedAt >= 5 * 60_000) schedule(0); };
  schedule(1_000);
  return stopCurrent;
}
