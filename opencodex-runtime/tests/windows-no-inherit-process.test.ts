import { describe, expect, test } from "bun:test";
import { isPortAvailable } from "../src/server/ports";
import {
  buildWindowsNoInheritLaunchScript,
  launchWindowsProcessWithoutInheritedHandles,
  ownedWindowsProcess,
  spawnWindowsProcessWithoutInheritedHandles,
  spawnWindowsProcessWithoutInheritedHandlesAsync,
} from "../src/lib/windows-no-inherit-process";

describe("Windows child launch without inherited server handles", () => {
  test("quotes executable arguments and non-sensitive environment markers", () => {
    const script = buildWindowsNoInheritLaunchScript(
      "C:\\Program Files\\Remodex\\bun.exe",
      ["C:\\a path\\cli.ts", "plain", ""],
      { environment: { OCX_SERVICE: "1" } },
    );
    expect(script).toContain("$env:OCX_SERVICE = '1'");
    expect(script).toContain("Start-Process -FilePath 'C:\\Program Files\\Remodex\\bun.exe'");
    expect(script).toContain("-ArgumentList '\"C:\\a path\\cli.ts\" plain \"\"'");
    expect(script).toContain("Write-Output $p.Id");
  });

  test("preserves a pre-escaped cmd.exe argument line verbatim", () => {
    const args = ["/d", "/s", "/c", '"C:\\Tools\\codex.cmd ^"app-server^""'];
    const script = buildWindowsNoInheritLaunchScript("C:\\Windows\\System32\\cmd.exe", args, {
      windowsVerbatimArguments: true,
    });
    expect(script).toContain(`-ArgumentList '${args.join(" ")}'`);
  });

  test("returns only a valid PID from the bounded PowerShell launcher", () => {
    const calls: unknown[][] = [];
    const pid = launchWindowsProcessWithoutInheritedHandles("C:\\Tools\\child.exe", ["x"], {}, {
      platform: "win32",
      powershell: () => "C:\\Windows\\powershell.exe",
      spawnSync: ((file: unknown, args: unknown, options: unknown) => {
        calls.push([file, args, options]);
        return { status: 0, stdout: "4217\r\n", stderr: "" };
      }) as typeof import("node:child_process").spawnSync,
    });
    expect(pid).toBe(4217);
    expect(calls).toHaveLength(1);
    expect((calls[0]![2] as { env: Record<string, string> }).env).toEqual({ ...process.env });
  });

  test("kills the whole explicitly owned tree and observes exit", async () => {
    let alive = true;
    const killed: number[] = [];
    const child = ownedWindowsProcess(77, {
      hasExited: () => !alive,
      killTree: pid => {
        killed.push(pid);
        alive = false;
      },
      pollMs: 10,
    });
    child.kill("SIGTERM");
    await expect(child.exited).resolves.toBe(0);
    expect(killed).toEqual([77]);
  });

  test("transports quoted Unicode paths and literal percent signs as an encoded command", () => {
    const file = "C:\\Program Files\\Remodex\\bun.exe";
    const args = ["C:\\user's space\\child & %TEMP% 테스트.ts", "__tray-host"];
    const options = { environment: { OCX_TRAY_ENTRY_B64: "fixture" } };
    launchWindowsProcessWithoutInheritedHandles(file, args, options, {
      platform: "win32",
      powershell: () => "C:\\Windows\\powershell.exe",
      spawnSync: ((_file: string, commandArgs: string[], spawnOptions: Record<string, unknown>) => {
        expect(commandArgs).not.toContain("-Command");
        expect(commandArgs.at(-2)).toBe("-EncodedCommand");
        expect(Buffer.from(commandArgs.at(-1)!, "base64").toString("utf16le"))
          .toBe(buildWindowsNoInheritLaunchScript(file, args, options));
        expect(spawnOptions.windowsHide).toBe(true);
        return { status: 0, stdout: "4217\r\n", stderr: "" };
      }) as typeof import("node:child_process").spawnSync,
    });
  });

  test.skipIf(process.platform !== "win32")(
    "asynchronous child startup leaves the server responsive and releases its listener",
    async () => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("healthy") });
      const port = server.port!;
      const pending = spawnWindowsProcessWithoutInheritedHandlesAsync(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
      let child: Awaited<typeof pending> | undefined;
      try {
        expect(await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) })).text()).toBe("healthy");
        child = await pending;
        await server.stop(true);
        expect(await isPortAvailable(port, "127.0.0.1")).toBe(true);
      } finally {
        child ??= await pending;
        child.kill("SIGKILL");
        await child.exited;
        await server.stop(true);
      }
    }, 20_000,
  );

  test.skipIf(process.platform !== "win32")(
    "a live child does not retain a stopped Bun server port",
    async () => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("ok"),
      });
      const port = server.port!;
      const child = spawnWindowsProcessWithoutInheritedHandles(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)"],
      );
      try {
        await server.stop(true);
        expect(await isPortAvailable(port, "127.0.0.1")).toBe(true);
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    },
    15_000,
  );
});
