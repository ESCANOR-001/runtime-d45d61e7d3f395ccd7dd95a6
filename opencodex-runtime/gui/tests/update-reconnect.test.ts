import { expect, test } from "bun:test";
import {
  observeUpdateReconnect,
  UPDATE_RELOAD_HEALTH_CONFIRMATIONS,
  type UpdateReloadTracker,
} from "../src/pages/update-reconnect";

function tracker(jobId = "job-1", targetVersion: string | null = "1.1.3"): UpdateReloadTracker {
  return { jobId, targetVersion, healthyChecks: 0 };
}

test("does not reload while the update worker is still running", () => {
  const decision = observeUpdateReconnect(tracker(), {
    jobId: "job-1",
    targetVersion: "1.1.3",
    status: "restarting",
    healthVersion: "1.1.3",
    healthOk: true,
  });

  expect(decision).toMatchObject({ reconnecting: true, reload: false });
  expect(decision.tracker.healthyChecks).toBe(0);
});

test("requires consecutive healthy target-version responses after success", () => {
  let current = tracker();
  for (let i = 1; i < UPDATE_RELOAD_HEALTH_CONFIRMATIONS; i += 1) {
    const decision = observeUpdateReconnect(current, {
      jobId: "job-1",
      targetVersion: "1.1.3",
      status: "succeeded",
      healthVersion: "1.1.3",
      healthOk: true,
    });
    expect(decision.reconnecting).toBe(true);
    expect(decision.reload).toBe(false);
    current = decision.tracker;
  }

  const ready = observeUpdateReconnect(current, {
    jobId: "job-1",
    targetVersion: "1.1.3",
    status: "succeeded",
    healthVersion: "1.1.3",
    healthOk: true,
  });
  expect(ready.reconnecting).toBe(false);
  expect(ready.reload).toBe(true);
});

test("a failed probe resets readiness and an old version cannot unlock reload", () => {
  const first = observeUpdateReconnect(tracker(), {
    jobId: "job-1",
    targetVersion: "1.1.3",
    status: "succeeded",
    healthVersion: "1.1.3",
    healthOk: true,
  });
  const old = observeUpdateReconnect(first.tracker, {
    jobId: "job-1",
    targetVersion: "1.1.3",
    status: "succeeded",
    healthVersion: "1.1.2",
    healthOk: true,
  });

  expect(old).toMatchObject({ reconnecting: true, reload: false });
  expect(old.tracker.healthyChecks).toBe(0);
});

test("a completed legacy job without a target version is shown but never reloads", () => {
  const decision = observeUpdateReconnect(tracker("legacy", null), {
    jobId: "legacy",
    targetVersion: null,
    status: "succeeded",
    healthVersion: "1.1.3",
    healthOk: true,
  });

  expect(decision).toMatchObject({ reconnecting: false, reload: false });
});
