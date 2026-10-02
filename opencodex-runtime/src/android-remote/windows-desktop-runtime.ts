import { execFileSync } from "node:child_process";
import { win32 } from "node:path";
import { classifyDesktopClientSnapshot, type DesktopClientSnapshot } from "../codex/desktop-client-processes";
import { tokenizeCommandLine } from "../codex/app-server-processes";

export interface WindowsDesktopRuntimeProcess extends DesktopClientSnapshot {
  parentPid: number;
}

/** Only Desktop's own app-server establishes the version it uses for history. */
export function activeWindowsDesktopRuntimePaths(
  processes: readonly WindowsDesktopRuntimeProcess[],
): string[] {
  const desktops = new Set(processes.filter(process =>
    classifyDesktopClientSnapshot(process, "win32") !== null).map(process => process.pid));
  const paths = new Map<string, string>();
  for (const process of processes) {
    if (!desktops.has(process.parentPid) || win32.basename(process.executablePath).toLowerCase() !== "codex.exe") continue;
    const args = tokenizeCommandLine(process.commandLine);
    if (!args.includes("app-server") || args.some(arg => arg === "--listen" || arg.startsWith("--listen="))) continue;
    if (!args[0] || win32.normalize(args[0]).toLowerCase() !== win32.normalize(process.executablePath).toLowerCase()) continue;
    paths.set(win32.normalize(process.executablePath).toLowerCase(), process.executablePath);
  }
  return [...paths.values()];
}

export function readActiveWindowsDesktopRuntimePaths(): string[] {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$rows=@(Get-CimInstance Win32_Process -Filter \"Name='codex.exe' OR Name='ChatGPT.exe'\" | ForEach-Object {",
    "  $o=Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue",
    "  if($null -eq $o -or $o.ReturnValue -ne 0){return}",
    "  $owner=if($o.Domain){\"$($o.Domain)\\$($o.User)\"}else{$o.User}",
    "  if($owner -ine $me -or -not $_.ExecutablePath -or -not $_.CommandLine){return}",
    "  [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;executablePath=$_.ExecutablePath;commandLine=$_.CommandLine}",
    "})",
    "ConvertTo-Json -InputObject $rows -Compress",
  ].join("\n");
  try {
    const output = execFileSync("powershell.exe", [
      "-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script,
    ], { encoding: "utf8", windowsHide: true, timeout: 8_000, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return activeWindowsDesktopRuntimePaths(JSON.parse(output.replace(/^\uFEFF/, "").trim()));
  } catch {
    throw new Error("Could not check the running Codex Desktop version. Open Codex Desktop and reconnect Android.");
  }
}
