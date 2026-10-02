import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCodexVersionOutput, resolveCodexRuntime, type ResolvedCodexRuntime } from "../codex/runtime";
import { readActiveWindowsDesktopRuntimePaths } from "./windows-desktop-runtime";

export type AndroidRuntimeSelection = {
  runtime: ResolvedCodexRuntime;
  desktopVersion: string | null;
};

/** Compare history readers by exact version until cross-version support is proven. */
export function selectAndroidRuntime(
  selected: ResolvedCodexRuntime,
  desktopBuilds: readonly ResolvedCodexRuntime[],
): AndroidRuntimeSelection {
  if (desktopBuilds.length === 0) return { runtime: selected, desktopVersion: null };
  const versions = new Set(desktopBuilds.map(build => build.version));
  if (versions.size !== 1 || versions.has(null)) {
    throw new Error("Multiple or unrecognized Codex Desktop builds were found. Open one Codex Desktop version and reconnect Android so Remodex can use its running version.");
  }
  const desktop = desktopBuilds[0]!;
  if (selected.source === "environment") {
    if (selected.version !== desktop.version) {
      throw new Error(`CODEX_CLI_PATH selects Codex ${selected.version ?? "unknown"}, but Desktop uses ${desktop.version}. Update or remove CODEX_CLI_PATH so Android can use the matching Desktop version.`);
    }
    return { runtime: selected, desktopVersion: desktop.version };
  }
  // A saved CLI choice can outlive a Desktop update. The Android history reader
  // follows the verified Desktop executable, without changing the user's CLI
  // choice or restarting an already-connected task server. An environment pin
  // remains explicit and must be corrected by its owner if incompatible.
  return { runtime: desktop, desktopVersion: desktop.version };
}

export function resolveAndroidRuntime(): AndroidRuntimeSelection {
  const selected = resolveCodexRuntime({ discoverAlternatives: false }).runtime;
  const localAppData = process.env.LOCALAPPDATA;
  if (process.platform !== "win32" || !localAppData) {
    return { runtime: selected, desktopVersion: null };
  }
  const root = join(localAppData, "OpenAI", "Codex", "bin");
  // Windows keeps old version folders after updates. Prefer the app-server
  // parented by the current Desktop, never an orphaned Remodex listener.
  let commands = readActiveWindowsDesktopRuntimePaths();
  if (commands.length === 0) {
    let directories: string[];
    try { directories = readdirSync(root); } catch { return { runtime: selected, desktopVersion: null }; }
    commands = directories.slice(0, 32).map(directory => join(root, directory, "codex.exe"))
      .filter(command => existsSync(command));
  }
  const builds: ResolvedCodexRuntime[] = [];
  for (const command of commands) {
    const candidate = resolveCodexRuntime({
      discoverAlternatives: false,
      env: { ...process.env, CODEX_CLI_PATH: command },
    }).runtime;
    // The generic resolver can fall back when a probe fails. That fallback is
    // not evidence that this Desktop executable is usable.
    if (resolve(candidate.command).toLowerCase() !== resolve(command).toLowerCase()) {
      throw new Error("The installed Codex Desktop version could not be checked. Repair or update Desktop before connecting Android.");
    }
    builds.push(candidate);
  }
  return selectAndroidRuntime(selected, builds);
}

export class AndroidRuntimeVersionMismatchError extends Error {}

export function verifyAndroidRuntimePeer(userAgent: unknown, expectedVersion: string | null): string | null {
  const version = typeof userAgent === "string" ? parseCodexVersionOutput(userAgent) : null;
  if (expectedVersion && version !== expectedVersion) {
    throw new AndroidRuntimeVersionMismatchError(`The connected Codex server reports version ${version ?? "unknown"}; Android requires ${expectedVersion}. Restart the Android connection with the matching Codex version.`);
  }
  return version;
}
