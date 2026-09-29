/**
 * Narrow, current-user lifecycle support for the official Codex/ChatGPT desktop
 * client. This is intentionally separate from app-server restart: closing the
 * full GUI can discard unsaved input, so only explicitly confirmed UI actions
 * call this module.
 *
 * There is no broad process-name kill. We require a supported absolute install
 * path, reject Electron helper command lines, revalidate pid + command identity
 * immediately before requesting a close. The ordinary tray action remains
 * graceful-only; the dashboard's separately confirmed model takeover uses the
 * narrow hard-restart entrypoint below.
 */
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { waitForExit } from "../lib/process-control";
import { tokenizeCommandLine } from "./app-server-processes";

export type DesktopClientProduct = "codex" | "chatgpt";

export interface DesktopClientSnapshot {
  pid: number;
  commandLine: string;
  executablePath: string;
  uid?: number;
  owner?: string;
}

export interface DesktopClientProcess extends DesktopClientSnapshot {
  product: DesktopClientProduct;
}

export interface DesktopClientProcessIo {
  platform?: NodeJS.Platform;
  getuid?: () => number | undefined;
  listSnapshots?: () => DesktopClientSnapshot[];
}

export interface RestartDesktopClientIo {
  listProcesses?: () => DesktopClientProcess[];
  requestClose?: (target: DesktopClientProcess) => void;
  forceClose?: (target: DesktopClientProcess) => void;
  waitExit?: (pid: number, timeoutMs: number) => boolean;
  launch?: (target: DesktopClientProcess) => void | Promise<void>;
  platform?: NodeJS.Platform;
  /** Test seam for the bounded post-launch process check. */
  replacementTimeoutMs?: number;
  replacementPollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export type RestartDesktopClientResult =
  | { ok: true; target: DesktopClientProcess }
  | { ok: false; reason: "not_running" | "ambiguous" | "target_changed" | "close_failed" | "force_close_failed" | "still_running" | "launch_failed"; message: string };

function normalizedPath(path: string): string {
  return path.trim().replace(/\\/g, "/");
}

function supportedProduct(executablePath: string, platform: NodeJS.Platform): DesktopClientProduct | null {
  const normalized = normalizedPath(executablePath);
  const lower = normalized.toLowerCase();
  const executable = basename(lower);
  const product: DesktopClientProduct | null = executable === "codex" || executable === "codex.exe"
    ? "codex"
    : executable === "chatgpt" || executable === "chatgpt.exe"
      ? "chatgpt"
      : null;
  if (!product) return null;

  if (platform === "darwin") {
    return /^\/(?:applications|users\/[^/]+\/applications)\/(?:codex|chatgpt)[.]app\/contents\/macos\/(?:codex|chatgpt)$/i.test(normalized)
      ? product
      : null;
  }
  if (platform === "win32") {
    if (!/^[a-z]:\//i.test(normalized)) return null;
    return /\/(?:program files(?: \(x86\))?|users\/[^/]+\/appdata\/local\/programs|windowsapps)\//i.test(normalized)
      && /(?:\/|[.])(?:codex|chatgpt)(?:\/|_|[.])/i.test(normalized)
      ? product
      : null;
  }
  if (!/^(?:\/usr\/|\/opt\/|\/snap\/|\/var\/lib\/flatpak\/)/.test(lower)) return null;
  const segments = lower.split("/").filter(Boolean);
  const parent = segments.at(-2);
  return parent === "codex" || parent === "chatgpt" ? product : null;
}

/** True only for a top-level supported desktop executable, never an Electron helper. */
export function classifyDesktopClientSnapshot(
  snapshot: DesktopClientSnapshot,
  platform: NodeJS.Platform = process.platform,
): DesktopClientProcess | null {
  if (!Number.isSafeInteger(snapshot.pid) || snapshot.pid <= 1) return null;
  const product = supportedProduct(snapshot.executablePath, platform);
  if (!product) return null;
  const tokens = tokenizeCommandLine(snapshot.commandLine);
  if (tokens.length === 0) return null;
  if (normalizedPath(tokens[0]!).toLowerCase() !== normalizedPath(snapshot.executablePath).toLowerCase()) {
    return null;
  }
  if (tokens.slice(1).some(token => {
    const lower = token.toLowerCase();
    return lower.startsWith("--type=")
      || lower.startsWith("--utility-sub-type=")
      || lower.includes("crashpad-handler")
      || lower === "app-server"
      || lower.includes("code-mode-host");
  })) {
    return null;
  }
  return { ...snapshot, product };
}

function parseProcUid(status: string): number | undefined {
  const match = /^Uid:\s+(\d+)/m.exec(status);
  const uid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(uid) ? uid : undefined;
}

function listLinuxSnapshots(uid: number): DesktopClientSnapshot[] {
  const snapshots: DesktopClientSnapshot[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    try {
      const processUid = parseProcUid(readFileSync(`/proc/${pid}/status`, "utf8"));
      if (processUid !== uid) continue;
      const executablePath = readlinkSync(`/proc/${pid}/exe`);
      const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .replace(/\0/g, " ")
        .trim();
      if (!commandLine) continue;
      snapshots.push({ pid, commandLine, executablePath, uid: processUid });
    } catch {
      /* Process exited or became unreadable during the scan. */
    }
  }
  return snapshots;
}

function listDarwinSnapshots(uid: number): DesktopClientSnapshot[] {
  const output = execFileSync("ps", ["-u", String(uid), "-o", "pid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  const snapshots: DesktopClientSnapshot[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(raw);
    if (!match) continue;
    const pid = Number(match[1]);
    const commandLine = match[2]!.trim();
    const executablePath = tokenizeCommandLine(commandLine)[0];
    if (!Number.isSafeInteger(pid) || pid <= 1 || !executablePath) continue;
    snapshots.push({ pid, commandLine, executablePath, uid });
  }
  return snapshots;
}

function listWindowsSnapshots(): DesktopClientSnapshot[] {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('Codex.exe','ChatGPT.exe') } | ForEach-Object {",
    "  $o=Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue",
    "  if($null -eq $o -or $o.ReturnValue -ne 0){return}",
    "  $owner=if($o.Domain){\"$($o.Domain)\\$($o.User)\"}else{$o.User}",
    "  if($owner -ine $me -or [string]::IsNullOrWhiteSpace($_.ExecutablePath) -or [string]::IsNullOrWhiteSpace($_.CommandLine)){return}",
    "  $cmd=($_.CommandLine -replace \"`t\",\" \" -replace \"`r|`n\",\" \" )",
    "  \"{0}`t{1}`t{2}`t{3}\" -f $_.ProcessId,$_.ExecutablePath,$cmd,$owner",
    "}",
  ].join("\n");
  const output = execFileSync("powershell.exe", [
    "-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 8_000,
    windowsHide: true,
  });
  const snapshots: DesktopClientSnapshot[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const [pidRaw, executablePath, commandLine, owner] = raw.split("\t", 4);
    const pid = Number(pidRaw);
    if (!Number.isSafeInteger(pid) || pid <= 1 || !executablePath || !commandLine || !owner) continue;
    snapshots.push({ pid, executablePath, commandLine, owner });
  }
  return snapshots;
}

function currentUid(getuid?: () => number | undefined): number | undefined {
  try {
    return (getuid ?? (() => typeof process.getuid === "function" ? process.getuid() : undefined))();
  } catch {
    return undefined;
  }
}

/** Enumerate only identity-checked top-level clients owned by the current user. */
export function listDesktopClientProcesses(io: DesktopClientProcessIo = {}): DesktopClientProcess[] {
  const platform = io.platform ?? process.platform;
  let snapshots: DesktopClientSnapshot[];
  try {
    if (io.listSnapshots) snapshots = io.listSnapshots();
    else if (platform === "win32") snapshots = listWindowsSnapshots();
    else {
      const uid = currentUid(io.getuid);
      if (uid === undefined) return [];
      snapshots = platform === "darwin" ? listDarwinSnapshots(uid) : listLinuxSnapshots(uid);
    }
  } catch {
    return [];
  }
  const seen = new Set<number>();
  const matched: DesktopClientProcess[] = [];
  for (const snapshot of snapshots) {
    if (seen.has(snapshot.pid)) continue;
    const process = classifyDesktopClientSnapshot(snapshot, platform);
    if (!process) continue;
    seen.add(process.pid);
    matched.push(process);
  }
  return matched;
}

export function desktopClientProcessIdentity(target: DesktopClientProcess): string {
  return `${target.pid}\0${normalizedPath(target.executablePath).toLowerCase()}\0${target.commandLine.trim().replace(/\s+/g, " ")}`;
}

function defaultRequestClose(target: DesktopClientProcess, platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    process.kill(target.pid, "SIGTERM");
    return;
  }
  const script = [
    `$p=Get-Process -Id ${target.pid} -ErrorAction Stop`,
    "if(-not $p.CloseMainWindow()){exit 4}",
  ].join(";");
  execFileSync("powershell.exe", [
    "-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script,
  ], { stdio: "ignore", timeout: 5_000, windowsHide: true });
}

function defaultForceClose(target: DesktopClientProcess, platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    process.kill(target.pid, "SIGKILL");
    return;
  }
  const systemRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim() || "C:\\Windows";
  execFileSync(join(systemRoot, "System32", "taskkill.exe"), [
    "/PID",
    String(target.pid),
    "/T",
    "/F",
  ], { stdio: "ignore", timeout: 5_000, windowsHide: true });
}

