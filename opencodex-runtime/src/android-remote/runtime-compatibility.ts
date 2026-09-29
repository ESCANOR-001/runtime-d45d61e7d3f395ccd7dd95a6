import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseCodexVersionOutput, resolveCodexRuntime, type ResolvedCodexRuntime } from "../codex/runtime";

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
    throw new Error("Multiple or unrecognized Codex Desktop builds were found. Keep one Desktop version installed before connecting Android so both apps read history the same way.");
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
  let directories: string[];
  try { directories = readdirSync(root); } catch { return { runtime: selected, desktopVersion: null }; }
  const builds: ResolvedCodexRuntime[] = [];
  for (const directory of directories.slice(0, 32)) {
    const command = join(root, directory, "codex.exe");
    if (!existsSync(command)) continue;
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

export function verifyAndroidRuntimePeer(userAgent: unknown, expectedVersion: string | null): string | null {
  const version = typeof userAgent === "string" ? parseCodexVersionOutput(userAgent) : null;
  if (expectedVersion && version !== expectedVersion) {
    throw new Error(`The connected Codex server reports version ${version ?? "unknown"}; Android requires ${expectedVersion}. Restart the Android connection with the matching Codex version.`);
  }
  return version;
}
