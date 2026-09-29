import { describe, expect, test } from "bun:test";
import {
  parseOnboardArgs,
  runCapturedCli,
  runOnboard,
  runOnboardCommand,
  type OnboardDeps,
  type OnboardRemoteStatus,
} from "../src/cli/onboard";
import type { CodexSyncResult } from "../src/codex/sync";
import type { ServiceDiagnostic } from "../src/service";
import { userRuntimeLaunch } from "../src/cli/user-runtime";

function service(overrides: Partial<ServiceDiagnostic> = {}): ServiceDiagnostic {
  return {
    supported: true,
    installed: true,
    enabled: true,
    running: true,
    viable: true,
    startable: true,
    stale: false,
    conflict: false,
    backend: "systemd",
    summary: "installed, enabled and running",
    ...overrides,
  };
}

function remote(
  mode: "quick" | "named",
  status: OnboardRemoteStatus["tunnel"]["runtime"]["status"] = "ready",
  publicUrl: string | null = mode === "quick"
    ? "https://verified.trycloudflare.com"
    : "https://r7k2m9.example.com",
  error: OnboardRemoteStatus["tunnel"]["runtime"]["error"] = null,
): OnboardRemoteStatus {
  return {
    controlEnabled: true,
    pairingAvailable: status === "ready",
    gateway: { status: "ready" },
    tunnel: {
      configuration: {
        mode,
        ...(mode === "named" ? { namedHostname: "r7k2m9.example.com" } : {}),
        hasNamedTunnelToken: mode === "named",
      },
      runtime: { mode, status, publicUrl, error },
    },
  };
}

function synced(routingApplied: boolean): CodexSyncResult {
  return {
    status: "applied",
    ok: true,
    added: 0,
    catalogPath: null,
    catalogExists: false,
    catalogWritten: false,
    cacheSynced: false,
    routingApplied,
    message: "Codex configuration verified",
  };
}

function capturedOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    output: {
      log: (value?: unknown) => stdout.push(String(value ?? "")),
      error: (value?: unknown) => stderr.push(String(value ?? "")),
    },
  };
}

function healthyDeps(overrides: OnboardDeps = {}): OnboardDeps {
  return {
    platform: "linux",
    setupUpdater: () => ({ status: "ready", message: "Automatic updates are ready." }),
    codexConfigExists: () => true,
    assertServiceOwnership: () => undefined,
    externalProvider: () => null,
    ensureConfig: () => ({ status: "existing" }),
    enableCodex: () => ({ ok: true, status: "unchanged", enabled: true }),
    configureAndroidRemote: () => ({ mode: "quick" }),
    diagnoseService: () => service(),
    runSubcommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    findLive: async () => ({ pid: 42, port: 10100, hostname: "127.0.0.1", source: "runtime" }),
    startRuntime: async () => undefined,
    applyAndroidRemote: async () => remote("quick", "starting", null),
    readAndroidRemote: async () => remote("quick"),
    syncCodex: async () => synced(true),
    open: () => undefined,
    sleep: async () => undefined,
    publicVerifyWaitMs: 0,
    ...overrides,
  };
}

