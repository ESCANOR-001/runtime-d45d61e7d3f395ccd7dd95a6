import { AndroidCodexRuntime, type AndroidCodexClient } from "../src/android-remote/codex-app-server";
import { describe, expect, test } from "bun:test";
import { codexAccountQuotaReport } from "../src/android-remote/codex-account-usage";
import { projectProviderUsageActivity } from "../src/android-remote/projection";

describe("native ChatGPT account quota projection", () => {
  test("uses duration rather than assuming primary is five-hour", () => {
    const report = codexAccountQuotaReport({
      accountId: "must-not-cross-remote-boundary",
      rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300 } },
      rateLimitsByLimitId: { codex: {
        primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1800000000 },
        secondary: null,
      } },
    }, 1790000000000);
    const activity = projectProviderUsageActivity({
      threadId: "quota-thread", report, fallbackCreatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(activity?.payload).toEqual({
      providerId: "openai", providerLabel: "ChatGPT account",
      windows: [{ label: "Weekly", usedPercent: 40, remainingPercent: 60, resetAt: 1800000000 }],
    });
    expect(JSON.stringify(report)).not.toContain("must-not-cross-remote-boundary");
  });

  test("retains a real zero and ignores absent or invalid windows", () => {
    expect(codexAccountQuotaReport({ rateLimits: { primary: { usedPercent: null } } }, 1)).toBeNull();
    expect(codexAccountQuotaReport({ rateLimits: { primary: { usedPercent: NaN } } }, 1)).toBeNull();
    expect(codexAccountQuotaReport({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } }, 1))
      .toMatchObject({ quota: { customWindows: [{ label: "5-hour", percent: 0 }] } });
  });

  test("keeps separate account buckets bounded and identifiable", () => {
    const report = codexAccountQuotaReport({ rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 25, windowDurationMins: 300 } },
      extra: { limitName: "Extra models", primary: { usedPercent: 75, windowDurationMins: 10080 } },
    } }, 1);
    expect(report).toMatchObject({ quota: { customWindows: [
      { label: "codex · 5-hour", percent: 25 },
      { label: "Extra models · Weekly", percent: 75 },
    ] } });
  });
});

// The gateway receives the reconnecting facade, not the raw socket.
test("runtime facade exposes the current socket provider across reconnection", () => {
  const runtime = new AndroidCodexRuntime() as unknown as {
    createFacade(): AndroidCodexClient;
    socket: Partial<AndroidCodexClient> | null;
  };
  const client = runtime.createFacade();
  runtime.socket = { directModelProvider: "openai" };
  expect(client.directModelProvider).toBe("openai");
  runtime.socket = null;
  expect(client.directModelProvider).toBeUndefined();
  runtime.socket = { directModelProvider: "custom-provider" };
  expect(client.directModelProvider).toBe("custom-provider");
});