function macosAppBundle(executablePath: string): string | null {
  const normalized = normalizedPath(executablePath);
  const marker = normalized.toLowerCase().indexOf(".app/contents/macos/");
  return marker < 0 ? null : normalized.slice(0, marker + 4);
}

function windowsExplorerPath(): string {
  const root = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim() || "C:\\Windows";
  return join(root, "explorer.exe");
}

function powershellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

export function isValidWindowsAppUserModelId(
  value: string,
  product?: DesktopClientProduct,
): boolean {
  if (!/^[A-Za-z0-9._~-]{1,255}![A-Za-z0-9._~-]{1,255}$/.test(value)) return false;
  if (!product) return true;
  const lower = value.toLowerCase();
  return lower.includes(product) || lower.includes("openai");
}

/**
 * Resolve a packaged executable to exactly one current-user AUMID. The path
 * match is preferred; the Start-menu AppID fallback covers execution aliases
 * under AppData\Local\Microsoft\WindowsApps.
 */
export function windowsAppUserModelIdDiscoveryScript(target: DesktopClientProcess): string {
  const executable = powershellSingleQuoted(target.executablePath);
  const productName = target.product === "chatgpt" ? "ChatGPT" : "Codex";
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$target=[IO.Path]::GetFullPath('${executable}')`,
    `$product='${productName}'`,
    "$ids=@()",
    "foreach($package in @(Get-AppxPackage)){",
    "  $location=[string]$package.InstallLocation",
    "  if([string]::IsNullOrWhiteSpace($location)){continue}",
    "  try{$root=[IO.Path]::GetFullPath($location).TrimEnd('\\')+'\\'}catch{continue}",
    "  if(-not $target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){continue}",
    "  $manifest=Get-AppxPackageManifest -Package $package",
    "  foreach($application in @($manifest.Package.Applications.Application)){",
    "    $relative=[string]$application.Executable",
    "    if([string]::IsNullOrWhiteSpace($relative)){continue}",
    "    try{$candidate=[IO.Path]::GetFullPath((Join-Path $location $relative))}catch{continue}",
    "    if([string]::Equals($candidate,$target,[StringComparison]::OrdinalIgnoreCase)){",
    "      $ids += \"$($package.PackageFamilyName)!$($application.Id)\"",
    "    }",
    "  }",
    "}",
    "if($ids.Count -eq 0){",
    "  $ids += @(Get-StartApps | Where-Object {$_.Name -ieq $product} | ForEach-Object {[string]$_.AppID})",
    "}",
    "$ids=@($ids | Where-Object {-not [string]::IsNullOrWhiteSpace($_)} | Sort-Object -Unique)",
    "if($ids.Count -ne 1){exit 3}",
    "[Console]::Out.Write($ids[0])",
  ].join("\n");
}

function resolveWindowsAppUserModelId(target: DesktopClientProcess): string | null {
  const script = windowsAppUserModelIdDiscoveryScript(target);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const value = execFileSync("powershell.exe", [
      "-NoProfile",
      "-NoLogo",
      "-NonInteractive",
      "-EncodedCommand",
      encoded,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8_000,
      windowsHide: true,
    }).trim();
    return isValidWindowsAppUserModelId(value, target.product) ? value : null;
  } catch {
    return null;
  }
}

function spawnDetached(
  command: string,
  args: readonly string[],
  options: { cwd?: string; windowsHide?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: options.windowsHide,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    // Keep the listener attached after a successful `spawn` event. A late
    // platform error must be consumed rather than becoming an uncaught
    // exception in the tray action process.
    child.once("error", error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

async function defaultLaunch(target: DesktopClientProcess, platform: NodeJS.Platform): Promise<void> {
  if (platform === "darwin") {
    const bundle = macosAppBundle(target.executablePath);
    if (!bundle) throw new Error("desktop app bundle could not be resolved");
    await spawnDetached("open", ["-n", bundle], {
      cwd: dirname(bundle),
      windowsHide: true,
    });
    return;
  }

  if (platform === "win32") {
    const appUserModelId = resolveWindowsAppUserModelId(target);
    if (appUserModelId) {
      try {
        await spawnDetached(
          windowsExplorerPath(),
          [`shell:AppsFolder\\${appUserModelId}`],
          {
            cwd: dirname(windowsExplorerPath()),
            windowsHide: true,
          },
        );
        return;
      } catch {
        // Continue to the identity-checked executable fallbacks below. The
        // post-launch process verification still decides whether restart
        // actually succeeded.
      }
    }
    try {
      await spawnDetached(target.executablePath, [], {
        cwd: dirname(target.executablePath),
        windowsHide: false,
      });
    } catch (directError) {
      // Packaged WindowsApps/MSIX launches can reject a direct executable
      // request even though Explorer can activate the registered app. The
      // path was already identity-checked, so this fallback does not broaden
      // which application may be started.
      try {
        await spawnDetached(windowsExplorerPath(), [target.executablePath], {
          cwd: dirname(windowsExplorerPath()),
          windowsHide: true,
        });
      } catch (fallbackError) {
        throw new Error(
          `direct launch failed: ${directError instanceof Error ? directError.message : String(directError)}; ` +
          `Explorer fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        );
      }
    }
    return;
  }

  await spawnDetached(target.executablePath, [], {
    cwd: dirname(target.executablePath),
    windowsHide: true,
  });
}