describe("rmx onboard", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    test(`fresh onboarding and reruns need no service or elevation on ${platform}`, async () => {
      let starts = 0;
      let live = false;
      const capture = capturedOutput();
      const deps = healthyDeps({
        platform, output: capture.output,
        assertServiceOwnership: () => { throw new Error("must not require a service"); },
        diagnoseService: () => { throw new Error("must not query service manager"); },
        runSubcommand: async () => { throw new Error("must not install or repair a service"); },
        findLive: async () => live ? { pid: 42, port: 10110, hostname: "127.0.0.1", source: "runtime" } : null,
        startRuntime: async () => { starts++; live = true; },
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await runOnboard({ verbose: false, json: false, noOpen: true }, deps);
        expect(result.ok).toBe(true);
        expect(result.service).toBeNull();
        expect(result.dashboardUrl).toBe("http://localhost:10110/#android-remote/pair");
      }
      expect(starts).toBe(1);
      expect(capture.stdout.join("\n")).toContain("after restarting or signing out");
    });
  }

  test("detached runtime uses hidden windows, literal arguments and the existing user profile", () => {
    const env = { OCX_SERVICE: "1", OPENCODEX_HOME: "/test/profile", CODEX_HOME: "/test/codex", REMODEX_CONNECT_ONLY: "1" };
    const launch = userRuntimeLaunch(env, "C:\\Program Files\\Remodex\\connect.ts", 10110, 123);
    expect(launch.args).toEqual(["C:\\Program Files\\Remodex\\connect.ts", "start", "--port", "10110"]);
    expect(launch.options).toMatchObject({ detached: true, windowsHide: true, shell: false, stdio: ["ignore", 123, 123] });
    expect(launch.options.env?.OCX_SERVICE).toBeUndefined();
    expect(launch.options.env?.CODEX_HOME).toBe(env.CODEX_HOME);
    expect(env.OCX_SERVICE).toBe("1");
  });

  test("a failed user runtime launch never exposes a ready QR page or falls back to service installation", async () => {
    const result = await runOnboard({ verbose: false, json: true, noOpen: true }, healthyDeps({
      output: capturedOutput().output,
      findLive: async () => null,
      startRuntime: async () => { throw new Error("runtime launch failed"); },
      runSubcommand: async () => { throw new Error("must not elevate"); },
      applyAndroidRemote: async () => { throw new Error("must not create pairing"); },
    }));
    expect(result.ok).toBe(false);
    expect(result.completedSteps).toBe(1);
    expect(result.dashboardUrl).toBeNull();
    expect(result.error).toBe("runtime launch failed");
  });
  test("bounds a hung captured child command and preserves normal command output", async () => {
    const runFixture = (script: string, timeoutMs: number) => {
      const previousEntry = process.argv[1];
      try {
        process.argv[1] = "-e";
        return runCapturedCli([script], timeoutMs);
      } finally {
        process.argv[1] = previousEntry!;
      }
    };
    const stalled = await runFixture("await Bun.sleep(60000)", 25);
    expect(stalled.code).toBe(1);
    expect(stalled.stderr).toContain("Service setup timed out");
    const finished = await runFixture("console.log('fixture completed')", 2_000);
    expect(finished.code).toBe(0);
    expect(finished.stdout).toContain("fixture completed");
  });

  for (const platform of ["win32", "linux", "darwin"] as const) {
    test(`accepts late Wi-Fi readiness despite a failed tunnel on ${platform}`, async () => {
      const capture = capturedOutput();
      let reads = 0;
      let clock = 0;
      let opened = false;
      const result = await runOnboard({ verbose: false, json: false, noOpen: false }, healthyDeps({
        platform, output: capture.output,
        enableCodex: () => { throw new Error("must not change integration choice"); },
        setupUpdater: () => { throw new Error("must not install updater"); },
        syncCodex: async () => { throw new Error("must not sync routing"); },
        trayStatus: async () => { throw new Error("must not require tray"); },
        applyAndroidRemote: async () => {
          expect(opened).toBe(true);
          return { ...remote("quick", "starting", null), gateway: { status: "starting" } };
        },
        readAndroidRemote: async () => ++reads === 1
          ? { ...remote("quick", "starting", null), gateway: { status: "starting" } }
          : { ...remote("quick", "error", null, "cloudflared_unavailable"),
            pairingAvailable: true, reachableAddresses: ["http://192.168.1.3:10105"] },
        open: () => { opened = true; }, now: () => clock,
        sleep: async milliseconds => { clock += milliseconds; },
      }));
      expect(result.ok).toBe(true);
      expect(result.connection).toEqual({ localReady: true, remoteReady: false });
      expect(clock).toBe(1_000);
      expect(reads).toBe(2);
      expect(capture.stdout.join("\n")).toContain("Wi-Fi pairing ready");
    });
  }

  test("accepts Wi-Fi that becomes ready during public verification", async () => {
    let reads = 0;
    let clock = 0;
    const result = await runOnboard({ verbose: false, json: false, noOpen: true }, healthyDeps({
      output: capturedOutput().output,
      readAndroidRemote: async () => ++reads === 1 ? remote("quick", "checking")
        : { ...remote("quick", "starting", null), pairingAvailable: true, reachableAddresses: ["http://10.0.0.2:10105"] },
      now: () => clock, sleep: async milliseconds => { clock += milliseconds; }, publicVerifyWaitMs: 2_000,
    }));
    expect(result.ok).toBe(true);
    expect(result.connection?.localReady).toBe(true);
    expect(result.tunnel).toBeNull();
    expect(reads).toBe(2);
  });

  for (const json of [false, true]) {
    for (const fails of [false, true]) {
      test(`cleans up live progress after ${fails ? "failure" : "success"}, JSON=${json}`, async () => {
        const capture = capturedOutput();
        const result = await runOnboard({ verbose: false, json, noOpen: false }, healthyDeps({
          output: capture.output, progressIntervalMs: 5,
          findLive: async () => {
            await Bun.sleep(25);
            if (fails) throw new Error("test failure");
            return { pid: 42, port: 10100, hostname: "127.0.0.1", source: "runtime" };
          },
          proxyWaitMs: 1,
          open: () => { if (json) throw new Error("JSON opened browser"); },
        }));
        expect(result.ok).toBe(!fails);
        if (json) {
          expect(capture.stdout).toHaveLength(1);
          expect(JSON.parse(capture.stdout[0]!)).toEqual(result);
        } else {
          expect(capture.stdout.some(line => line.includes("Still working"))).toBe(true);
        }
        const count = capture.stdout.length;
        await Bun.sleep(20);
        expect(capture.stdout).toHaveLength(count);
      });
    }
  }

  test("browser launch failure does not fail a usable connection", async () => {
    const capture = capturedOutput();
    const result = await runOnboard({ verbose: false, json: false, noOpen: false }, healthyDeps({
      output: capture.output, open: () => { throw new Error("no browser"); },
    }));
    expect(result.ok).toBe(true);
    expect(capture.stdout.join("\n")).toContain("Open the QR page above manually");
  });

  for (const platform of ["win32", "linux", "darwin"] as const) {
    for (const mode of ["quick", "named"] as const) {
      test(`completes three stages without optional setup before Wi-Fi pairing without waiting for remote access on ${platform}/${mode}`, async () => {
        const capture = capturedOutput();
        const opened: string[] = [];
        let updaterSetups = 0;
        let synced = false;
        const commands: string[][] = [];
        let trayReads = 0;
        const forbidden = async () => { throw new Error("optional work delayed local pairing"); };
        const result = await runOnboard({ verbose: false, json: false, noOpen: false }, healthyDeps({
          platform, output: capture.output, configureAndroidRemote: () => ({ mode }),
          setupUpdater: () => {
            expect(opened).toHaveLength(0);
            updaterSetups++;
            return { status: "ready", message: "Automatic updates are ready." };
          },
          applyAndroidRemote: async () => ({ ...remote(mode, "error", null, "verification_failed"),
            pairingAvailable: true, reachableAddresses: ["http://192.168.1.3:10105"] }),
          readAndroidRemote: forbidden, sleep: forbidden,
          syncCodex: async () => { synced = true; return { status: "skipped", ok: true, skippedReason: "permission_required", message: "Permission required" }; },
          trayStatus: async () => ({ supported: true, installed: trayReads++ > 0, running: trayReads > 1, stale: false, summary: "test" }),
          runSubcommand: async args => { commands.push(args); return { code: 0, stdout: "", stderr: "" }; },
          open: url => { expect(synced).toBe(false); opened.push(url); },
        }));
        expect(result.ok).toBe(true);
        expect(updaterSetups).toBe(0);
        expect(commands).toEqual([]);
        expect(capture.stdout.filter(line => /^\[\d\/3\]/.test(line))).toHaveLength(3);
        expect(result.automaticUpdates).toBeUndefined();
        expect(result.connection).toEqual({ localReady: true, remoteReady: false });
        expect(result.tunnel).toBeNull();
        expect(opened).toEqual(["http://localhost:10100/#android-remote/pair"]);
        expect(capture.stdout.join("\n")).toContain("You can connect over Wi-Fi now");
        expect(capture.stderr).toEqual([]);
      });
    }
  }

  test("local-first JSON reports remote preparation and never opens a browser", async () => {
    const capture = capturedOutput();
    const result = await runOnboard({ verbose: false, json: true, noOpen: true }, healthyDeps({
      output: capture.output,
      applyAndroidRemote: async () => ({ ...remote("quick", "starting", null), pairingAvailable: true,
        reachableAddresses: ["http://10.0.0.2:10105"] }),
      open: () => { throw new Error("opened browser"); },
    }));
    expect(capture.stdout).toHaveLength(1);
    expect(JSON.parse(capture.stdout[0]!)).toEqual(result);
    expect(result.connection?.localReady).toBe(true);
  });
  for (const platform of ["win32", "linux", "darwin"] as const) {
    for (const mode of ["quick", "named"] as const) {
      test(`does not call an unverified ${mode} link ready on ${platform}`, async () => {
        const capture = capturedOutput();
        const commands: string[][] = [];
        let reads = 0;
        let sleeps = 0;
        const result = await runOnboard({ verbose: false, json: false, noOpen: true }, healthyDeps({
          platform,
          output: capture.output,
          configureAndroidRemote: () => ({ mode }),
          trayStatus: async () => ({ supported: true, installed: true, running: true, stale: false, summary: "ready" }),
          runSubcommand: async args => { commands.push(args); return { code: 0, stdout: "", stderr: "" }; },
          readAndroidRemote: async () => { reads += 1; return remote(mode, "checking"); },
          sleep: async () => { sleeps += 1; },
        }));
        expect(result.ok).toBe(false);
        expect(result.tunnel).toBeNull();
        expect(reads).toBe(1);
        expect(sleeps).toBe(0);
        expect(commands).toEqual([]);
        expect(capture.stdout.join("\n")).toContain("[3/3]");
        expect(capture.stdout.join("\n")).not.toContain("DNS cache");
        expect(capture.stdout.join("\n")).not.toContain("Public connection verified");
      });
    }
  }

  test("parses the compact public options and keeps JSON non-interactive", () => {
    expect(parseOnboardArgs(["--verbose", "--no-open"])).toEqual({
      ok: true,
      options: { verbose: true, json: false, noOpen: true },
    });
    expect(parseOnboardArgs(["--json"])).toEqual({
      ok: true,
      options: { verbose: false, json: true, noOpen: true },
    });
    expect(parseOnboardArgs(["--wat"])).toEqual({
      ok: false,
      message: "Unknown onboard option: --wat",
    });
  });

  test("verifies a fresh Quick Tunnel before opening the pairing page", async () => {
    const commands: string[][] = [];
    const opened: string[] = [];
    const transitions = [
      remote("quick", "starting", null),
      remote("quick", "checking", "https://unverified.trycloudflare.com"),
      remote("quick"),
    ];
    let serviceReads = 0;
    let clock = 0;
    const capture = capturedOutput();
    const result = await runOnboard(
      { verbose: false, json: false, noOpen: false },
      healthyDeps({
        output: capture.output,
        ensureConfig: () => ({ status: "created" }),
        configureAndroidRemote: () => ({ mode: "quick" }),
        diagnoseService: () => serviceReads++ === 0
          ? service({ installed: false, enabled: false, running: false, viable: false, startable: false, backend: null, summary: "not installed" })
          : service(),
        runSubcommand: async args => {
          commands.push(args);
          return { code: 0, stdout: "service installed", stderr: "" };
        },
        readAndroidRemote: async () => transitions.shift() ?? remote("quick"),
        open: url => { opened.push(url); },
        now: () => clock,
        sleep: async milliseconds => { clock += milliseconds; },
        publicVerifyWaitMs: 1_000,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.completedSteps).toBe(3);
    expect(result.tunnel).toEqual({
      mode: "quick",
      status: "created",
      publicUrl: "https://verified.trycloudflare.com",
    });
    expect(commands).toEqual([]);
    expect(opened).toEqual(["http://localhost:10100/#android-remote/pair"]);
    expect(transitions).toHaveLength(0);
    expect(capture.stdout.join("\n")).toContain("[3/3]");
    expect(capture.stdout.join("\n")).toContain("Ready to connect your phone");
    expect(capture.stdout.join("\n")).toContain("Keep the QR page open");
    expect(capture.stdout.join("\n")).toContain("https://verified.trycloudflare.com");
    expect(capture.stdout.join("\n")).toContain("Public connection verified");
    expect(capture.stderr).toEqual([]);
  });

  for (const mode of ["quick", "named"] as const) {
    for (const condition of ["verified", "no-open", "checking", "failed", "pairing-unavailable"] as const) {
      test(`opens the ${mode} progress page while withholding unverified pairing: ${condition}`, async () => {
        const opened: string[] = [];
        const capture = capturedOutput();
        const state = remote(mode,
          condition === "checking" ? "checking" : condition === "failed" ? "error" : "ready",
          "https://pairing-test.example.com",
          condition === "failed" ? "verification_failed" : null);
        if (condition === "pairing-unavailable") state.pairingAvailable = false;
        const result = await runOnboard({ verbose: false, json: false, noOpen: condition === "no-open" }, healthyDeps({
          output: capture.output,
          configureAndroidRemote: () => ({ mode }),
          readAndroidRemote: async () => state,
          open: url => { opened.push(url); },
        }));
        expect(result.ok).toBe(condition === "verified" || condition === "no-open");
        expect(opened).toEqual(condition === "no-open" ? [] : ["http://localhost:10100/#android-remote/pair"]);
        if (condition === "verified") expect(capture.stdout.join("\n")).toContain("Public connection verified");
      });
    }
  }

  test("reports pending verification honestly without restarting the tunnel", async () => {
    const capture = capturedOutput();
    const transitions = [
      remote(
        "quick",
        "error",
        "https://delayed.trycloudflare.com",
        "verification_failed",
      ),
      remote("quick", "checking", "https://delayed.trycloudflare.com"),
      remote("quick"),
    ];
    let reads = 0;
    let sleeps = 0;
    let applies = 0;
    let clock = 0;
    const result = await runOnboard(
      { verbose: false, json: false, noOpen: true },
      healthyDeps({
        output: capture.output,
        applyAndroidRemote: async () => { applies += 1; return remote("quick", "starting", null); },
        readAndroidRemote: async () => {
          reads += 1;
          return transitions.shift() ?? remote("quick");
        },
        now: () => clock,
        sleep: async milliseconds => { sleeps += 1; clock += milliseconds; },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.completedSteps).toBe(2);
    expect(result.tunnel).toBeNull();
    expect(result.error).toContain("not ready yet");
    expect(reads).toBe(1);
    expect(sleeps).toBe(0);
    expect(applies).toBe(1);
  });

  test("does not report success for a created link without pairing availability", async () => {
    let clock = 0;
    let reads = 0;
    const result = await runOnboard(
      { verbose: false, json: false, noOpen: true },
      healthyDeps({
        readAndroidRemote: async () => {
          reads += 1;
          return clock >= 50_000
            ? remote("quick")
            : remote("quick", "checking", "https://slow-propagation.trycloudflare.com");
        },
        now: () => clock,
        sleep: async milliseconds => { clock += milliseconds; },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.tunnel).toBeNull();
    expect(reads).toBe(1);
    expect(clock).toBe(0);
  });

  test("bounds the wait when Cloudflare never creates a link", async () => {
    let clock = 0;
    let sleeps = 0;
    const result = await runOnboard(
      { verbose: false, json: false, noOpen: true },
      healthyDeps({
        readAndroidRemote: async () => remote(
          "quick",
          "starting",
          null,
        ),
        now: () => clock,
        sleep: async milliseconds => { sleeps += 1; clock += milliseconds; },
        tunnelWaitMs: 2_000,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.completedSteps).toBe(2);
    expect(sleeps).toBe(2);
    expect(result.error).toContain("did not provide a tunnel link in time");
  });

  for (const error of ["tunnel_failed", "cloudflared_unavailable", "named_tunnel_incomplete"] as const) {
    test(`reports a real startup error immediately even with a leftover URL: ${error}`, async () => {
      let sleeps = 0;
      const result = await runOnboard({ verbose: false, json: false, noOpen: true }, healthyDeps({
        output: capturedOutput().output,
        readAndroidRemote: async () => remote("quick", "error", "https://stale.trycloudflare.com", error),
        sleep: async () => { sleeps += 1; },
      }));
      expect(result.ok).toBe(false);
      expect(result.completedSteps).toBe(2);
      expect(result.tunnel).toBeNull();
      expect(sleeps).toBe(0);
    });
  }

  const unavailableLinks: Array<[string, OnboardRemoteStatus]> = [
    ["stopped tunnel", remote("quick", "stopped")],
    ["restarting tunnel", remote("quick", "starting")],
    ["wrong tunnel mode", remote("named", "checking")],
    ["missing URL", remote("quick", "checking", null)],
    ["non-HTTPS URL", remote("quick", "checking", "http://example.com")],
    ["disabled gateway", { ...remote("quick", "checking"), controlEnabled: false }],
    ["starting gateway", { ...remote("quick", "checking"), gateway: { status: "starting" } }],
  ];
  for (const [reason, status] of unavailableLinks) {
    test(`does not report a created link with ${reason}`, async () => {
      let clock = 0;
      const result = await runOnboard({ verbose: false, json: false, noOpen: true }, healthyDeps({
        output: capturedOutput().output,
        readAndroidRemote: async () => status,
        now: () => clock,
        sleep: async milliseconds => { clock += milliseconds; },
        tunnelWaitMs: 1_000,
      }));
      expect(result.ok).toBe(false);
      expect(result.completedSteps).toBe(2);
      expect(result.tunnel).toBeNull();
      expect(clock).toBe(1_000);
    });
  }

  test("preserves codex-lb and an existing custom domain on an idempotent rerun", async () => {
    const commands: string[][] = [];
    const capture = capturedOutput();
    const result = await runOnboard(
      { verbose: false, json: false, noOpen: true },
      healthyDeps({
        output: capture.output,
        externalProvider: () => "codex-lb",
        configureAndroidRemote: () => ({ mode: "named", hostname: "r7k2m9.example.com" }),
        applyAndroidRemote: async () => remote("named"),
        readAndroidRemote: async () => remote("named"),
        syncCodex: async () => synced(false),
        runSubcommand: async args => {
          commands.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("codex-lb");
    expect(result.codex).toBe("codex-lb preserved");
    expect(result.tunnel?.mode).toBe("named");
    expect(commands).toEqual([]);
    expect(capture.stdout.join("\n")).toContain("codex-lb preserved");
    expect(capture.stdout.join("\n")).toContain("https://r7k2m9.example.com");
  });

  test("leaves the optional Windows tray out of the pairing path", async () => {
    const commands: string[][] = [];
    let trayReads = 0;
    const result = await runOnboard(
      { verbose: false, json: false, noOpen: true },
      healthyDeps({
        platform: "win32",
        diagnoseService: () => service({ backend: "scheduler" }),
        trayStatus: async () => trayReads++ === 0
          ? { supported: true, installed: false, running: false, stale: false, summary: "not installed" }
          : { supported: true, installed: true, running: true, stale: false, summary: "installed and running" },
        runSubcommand: async args => {
          commands.push(args);
          return { code: 0, stdout: "tray installed", stderr: "" };
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.tray).toBeNull();
    expect(trayReads).toBe(0);
    expect(commands).toEqual([]);
  });

  test("Windows onboarding never requests administrator approval or inspects service registration", async () => {
    const capture = capturedOutput();
    let serviceReads = 0;
    const result = await runOnboard(
      { verbose: false, json: false, noOpen: true },
      healthyDeps({
        platform: "win32",
        output: capture.output,
        diagnoseService: () => serviceReads++ === 0
          ? service({
            installed: false,
            enabled: false,
            running: false,
            viable: false,
            startable: false,
            backend: null,
            summary: "not installed",
          })
          : service({ backend: "scheduler" }),
        trayStatus: async () => ({
          supported: true,
          installed: true,
          running: true,
          stale: false,
          summary: "installed and running",
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(serviceReads).toBe(0);
    expect(result.service).toBeNull();
    expect(capture.stdout.join("\n")).not.toContain("Windows will ask for administrator approval");
  });

  test("starts a user runtime instead of repairing a service when no proxy answers", async () => {
    const commands: string[][] = [];
    let liveReads = 0;
    let starts = 0;
    let clock = 0;
    const capture = capturedOutput();
    const result = await runOnboard(
      { verbose: false, json: false, noOpen: true },
      healthyDeps({
        output: capture.output,
        startRuntime: async () => { starts++; },
        findLive: async () => liveReads++ === 0
          ? null
          : { pid: 42, port: 10100, hostname: "127.0.0.1", source: "runtime" },
        runSubcommand: async args => {
          commands.push(args);
          return { code: 0, stdout: "service repaired", stderr: "" };
        },
        proxyWaitMs: 500,
        now: () => clock,
        sleep: async milliseconds => { clock += milliseconds; },
      }),
    );

    expect(result.ok).toBe(true);
    expect(commands).toEqual([]);
    expect(starts).toBe(1);
    expect(capture.stdout.join("\n")).toContain("No background-service installation required");
  });

  test("retries a transient Android gateway startup before pausing setup", async () => {
    const capture = capturedOutput();
    let reads = 0;
    let applies = 0;
    const result = await runOnboard(
      { verbose: false, json: false, noOpen: true },
      healthyDeps({
        output: capture.output,
        applyAndroidRemote: async () => {
          applies += 1;
          return remote("quick", "starting", null);
        },
        readAndroidRemote: async () => {
          reads += 1;
          if (reads === 1) {
            return {
              ...remote("quick", "stopped", null),
              gateway: { status: "error", error: "Could not start the Android Remote gateway" },
            };
          }
          return remote("quick");
        },
        sleep: async () => undefined,
      }),
    );

    expect(result.ok).toBe(true);
    expect(applies).toBe(2);
    expect(capture.stdout.join("\n")).toContain("Android gateway did not start; retrying");
  });

  test("stops after bounded Android gateway retries and keeps the cause readable", async () => {
    const capture = capturedOutput();
    let applies = 0;
    const result = await runOnboard(
      { verbose: false, json: false, noOpen: true },
      healthyDeps({
        output: capture.output,
        applyAndroidRemote: async () => {
          applies += 1;
          return remote("quick", "starting", null);
        },
        readAndroidRemote: async () => ({
          ...remote("quick", "stopped", null),
          gateway: {
            status: "error",
            error: "Could not start the Android Remote gateway: listen EADDRINUSE; api_key=super-secret-value",
          },
        }),
        sleep: async () => undefined,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.completedSteps).toBe(2);
    expect(applies).toBe(3);
    expect(result.error).toBe("The Android gateway could not start: listen EADDRINUSE; api_key=[REDACTED]");
    expect(capture.stderr.join("\n")).toContain(
      "Issue       The Android gateway could not start: listen EADDRINUSE; api_key=[REDACTED]",
    );
    expect(capture.stderr.join("\n")).not.toContain("Could not start the Android Remote gateway: Could not start");
  });

  test("stops on malformed config without touching Android Remote or the service", async () => {
    let androidTouched = false;
    let serviceTouched = false;
    const capture = capturedOutput();
    const result = await runOnboard(
      { verbose: false, json: false, noOpen: true },
      healthyDeps({
        output: capture.output,
        ensureConfig: () => ({ status: "invalid" }),
        configureAndroidRemote: () => {
          androidTouched = true;
          return { mode: "quick" };
        },
        runSubcommand: async () => {
          serviceTouched = true;
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.completedSteps).toBe(0);
    expect(androidTouched).toBe(false);
    expect(serviceTouched).toBe(false);
    expect(capture.stderr.join("\n")).toContain("Setup paused");
    expect(capture.stderr.join("\n")).toContain("config.json is malformed");
    expect(capture.stderr.join("\n")).toContain("Retry: rmx onboard");
    expect(capture.stderr.join("\n")).not.toContain("at runOnboard");
  });

  test("JSON emits one result and never opens a browser", async () => {
    const capture = capturedOutput();
    let opened = false;
    const code = await runOnboardCommand(["--json"], healthyDeps({
      output: capture.output,
      open: () => { opened = true; },
    }));

    expect(code).toBe(0);
    expect(opened).toBe(false);
    expect(capture.stderr).toEqual([]);
    expect(capture.stdout).toHaveLength(1);
    expect(JSON.parse(capture.stdout[0]!)).toMatchObject({
      ok: true,
      completedSteps: 3,
      service: null,
      tunnel: { mode: "quick", status: "created" },
    });
  });

  test("unknown options use a conventional usage exit without starting setup", async () => {
    const capture = capturedOutput();
    const code = await runOnboardCommand(["--unknown"], { output: capture.output });
    expect(code).toBe(64);
    expect(capture.stderr).toEqual([
      "Unknown onboard option: --unknown",
      "Usage: rmx onboard [--verbose] [--json] [--no-open]",
    ]);
  });
});
