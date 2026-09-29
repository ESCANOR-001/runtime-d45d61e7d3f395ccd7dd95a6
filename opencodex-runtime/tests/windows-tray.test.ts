import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWindowsTrayLauncherScript,
  buildWindowsTrayPowerShellCommand,
  buildWindowsTrayRunCommand,
  launchWindowsTrayHost,
  parseWindowsTrayRunValue,
  readWindowsTrayRunValueWithAsyncRunner,
  readWindowsTrayRunValueWithRunner,
  replaceWindowsTrayOwnedFile,
  windowsTrayProcessArgs,
  windowsTrayRunValue,
  windowsTrayStatePathsOwned,
  windowsTrayRegistrationIsStale,
  windowsTrayRegistrationCanBeRepaired,
  windowsRegistryParentShowsRunKey,
  type WindowsTrayEntry,
} from "../src/tray/windows";
import {
  hardenSecretPath,
  hardenedSecretPathCountForTests,
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../src/lib/windows-secret-acl";
import { handleManagementAPI } from "../src/server/management-api";
import { MEMORY_DRAIN_RESTART_MS, REPLACEMENT_READY_TIMEOUT_MS } from "../src/server/management/system-restart";
import type { OcxConfig } from "../src/types";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "./helpers/test-budget";
import { waitForPortAvailable } from "../src/server/ports";

const entry: WindowsTrayEntry = {
  bun: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\bun.exe",
  bunRuntimeSource: "bundled",
  cli: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\src\\cli\\index.ts",
  script: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\src\\tray\\windows-tray.ps1",
  codexHome: "C:\\사용자 공간\\.codex",
  opencodexHome: "C:\\사용자 공간\\%TEMP% ! ^ ( ) & 검증\\.opencodex",
};

describe("Windows tray packaging and command safety", () => {
  test("owned-file temp cleanup forgets successful ACL memos and retains failed removals", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-tray-acl-"));
    const target = join(root, "tray-state.json");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    const write = (path: string, contents: string | Buffer): void => {
      writeFileSync(path, contents, { mode: 0o600 });
    };
    const harden = (path: string): void => {
      hardenSecretPath(path, { required: true });
    };
    try {
      replaceWindowsTrayOwnedFile(target, "success", {
        write,
        harden,
        rename: renameSync,
        unlink: unlinkSync,
      });
      expect(hardenedSecretPathCountForTests()).toBe(0);

      expect(() => replaceWindowsTrayOwnedFile(target, "failure", {
        write,
        harden,
        rename: () => { throw new Error("injected rename failure"); },
        unlink: () => { throw Object.assign(new Error("injected unlink failure"), { code: "EPERM" }); },
      })).toThrow("injected rename failure");
      expect(hardenedSecretPathCountForTests()).toBe(1);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses fixed argv for the hidden PowerShell host", () => {
    const args = windowsTrayProcessArgs(entry);
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    expect(args).toContain("-STA");
    expect(args).toContain(entry.script);
    expect(args).toContain(entry.bun);
    expect(args).toContain(entry.cli);
    expect(args).not.toContain("-Command");
    expect(windowsTrayProcessArgs(entry, "Run", 4242)).toContain("4242");
  });

  test("passes the Bun provenance through to the tray host (#848)", () => {
    // The tray relaunches the proxy itself, so a tray-started service would otherwise
    // reach doctor with no provenance and get the legacy/unknown treatment.
    const args = windowsTrayProcessArgs(entry);
    expect(args).toContain("-BunRuntimeSource");
    expect(args[args.indexOf("-BunRuntimeSource") + 1]).toBe("bundled");

    const overrideCommand = buildWindowsTrayPowerShellCommand(
      { ...entry, bunRuntimeSource: "override" },
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(overrideCommand).toContain("-BunRuntimeSource override");
  });

  test("quotes metacharacter and Unicode paths without shell interpolation", () => {
    const powershellCommand = buildWindowsTrayPowerShellCommand(entry, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellCommand).toContain(`-File "${entry.script}"`);
    expect(powershellCommand).toContain(`-OpenCodexHome "${entry.opencodexHome}"`);
    expect(powershellCommand).not.toContain("cmd /c");
    expect(powershellCommand).not.toContain("-Command");
    const runCommand = buildWindowsTrayRunCommand({
      ...entry,
      launcherPath: `${entry.opencodexHome}\\opencodex-tray.vbs`,
    });
    expect(runCommand.toLowerCase()).toContain("wscript.exe");
    expect(runCommand.length).toBeLessThanOrEqual(260);
  });
  test("keeps UNC backslashes literal in the VBS Run command", () => {
    const uncRoot = "\\\\server\\share";
    const uncEntry: WindowsTrayEntry = {
      bun: `${uncRoot}\\tools\\bun.exe`,
      cli: `${uncRoot}\\repo\\src\\cli\\index.ts`,
      script: `${uncRoot}\\repo\\src\\tray\\windows-tray.ps1`,
      codexHome: "C:\\Users\\Test\\.codex",
      opencodexHome: `${uncRoot}\\opencodex`,
    };
    const launcher = buildWindowsTrayLauncherScript(uncEntry);
    expect(launcher).toContain(`${uncRoot}\\tools\\bun.exe`);
    expect(launcher).not.toMatch(/\\\\\\\\server/);
  });


  test("preserves non-ASCII paths in the tray launcher script and UTF-16LE install encoding", () => {
    const launcher = buildWindowsTrayLauncherScript(entry);
    expect(launcher).toContain("사용자 공간");
    const encoded = Buffer.from("\uFEFF" + launcher, "utf16le");
    expect(encoded.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))).toBe(true);
    expect(encoded.toString("utf16le")).toContain("사용자 공간");
  });

  test("rejects quote and control-character path injection", () => {
    expect(() => windowsTrayProcessArgs({ ...entry, opencodexHome: 'C:\\bad" -Command whoami' })).toThrow();
    expect(() => windowsTrayProcessArgs({ ...entry, cli: "C:\\bad\r\nwhoami" })).toThrow();
  });

  test("never trusts state-selected executable or deletion paths", () => {
    const home = "C:\\Users\\Test\\.opencodex";
    expect(windowsTrayStatePathsOwned({
      opencodexHome: home,
      script: join(home, "opencodex-tray.ps1"),
      launcherPath: join(home, "opencodex-tray.vbs"),
    }, home)).toBe(true);
    expect(windowsTrayStatePathsOwned({
      opencodexHome: home,
      script: "C:\\attacker\\payload.ps1",
    }, home)).toBe(false);
    expect(windowsTrayStatePathsOwned({
      opencodexHome: home,
      script: join(home, "opencodex-tray.ps1"),
      launcherPath: "C:\\victim\\document.txt",
    }, home)).toBe(false);
  });

  test("treats a live unregistered tray as stale so uninstall cannot skip it", () => {
    expect(windowsTrayRegistrationIsStale({
      registered: false,
      registrationOwned: false,
      running: true,
      heartbeatFresh: true,
    })).toBe(true);
    expect(windowsTrayRegistrationIsStale({
      registered: false,
      registrationOwned: false,
      running: false,
      heartbeatFresh: false,
    })).toBe(false);
  });

  test("normalizes equivalent homes to one owned Run value", () => {
    expect(windowsTrayRunValue("C:\\Users\\Test\\.opencodex"))
      .toBe(windowsTrayRunValue("C:\\Users\\Test\\.opencodex\\."));
  });

  test("treats an unexpected registry type or unreadable value as foreign", () => {
    const value = "OpenCodexTray-test";
    const command = '"C:\\Windows\\powershell.exe" -File "C:\\tray.ps1"';
    expect(parseWindowsTrayRunValue(`    ${value}    REG_SZ    ${command}`, value)).toBe(command);
    expect(parseWindowsTrayRunValue(`    ${value}    REG_EXPAND_SZ    ${command}`, value)).not.toBe(command);
    expect(parseWindowsTrayRunValue("unexpected output", value)).not.toBeNull();
  });

  test("repairs only the exact planned Run command when tray state is missing", () => {
    const planned = '"C:\\Windows\\System32\\wscript.exe" //B //NoLogo "C:\\Users\\Test\\.remodex\\opencodex-tray.vbs"';
    expect(windowsTrayRegistrationCanBeRepaired(planned, null, planned)).toBe(true);
    expect(windowsTrayRegistrationCanBeRepaired(null, null, planned)).toBe(true);
    expect(windowsTrayRegistrationCanBeRepaired("foreign command", null, planned)).toBe(false);
    expect(windowsTrayRegistrationCanBeRepaired("recorded command", "recorded command", planned)).toBe(true);
  });

  test("distinguishes a missing Run key from an unreadable existing key", () => {
    const parent = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    ].join("\r\n");
    expect(windowsRegistryParentShowsRunKey(parent)).toBe(true);
    expect(windowsRegistryParentShowsRunKey(parent.replace(/\\Run\r?\n?$/, ""))).toBe(false);
  });

  test("fails closed when registry absence cannot be proven", async () => {
    const value = "OpenCodexTray-test";
    const statusError = (status: number) => Object.assign(new Error(`reg exit ${status}`), { status });
    const codeError = (code: number) => Object.assign(new Error(`reg exit ${code}`), { code });

    expect(readWindowsTrayRunValueWithRunner(value, args => {
      if (args.includes("/v")) throw statusError(1);
      if (args[1]?.endsWith("\\Run")) return "readable";
      throw new Error("unexpected query");
    })).toBeNull();
    expect(() => readWindowsTrayRunValueWithRunner(value, () => { throw statusError(5); }))
      .toThrow("refusing to change persistence");
    expect(() => readWindowsTrayRunValueWithRunner(value, args => {
      if (args.includes("/v")) throw statusError(1);
      throw statusError(5);
    })).toThrow("refusing to change persistence");

    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      if (args.includes("/v")) throw codeError(1);
      if (args[1]?.endsWith("\\Run")) return "readable";
      throw new Error("unexpected query");
    })).resolves.toBeNull();
    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async () => { throw codeError(5); }))
      .rejects.toThrow("Unable to verify Windows tray registry status");
    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      if (args.includes("/v")) throw codeError(1);
      throw codeError(5);
    })).rejects.toThrow("Unable to verify Windows tray registry status");
  });

  test("proves a missing Run key only through the readable parent path", async () => {
    const value = "OpenCodexTray-test";
    const syncCalls: string[][] = [];
    const syncResult = readWindowsTrayRunValueWithRunner(value, args => {
      syncCalls.push(args);
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) {
        throw Object.assign(new Error("missing"), { status: 1 });
      }
      return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer";
    });
    expect(syncResult).toBeNull();
    expect(syncCalls).toEqual([
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", value, "/reg:64"],
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/reg:64"],
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion", "/reg:64"],
    ]);

    const asyncCalls: string[][] = [];
    const asyncResult = await readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      asyncCalls.push(args);
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) {
        throw Object.assign(new Error("missing"), { code: 1 });
      }
      return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer";
    });
    expect(asyncResult).toBeNull();
    expect(asyncCalls).toEqual(syncCalls);

    expect(() => readWindowsTrayRunValueWithRunner(value, args => {
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) {
        throw Object.assign(new Error("unreadable"), { status: 1 });
      }
      return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    })).toThrow("refusing to change persistence");

    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) {
        throw Object.assign(new Error("unreadable"), { code: 1 });
      }
      return "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    })).rejects.toThrow("Unable to verify Windows tray registry status");

    const parentFailureSync = (args: string[]): string => {
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) throw Object.assign(new Error("missing"), { status: 1 });
      throw Object.assign(new Error("parent unreadable"), { status: 5 });
    };
    expect(() => readWindowsTrayRunValueWithRunner(value, parentFailureSync))
      .toThrow("refusing to change persistence");
    await expect(readWindowsTrayRunValueWithAsyncRunner(value, async args => {
      if (args.includes("/v") || args[1]?.endsWith("\\Run")) throw Object.assign(new Error("missing"), { code: 1 });
      throw Object.assign(new Error("parent unreadable"), { code: 5 });
    })).rejects.toThrow("Unable to verify Windows tray registry status");
  });

  test("PowerShell controller uses mutex/event shutdown and bans command evaluation", () => {
    const typescript = readFileSync(join(import.meta.dir, "..", "src", "tray", "windows.ts"), "utf8");
    const source = readFileSync(join(import.meta.dir, "..", "src", "tray", "windows-tray.ps1"), "utf8");
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");
    expect(typescript).not.toContain("\u0000");
    expect(typescript).toContain("OCX_TRAY_ENTRY_B64");
    expect(typescript).toContain('launchWindowsProcessWithoutInheritedHandles(bun, [cli, "__tray-host"]');
    expect(source).toContain("System.Threading.Mutex");
    expect(source).toContain("System.Threading.EventWaitHandle");
    expect(source).toContain("GetFullPath");
    expect(source).toContain("GetPathRoot");
    expect(source).toContain("$heartbeat.hostPid = $HostPid");
    expect(source).toContain('-CommandArgs @("__tray-restart")');
    expect(source).toContain("-TrackExit");
    expect(source).toContain("$script:pendingProcess.HasExited");
    expect(source).toContain('if ($null -ne $script:pendingAction)');
    expect(source).toContain('foreach ($item in $actionItems) { $item.Enabled = -not $busy }');
    expect(source).toContain('ignored because $($script:pendingAction) is still pending');
    const startBudget = source.match(/-Action "Start Proxy"[^\r\n]+-TimeoutSeconds (\d+)/);
    expect(startBudget).not.toBeNull();
    expect(Number(startBudget![1])).toBeGreaterThanOrEqual(75);
    const restartBudget = source.match(/-Action "Restart Remodex"[^\r\n]+-TimeoutSeconds (\d+)/);
    expect(restartBudget).not.toBeNull();
    expect(Number(restartBudget![1]) * 1000).toBeGreaterThanOrEqual(
      MEMORY_DRAIN_RESTART_MS + REPLACEMENT_READY_TIMEOUT_MS + 30_000,
    );
    expect(cli).toContain("requestBoundSystemRestart(previous, deadlineAt)");
    expect(cli).toContain("Date.now() + PROXY_RESTART_OBSERVE_MS");
    expect(cli).toContain("discoverStableProxyForRestart");
    expect(cli).toContain("isProxyReplacement(previous, live)");
    expect(cli).toContain("process.exitCode = result.ok ? 0 : 1");
    expect(cli).toContain("waitForProxy(40_000)");
    expect(cli).toContain("await handleProxyRestart(() => handleTrayProxyStart(false))");
    expect(cli).toContain("function detachedStartEnvironment()");
    expect(cli).toContain("delete env.OCX_SERVICE");
    expect(cli).not.toContain("OCX_KEEP_ROUTING");
    expect(source).toContain('Load-TrayIcon "remodex-tray.ico"');
    expect(source).toContain("[System.Drawing.SystemIcons]::Application");
    expect(source).toContain("$notify.Icon = $trayIcon");
    expect(source).not.toContain('Load-TrayIcon "opencodex-tray-');
    expect(source).not.toContain("$menu.add_Opening({ Update-TrayState })");
    expect(source).not.toContain("Invoke-Expression");
    expect(source).not.toContain("taskkill");
    expect(source).not.toContain("Stop-Process");
  });

  test("standalone npm tray mirrors the desktop tray action tree", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "tray", "windows-tray.ps1"), "utf8");
    for (const label of [
      "Open dashboard",
      "Start Proxy",
      "Stop Proxy",
      "Apply Changes",
      "Restart Codex",
      "Restart Remodex",
      "Restart desktop application (advanced)…",
      "Check package updates",
      "Quit desktop shell",
    ]) {
      expect(source).toContain(label);
    }
    for (const command of [
      '@("sync")',
      '@("__desktop-restart-codex")',
      '@("__tray-restart")',
      '@("__desktop-restart-client")',
      '@("gui", "--update")',
    ]) {
      expect(source).toContain(`-CommandArgs ${command}`);
    }
    expect(source).not.toContain("__desktop-update");
    expect(source).toContain('$statusItem.add_Click({');
    expect(source).not.toContain('Stop Proxy and Restore Native Routing');
  });

  // This test really does launch PowerShell, which really does launch a Bun child, and
  // then rebinds the port to prove the child did not inherit the listen socket. Those
  // processes ARE the assertion — there is no version of this proof that fakes them.
  //
  // So the budget has to cover work the test genuinely performs. Production allows
  // PowerShell 15s (`execFileSync` timeout in src/tray/windows.ts), while Bun's default
  // test budget is 5s; a contended windows-latest runner lands between the two and the
  // test fails at ~5.1s having done nothing wrong.
  //
  // Raising a budget is NOT the general answer to a flaky test. Earlier in this same
  // round the sidebar route tests were fixed by DELETING their real `gh` spawn, because
  // spawning a binary was incidental to what those tests claimed. The distinction is
  // whether the wait is intrinsic to the assertion. Here it is; there it was not.
  const PID_FILE_WAIT_MS = INTERNAL_DEADLINE_MS;
  const TRAY_LAUNCH_TIMEOUT_MS = SPAWN_BUDGET_MS;

  test("launches the detached tray host without retaining the proxy listen socket", async () => {
    if (process.platform !== "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "ocx-tray-inheritance-"));
    const pidPath = join(directory, "child.pid");
    const childPath = join(directory, "child & %TEMP% 테스트.ts");
    copyFileSync(join(import.meta.dir, "helpers", "windows-tray-inheritance-child.ts"), childPath);
    const previousPidPath = process.env.OCX_TRAY_TEST_PID_FILE;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    const port = server.port;
    let childPid = 0;
    let replacement: ReturnType<typeof Bun.serve> | undefined;

    try {
      process.env.OCX_TRAY_TEST_PID_FILE = pidPath;
      launchWindowsTrayHost({
        ...entry,
        bun: process.execPath,
        cli: childPath,
      });
      const pidDeadline = Date.now() + PID_FILE_WAIT_MS;
      while (!existsSync(pidPath) && Date.now() < pidDeadline) {
        await Bun.sleep(25);
      }
      // Name what actually went wrong. A bare `false` here means "the pid file is
      // missing" and nothing about whether PowerShell never started, the child died,
      // or the runner was simply slow — which is most of the work in diagnosing it.
      expect(
        existsSync(pidPath),
        `tray child never wrote ${pidPath} within ${PID_FILE_WAIT_MS}ms`,
      ).toBe(true);
      childPid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
      expect(() => process.kill(childPid, 0)).not.toThrow();

      await server.stop(true);
      expect(await waitForPortAvailable(port!, "127.0.0.1", { timeoutMs: 2000 })).toBe(true);
      replacement = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: () => new Response("replacement"),
      });
      expect(replacement.port).toBe(port);
      expect(() => process.kill(childPid, 0)).not.toThrow();
    } finally {
      if (previousPidPath === undefined) delete process.env.OCX_TRAY_TEST_PID_FILE;
      else process.env.OCX_TRAY_TEST_PID_FILE = previousPidPath;
      if (replacement) await replacement.stop(true);
      await server.stop(true);
      if (childPid > 0) {
        try { process.kill(childPid); } catch { /* exact test child already exited */ }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, { timeout: TRAY_LAUNCH_TIMEOUT_MS });

  test("retires the bundled C logo and packages the Remodex tray icon", () => {
    const assets = join(import.meta.dir, "..", "src", "tray", "assets");
    for (const name of [
      "opencodex-tray-online.ico",
      "opencodex-tray-warning.ico",
      "opencodex-tray-offline.ico",
      "opencodex-tray.png",
    ]) {
      expect(existsSync(join(assets, name))).toBe(false);
    }
    expect(readFileSync(join(assets, "README.md"), "utf8")).toContain("remodex-tray.ico");

    // The tray icon must be a real multi-size Windows icon. A missing or
    // PNG-renamed file makes PowerShell silently fall back to the generic
    // application icon, which is the user-visible failure this guard prevents.
    const icon = readFileSync(join(assets, "remodex-tray.ico"));
    expect(icon.readUInt16LE(0)).toBe(0); // ICONDIR reserved
    expect(icon.readUInt16LE(2)).toBe(1); // ICONDIR type: icon
    const count = icon.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(4);
    const sizes = new Set<number>();
    for (let index = 0; index < count; index++) {
      const offset = 6 + index * 16;
      const width = icon[offset] ?? 0;
      const height = icon[offset + 1] ?? 0;
      sizes.add(width === 0 ? 256 : width);
      sizes.add(height === 0 ? 256 : height);
    }
    for (const size of [16, 32, 48, 64, 128, 256]) expect(sizes.has(size)).toBe(true);
  });

  test("refresh probes only fresh public runtime health", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "tray", "windows-tray.ps1"), "utf8");
    expect(source).toContain('$statusItem.add_Click({');
    expect(source).toContain('Update-TrayState');
    expect(source).toContain('$httpClient.GetStringAsync($probeUrl)');
    expect(source).toContain('$httpHandler.UseProxy = $false');
    expect(source).toContain('$cacheControl.NoCache = $true');
    expect(source).toContain('$cacheControl.NoStore = $true');
    // Reusing the client connection avoids a buildup of short-lived CLOSE_WAIT
    // sockets while the tray polls every second.
    expect(source).not.toContain('ConnectionClose = $true');
    expect(source).toContain('$healthProbeIntervalMs = 1000');
    expect(source).toContain('$timer.Interval = 250');
    const completionGate = source.indexOf('-not $script:healthProbe.IsCompleted');
    const resultRead = source.indexOf('$probe.GetAwaiter().GetResult()');
    expect(completionGate).toBeGreaterThan(-1);
    expect(resultRead).toBeGreaterThan(completionGate);
    expect(source).not.toContain('/api/startup-health');
    expect(source).not.toContain('Degraded');
  });

  test("serves tray status without blocking the proxy event loop", async () => {
    if (process.platform !== "win32") return;
    const url = new URL("http://localhost/api/windows-tray");
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    const responsePromise = handleManagementAPI(
      new Request(url),
      url,
      { port: 10100, providers: {}, defaultProvider: "openai" } as OcxConfig,
    );
    await Bun.sleep(50);
    expect(timerFired).toBe(true);
    clearTimeout(timer);
    const response = await responsePromise;
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.supported).toBe(true);
    expect(typeof body.installed).toBe("boolean");
    expect(typeof body.running).toBe("boolean");
  });

  test("copies the tray script into the hardened home and gates all update lanes", () => {
    const root = join(import.meta.dir, "..");
    const tray = readFileSync(join(root, "src", "tray", "windows.ts"), "utf8");
    expect(tray).toContain('join(getConfigDir(), "opencodex-tray.ps1")');
    expect(tray).toContain('join(import.meta.dir, "assets", TRAY_ICON_FILE)');
    expect(tray).toContain("installedTrayIconPaths()");
    expect(tray).toContain("const hardened = hardenSecretPath(target, { required: true, timeoutMemoKey: path })");
    expect(tray).toContain("if (!hardened.ok)");
    expect(tray).toContain("if (!hardenedDir.ok)");
    expect(tray).toContain("refusing to replace its persistent script");
    expect(tray).toContain("restorePreviousInstall");
    expect(tray).toContain("previousStateBytes");
    expect(tray).toContain("previousScriptBytes");
    expect(tray).toContain('windowsTrayProcessArgs(currentEntry(), "Stop")');
    expect(tray).not.toContain("spawnTray(state)");
    expect(tray).toContain("return readWindowsTrayRunValueWithRunner(runValue, runRegistry)");
    expect(tray).toContain("return readWindowsTrayRunValueWithAsyncRunner(runValue, runRegistryAsync)");

    const updateSources = [
      join(root, "src", "update", "index.ts"),
      join(root, "src", "update", "job.ts"),
      join(root, "bin", "ocx.mjs"),
    ].map(path => readFileSync(path, "utf8"));
    for (const source of updateSources) {
      expect(source).toContain("tray");
      expect(source).toContain("stop");
      expect(source).toContain("aborting before package replacement");
    }
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";