function replacementFor(
  processes: DesktopClientProcess[],
  target: DesktopClientProcess,
): DesktopClientProcess | null {
  const executable = normalizedPath(target.executablePath).toLowerCase();
  return processes.find(candidate =>
    candidate.pid !== target.pid
    && candidate.product === target.product
    && normalizedPath(candidate.executablePath).toLowerCase() === executable,
  ) ?? null;
}

async function waitForReplacement(
  list: () => DesktopClientProcess[],
  target: DesktopClientProcess,
  options: Pick<RestartDesktopClientIo, "replacementTimeoutMs" | "replacementPollIntervalMs" | "sleep" | "now"> = {},
): Promise<DesktopClientProcess | null> {
  const timeoutMs = Math.max(0, options.replacementTimeoutMs ?? 10_000);
  const intervalMs = Math.max(1, options.replacementPollIntervalMs ?? 100);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => {
    setTimeout(resolve, milliseconds);
  }));
  const deadline = now() + timeoutMs;
  // The attempt cap keeps injected clocks/sleeps from creating an accidental
  // infinite loop while retaining a time-based bound in production.
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs) + 1);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const replacement = replacementFor(list(), target);
      if (replacement) return replacement;
    } catch {
      // A process enumeration race is normal while an app is exiting/starting.
      // Keep polling until the bounded deadline rather than reporting a false
      // success or crashing the action worker.
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return null;
}

