/**
 * Launch a long-lived Windows child without copying Bun.serve listener handles.
 *
 * Bun's Windows child-process path can inherit an otherwise unrelated LISTEN
 * handle.  If the proxy later exits while that child is still alive, netstat
 * keeps the dead proxy PID on the port and the next fixed-port start fails.
 * PowerShell's Start-Process creates a fresh process tree without those handles.
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { dlopen, type Pointer } from "bun:ffi";
import {
  buildWindowsElevatedArgumentList,
  resolveTrustedWindowsPowerShellExe,
  resolveTrustedWindowsSystemDirectory,
} from "./windows-elevation";

export interface WindowsNoInheritLaunchOptions {
  /** Preserve an already escaped cmd.exe argument line. */
  windowsVerbatimArguments?: boolean;
  /** Non-sensitive process markers only; values appear in PowerShell's argv. */
  environment?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface WindowsNoInheritLaunchIo {
  platform?: NodeJS.Platform;
  powershell?: () => string;
  spawnSync?: typeof spawnSync;
}

export interface OwnedWindowsProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export interface OwnedWindowsProcessIo {
  /** Test seam. True means the exact originally launched process has exited. */
  hasExited?: () => boolean;
  killTree?: (pid: number) => void;
  closeTracker?: () => void;
  pollMs?: number;
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function environmentScript(environment: Readonly<Record<string, string>> | undefined): string[] {
  if (!environment) return [];
  return Object.entries(environment).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid Windows child environment name ${JSON.stringify(name)}.`);
    }
    return `$env:${name} = ${psSingleQuote(value)}`;
  });
}

/** Build the bounded Start-Process command; exported for exact quoting tests. */
export function buildWindowsNoInheritLaunchScript(
  file: string,
  args: readonly string[],
  options: WindowsNoInheritLaunchOptions = {},
): string {
  const argumentList = options.windowsVerbatimArguments
    ? args.join(" ")
    : buildWindowsElevatedArgumentList([...args]);
  return [
    ...environmentScript(options.environment),
    `$p = Start-Process -FilePath ${psSingleQuote(file)}`
      + (argumentList ? ` -ArgumentList ${psSingleQuote(argumentList)}` : "")
      + " -WindowStyle Hidden -PassThru",
    "if ($null -eq $p) { exit 1 }",
    "Write-Output $p.Id",
  ].join("; ");
}

/**
 * Return the new root PID after the short PowerShell launcher exits. The caller
 * can then monitor or terminate that exact owned tree without keeping the
 * launcher (and its temporarily inherited handles) alive.
 */
export function launchWindowsProcessWithoutInheritedHandles(
  file: string,
  args: readonly string[],
  options: WindowsNoInheritLaunchOptions = {},
  io: WindowsNoInheritLaunchIo = {},
): number {
  if ((io.platform ?? process.platform) !== "win32") {
    throw new Error("The no-inherited-handles launcher is Windows-only.");
  }
  const run = io.spawnSync ?? spawnSync;
  const powershell = (io.powershell ?? resolveTrustedWindowsPowerShellExe)();
  const result = run(
    powershell,
    [
      "-NoProfile",
      "-NoLogo",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      Buffer.from(buildWindowsNoInheritLaunchScript(file, args, options), "utf16le").toString("base64"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env },
      windowsHide: true,
      timeout: options.timeoutMs ?? 15_000,
    },
  );
  const pid = Number(String(result.stdout ?? "").trim().split(/\r?\n/u).pop());
  if (result.status !== 0 || !Number.isSafeInteger(pid) || pid <= 0) {
    const detail = String(result.stderr ?? result.stdout ?? "").trim();
    throw new Error(`Windows child launch failed${detail ? `: ${detail}` : "."}`);
  }
  return pid;
}

function forceKillTree(pid: number): void {
  const taskkill = `${resolveTrustedWindowsSystemDirectory()}\\taskkill.exe`;
  execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    stdio: "pipe",
    windowsHide: true,
  });
}

type OpenProcessFn = (access: number, inherit: number, pid: number) => Pointer | null;
type WaitForSingleObjectFn = (handle: Pointer, milliseconds: number) => number;
type CloseHandleFn = (handle: Pointer) => number;

function openProcessExitTracker(pid: number): { hasExited: () => boolean; close: () => void } {
  const kernel = dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "u32", "u32"], returns: "ptr" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
  });
  const openProcess = kernel.symbols.OpenProcess as OpenProcessFn;
  const waitForSingleObject = kernel.symbols.WaitForSingleObject as WaitForSingleObjectFn;
  const closeHandle = kernel.symbols.CloseHandle as CloseHandleFn;
  // SYNCHRONIZE is sufficient for WaitForSingleObject and keeps this exact
  // process object alive, so Windows cannot reuse its PID while we own it.
  const handle = openProcess(0x00100000, 0, pid);
  if (!handle) {
    kernel.close();
    throw new Error(`Could not track launched Windows process ${pid}.`);
  }
  let closed = false;
  return {
    hasExited: () => {
      if (closed) return true;
      const result = waitForSingleObject(handle, 0);
      if (result === 0) return true; // WAIT_OBJECT_0
      if (result === 258) return false; // WAIT_TIMEOUT
      throw new Error(`Could not read launched Windows process ${pid} state.`);
    },
    close: () => {
      if (closed) return;
      closed = true;
      closeHandle(handle);
      kernel.close();
    },
  };
}

/** Adapt a Start-Process PID to the small child contract used by sidecars. */
export function ownedWindowsProcess(
  pid: number,
  io: OwnedWindowsProcessIo = {},
): OwnedWindowsProcess {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owned Windows process PID.");
  const tracker = io.hasExited
    ? { hasExited: io.hasExited, close: io.closeTracker ?? (() => {}) }
    : openProcessExitTracker(pid);
  const killTree = io.killTree ?? forceKillTree;
  const pollMs = Math.max(10, Math.trunc(io.pollMs ?? 100));
  const exited = new Promise<number>(resolve => {
    const poll = () => {
      if (tracker.hasExited()) {
        tracker.close();
        resolve(0);
        return;
      }
      setTimeout(poll, pollMs);
    };
    poll();
  });
  return {
    pid,
    exited,
    // Windows has no soft POSIX SIGTERM for this process. Both escalation steps
    // therefore use taskkill /T /F, which also closes cmd/npm descendants.
    kill() {
      if (!tracker.hasExited()) killTree(pid);
    },
  };
}

export function spawnWindowsProcessWithoutInheritedHandles(
  file: string,
  args: readonly string[],
  options: WindowsNoInheritLaunchOptions = {},
): OwnedWindowsProcess {
  return ownedWindowsProcess(
    launchWindowsProcessWithoutInheritedHandles(file, args, options),
  );
}

/** Same handle-isolated launch without blocking a running server during PowerShell startup. */
export function spawnWindowsProcessWithoutInheritedHandlesAsync(
  file: string,
  args: readonly string[],
  options: WindowsNoInheritLaunchOptions = {},
): Promise<OwnedWindowsProcess> {
  if (process.platform !== "win32") return Promise.reject(new Error("The no-inherited-handles launcher is Windows-only."));
  return new Promise((resolve, reject) => {
    execFile(resolveTrustedWindowsPowerShellExe(), [
      "-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand",
      Buffer.from(buildWindowsNoInheritLaunchScript(file, args, options), "utf16le").toString("base64"),
    ], { encoding: "utf8", env: { ...process.env }, windowsHide: true, timeout: options.timeoutMs ?? 15_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      const pid = Number(stdout.trim().split(/\r?\n/u).pop());
      if (error || !Number.isSafeInteger(pid) || pid <= 0) {
        reject(new Error("Windows child launch failed or timed out."));
        return;
      }
      try { resolve(ownedWindowsProcess(pid)); } catch (error) { reject(error); }
    });
  });
}
