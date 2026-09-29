import {
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const REMODEX_HOME_DIRNAME = ".remodex";
export const LEGACY_REMODEX_HOME_DIRNAME = ".opencodex";

/**
 * Files that are specific enough to identify a previous Remodex state root.
 *
 * The migration deliberately does not move an arbitrary, user-created
 * `~/.opencodex` directory. A directory is eligible only when it contains a
 * known Remodex artifact, or a config.json with Remodex-shaped top-level keys.
 */
export const REMODEX_STATE_EVIDENCE_FILES = [
  ".opencodex-owner.json",
  ".opencodex-uninstall.json",
  "admin-api-token",
  "android-remote.json",
  "auto-update.cmd",
  "auto-update.vbs",
  "auto-update-task.xml",
  "auto-update.json",
  "auto-update.lock",
  "auto-update.log",
  "catalog-backup.json",
  "codex-runtime-clamp.json",
  "codex-runtime.json",
  "codex-shim.json",
  "desktop-runtime.log",
  "desktop-update.json",
  "ocx.pid",
  "responses-state.json",
  "runtime-port.json",
  "service-api-token",
  "service-provider-env.json",
  "service-state.json",
  "service.log",
  "tray-heartbeat.json",
  "tray-state.json",
  "usage-debug.jsonl",
  "usage.jsonl",
  "update-job.json",
  "winsw",
] as const;

const CONFIG_EVIDENCE_KEYS = [
  "providers",
  "defaultProvider",
  "clientIntegrations",
  "claudeCode",
  "grok",
  "tokenGuardian",
  "routingProfiles",
  "subagentModels",
] as const;
const MAX_EVIDENCE_CONFIG_BYTES = 256 * 1024;

type HomeStat = {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

export interface RemodexHomeIO {
  lstat(path: string): HomeStat;
  readdir(path: string): string[];
  readFile(path: string): string;
  rename(source: string, destination: string): void;
  removeEmptyDirectory?: (path: string) => void;
}

const defaultIO: RemodexHomeIO = {
  lstat: lstatSync,
  readdir: path => readdirSync(path),
  readFile: path => readFileSync(path, "utf8"),
  rename: renameSync,
  removeEmptyDirectory: rmdirSync,
};

export type DefaultRemodexHomeOutcome =
  | "canonical-existing"
  | "new"
  | "migrated"
  | "legacy-fallback"
  | "collision"
  | "canonical-blocked"
  | "migration-deferred";

export interface DefaultRemodexHomeResolution {
  readonly path: string;
  readonly canonicalPath: string;
  readonly legacyPath: string;
  readonly outcome: DefaultRemodexHomeOutcome;
  readonly legacyEvidence: boolean;
  readonly warning?: string;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isDirectory(path: string, io: RemodexHomeIO): boolean {
  try {
    const stat = io.lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function pathExists(path: string, io: RemodexHomeIO): boolean {
  try {
    io.lstat(path);
    return true;
  } catch {
    return false;
  }
}

function directoryNames(path: string, io: RemodexHomeIO): string[] | null {
  try {
    return io.readdir(path);
  } catch {
    return null;
  }
}

function hasConfigEvidence(path: string, io: RemodexHomeIO): boolean {
  const configPath = join(path, "config.json");
  let raw: string;
  try {
    const stat = io.lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    raw = io.readFile(configPath);
  } catch {
    return false;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_EVIDENCE_CONFIG_BYTES) return false;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return CONFIG_EVIDENCE_KEYS.some(key => Object.prototype.hasOwnProperty.call(value, key));
  } catch {
    return false;
  }
}

function hasServiceAssetEvidence(path: string, io: RemodexHomeIO): boolean {
  const names = directoryNames(path, io);
  if (!names) return false;
  return [
    "service-state.json",
    "opencodex-service.cmd",
    "opencodex-service-launcher.vbs",
    "opencodex-service-task.xml",
    "winsw",
  ].some(name => names.includes(name));
}

function normalizeComparablePath(path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/").replace(/\/+$/g, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * A legacy service is an active owner of the old root until its definition has
 * been rewritten. Moving the directory underneath it would make the manager
 * start a second default-root instance or lose its credentials on the next
 * login. Treat the asset set as a migration boundary even when the canonical
 * directory already exists.
 */
function legacyServiceOwnsPath(
  path: string,
  legacyPath: string,
  io: RemodexHomeIO,
): boolean {
  if (!hasServiceAssetEvidence(path, io)) return false;
  const statePath = join(path, "service-state.json");
  try {
    const stat = io.lstat(statePath);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      const parsed = JSON.parse(io.readFile(statePath)) as Record<string, unknown>;
      const recorded = typeof parsed.opencodexHome === "string"
        ? parsed.opencodexHome
        : undefined;
      if (recorded) return normalizeComparablePath(recorded) === normalizeComparablePath(legacyPath);
    }
  } catch {
    // A malformed state file is still not permission to move a service asset.
  }
  return true;
}

/** Return true only for a directory with unambiguous Remodex state evidence. */
export function hasStrongRemodexEvidence(
  path: string,
  io: RemodexHomeIO = defaultIO,
): boolean {
  if (!isDirectory(path, io)) return false;
  const names = directoryNames(path, io);
  if (!names) return false;
  const known = new Set<string>(REMODEX_STATE_EVIDENCE_FILES);
  if (names.some(name => known.has(name))) return true;
  return names.includes("config.json") && hasConfigEvidence(path, io);
}

/** True when the legacy root contains service assets that still claim ownership. */
export function hasLegacyRemodexServiceRoot(options: {
  home?: string;
  io?: RemodexHomeIO;
} = {}): boolean {
  const io = options.io ?? defaultIO;
  const home = resolve(options.home ?? homedir());
  const legacyPath = join(home, LEGACY_REMODEX_HOME_DIRNAME);
  return isDirectory(legacyPath, io)
    && hasStrongRemodexEvidence(legacyPath, io)
    && legacyServiceOwnsPath(legacyPath, legacyPath, io);
}

function nonEmptyDirectory(path: string, io: RemodexHomeIO): boolean {
  const names = directoryNames(path, io);
  return names === null || names.length > 0;
}

const emittedWarnings = new Set<string>();

function warningOnce(
  key: string,
  message: string,
  warn: (message: string) => void,
): void {
  if (emittedWarnings.has(key)) return;
  emittedWarnings.add(key);
  warn(message);
}

/**
 * Inspect whether an implicit legacy service root can be moved without changing
 * the filesystem. Callers use this before stopping the owning service so a
 * populated `.remodex` root cannot turn a recoverable repair into downtime.
 */
export function preflightLegacyRemodexServiceMigration(options: {
  home?: string;
  io?: RemodexHomeIO;
  warn?: (message: string) => void;
} = {}): DefaultRemodexHomeResolution {
  const io = options.io ?? defaultIO;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const home = resolve(options.home ?? homedir());
  const canonicalPath = join(home, REMODEX_HOME_DIRNAME);
  const legacyPath = join(home, LEGACY_REMODEX_HOME_DIRNAME);
  const canonicalDirectory = isDirectory(canonicalPath, io);
  const legacyDirectory = isDirectory(legacyPath, io);
  const legacyEvidence = legacyDirectory && hasStrongRemodexEvidence(legacyPath, io);

  if (!legacyDirectory || !legacyEvidence || !legacyServiceOwnsPath(legacyPath, legacyPath, io)) {
    return {
      path: canonicalDirectory ? canonicalPath : canonicalPath,
      canonicalPath,
      legacyPath,
      outcome: canonicalDirectory ? "canonical-existing" : "new",
      legacyEvidence,
    };
  }

  if (!pathExists(canonicalPath, io)) {
    return {
      path: canonicalPath,
      canonicalPath,
      legacyPath,
      outcome: "migrated",
      legacyEvidence: true,
    };
  }

  if (!canonicalDirectory) {
    const warning =
      `${canonicalPath} exists but is not a real directory; Remodex will not replace it.`;
    warningOnce(`${canonicalPath}:blocked`, warning, warn);
    return {
      path: canonicalPath,
      canonicalPath,
      legacyPath,
      outcome: "canonical-blocked",
      legacyEvidence: true,
      warning,
    };
  }

  const names = directoryNames(canonicalPath, io);
  const removeEmptyDirectory = io.removeEmptyDirectory;
  if (names === null || names.length > 0 || !removeEmptyDirectory) {
    const warning =
      `Remodex cannot move the legacy service root ${legacyPath} because `
      + `the canonical directory ${canonicalPath} is already populated. `
      + "No files were changed; resolve the two roots, then run `rmx service repair` again.";
    warningOnce(`${canonicalPath}:service-collision`, warning, warn);
    return {
      path: legacyPath,
      canonicalPath,
      legacyPath,
      outcome: "collision",
      legacyEvidence: true,
      warning,
    };
  }

  return {
    path: canonicalPath,
    canonicalPath,
    legacyPath,
    outcome: "migrated",
    legacyEvidence: true,
  };
}

function migrateLegacyServiceRoot(
  canonicalPath: string,
  legacyPath: string,
  io: RemodexHomeIO,
  warn: (message: string) => void,
): DefaultRemodexHomeResolution {
  const preflight = preflightLegacyRemodexServiceMigration({
    home: dirname(canonicalPath),
    io,
    warn,
  });
  if (preflight.outcome === "canonical-blocked" || preflight.outcome === "collision") {
    return preflight;
  }
  if (preflight.outcome !== "migrated") {
    return {
      ...preflight,
      path: canonicalPath,
      canonicalPath,
      legacyPath,
    };
  }

  const removeEmptyDirectory = io.removeEmptyDirectory;
  if (pathExists(canonicalPath, io)) {
    // A previous startup can leave an empty canonical directory behind. It is
    // safe to remove that empty placeholder; the read-only preflight above has
    // already established that it is empty.
    if (!removeEmptyDirectory) {
      return {
        path: legacyPath,
        canonicalPath,
        legacyPath,
        outcome: "collision",
        legacyEvidence: preflight.legacyEvidence,
        warning: preflight.warning
          ?? `Remodex could not remove the empty canonical directory ${canonicalPath}; no service-root migration was completed.`,
      };
    }
    try {
      removeEmptyDirectory(canonicalPath);
    } catch (error) {
      const code = errorCode(error);
      const warning =
        `Remodex could not remove the empty canonical directory ${canonicalPath}`
        + (code ? ` (${code})` : "")
        + "; no service-root migration was completed.";
      warningOnce(`${canonicalPath}:service-collision`, warning, warn);
      return {
        path: legacyPath,
        canonicalPath,
        legacyPath,
        outcome: "collision",
        legacyEvidence: preflight.legacyEvidence,
        warning,
      };
    }
  }

  try {
    io.rename(legacyPath, canonicalPath);
    return {
      path: canonicalPath,
      canonicalPath,
      legacyPath,
      outcome: "migrated",
      legacyEvidence: preflight.legacyEvidence,
    };
  } catch (error) {
    // Another Remodex process may have won the race. Only accept that outcome
    // when the old service root is gone; otherwise keep using the old root.
    if (isDirectory(canonicalPath, io) && !isDirectory(legacyPath, io)) {
      return {
        path: canonicalPath,
        canonicalPath,
        legacyPath,
        outcome: "canonical-existing",
        legacyEvidence: true,
      };
    }

    if (isDirectory(legacyPath, io)) {
      const code = errorCode(error);
      const warning =
        `Remodex could not move legacy service state from ${legacyPath} to ${canonicalPath}`
        + (code ? ` (${code})` : "")
        + ". The legacy root was left intact; retry `rmx service repair` after the service is stopped.";
      warningOnce(`${canonicalPath}:service-migration-failed`, warning, warn);
      return {
        path: legacyPath,
        canonicalPath,
        legacyPath,
        outcome: "legacy-fallback",
        legacyEvidence: true,
        warning,
      };
    }

    return {
      path: canonicalPath,
      canonicalPath,
      legacyPath,
      outcome: "new",
      legacyEvidence: true,
    };
  }
}

/**
 * Resolve the default Remodex state root.
 *
 * `OPENCODEX_HOME` is handled by the caller and remains an authoritative
 * explicit override. This function is only for the implicit per-user default.
 *
 * Migration is a same-parent directory rename, so it is atomic and never
 * merges two populated roots. If Windows has a locked file and the rename
 * cannot be completed, the legacy root is selected for this process so an
 * installed service is not accidentally duplicated under a new empty root.
 * A later process retries the migration.
 */
export function resolveDefaultRemodexHome(options: {
  home?: string;
  io?: RemodexHomeIO;
  warn?: (message: string) => void;
  /** Disabled by test harnesses and read-only probes; production defaults true. */
  migrate?: boolean;
  /**
   * Used only after the owning service has been stopped. This permits the
   * legacy service root to move even though ordinary startup deliberately
   * keeps it in place until its assets are rewritten.
   */
  forceLegacyServiceMigration?: boolean;
} = {}): DefaultRemodexHomeResolution {
  const io = options.io ?? defaultIO;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const migrate = options.migrate ?? true;
  const forceLegacyServiceMigration = options.forceLegacyServiceMigration ?? false;
  const home = resolve(options.home ?? homedir());
  const canonicalPath = join(home, REMODEX_HOME_DIRNAME);
  const legacyPath = join(home, LEGACY_REMODEX_HOME_DIRNAME);
  const canonicalDirectory = isDirectory(canonicalPath, io);
  const legacyDirectory = isDirectory(legacyPath, io);

  // A test process must never rename a real user's state root merely because
  // one test temporarily deletes OPENCODEX_HOME.
  if (!migrate) {
    return {
      path: canonicalPath,
      canonicalPath,
      legacyPath,
      outcome: canonicalDirectory ? "canonical-existing" : "migration-deferred",
      legacyEvidence: legacyDirectory && hasStrongRemodexEvidence(legacyPath, io),
    };
  }

  if (canonicalDirectory) {
    const legacyEvidence = hasStrongRemodexEvidence(legacyPath, io);
    if (legacyDirectory && legacyServiceOwnsPath(legacyPath, legacyPath, io)) {
      if (forceLegacyServiceMigration) {
        return migrateLegacyServiceRoot(canonicalPath, legacyPath, io, warn);
      }
      const warning =
        `Remodex is keeping the legacy state root ${legacyPath} because an installed `
        + "service still points there. Run `rmx service repair` after closing the "
        + "current proxy to move service state to the canonical .remodex directory.";
      warningOnce(`${canonicalPath}:legacy-service`, warning, warn);
      return {
        path: legacyPath,
        canonicalPath,
        legacyPath,
        outcome: "legacy-fallback",
        legacyEvidence,
        warning,
      };
    }
    const collision = legacyDirectory && nonEmptyDirectory(legacyPath, io);
    if (collision) {
      const warning =
        `Remodex found both ${canonicalPath} and legacy ${legacyPath}; `
        + `using ${canonicalPath} and leaving the legacy directory untouched. `
        + "Review the legacy directory before removing it.";
      warningOnce(`${canonicalPath}:collision`, warning, warn);
      return {
        path: canonicalPath,
        canonicalPath,
        legacyPath,
        outcome: "collision",
        legacyEvidence,
        warning,
      };
    }
    return {
      path: canonicalPath,
      canonicalPath,
      legacyPath,
      outcome: "canonical-existing",
      legacyEvidence,
    };
  }

  if (pathExists(canonicalPath, io)) {
    const warning =
      `${canonicalPath} exists but is not a real directory; Remodex will not replace it.`;
    warningOnce(`${canonicalPath}:blocked`, warning, warn);
    return {
      path: canonicalPath,
      canonicalPath,
      legacyPath,
      outcome: "canonical-blocked",
      legacyEvidence: false,
      warning,
    };
  }

  const legacyEvidence = legacyDirectory && hasStrongRemodexEvidence(legacyPath, io);
  if (!legacyEvidence) {
    return {
      path: canonicalPath,
      canonicalPath,
      legacyPath,
      outcome: "new",
      legacyEvidence: false,
    };
  }

  if (legacyServiceOwnsPath(legacyPath, legacyPath, io)) {
    if (forceLegacyServiceMigration) {
      return migrateLegacyServiceRoot(canonicalPath, legacyPath, io, warn);
    }
    const warning =
      `Remodex found an installed service under legacy state root ${legacyPath}; `
      + "it will remain there until `rmx service repair` rewrites the service safely.";
    warningOnce(`${canonicalPath}:legacy-service`, warning, warn);
    return {
      path: legacyPath,
      canonicalPath,
      legacyPath,
      outcome: "legacy-fallback",
      legacyEvidence: true,
      warning,
    };
  }

  try {
    io.rename(legacyPath, canonicalPath);
    return {
      path: canonicalPath,
      canonicalPath,
      legacyPath,
      outcome: "migrated",
      legacyEvidence: true,
    };
  } catch (error) {
    // Another Remodex process may have won the race. Re-read both entries
    // before deciding whether to fall back.
    if (isDirectory(canonicalPath, io)) {
      return {
        path: canonicalPath,
        canonicalPath,
        legacyPath,
        outcome: "canonical-existing",
        legacyEvidence: true,
      };
    }

    if (isDirectory(legacyPath, io)) {
      const code = errorCode(error);
      const warning =
        `Remodex could not move legacy state from ${legacyPath} to ${canonicalPath}`
        + (code ? ` (${code})` : "")
        + ". It will continue using the legacy directory temporarily; close Remodex/Codex "
        + "and try again so the migration can complete.";
      warningOnce(`${canonicalPath}:migration-failed`, warning, warn);
      return {
        path: legacyPath,
        canonicalPath,
        legacyPath,
        outcome: "legacy-fallback",
        legacyEvidence: true,
        warning,
      };
    }

    return {
      path: canonicalPath,
      canonicalPath,
      legacyPath,
      outcome: "new",
      legacyEvidence: true,
    };
  }
}

/** Test support for warning-memo isolation without exposing production state. */
export function clearRemodexHomeWarningMemosForTests(): void {
  emittedWarnings.clear();
}
