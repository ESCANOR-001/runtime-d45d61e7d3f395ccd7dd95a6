import { describe, expect, test } from "bun:test";
import { isProcessAlive, waitForExit, waitForStoppedPort } from "../src/lib/process-control";

describe("process control helpers", () => {
  test("reports the current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("reports a clearly invalid pid as exited", () => {
    const invalidPid = 999_999_999;

    expect(isProcessAlive(invalidPid)).toBe(false);
    expect(waitForExit(invalidPid, 1)).toBe(true);
  });

  test("waitForStoppedPort reports a port that could not be reclaimed", async () => {
    const options: { port?: number; hostname?: string; timeoutMs?: number } = {};
    await expect(waitForStoppedPort(
      { port: 10100, hostname: "127.0.0.1" },
      4242,
      {
        reclaim: async (port, hostname, reclaimOptions) => {
          options.port = port;
          options.hostname = hostname;
          options.timeoutMs = reclaimOptions.timeoutMs;
          return false;
        },
      },
    )).rejects.toThrow("Port 10100 is still unavailable after the proxy stopped");
    expect(options).toEqual({ port: 10100, hostname: "127.0.0.1", timeoutMs: 15_000 });
  });

  test("waitForStoppedPort succeeds only after the reclaim check succeeds", async () => {
    let calls = 0;
    await waitForStoppedPort({ port: 10100 }, 4242, {
      reclaim: async () => {
        calls += 1;
        return true;
      },
    });
    expect(calls).toBe(1);
  });
});
