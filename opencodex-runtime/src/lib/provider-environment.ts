import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 as win32Path } from "node:path";
import type { OcxConfig } from "../types";
import { resolveTrustedWindowsSystemDirectory } from "./windows-elevation";

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENVIRONMENT_FILE_BYTES = 256 * 1024;
const MAX_ENVIRONMENT_COMMAND_BYTES = 512 * 1024;
const MAX_ENVIRONMENT_VALUE_BYTES = 64 * 1024;
const MAX_ENVIRONMENT_FILES = 64;
const ENVIRONMENT_COMMAND_TIMEOUT_MS = 1_500;

type EnvironmentMap = Record<string, string | undefined>;
type EnvironmentSource = "process" | "os" | "file";

export interface ProviderEnvironmentDiscoveryOptions {
  /** Test seam; production always uses process.platform. */
  platform?: NodeJS.Platform;
  /** Destination and highest-priority source. Defaults to process.env. */
  env?: EnvironmentMap;
  /** Test seam for a platform-independent fake user home. */
  homeDir?: string;
  /** Test seam; returns null for an unavailable or refused command. */
  runCommand?: (command: string, args: readonly string[]) => string | null;
  /** Test seam; production applies regular-file and size bounds before reading. */
  readFile?: (path: string) => string | null;
  /** Test seam for environment.d discovery. Entries must be base names. */
  readDirectory?: (path: string) => readonly string[];
  /** Exact persisted-source override, primarily for cross-platform tests. */
  persistedFiles?: readonly string[];
  /** Test seam for the Windows system directory; production uses GetSystemDirectoryW. */
  resolveWindowsSystemDirectory?: () => string | null;
}

export interface ProviderEnvironmentHydrationResult {
  referenced: number;
  loaded: number;
  /** Names are safe to report; values deliberately never leave process.env. */
  loadedNames: string[];
  missing: string[];
  sources: Record<string, EnvironmentSource>;
}

export function environmentReferenceName(value: string | undefined): string | null {
  if (!value) return null;
  const braced = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (braced) return braced[1]!;
  const bare = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  return bare ? bare[1]! : null;
}

/**
 * The only OS variables Remodex is allowed to discover.
 *
 * Provider credentials stay as `${NAME}` references in config.json. OAuth, forward-auth, and
 * local providers do not consume provider.apiKey, so an inert hand-edited value on one of those
 * rows must not authorize reading an unrelated variable from the user's environment.
 */
export function providerEnvironmentReferences(
  config: Pick<OcxConfig, "proxy" | "providers">,
): string[] {
  const names = new Set<string>();
  const add = (value: string | undefined) => {
    const name = environmentReferenceName(value);
    if (name && ENVIRONMENT_NAME.test(name)) names.add(name);
  };
  add(config.proxy);
  for (const provider of Object.values(config.providers)) {
    if (provider.authMode === "oauth" || provider.authMode === "forward" || provider.authMode === "local") continue;
    add(provider.apiKey);
    for (const entry of provider.apiKeyPool ?? []) add(entry.key);
  }
  return [...names].sort();
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validDiscoveredValue(value: string | undefined): value is string {
  return nonEmpty(value)
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= MAX_ENVIRONMENT_VALUE_BYTES;
}

function environmentValue(
  env: EnvironmentMap,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  const direct = env[name];
  if (nonEmpty(direct)) return direct;
  if (platform !== "win32") return undefined;
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? env[key] : undefined;
  return nonEmpty(value) ? value : undefined;
}

function defaultRunCommand(command: string, args: readonly string[]): string | null {
  try {
    const output = execFileSync(command, [...args], {
      encoding: "utf8",
      timeout: ENVIRONMENT_COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_ENVIRONMENT_COMMAND_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return typeof output === "string" ? output : null;
  } catch {
    return null;
  }
}

function defaultReadFile(path: string): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_ENVIRONMENT_FILE_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultReadDirectory(path: string): readonly string[] {
  try {
    return readdirSync(path).slice(0, MAX_ENVIRONMENT_FILES);
  } catch {
    return [];
  }
}

function decodeCString(value: string): string | null {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined) return null;
    if (escaped === "n") decoded += "\n";
    else if (escaped === "r") decoded += "\r";
    else if (escaped === "t") decoded += "\t";
    else if (escaped === "b") decoded += "\b";
    else if (escaped === "f") decoded += "\f";
    else if (escaped === "v") decoded += "\v";
    else if (escaped === "a") decoded += "\u0007";
    else if (escaped === "x") {
      const digits = value.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(digits)) return null;
      decoded += String.fromCodePoint(Number.parseInt(digits, 16));
      index += 2;
    } else if (escaped === "u" || escaped === "U") {
      const count = escaped === "u" ? 4 : 8;
      const digits = value.slice(index + 1, index + 1 + count);
      if (!new RegExp(`^[0-9A-Fa-f]{${count}}$`).test(digits)) return null;
      const point = Number.parseInt(digits, 16);
      if (point > 0x10ffff) return null;
      decoded += String.fromCodePoint(point);
      index += count;
    } else if (/[0-7]/.test(escaped)) {
      const tail = value.slice(index, index + 3).match(/^[0-7]{1,3}/)?.[0] ?? escaped;
      decoded += String.fromCodePoint(Number.parseInt(tail, 8));
      index += tail.length - 1;
    } else {
      decoded += escaped;
    }
  }
  return decoded;
}

