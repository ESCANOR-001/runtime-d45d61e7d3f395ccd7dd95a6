import { expect, test } from "bun:test";
import { startAndroidRemoteRecovery } from "../src/android-remote/startup-recovery";
import { DEFAULT_ANDROID_REMOTE_SETTINGS } from "../src/android-remote/store";

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("retries failures without restarting healthy connections or repeating warnings", async () => {
  let status = "stopped", attempts = 0;
  const warnings: string[] = [];
  const recovery = startAndroidRemoteRecovery({
    settings: () => ({ ...DEFAULT_ANDROID_REMOTE_SETTINGS, controlEnabled: true }),
    status: () => ({ status }), intervalMs: 10,
    async apply() { if (++attempts < 3) { status = "error"; throw new Error("temporarily unavailable"); } status = "ready"; },
    warn: message => warnings.push(message),
  });
  try {
    await until(() => status === "ready");
    await Bun.sleep(50);
    expect(attempts).toBe(3);
    expect(warnings).toHaveLength(1);
  } finally { await recovery.stop(); }
});

test("does not overlap a pending start, and stopping prevents later retries", async () => {
  let release!: () => void;
  let attempts = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const recovery = startAndroidRemoteRecovery({
    settings: () => ({ ...DEFAULT_ANDROID_REMOTE_SETTINGS, controlEnabled: true }),
    status: () => ({ status: "error" }), intervalMs: 5,
    async apply() { attempts++; await pending; throw new Error("failed"); }, warn() {},
  });
  await until(() => attempts === 1);
  await Bun.sleep(30);
  expect(attempts).toBe(1);
  const stopped = recovery.stop();
  release();
  await stopped;
  await Bun.sleep(30);
  expect(attempts).toBe(1);
});

test("respects disabled settings and does not probe settings for a ready connection", async () => {
  let enabled = false, status = "stopped", reads = 0, starts = 0;
  const recovery = startAndroidRemoteRecovery({
    settings() { reads++; return { ...DEFAULT_ANDROID_REMOTE_SETTINGS, controlEnabled: enabled }; },
    status: () => ({ status }), intervalMs: 5,
    async apply() { starts++; status = "ready"; }, warn() {},
  });
  try {
    await until(() => reads >= 2);
    expect(starts).toBe(0);
    enabled = true;
    await until(() => starts === 1);
    const readyReads = reads;
    await Bun.sleep(30);
    expect(starts).toBe(1);
    expect(reads).toBe(readyReads);
  } finally { await recovery.stop(); }
});

test("an immediate stop prevents the queued initial attempt", async () => {
  let starts = 0;
  const recovery = startAndroidRemoteRecovery({
    settings: () => ({ ...DEFAULT_ANDROID_REMOTE_SETTINGS, controlEnabled: true }),
    status: () => ({ status: "stopped" }), async apply() { starts++; }, warn() {},
  });
  await recovery.stop();
  expect(starts).toBe(0);
});