/** Gracefully close and relaunch exactly one supported desktop client. */
export async function restartDesktopClient(
  io: RestartDesktopClientIo = {},
): Promise<RestartDesktopClientResult> {
  const platform = io.platform ?? process.platform;
  const list = io.listProcesses ?? (() => listDesktopClientProcesses({ platform }));
  const targets = list();
  if (targets.length === 0) {
    return { ok: false, reason: "not_running", message: "No supported Codex/ChatGPT desktop application is running." };
  }
  if (targets.length !== 1) {
    return { ok: false, reason: "ambiguous", message: "Multiple desktop applications matched; close and reopen the intended one manually." };
  }
  const target = targets[0]!;
  const current = list().find(candidate => candidate.pid === target.pid);
  if (!current || desktopClientProcessIdentity(current) !== desktopClientProcessIdentity(target)) {
    return { ok: false, reason: "target_changed", message: "The desktop application changed before restart; nothing was closed." };
  }
  try {
    (io.requestClose ?? (candidate => defaultRequestClose(candidate, platform)))(target);
  } catch (error) {
    return {
      ok: false,
      reason: "close_failed",
      message: `The desktop application did not accept a graceful close: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const exited = (io.waitExit ?? waitForExit)(target.pid, 8_000);
  if (!exited) {
    return { ok: false, reason: "still_running", message: "The desktop application is still running; no force-close was attempted." };
  }
  try {
    await (io.launch ?? (candidate => defaultLaunch(candidate, platform)))(target);
  } catch (error) {
    return {
      ok: false,
      reason: "launch_failed",
      message: `The desktop application closed but could not be relaunched: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const replacement = await waitForReplacement(list, target, io);
  if (!replacement) {
    return {
      ok: false,
      reason: "launch_failed",
      message: "The desktop application launch was requested, but no replacement process appeared within 10 seconds.",
    };
  }
  return { ok: true, target };
}

/** Force-close and relaunch one identity-checked Codex/ChatGPT desktop client. */
export async function hardRestartDesktopClient(
  io: RestartDesktopClientIo = {},
): Promise<RestartDesktopClientResult> {
  const platform = io.platform ?? process.platform;
  const list = io.listProcesses ?? (() => listDesktopClientProcesses({ platform }));
  const targets = list();
  if (targets.length === 0) {
    return { ok: false, reason: "not_running", message: "No supported Codex/ChatGPT desktop application is running." };
  }
  if (targets.length !== 1) {
    return { ok: false, reason: "ambiguous", message: "Multiple desktop applications matched; restart the intended one manually." };
  }
  const target = targets[0]!;
  const current = list().find(candidate => candidate.pid === target.pid);
  if (!current || desktopClientProcessIdentity(current) !== desktopClientProcessIdentity(target)) {
    return { ok: false, reason: "target_changed", message: "The desktop application changed before restart; nothing was force-closed." };
  }
  try {
    (io.forceClose ?? (candidate => defaultForceClose(candidate, platform)))(target);
  } catch (error) {
    return {
      ok: false,
      reason: "force_close_failed",
      message: `The desktop application could not be force-closed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const exited = (io.waitExit ?? waitForExit)(target.pid, 5_000);
  if (!exited) {
    return { ok: false, reason: "still_running", message: "The desktop application is still running after the force-close request." };
  }
  try {
    await (io.launch ?? (candidate => defaultLaunch(candidate, platform)))(target);
  } catch (error) {
    return {
      ok: false,
      reason: "launch_failed",
      message: `The desktop application was force-closed but could not be relaunched: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const replacement = await waitForReplacement(list, target, io);
  if (!replacement) {
    return {
      ok: false,
      reason: "launch_failed",
      message: "The desktop application launch was requested, but no replacement process appeared within 10 seconds.",
    };
  }
  return { ok: true, target };
}