function stripUnquotedComment(value: string): string {
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === "\"") {
      if (quote === character) quote = null;
      else if (quote === null) quote = character;
      continue;
    }
    if (character === "#" && quote === null && (index === 0 || /\s/.test(value[index - 1]!))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function decodeDoubleQuoted(value: string): string | null {
  if (/(^|[^\\])(?:\$\(|`|\$\{?[A-Za-z_])/.test(value)) return null;
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined) return null;
    // These are the only characters whose backslash is removed inside POSIX double quotes.
    decoded += ["$", "`", "\"", "\\"].includes(escaped) ? escaped : `\\${escaped}`;
  }
  return decoded;
}

function decodeUnquoted(value: string): string | null {
  if (/(^|[^\\])(?:\$\(|`|\$\{?[A-Za-z_]|;|&&|\|\||[<>|])/.test(value)) return null;
  let decoded = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      decoded += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else {
      decoded += character;
    }
  }
  return escaped ? null : decoded.trim();
}

function decodeAssignmentValue(rawValue: string): string | null {
  const value = stripUnquotedComment(rawValue).trim();
  if (!value) return null;
  let decoded: string | null;
  if (value.startsWith("$'") && value.endsWith("'") && value.length >= 3) {
    decoded = decodeCString(value.slice(2, -1));
  } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    decoded = value.slice(1, -1);
  } else if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
    decoded = decodeDoubleQuoted(value.slice(1, -1));
  } else {
    decoded = decodeUnquoted(value);
  }
  return validDiscoveredValue(decoded ?? undefined) ? decoded : null;
}

function assignmentFromLine(line: string): { name: string; rawValue: string } | null {
  const normalized = line.replace(/^\uFEFF/, "").trim();
  if (!normalized || normalized.startsWith("#")) return null;

  const shell = normalized.match(
    /^(?:(?:export|readonly|declare\s+-x|typeset\s+-x)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/,
  );
  if (shell) return { name: shell[1]!, rawValue: shell[2]! };

  const pam = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(?:DEFAULT|OVERRIDE)=(.+)$/);
  if (pam) return { name: pam[1]!, rawValue: pam[2]! };

  const words = normalized.match(
    /^(?:set\s+-(?:[A-Za-z]*[gxU][A-Za-z]*|[gxU]+)|setenv|launchctl\s+setenv)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/,
  );
  return words ? { name: words[1]!, rawValue: words[2]! } : null;
}

/** Parse direct assignments only. Shell code, substitutions, and sourced files are never run. */
export function parseEnvironmentAssignments(
  content: string,
  requestedNames: readonly string[],
): Record<string, string> {
  const requested = new Set(requestedNames.filter(name => ENVIRONMENT_NAME.test(name)));
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  if (requested.size === 0 || Buffer.byteLength(content, "utf8") > MAX_ENVIRONMENT_COMMAND_BYTES) return values;
  for (const line of content.split(/\r?\n/)) {
    const assignment = assignmentFromLine(line);
    if (!assignment || !requested.has(assignment.name)) continue;
    const value = decodeAssignmentValue(assignment.rawValue);
    if (value !== null) values[assignment.name] = value;
  }
  return values;
}

function environmentDirectoryFiles(
  directory: string,
  readDirectory: (path: string) => readonly string[],
): string[] {
  return readDirectory(directory)
    .filter(name => /^[A-Za-z0-9_.-]+\.(?:conf|env)$/.test(name))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_ENVIRONMENT_FILES)
    .map(name => join(directory, name));
}

function defaultPersistedFiles(
  platform: NodeJS.Platform,
  home: string,
  readDirectory: (path: string) => readonly string[],
): string[] {
  if (platform === "win32") return [];
  const files: string[] = [];
  if (platform === "linux") {
    files.push("/etc/environment");
    for (const directory of ["/usr/lib/environment.d", "/usr/local/lib/environment.d", "/etc/environment.d"]) {
      files.push(...environmentDirectoryFiles(directory, readDirectory));
    }
  }
  files.push(join(home, ".pam_environment"));
  files.push(...environmentDirectoryFiles(join(home, ".config", "environment.d"), readDirectory));
  files.push(
    join(home, ".profile"),
    join(home, ".bash_profile"),
    join(home, ".bash_login"),
    join(home, ".bashrc"),
    join(home, ".zshenv"),
    join(home, ".zprofile"),
    join(home, ".zshrc"),
    join(home, ".config", "fish", "config.fish"),
  );
  return files.slice(0, MAX_ENVIRONMENT_FILES);
}

function systemExecutable(candidates: readonly string[], fallback: string): string {
  return candidates.find(existsSync) ?? fallback;
}

function parseWindowsRegistryValue(output: string, requestedName: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 3 || columns[0]?.toLowerCase() !== requestedName.toLowerCase()) continue;
    if (!/^REG_(?:SZ|EXPAND_SZ)$/i.test(columns[1]!)) continue;
    const value = columns.slice(2).join("  ");
    if (validDiscoveredValue(value)) return value;
  }
  return null;
}

function discoverOsValues(
  names: readonly string[],
  platform: NodeJS.Platform,
  runCommand: (command: string, args: readonly string[]) => string | null,
  resolveWindowsSystemDirectory?: () => string | null,
): Record<string, string> {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  if (names.length === 0) return values;

  if (platform === "linux") {
    const systemctl = systemExecutable(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
    const output = runCommand(systemctl, ["--user", "show-environment"]);
    if (output) Object.assign(values, parseEnvironmentAssignments(output, names));
    return values;
  }

  if (platform === "darwin") {
    const launchctl = systemExecutable(["/bin/launchctl", "/usr/bin/launchctl"], "launchctl");
    for (const name of names) {
      const output = runCommand(launchctl, ["getenv", name]);
      const value = output?.replace(/[\r\n]+$/, "");
      if (validDiscoveredValue(value)) values[name] = value;
    }
    return values;
  }

  if (platform === "win32") {
    // SystemRoot/WINDIR are caller-controlled environment variables. Never use
    // them to select an executable that reads credentials; resolve System32
    // through the OS API and fail closed when that API is unavailable.
    let systemDirectory: string | null;
    try {
      systemDirectory = resolveWindowsSystemDirectory
        ? resolveWindowsSystemDirectory()
        : resolveTrustedWindowsSystemDirectory();
    } catch {
      return values;
    }
    if (!systemDirectory?.trim()) return values;
    const reg = win32Path.join(systemDirectory, "reg.exe");
    const roots = [
      "HKCU\\Environment",
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    ];
    for (const name of names) {
      for (const root of roots) {
        const output = runCommand(reg, ["query", root, "/v", name]);
        const value = output ? parseWindowsRegistryValue(output, name) : null;
        if (!value) continue;
        values[name] = value;
        break; // User environment wins over the machine environment.
      }
    }
  }
  return values;
}

/**
 * Resolve configured provider/proxy references from the current process, the OS user environment,
 * and safely parsed persisted user files, in that order. Only process.env is mutated. No value is
 * written to Remodex/Codex configuration or returned to callers.
 */
export function hydrateProviderEnvironment(
  config: Pick<OcxConfig, "proxy" | "providers">,
  options: ProviderEnvironmentDiscoveryOptions = {},
): ProviderEnvironmentHydrationResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const names = providerEnvironmentReferences(config);
  const sources: Record<string, EnvironmentSource> = Object.create(null) as Record<string, EnvironmentSource>;
  const unresolved: string[] = [];
  for (const name of names) {
    if (environmentValue(env, name, platform)) sources[name] = "process";
    else unresolved.push(name);
  }

  const runCommand = options.runCommand ?? defaultRunCommand;
  const osValues = discoverOsValues(
    unresolved,
    platform,
    runCommand,
    options.resolveWindowsSystemDirectory,
  );
  const afterOs: string[] = [];
  for (const name of unresolved) {
    const value = osValues[name];
    if (validDiscoveredValue(value)) {
      env[name] = value;
      sources[name] = "os";
    } else {
      afterOs.push(name);
    }
  }

  const readFile = options.readFile ?? defaultReadFile;
  const readDirectory = options.readDirectory ?? defaultReadDirectory;
  const home = options.homeDir ?? homedir();
  const persistedFiles = options.persistedFiles
    ? [...options.persistedFiles]
    : defaultPersistedFiles(platform, home, readDirectory);
  const fileValues: Record<string, string> = Object.create(null) as Record<string, string>;
  if (afterOs.length > 0) {
    for (const path of persistedFiles.slice(0, MAX_ENVIRONMENT_FILES)) {
      const content = readFile(path);
      if (content === null || Buffer.byteLength(content, "utf8") > MAX_ENVIRONMENT_FILE_BYTES) continue;
      Object.assign(fileValues, parseEnvironmentAssignments(content, afterOs));
    }
  }

  const missing: string[] = [];
  const loadedNames: string[] = [];
  for (const name of afterOs) {
    const value = fileValues[name];
    if (!validDiscoveredValue(value)) {
      missing.push(name);
      continue;
    }
    env[name] = value;
    sources[name] = "file";
  }
  for (const name of names) {
    if (sources[name] === "os" || sources[name] === "file") loadedNames.push(name);
  }

  return {
    referenced: names.length,
    loaded: loadedNames.length,
    loadedNames,
    missing,
    sources,
  };
}
