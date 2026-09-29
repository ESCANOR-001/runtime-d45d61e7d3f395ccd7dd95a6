import { describe, expect, test } from "bun:test";
import {
  classifyDesktopClientSnapshot,
  desktopClientProcessIdentity,
  hardRestartDesktopClient,
  isValidWindowsAppUserModelId,
  listDesktopClientProcesses,
  restartDesktopClient,
  windowsAppUserModelIdDiscoveryScript,
  type DesktopClientProcess,
} from "../src/codex/desktop-client-processes";

const linuxClient: DesktopClientProcess = {
  pid: 101,
  executablePath: "/usr/lib/chatgpt/ChatGPT",
  commandLine: "/usr/lib/chatgpt/ChatGPT",
  uid: 1000,
  product: "chatgpt",
};

describe("desktop client matching", () => {
  test("matches supported top-level Linux, macOS, and Windows clients", () => {
    expect(classifyDesktopClientSnapshot(linuxClient, "linux")?.product).toBe("chatgpt");
    expect(classifyDesktopClientSnapshot({
      pid: 102,
      executablePath: "/Applications/Codex.app/Contents/MacOS/Codex",
      commandLine: "/Applications/Codex.app/Contents/MacOS/Codex",
      uid: 501,
    }, "darwin")?.product).toBe("codex");
    expect(classifyDesktopClientSnapshot({
      pid: 103,
      executablePath: "C:\\Users\\a\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe",
      commandLine: '"C:\\Users\\a\\AppData\\Local\\Programs\\ChatGPT\\ChatGPT.exe"',
      owner: "DESKTOP\\a",
    }, "win32")?.product).toBe("chatgpt");
  });

  test("rejects Electron helpers, arbitrary paths, and executable mismatches", () => {
    expect(classifyDesktopClientSnapshot({
      ...linuxClient,
      pid: 104,
      commandLine: "/usr/lib/chatgpt/ChatGPT --type=renderer",
    }, "linux")).toBeNull();
    expect(classifyDesktopClientSnapshot({
      ...linuxClient,
      pid: 105,
      executablePath: "/tmp/chatgpt/ChatGPT",
      commandLine: "/tmp/chatgpt/ChatGPT",
    }, "linux")).toBeNull();
    expect(classifyDesktopClientSnapshot({
      ...linuxClient,
      pid: 106,
      commandLine: "/usr/lib/chatgpt/Other",
    }, "linux")).toBeNull();
    expect(classifyDesktopClientSnapshot({
      ...linuxClient,
      pid: 107,
      executablePath: "/usr/lib/chatgpt/resources/codex",
      commandLine: "/usr/lib/chatgpt/resources/codex app-server",
    }, "linux")).toBeNull();
  });

  test("deduplicates injected snapshots and ignores unrelated processes", () => {
    const processes = listDesktopClientProcesses({
      platform: "linux",
      listSnapshots: () => [
        linuxClient,
        linuxClient,
        {
          pid: 202,
          executablePath: "/usr/bin/bash",
          commandLine: "bash -lc codex",
          uid: 1000,
        },
      ],
    });
    expect(processes).toHaveLength(1);
    expect(processes[0]?.pid).toBe(101);
  });
});

