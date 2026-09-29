import { afterEach, expect, test } from "bun:test";
import { backgroundUpdateStatus, requestBackgroundUpdateCheck, startBackgroundUpdates, stopBackgroundUpdates, UPDATE_CHECK_INTERVAL_MS, UPDATE_RETRY_INTERVAL_MS } from "../src/update/background";
import type { RemoteUpdateCheck } from "../src/update/remote-check";

afterEach(stopBackgroundUpdates);
const available: RemoteUpdateCheck = {
  currentVersion: "1.0.0", latestVersion: "1.0.1", channel: "latest", installer: "npm",
  updateAvailable: true, canUpdate: true, command: "", releaseNotesUrl: "", checkedAt: "", releaseNotes: null,
};
function harness() {
  let now = 1_000_000;
  let due = 0;
  let timer: (() => void) | undefined;
  let checks = 0, starts = 0;
  let result = available;
  let tasks = { known: true, running: 0 };
  let enabled = true;
  let failStart = false;
  let blocked: string | null = null;
  const stop = startBackgroundUpdates(() => tasks, {
    now: () => now, random: () => 0.5,
    check: async () => { checks++; return result; }, enabled: () => enabled,
    blockedTarget: () => blocked,
    start: async () => { starts++; if (failStart) throw new Error("scheduler unavailable"); },
    setTimer: ((fn: () => void, delay: number) => { due = now + delay; timer = fn; return { unref() {} }; }) as unknown as typeof setTimeout,
    clearTimer: (() => { timer = undefined; }) as typeof clearTimeout,
  });
  return {
    stop, get checks() { return checks; }, get starts() { return starts; }, get delay() { return due - now; },
    setResult(value: RemoteUpdateCheck) { result = value; },
    blockTarget(value: string | null) { blocked = value; },
    setTasks(value: typeof tasks) { tasks = value; }, setEnabled(value: boolean) { enabled = value; }, failStart() { failStart = true; },
    async tick() { now = due; const fn = timer; timer = undefined; fn?.(); for (let i=0;i<8;i++) await Promise.resolve(); },
  };
}
test("checks on startup then every thirty minutes when current", async () => {
  const h = harness(); h.setResult({ ...available, updateAvailable: false, canUpdate: false });
  expect(h.delay).toBe(1000); await h.tick();
  expect(h.checks).toBe(1); expect(h.delay).toBe(UPDATE_CHECK_INTERVAL_MS);
  expect(backgroundUpdateStatus().status).toBe("current"); expect(h.starts).toBe(0);
});
test("offline failure retries in two minutes and recovers", async () => {
  const h = harness(); h.setResult({ ...available, latestVersion: null });
  await h.tick(); expect(backgroundUpdateStatus().status).toBe("check_failed"); expect(h.delay).toBe(UPDATE_RETRY_INTERVAL_MS);
  h.setResult(available); await h.tick(); expect(backgroundUpdateStatus().status).toBe("waiting_for_idle");
});
test("busy and unknown tasks defer installation; two idle observations start it", async () => {
  const h = harness(); h.setTasks({ known: true, running: 1 });
  await h.tick(); await h.tick(); expect(h.starts).toBe(0);
  h.setTasks({ known: false, running: 0 }); await h.tick(); expect(h.starts).toBe(0);
  h.setTasks({ known: true, running: 0 }); await h.tick(); expect(h.starts).toBe(0);
  await h.tick(); expect(h.starts).toBe(1); expect(backgroundUpdateStatus().status).toBe("starting");
});
test("saved opt-out checks availability without installing", async () => {
  const h = harness(); h.setEnabled(false); await h.tick(); await h.tick();
  expect(h.starts).toBe(0); expect(backgroundUpdateStatus().status).toBe("available");
});

test("a rolled-back release is blocked while a newer release can install", async () => {
  const h = harness(); h.blockTarget(available.latestVersion);
  await h.tick(); await h.tick();
  expect(h.starts).toBe(0); expect(backgroundUpdateStatus().status).toBe("update_failed");
  h.setResult({ ...available, latestVersion: "1.0.2" });
  await h.tick(); await h.tick(); expect(h.starts).toBe(1);
});
test("a broken scheduler is visible and retried", async () => {
  const h = harness(); h.failStart(); await h.tick(); await h.tick();
  expect(backgroundUpdateStatus().status).toBe("setup_failed"); expect(h.delay).toBe(UPDATE_RETRY_INTERVAL_MS);
});
test("reconnect reuses a fresh check and stopped monitor cannot start work", async () => {
  const h = harness(); await h.tick(); const delay = h.delay;
  requestBackgroundUpdateCheck(); expect(h.delay).toBe(delay);
  h.stop(); await h.tick(); expect(h.checks).toBe(1); expect(h.starts).toBe(0);
});
