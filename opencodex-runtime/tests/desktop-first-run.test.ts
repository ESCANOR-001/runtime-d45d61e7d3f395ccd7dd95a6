import { describe, expect, test } from "bun:test";
import { bootstrapDesktopConfigIfNeeded } from "../src/cli/desktop-first-run";

describe("desktop first-run config bootstrap", () => {
  test("generic CLI startup remains read-only", () => {
    let calls = 0;
    const outcome = bootstrapDesktopConfigIfNeeded({}, () => {
      calls += 1;
      return { status: "created" };
    });

    expect(outcome).toEqual({ ran: false });
    expect(calls).toBe(0);
  });

  test("desktop startup invokes the no-replace bootstrap exactly once", () => {
    let calls = 0;
    const outcome = bootstrapDesktopConfigIfNeeded({ OCX_DESKTOP: "1" }, () => {
      calls += 1;
      return { status: "created" };
    });

    expect(outcome).toEqual({ ran: true, result: { status: "created" } });
    expect(calls).toBe(1);
  });

  test("existing and malformed files remain decisions of the bootstrap boundary", () => {
    expect(
      bootstrapDesktopConfigIfNeeded(
        { OCX_DESKTOP: "1" },
        () => ({ status: "existing" }),
      ),
    ).toEqual({ ran: true, result: { status: "existing" } });
    expect(
      bootstrapDesktopConfigIfNeeded(
        { OCX_DESKTOP: "1" },
        () => ({ status: "invalid" }),
      ),
    ).toEqual({ ran: true, result: { status: "invalid" } });
  });

  test("handleStart bootstraps before it captures config for startup sync", async () => {
    const cli = await Bun.file(new URL("../src/cli/index.ts", import.meta.url)).text();
    const start = cli.indexOf("async function handleStart(");
    const end = cli.indexOf("async function handleEnsure(", start);
    const handleStart = cli.slice(start, end);

    const bootstrap = handleStart.indexOf("bootstrapDesktopConfigIfNeeded()");
    const config = handleStart.indexOf("const config = loadConfig()");
    const sync = handleStart.indexOf("syncCodexOnStartIfEnabled(");
    expect(bootstrap).toBeGreaterThan(-1);
    expect(config).toBeGreaterThan(bootstrap);
    expect(sync).toBeGreaterThan(config);
  });
});