describe("desktop client restart", () => {
  test("revalidates, requests a graceful close, waits, relaunches, and verifies the replacement", async () => {
    const calls: string[] = [];
    let scans = 0;
    const replacement = { ...linuxClient, pid: 202 };
    const result = await restartDesktopClient({
      platform: "linux",
      listProcesses: () => {
        scans += 1;
        return scans <= 2 ? [linuxClient] : [replacement];
      },
      requestClose: target => { calls.push(`close:${target.pid}`); },
      waitExit: pid => { calls.push(`wait:${pid}`); return true; },
      launch: target => { calls.push(`launch:${target.executablePath}`); },
      replacementTimeoutMs: 0,
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "close:101",
      "wait:101",
      "launch:/usr/lib/chatgpt/ChatGPT",
    ]);
  });

  test("refuses when the target identity changes before close", async () => {
    let scan = 0;
    const result = await restartDesktopClient({
      listProcesses: () => {
        scan += 1;
        return [{ ...linuxClient, commandLine: scan === 1 ? linuxClient.commandLine : `${linuxClient.commandLine} --changed` }];
      },
      requestClose: () => { throw new Error("must not close"); },
    });
    expect(result).toMatchObject({ ok: false, reason: "target_changed" });
  });

  test("reports asynchronous launch errors", async () => {
    const result = await restartDesktopClient({
      platform: "win32",
      listProcesses: () => [linuxClient],
      requestClose: () => {},
      waitExit: () => true,
      launch: async () => {
        throw new Error("access denied");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "launch_failed" });
    expect(result.message).toContain("access denied");
  });

  test("reports when launch returns but no replacement appears", async () => {
    const result = await restartDesktopClient({
      listProcesses: () => [linuxClient],
      requestClose: () => {},
      waitExit: () => true,
      launch: () => {},
      replacementTimeoutMs: 0,
    });
    expect(result).toMatchObject({ ok: false, reason: "launch_failed" });
    expect(result.message).toContain("no replacement process appeared");
  });

  test("refuses ambiguous clients and never force-closes a survivor", async () => {
    const second = { ...linuxClient, pid: 202 };
    expect(await restartDesktopClient({ listProcesses: () => [linuxClient, second] }))
      .toMatchObject({ ok: false, reason: "ambiguous" });

    let launched = false;
    const survivor = await restartDesktopClient({
      listProcesses: () => [linuxClient],
      requestClose: () => {},
      waitExit: () => false,
      launch: () => { launched = true; },
    });
    expect(survivor).toMatchObject({ ok: false, reason: "still_running" });
    expect(launched).toBe(false);
  });

  test("hard restart force-closes, relaunches, and verifies the replacement", async () => {
    const calls: string[] = [];
    let scans = 0;
    const replacement = { ...linuxClient, pid: 303 };
    const result = await hardRestartDesktopClient({
      platform: "linux",
      listProcesses: () => {
        scans += 1;
        return scans <= 2 ? [linuxClient] : [replacement];
      },
      forceClose: target => { calls.push(`force:${target.pid}`); },
      waitExit: pid => { calls.push(`wait:${pid}`); return true; },
      launch: target => { calls.push(`launch:${target.executablePath}`); },
      replacementTimeoutMs: 0,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "force:101",
      "wait:101",
      "launch:/usr/lib/chatgpt/ChatGPT",
    ]);
  });

  test("hard restart revalidates identity before force-closing", async () => {
    let scans = 0;
    let forceClosed = false;
    const result = await hardRestartDesktopClient({
      listProcesses: () => {
        scans += 1;
        return [{
          ...linuxClient,
          commandLine: scans === 1 ? linuxClient.commandLine : `${linuxClient.commandLine} --changed`,
        }];
      },
      forceClose: () => { forceClosed = true; },
    });

    expect(result).toMatchObject({ ok: false, reason: "target_changed" });
    expect(forceClosed).toBe(false);
  });

  test("identity includes pid, executable, and normalized command", () => {
    expect(desktopClientProcessIdentity(linuxClient))
      .not.toBe(desktopClientProcessIdentity({ ...linuxClient, pid: 102 }));
    expect(desktopClientProcessIdentity(linuxClient))
      .toBe(desktopClientProcessIdentity({ ...linuxClient, commandLine: "  /usr/lib/chatgpt/ChatGPT  " }));
  });
});

describe("Windows packaged desktop activation", () => {
  const packaged: DesktopClientProcess = {
    pid: 303,
    executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_1.0.0.0_x64__abc\\ChatGPT.exe",
    commandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_1.0.0.0_x64__abc\\ChatGPT.exe"',
    owner: "DESKTOP\\ada",
    product: "chatgpt",
  };

  test("accepts only bounded product-matching AUMIDs", () => {
    expect(isValidWindowsAppUserModelId("OpenAI.ChatGPT_abc!App", "chatgpt")).toBe(true);
    expect(isValidWindowsAppUserModelId("Microsoft.WindowsCalculator_abc!App", "chatgpt")).toBe(false);
    expect(isValidWindowsAppUserModelId("OpenAI.ChatGPT_abc!App\\evil", "chatgpt")).toBe(false);
    expect(isValidWindowsAppUserModelId("OpenAI.ChatGPT_abc", "chatgpt")).toBe(false);
  });

  test("discovers by exact package executable before using the exact display-name fallback", () => {
    const script = windowsAppUserModelIdDiscoveryScript(packaged);
    const pathMatch = script.indexOf("[string]::Equals($candidate,$target");
    const displayFallback = script.indexOf("$_.Name -ieq $product");

    expect(pathMatch).toBeGreaterThan(-1);
    expect(displayFallback).toBeGreaterThan(pathMatch);
    expect(script).toContain("Get-AppxPackageManifest -Package $package");
    expect(script).toContain("Get-StartApps");
    expect(script).toContain("Sort-Object -Unique");
    expect(script).toContain("if($ids.Count -ne 1){exit 3}");
  });

  test("escapes apostrophes before embedding the executable in PowerShell", () => {
    const script = windowsAppUserModelIdDiscoveryScript({
      ...packaged,
      executablePath: "C:\\Users\\O'Brien\\AppData\\Local\\Microsoft\\WindowsApps\\ChatGPT.exe",
    });
    expect(script).toContain("O''Brien");
    expect(script).not.toContain("O'Brien");
  });
});
