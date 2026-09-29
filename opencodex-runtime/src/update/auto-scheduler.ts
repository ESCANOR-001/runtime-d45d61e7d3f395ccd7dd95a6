/**
 * Cross-platform unattended Remodex updater.
 *
 * The scheduler is intentionally separate from the long-running proxy service:
 * service mode must remain quiet, while this short-lived job owns the package
 * replacement, restart confirmation, and rollback record.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWriteFile,
  expandUserPath,
  getConfigDir,
} from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { isProcessAlive } from "../lib/process-control";
import { resolveTrustedWindowsSchtasksExe } from "../lib/windows-elevation";
import { findLiveProxy } from "../server/proxy-liveness";
import { probeWindowsSchedulerTask } from "../service";
import {
  checkUpdatePackageIntegrity,
  currentVersion,
  defaultUpdateTag,
  detectInstall,
  PKG,
  type Channel,
  type Installer,
} from "./index";
import {
  checkForUpdate,
  packageLauncherPath,
  readUpdateJob,
  runGuiUpdateWorker,
  staleActiveUpdateJobReason,
  type UpdateJobState,
  type UpdateCheckResult,
} from "./job";

export const AUTO_UPDATE_STATE_FILENAME = "auto-update.json";
export const AUTO_UPDATE_LOG_FILENAME = "auto-update.log";
export const AUTO_UPDATE_LOCK_FILENAME = "auto-update.lock";
export const AUTO_UPDATE_WINDOWS_SCRIPT_FILENAME = "auto-update.vbs";
export const AUTO_UPDATE_WINDOWS_XML_FILENAME = "auto-update-task.xml";
export const AUTO_UPDATE_WINDOWS_TASK_NAME = "Remodex-AutoUpdate";
export const AUTO_UPDATE_LAUNCHD_LABEL = "com.remodex.auto-update";
export const AUTO_UPDATE_SYSTEMD_SERVICE = "remodex-auto-update.service";
export const AUTO_UPDATE_SYSTEMD_TIMER = "remodex-auto-update.timer";

export const AUTO_UPDATE_DEFAULT_HOUR = 3;
export const AUTO_UPDATE_DEFAULT_MINUTE = 0;
export const AUTO_UPDATE_LOCK_STALE_MS = 6 * 60 * 60 * 1000;
export const AUTO_UPDATE_LOCK_MALFORMED_STALE_MS = 24 * 60 * 60 * 1000;
export const AUTO_UPDATE_HEALTH_TIMEOUT_MS = 45_000;
export const AUTO_UPDATE_COMMAND_TIMEOUT_MS = 8 * 60_000;

export type AutoUpdateSchedulerKind =
  | "windows-task"
  | "launchd"
  | "systemd-user-timer";

export type AutoUpdateResult =
  | "running"
  | "updated"
  | "already_current"
  | "skipped"
  | "failed"
  | "busy";

export type AutoUpdateErrorCode =
  | "source_checkout"
  | "unsupported_platform"
  | "scheduler_unavailable"
  | "scheduler_registration_failed"
  | "scheduler_query_failed"
  | "invalid_channel"
  | "invalid_state"
  | "integrity_unavailable"
  | "integrity_invalid"
  | "update_unavailable"
  | "update_failed"
  | "health_failed"
  | "rollback_integrity_unavailable"
  | "rollback_failed"
  | "worker_failed";

export interface AutoUpdateSchedule {
  kind: "daily";
  hour: number;
  minute: number;
}

export interface AutoUpdateRollback {
  attemptedAt: string;
  version: string;
  result: "running" | "succeeded" | "failed";
}

export interface AutoUpdateState {
  version: 1;
  schedulerRevision?: number;
  enabled: boolean;
  channel: Channel;
  schedule: AutoUpdateSchedule;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  lastFinishedAt?: string;
  lastResult?: AutoUpdateResult;
  currentVersion?: string;
  targetVersion?: string;
  previousVersion?: string;
  lastErrorCode?: AutoUpdateErrorCode;
  rollback?: AutoUpdateRollback;
  lastJobId?: string;
}

export type AutoSchedulerPresence = "present" | "absent" | "unknown";

export interface AutoUpdatePaths {
  configDir: string;
  homeDir: string;
  statePath: string;
  logPath: string;
  lockPath: string;
  windowsScriptPath: string;
  windowsXmlPath: string;
  launchdPlistPath: string;
  systemdServicePath: string;
  systemdTimerPath: string;
}

export interface AutoUpdateRuntimePaths {
  nodePath: string;
  launcherPath: string;
  configDir: string;
  codexHome?: string;
  path?: string;
}

export interface AutoUpdateCommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
}

export type AutoUpdateCommandRunner = (
  file: string,
  args: readonly string[],
) => AutoUpdateCommandResult;

export interface AutoUpdateSchedulerDeps {
  platform?: NodeJS.Platform;
  configDir?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  launcherPath?: string;
  uid?: number;
  schtasksPath?: string;
  launchctlPath?: string;
  systemctlPath?: string;
  runCommand?: AutoUpdateCommandRunner;
  now?: () => number;
  probeWindows?: () => AutoSchedulerPresence;
  probeLaunchd?: () => AutoSchedulerPresence;
  probeSystemd?: () => AutoSchedulerPresence;
  installer?: Installer;
  currentVersion?: string;
}

export interface AutoUpdateStatus {
  enabled: boolean;
  defaultEnabled: boolean;
  supported: boolean;
  installer: Installer;
  channel: Channel;
  schedule: AutoUpdateSchedule;
  schedulerKind: AutoUpdateSchedulerKind | null;
  scheduler: AutoSchedulerPresence;
  state: AutoUpdateState | null;
  paths: AutoUpdatePaths;
}

export interface AutoUpdateRunResult {
  ok: boolean;
  result: AutoUpdateResult;
  currentVersion: string;
  targetVersion: string | null;
  rolledBack: boolean;
}

export interface AutoUpdateWorkerDeps {
  activityFn?: () => Promise<{ known: boolean; running: number; source?: boolean }>;
  now?: () => number;
  checkForUpdateFn?: (channel: Channel) => UpdateCheckResult;
  integrityFn?: (version: string) => ReturnType<typeof checkUpdatePackageIntegrity>;
  runGuiWorkerFn?: (
    jobId: string,
    channel: Channel,
    restart: boolean,
    io: {
      checkForUpdateFn?: (channel: Channel) => UpdateCheckResult;
      integrityFn?: (version: string | null) => ReturnType<typeof checkUpdatePackageIntegrity>;
      exactVersion?: string;
      beforeStopFn?: () => Promise<boolean>;
    },
  ) => Promise<void>;
  currentVersionFn?: () => string;
  installedVersionFn?: () => string | null;
  isProcessAliveFn?: (pid: number) => boolean;
  healthFn?: () => Promise<boolean>;
  configDir?: string;
  installer?: Installer;
  readUpdateJobFn?: (jobId?: string | null) => UpdateJobState | null;
}

export class AutoUpdateError extends Error {
  constructor(
    message: string,
    readonly code: AutoUpdateErrorCode,
  ) {
    super(message);
    this.name = "AutoUpdateError";
  }
}

const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLED_PACKAGE_ROOT = resolve(HERE, "..", "..");
const AUTO_RESULT_VALUES = new Set<AutoUpdateResult>([
  "running",
  "updated",
  "already_current",
  "skipped",
  "failed",
  "busy",
]);
const AUTO_ERROR_VALUES = new Set<AutoUpdateErrorCode>([
  "source_checkout",
  "unsupported_platform",
  "scheduler_unavailable",
  "scheduler_registration_failed",
  "scheduler_query_failed",
  "invalid_channel",
  "invalid_state",
  "integrity_unavailable",
  "integrity_invalid",
  "update_unavailable",
  "update_failed",
  "health_failed",
  "rollback_integrity_unavailable",
  "rollback_failed",
  "worker_failed",
]);

export function isAutoUpdateVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && SAFE_VERSION.test(value);
}

function isAutoUpdateChannel(value: unknown): value is Channel {
  return value === "latest" || value === "preview";
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is "win32" | "darwin" | "linux" {
  return platform === "win32" || platform === "darwin" || platform === "linux";
}

export function autoUpdateSchedulerKind(
  platform: NodeJS.Platform = process.platform,
): AutoUpdateSchedulerKind | null {
  if (platform === "win32") return "windows-task";
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd-user-timer";
  return null;
}

export function autoUpdatePaths(options: {
  configDir?: string;
  homeDir?: string;
} = {}): AutoUpdatePaths {
  const configDir = resolve(options.configDir ?? getConfigDir());
  const homeDir = resolve(options.homeDir ?? homedir());
  const launchAgents = join(homeDir, "Library", "LaunchAgents");
  const systemdUser = join(homeDir, ".config", "systemd", "user");
  return {
    configDir,
    homeDir,
    statePath: join(configDir, AUTO_UPDATE_STATE_FILENAME),
    logPath: join(configDir, AUTO_UPDATE_LOG_FILENAME),
    lockPath: join(configDir, AUTO_UPDATE_LOCK_FILENAME),
    windowsScriptPath: join(configDir, AUTO_UPDATE_WINDOWS_SCRIPT_FILENAME),
    windowsXmlPath: join(configDir, AUTO_UPDATE_WINDOWS_XML_FILENAME),
    launchdPlistPath: join(launchAgents, `${AUTO_UPDATE_LAUNCHD_LABEL}.plist`),
    systemdServicePath: join(systemdUser, AUTO_UPDATE_SYSTEMD_SERVICE),
    systemdTimerPath: join(systemdUser, AUTO_UPDATE_SYSTEMD_TIMER),
  };
}

export function autoUpdateStatePath(configDir = getConfigDir()): string {
  return autoUpdatePaths({ configDir }).statePath;
}

export function autoUpdateLogPath(configDir = getConfigDir()): string {
  return autoUpdatePaths({ configDir }).logPath;
}

export function autoUpdateLockPath(configDir = getConfigDir()): string {
  return autoUpdatePaths({ configDir }).lockPath;
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function parseSchedule(value: unknown): AutoUpdateSchedule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const schedule = value as Record<string, unknown>;
  if (
    schedule.kind !== "daily"
    || !Number.isInteger(schedule.hour)
    || !Number.isInteger(schedule.minute)
    || Number(schedule.hour) < 0
    || Number(schedule.hour) > 23
    || Number(schedule.minute) < 0
    || Number(schedule.minute) > 59
  ) return null;
  return {
    kind: "daily",
    hour: Number(schedule.hour),
    minute: Number(schedule.minute),
  };
}

function parseRollback(value: unknown): AutoUpdateRollback | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rollback = value as Record<string, unknown>;
  if (
    !isValidTimestamp(rollback.attemptedAt)
    || !isAutoUpdateVersion(rollback.version)
    || (rollback.result !== "running" && rollback.result !== "succeeded" && rollback.result !== "failed")
  ) return undefined;
  return {
    attemptedAt: rollback.attemptedAt,
    version: rollback.version,
    result: rollback.result,
  };
}

export function parseAutoUpdateState(value: unknown): AutoUpdateState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const schedule = parseSchedule(raw.schedule);
  if (
    raw.version !== 1
    || typeof raw.enabled !== "boolean"
    || (raw.channel !== "latest" && raw.channel !== "preview")
    || !schedule
    || !isValidTimestamp(raw.createdAt)
    || !isValidTimestamp(raw.updatedAt)
  ) return null;

  const state: AutoUpdateState = {
    version: 1,
    ...(raw.schedulerRevision === 2 ? { schedulerRevision: 2 } : {}),
    enabled: raw.enabled,
    channel: raw.channel,
    schedule,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  if (raw.lastAttemptAt !== undefined && !isValidTimestamp(raw.lastAttemptAt)) return null;
  if (raw.lastFinishedAt !== undefined && !isValidTimestamp(raw.lastFinishedAt)) return null;
  if (raw.lastResult !== undefined && (
    typeof raw.lastResult !== "string" || !AUTO_RESULT_VALUES.has(raw.lastResult as AutoUpdateResult)
  )) return null;
  if (raw.currentVersion !== undefined && !isAutoUpdateVersion(raw.currentVersion)) return null;
  if (raw.targetVersion !== undefined && !isAutoUpdateVersion(raw.targetVersion)) return null;
  if (raw.previousVersion !== undefined && !isAutoUpdateVersion(raw.previousVersion)) return null;
  if (raw.lastErrorCode !== undefined && (
    typeof raw.lastErrorCode !== "string" || !AUTO_ERROR_VALUES.has(raw.lastErrorCode as AutoUpdateErrorCode)
  )) return null;
  if (raw.lastJobId !== undefined && (
    typeof raw.lastJobId !== "string" || raw.lastJobId.length > 100 || !/^[A-Za-z0-9._-]+$/.test(raw.lastJobId)
  )) return null;
  const rollback = parseRollback(raw.rollback);
  if (raw.rollback !== undefined && !rollback) return null;

  for (const key of ["lastAttemptAt", "lastFinishedAt", "lastResult", "currentVersion", "targetVersion", "previousVersion", "lastErrorCode", "lastJobId"] as const) {
    if (raw[key] !== undefined) (state as unknown as Record<string, unknown>)[key] = raw[key];
  }
  if (rollback) state.rollback = rollback;
  return state;
}

export function readAutoUpdateState(configDir = getConfigDir()): AutoUpdateState | null {
  try {
    return parseAutoUpdateState(JSON.parse(readFileSync(autoUpdateStatePath(configDir), "utf8")));
  } catch {
    return null;
  }
}

function stateFileExists(configDir: string): boolean {
  try {
    return existsSync(autoUpdateStatePath(configDir));
  } catch {
    return false;
  }
}

function ensureStateOwnership(paths: AutoUpdatePaths): void {
  if (!existsSync(paths.configDir)) mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  recordOwnedConfigPath(paths.configDir, paths.statePath);
  recordOwnedConfigPath(paths.configDir, paths.logPath);
  recordOwnedConfigPath(paths.configDir, paths.lockPath);
  recordOwnedConfigPath(paths.configDir, paths.windowsScriptPath);
  recordOwnedConfigPath(paths.configDir, paths.windowsXmlPath);
}

function writeAutoUpdateState(state: AutoUpdateState, paths: AutoUpdatePaths): void {
  ensureStateOwnership(paths);
  atomicWriteFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function appendAutoUpdateLog(paths: AutoUpdatePaths, line: string): void {
  ensureStateOwnership(paths);
  // Callers only pass fixed templates and validated versions. Do not append scheduler
  // stdout/stderr: package-manager output can contain local paths and account names.
  appendFileSync(paths.logPath, `${new Date().toISOString()} ${line}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function defaultState(now: () => number, channel = defaultUpdateTag(currentVersion())): AutoUpdateState {
  const timestamp = nowIso(now);
  return {
    version: 1,
    enabled: true,
    channel,
    schedule: {
      kind: "daily",
      hour: AUTO_UPDATE_DEFAULT_HOUR,
      minute: AUTO_UPDATE_DEFAULT_MINUTE,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function selectedInstaller(deps: Pick<AutoUpdateSchedulerDeps, "installer">): Installer {
  return deps.installer ?? detectInstall();
}

function selectedCurrentVersion(
  deps: Pick<AutoUpdateSchedulerDeps, "currentVersion">,
): string {
  return deps.currentVersion ?? currentVersion();
}

function stateForChannel(
  existing: AutoUpdateState | null,
  channel: Channel,
  now: () => number,
): AutoUpdateState {
  const base = existing ?? defaultState(now, channel);
  return {
    ...base,
    enabled: true,
    channel,
    updatedAt: nowIso(now),
  };
}

function stateForDisabled(
  existing: AutoUpdateState | null,
  now: () => number,
): AutoUpdateState {
  const base = existing ?? defaultState(now);
  return {
    ...base,
    enabled: false,
    updatedAt: nowIso(now),
    lastResult: base.lastResult === "running" ? "failed" : base.lastResult,
    ...(base.lastResult === "running" ? { lastErrorCode: "worker_failed" as const } : {}),
  };
}

function safePathCandidate(value: string | undefined, label: string): string {
  if (!value || !resolve(value) || !existsSync(resolve(value))) {
    throw new AutoUpdateError(`${label} could not be resolved.`, "scheduler_unavailable");
  }
  return resolve(value);
}

function looksLikeNode(value: string): boolean {
  const name = basename(value).toLowerCase();
  return name === "node" || name === "node.exe";
}

export function resolveAutoUpdateRuntimePaths(
  deps: Pick<AutoUpdateSchedulerDeps, "env" | "nodePath" | "launcherPath" | "configDir"> = {},
): AutoUpdateRuntimePaths {
  const env = deps.env ?? process.env;
  const configDir = resolve(deps.configDir ?? getConfigDir());
  const launcherPath = safePathCandidate(
    deps.launcherPath ?? packageLauncherPath(),
    "the Remodex launcher",
  );
  const candidates = [
    deps.nodePath,
    env.OCX_NODE_LAUNCHER_PATH,
    env.npm_node_execpath,
    looksLikeNode(process.execPath) ? process.execPath : undefined,
    typeof Bun !== "undefined" ? Bun.which("node") ?? undefined : undefined,
  ];
  const nodePath = candidates
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
    .map(candidate => resolve(expandUserPath(candidate)))
    .find(candidate => looksLikeNode(candidate) && existsSync(candidate));
  if (!nodePath) {
    throw new AutoUpdateError(
      "A stable Node.js launcher was not found; automatic updates are not registered.",
      "scheduler_unavailable",
    );
  }
  return {
    nodePath,
    launcherPath,
    configDir,
    ...(env.CODEX_HOME?.trim() ? { codexHome: resolve(expandUserPath(env.CODEX_HOME.trim())) } : {}),
    ...(env.PATH ? { path: env.PATH } : {}),
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plistEscape(value: string): string {
  return xmlEscape(value);
}

export interface AutoUpdateArtifactInput extends AutoUpdateRuntimePaths {
  hour?: number;
  minute?: number;
  logPath?: string;
  env?: Record<string, string | undefined>;
}

export function buildWindowsAutoUpdateScript(input: AutoUpdateArtifactInput): string {
  const literal = (value: string) => {
    if (/[\r\n\0]/.test(value)) throw new Error("Invalid updater path");
    return `"${value.replaceAll('"', '""')}"`;
  };
  const environment: Record<string, string> = {
    OPENCODEX_HOME: input.configDir, OCX_AUTO_UPDATE: "1", OCX_NODE_LAUNCHER_PATH: input.nodePath,
    RMX_AUTO_UPDATE_NODE: input.nodePath, RMX_AUTO_UPDATE_LAUNCHER: input.launcherPath,
    ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {}),
    ...(input.path ? { PATH: input.path } : {}),
  };
  const command = '"%RMX_AUTO_UPDATE_NODE%" "%RMX_AUTO_UPDATE_LAUNCHER%" __auto-update';
  return [
    'Option Explicit', 'Dim shell, env, result', 'Set shell = CreateObject("WScript.Shell")',
    'Set env = shell.Environment("Process")',
    ...Object.entries(environment).map(([key, value]) => `env(${literal(key)}) = ${literal(value)}`),
    `shell.CurrentDirectory = ${literal(input.configDir)}`,
    `result = shell.Run(${literal(command)}, 0, True)`,
    'WScript.Quit result', '',
  ].join("\r\n");
}

export function buildWindowsAutoUpdateTaskXml(
  scriptPath: string,
  options: {
    taskName?: string;
    commandPath?: string;
    hour?: number;
    minute?: number;
    startBoundary?: string;
  } = {},
): string {
  const taskName = options.taskName ?? AUTO_UPDATE_WINDOWS_TASK_NAME;
  const commandPath = options.commandPath ?? "wscript.exe";
  const hour = options.hour ?? AUTO_UPDATE_DEFAULT_HOUR;
  const minute = options.minute ?? AUTO_UPDATE_DEFAULT_MINUTE;
  const startBoundary = options.startBoundary
    ?? `2000-01-01T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  const argumentsValue = `//B //NoLogo "${scriptPath}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Remodex</Author>
    <Description>Daily Remodex package update check</Description>
    <URI>\\${xmlEscape(taskName)}</URI>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${xmlEscape(startBoundary)}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(commandPath)}</Command>
      <Arguments>${xmlEscape(argumentsValue)}</Arguments>
      <WorkingDirectory>${xmlEscape(dirname(scriptPath))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function plistArray(values: readonly string[]): string {
  return values.map(value => `    <string>${plistEscape(value)}</string>`).join("\n");
}

function plistEnvironment(entries: Readonly<Record<string, string>>): string {
  return Object.entries(entries)
    .map(([key, value]) => `    <key>${plistEscape(key)}</key>\n    <string>${plistEscape(value)}</string>`)
    .join("\n");
}

export function buildLaunchdAutoUpdatePlist(
  input: AutoUpdateArtifactInput & { label?: string },
): string {
  const hour = input.hour ?? AUTO_UPDATE_DEFAULT_HOUR;
  const minute = input.minute ?? AUTO_UPDATE_DEFAULT_MINUTE;
  const label = input.label ?? AUTO_UPDATE_LAUNCHD_LABEL;
  const environment: Record<string, string> = {
    OPENCODEX_HOME: input.configDir,
    OCX_AUTO_UPDATE: "1",
    OCX_NODE_LAUNCHER_PATH: input.nodePath,
  };
  if (input.codexHome) environment.CODEX_HOME = input.codexHome;
  if (input.path) environment.PATH = input.path;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${plistArray([input.nodePath, input.launcherPath, "__auto-update"])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${plistEnvironment(environment)}
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

function systemdQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/%/g, "%%")}"`;
}

/**
 * `WorkingDirectory=` accepts a path value, not the quoted argument form used
 * by `ExecStart=` and `Environment=`. Encode whitespace and unit-significant
 * characters as systemd escapes so paths with spaces remain valid without
 * leaving literal quotes in the directory name.
 */
function systemdPath(value: string): string {
  let escaped = "";
  for (const character of value) {
    if (character === "\\") escaped += "\\\\";
    else if (character === "%") escaped += "%%";
    else if (character === " ") escaped += "\\x20";
    else if (character === "\t") escaped += "\\x09";
    else if (character === "\n") escaped += "\\x0a";
    else if (character === '"') escaped += "\\x22";
    else escaped += character;
  }
  return escaped;
}

function systemdEnvironment(name: string, value: string): string {
  return `Environment=${systemdQuote(`${name}=${value}`)}`;
}

export function buildSystemdAutoUpdateService(
  input: AutoUpdateArtifactInput & { serviceName?: string; timerName?: string },
): string {
  const serviceName = input.serviceName ?? AUTO_UPDATE_SYSTEMD_SERVICE;
  const timerName = input.timerName ?? AUTO_UPDATE_SYSTEMD_TIMER;
  const env = [
    systemdEnvironment("OPENCODEX_HOME", input.configDir),
    systemdEnvironment("OCX_AUTO_UPDATE", "1"),
    systemdEnvironment("OCX_NODE_LAUNCHER_PATH", input.nodePath),
    ...(input.codexHome ? [systemdEnvironment("CODEX_HOME", input.codexHome)] : []),
    ...(input.path ? [systemdEnvironment("PATH", input.path)] : []),
  ];
  return `[Unit]
Description=Remodex automatic package update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${systemdQuote(input.nodePath)} ${systemdQuote(input.launcherPath)} __auto-update
WorkingDirectory=${systemdPath(input.configDir)}
${env.join("\n")}
TimeoutStartSec=15min

[Install]
WantedBy=default.target
# Timer: ${timerName}
`;
}

export function buildSystemdAutoUpdateTimer(
  input: Pick<AutoUpdateArtifactInput, "hour" | "minute"> & { serviceName?: string },
): string {
  const hour = String(input.hour ?? AUTO_UPDATE_DEFAULT_HOUR).padStart(2, "0");
  const minute = String(input.minute ?? AUTO_UPDATE_DEFAULT_MINUTE).padStart(2, "0");
  const serviceName = input.serviceName ?? AUTO_UPDATE_SYSTEMD_SERVICE;
  return `[Unit]
Description=Daily Remodex automatic update trigger

[Timer]
OnCalendar=*-*-* ${hour}:${minute}:00
Persistent=true
AccuracySec=1min
Unit=${serviceName}

[Install]
WantedBy=timers.target
`;
}

function defaultRunCommand(file: string, args: readonly string[]): AutoUpdateCommandResult {
  const result = spawnSync(file, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout.slice(0, 2000) : "",
    stderr: typeof result.stderr === "string" ? result.stderr.slice(0, 2000) : "",
  };
}

function commandRunner(deps: AutoUpdateSchedulerDeps): AutoUpdateCommandRunner {
  return deps.runCommand ?? defaultRunCommand;
}

function writeTextFile(path: string, content: string, encoding: BufferEncoding = "utf8"): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSyncCompat(temporary, content, encoding);
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function writeFileSyncCompat(path: string, content: string, encoding: BufferEncoding): void {
  // Kept as a tiny wrapper so all scheduler artifacts use one atomic write path.
  writeFileSync(path, content, { encoding, mode: 0o600 });
}

function removeExactFile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (error) {
    throw new AutoUpdateError("An automatic-update scheduler artifact could not be removed.", "scheduler_registration_failed");
  }
}

function runChecked(
  run: AutoUpdateCommandRunner,
  file: string,
  args: readonly string[],
): AutoUpdateCommandResult {
  const result = run(file, args);
  if (result.status !== 0) {
    throw new AutoUpdateError("The platform scheduler command failed.", "scheduler_registration_failed");
  }
  return result;
}

function windowsTaskProbe(
  deps: AutoUpdateSchedulerDeps,
  taskName = AUTO_UPDATE_WINDOWS_TASK_NAME,
): AutoSchedulerPresence {
  if (deps.probeWindows) return deps.probeWindows();
  // Production uses the existing locale-aware, fail-closed Task Scheduler probe.
  if (!deps.runCommand && (deps.platform ?? process.platform) === "win32") {
    try {
      return probeWindowsSchedulerTask(taskName).status;
    } catch {
      return "unknown";
    }
  }
  const file = deps.schtasksPath ?? "schtasks.exe";
  const result = commandRunner(deps)(file, ["/Query", "/TN", taskName]);
  if (result.status === 0) return "present";
  // The scheduler returns the same exit code for "not found" and access denied.
  // A test/adapter may provide a localized-safe marker in stdout; otherwise fail closed.
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  if (text.includes("not exist") || text.includes("cannot find") || text.includes("no task")) return "absent";
  return "unknown";
}

function launchdDomain(uid: number): string {
  return `gui/${uid}`;
}

function launchdProbe(
  deps: AutoUpdateSchedulerDeps,
  label = AUTO_UPDATE_LAUNCHD_LABEL,
): AutoSchedulerPresence {
  if (deps.probeLaunchd) return deps.probeLaunchd();
  const file = deps.launchctlPath ?? "/bin/launchctl";
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const result = commandRunner(deps)(file, ["print", `${launchdDomain(uid)}/${label}`]);
  if (result.status === 0) return "present";
  if (result.status === 113) return "absent";
  return "unknown";
}

function systemdProbe(
  deps: AutoUpdateSchedulerDeps,
  timerName = AUTO_UPDATE_SYSTEMD_TIMER,
  paths = autoUpdatePaths(deps),
): AutoSchedulerPresence {
  if (deps.probeSystemd) return deps.probeSystemd();
  if (!existsSync(paths.systemdTimerPath)) return "absent";
  const file = deps.systemctlPath ?? "systemctl";
  const result = commandRunner(deps)(file, ["--user", "is-enabled", timerName]);
  if (result.status === 0) {
    return commandRunner(deps)(file, ["--user", "is-active", timerName]).status === 0 ? "present" : "absent";
  }
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  if (text.includes("not-found") || text.includes("not found") || text.includes("disabled")) return "absent";
  return "unknown";
}

function schedulerPresence(
  deps: AutoUpdateSchedulerDeps,
  paths = autoUpdatePaths(deps),
): AutoSchedulerPresence {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return windowsTaskProbe(deps);
  if (platform === "darwin") return launchdProbe(deps);
  if (platform === "linux") return systemdProbe(deps, AUTO_UPDATE_SYSTEMD_TIMER, paths);
  return "unknown";
}

function windowsCommandPath(): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
}

function registerWindowsScheduler(
  deps: AutoUpdateSchedulerDeps,
  paths: AutoUpdatePaths,
  runtime: AutoUpdateRuntimePaths,
  schedule: AutoUpdateSchedule,
): void {
  const run = commandRunner(deps);
  const before = windowsTaskProbe(deps);
  if (before === "unknown") {
    throw new AutoUpdateError("Task Scheduler could not be queried safely.", "scheduler_query_failed");
  }
  writeTextFileUtf16(
    paths.windowsScriptPath,
    `\uFEFF${buildWindowsAutoUpdateScript({
      ...runtime,
      hour: schedule.hour,
      minute: schedule.minute,
      logPath: paths.logPath,
      env: deps.env ?? process.env,
    })}`,
  );
  const xml = buildWindowsAutoUpdateTaskXml(paths.windowsScriptPath, {
    hour: schedule.hour,
    minute: schedule.minute,
    commandPath: windowsCommandPath(),
  });
  writeTextFileUtf16(paths.windowsXmlPath, `\uFEFF${xml}`);

  const schtasks = deps.schtasksPath ?? (process.platform === "win32"
    ? resolveTrustedWindowsSchtasksExe()
    : "schtasks.exe");
  runChecked(run, schtasks, ["/Create", "/TN", AUTO_UPDATE_WINDOWS_TASK_NAME, "/XML", paths.windowsXmlPath, "/F"]);
  const after = windowsTaskProbe(deps);
  if (after !== "present") {
    throw new AutoUpdateError("Task Scheduler registration could not be verified.", "scheduler_registration_failed");
  }
}

function writeTextFileUtf16(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf16le", mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function unregisterWindowsScheduler(
  deps: AutoUpdateSchedulerDeps,
  paths: AutoUpdatePaths,
): void {
  const run = commandRunner(deps);
  const before = windowsTaskProbe(deps);
  if (before === "unknown") {
    throw new AutoUpdateError("Task Scheduler could not be queried safely.", "scheduler_query_failed");
  }
  if (before === "present") {
    const schtasks = deps.schtasksPath ?? (process.platform === "win32"
      ? resolveTrustedWindowsSchtasksExe()
      : "schtasks.exe");
    runChecked(run, schtasks, ["/Delete", "/TN", AUTO_UPDATE_WINDOWS_TASK_NAME, "/F"]);
    if (windowsTaskProbe(deps) !== "absent") {
      throw new AutoUpdateError("Task Scheduler removal could not be verified.", "scheduler_registration_failed");
    }
  }
  removeExactFile(paths.windowsScriptPath);
  removeExactFile(paths.windowsXmlPath);
}

function registerLaunchdScheduler(
  deps: AutoUpdateSchedulerDeps,
  paths: AutoUpdatePaths,
  runtime: AutoUpdateRuntimePaths,
  schedule: AutoUpdateSchedule,
): void {
  const run = commandRunner(deps);
  const dir = dirname(paths.launchdPlistPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeTextFile(
    paths.launchdPlistPath,
    buildLaunchdAutoUpdatePlist({
      ...runtime,
      hour: schedule.hour,
      minute: schedule.minute,
      logPath: paths.logPath,
    }),
  );
  const launchctl = deps.launchctlPath ?? "/bin/launchctl";
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const domain = launchdDomain(uid);
  // bootout is intentionally best effort: the job may not have existed yet.
  run(launchctl, ["bootout", `${domain}/${AUTO_UPDATE_LAUNCHD_LABEL}`]);
  runChecked(run, launchctl, ["bootstrap", domain, paths.launchdPlistPath]);
  if (launchdProbe(deps) !== "present") {
    throw new AutoUpdateError("launchd registration could not be verified.", "scheduler_registration_failed");
  }
}

function unregisterLaunchdScheduler(
  deps: AutoUpdateSchedulerDeps,
  paths: AutoUpdatePaths,
): void {
  const run = commandRunner(deps);
  const launchctl = deps.launchctlPath ?? "/bin/launchctl";
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const domain = launchdDomain(uid);
  const before = launchdProbe(deps);
  if (before === "unknown") {
    throw new AutoUpdateError("launchd could not be queried safely.", "scheduler_query_failed");
  }
  if (before === "present") {
    const result = run(launchctl, ["bootout", `${domain}/${AUTO_UPDATE_LAUNCHD_LABEL}`]);
    if (result.status !== 0 && launchdProbe(deps) !== "absent") {
      throw new AutoUpdateError("launchd removal could not be verified.", "scheduler_registration_failed");
    }
  }
  if (launchdProbe(deps) === "unknown") {
    throw new AutoUpdateError("launchd removal could not be verified.", "scheduler_query_failed");
  }
  removeExactFile(paths.launchdPlistPath);
}

function ensureSystemdAvailable(
  deps: AutoUpdateSchedulerDeps,
  run: AutoUpdateCommandRunner,
): string {
  const systemctl = deps.systemctlPath ?? "systemctl";
  const probe = run(systemctl, ["--user", "show-environment"]);
  if (probe.status !== 0) {
    throw new AutoUpdateError("The systemd user manager is unavailable.", "scheduler_unavailable");
  }
  return systemctl;
}

function registerSystemdScheduler(
  deps: AutoUpdateSchedulerDeps,
  paths: AutoUpdatePaths,
  runtime: AutoUpdateRuntimePaths,
  schedule: AutoUpdateSchedule,
): void {
  const run = commandRunner(deps);
  const systemctl = ensureSystemdAvailable(deps, run);
  const dir = dirname(paths.systemdServicePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeTextFile(
    paths.systemdServicePath,
    buildSystemdAutoUpdateService({
      ...runtime,
      hour: schedule.hour,
      minute: schedule.minute,
      logPath: paths.logPath,
    }),
  );
  writeTextFile(
    paths.systemdTimerPath,
    buildSystemdAutoUpdateTimer({
      hour: schedule.hour,
      minute: schedule.minute,
    }),
  );
  runChecked(run, systemctl, ["--user", "daemon-reload"]);
  runChecked(run, systemctl, ["--user", "enable", "--now", AUTO_UPDATE_SYSTEMD_TIMER]);
  if (systemdProbe(deps, AUTO_UPDATE_SYSTEMD_TIMER, paths) !== "present") {
    throw new AutoUpdateError("systemd timer registration could not be verified.", "scheduler_registration_failed");
  }
}

function unregisterSystemdScheduler(
  deps: AutoUpdateSchedulerDeps,
  paths: AutoUpdatePaths,
): void {
  const run = commandRunner(deps);
  const systemctl = deps.systemctlPath ?? "systemctl";
  const filesExist = existsSync(paths.systemdServicePath) || existsSync(paths.systemdTimerPath);
  if (filesExist) ensureSystemdAvailable(deps, run);
  const before = systemdProbe(deps, AUTO_UPDATE_SYSTEMD_TIMER, paths);
  if (before === "unknown") {
    throw new AutoUpdateError("systemd timer could not be queried safely.", "scheduler_query_failed");
  }
  if (before === "present") {
    runChecked(run, systemctl, ["--user", "disable", "--now", AUTO_UPDATE_SYSTEMD_TIMER]);
    runChecked(run, systemctl, ["--user", "daemon-reload"]);
    if (systemdProbe(deps, AUTO_UPDATE_SYSTEMD_TIMER, paths) === "unknown") {
      throw new AutoUpdateError("systemd timer removal could not be verified.", "scheduler_query_failed");
    }
  }
  removeExactFile(paths.systemdTimerPath);
  removeExactFile(paths.systemdServicePath);
  try { run(systemctl, ["--user", "daemon-reload"]); } catch { /* best effort */ }
}

function registerScheduler(
  deps: AutoUpdateSchedulerDeps,
  paths: AutoUpdatePaths,
  runtime: AutoUpdateRuntimePaths,
  schedule: AutoUpdateSchedule,
): void {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") registerWindowsScheduler(deps, paths, runtime, schedule);
  else if (platform === "darwin") registerLaunchdScheduler(deps, paths, runtime, schedule);
  else if (platform === "linux") registerSystemdScheduler(deps, paths, runtime, schedule);
  else throw new AutoUpdateError(`Automatic updates are unsupported on ${platform}.`, "unsupported_platform");
}

function unregisterScheduler(deps: AutoUpdateSchedulerDeps, paths: AutoUpdatePaths): void {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") unregisterWindowsScheduler(deps, paths);
  else if (platform === "darwin") unregisterLaunchdScheduler(deps, paths);
  else if (platform === "linux") unregisterSystemdScheduler(deps, paths);
  else throw new AutoUpdateError(`Automatic updates are unsupported on ${platform}.`, "unsupported_platform");
}

export function enableAutoUpdates(
  requestedChannel?: Channel,
  deps: AutoUpdateSchedulerDeps = {},
): AutoUpdateState {
  if (requestedChannel !== undefined && !isAutoUpdateChannel(requestedChannel)) {
    throw new AutoUpdateError(
      "The automatic-update channel must be latest or preview.",
      "invalid_channel",
    );
  }
  const platform = deps.platform ?? process.platform;
  const installer = selectedInstaller(deps);
  if (installer === "source") {
    throw new AutoUpdateError(
      "Automatic updates require a global npm or Bun installation, not a source checkout.",
      "source_checkout",
    );
  }
  if (!isSupportedPlatform(platform)) {
    throw new AutoUpdateError(`Automatic updates are unsupported on ${platform}.`, "unsupported_platform");
  }
  const now = deps.now ?? Date.now;
  const paths = autoUpdatePaths(deps);
  const existing = readAutoUpdateState(paths.configDir);
  if (stateFileExists(paths.configDir) && !existing) {
    throw new AutoUpdateError("The automatic-update state file is invalid; repair it before enabling updates.", "invalid_state");
  }
  const channel = requestedChannel ?? existing?.channel ?? defaultUpdateTag(selectedCurrentVersion(deps));
  const next = stateForChannel(existing, channel, now);
  next.schedulerRevision = 2;
  const runtime = resolveAutoUpdateRuntimePaths({
    env: deps.env,
    nodePath: deps.nodePath,
    launcherPath: deps.launcherPath,
    configDir: paths.configDir,
  });
  // Initialize ownership while the config root is still empty. Platform
  // registration writes scheduler artifacts before the state file is persisted;
  // if those artifacts land first in a fresh root, the ownership layer
  // intentionally refuses to claim the now-nonempty directory.
  ensureStateOwnership(paths);
  registerScheduler(deps, paths, runtime, next.schedule);
  try {
    writeAutoUpdateState(next, paths);
    appendAutoUpdateLog(paths, `scheduler enabled (${next.channel}, daily ${String(next.schedule.hour).padStart(2, "0")}:${String(next.schedule.minute).padStart(2, "0")})`);
  } catch (error) {
    // Do not leave a newly-created scheduler active without a state record. The
    // cleanup is exact-path-only and best effort; the original write error remains
    // the user-facing failure.
    try { unregisterScheduler(deps, paths); } catch { /* preserve primary failure */ }
    throw error;
  }
  return next;
}

export function disableAutoUpdates(
  deps: AutoUpdateSchedulerDeps = {},
): AutoUpdateState {
  const now = deps.now ?? Date.now;
  const paths = autoUpdatePaths(deps);
  const existing = readAutoUpdateState(paths.configDir);
  if (stateFileExists(paths.configDir) && !existing) {
    throw new AutoUpdateError("The automatic-update state file is invalid; repair it before disabling updates.", "invalid_state");
  }
  unregisterScheduler(deps, paths);
  const next = stateForDisabled(existing, now);
  writeAutoUpdateState(next, paths);
  appendAutoUpdateLog(paths, "scheduler disabled");
  return next;
}

export function readAutoUpdateStatus(
  deps: AutoUpdateSchedulerDeps = {},
): AutoUpdateStatus {
  const platform = deps.platform ?? process.platform;
  const paths = autoUpdatePaths(deps);
  const installer = selectedInstaller(deps);
  const stored = readAutoUpdateState(paths.configDir);
  const defaultEnabled = installer !== "source" && isSupportedPlatform(platform);
  const effective = stored ?? defaultState(
    deps.now ?? Date.now,
    defaultUpdateTag(selectedCurrentVersion(deps)),
  );
  return {
    enabled: stored?.enabled ?? defaultEnabled,
    defaultEnabled,
    supported: isSupportedPlatform(platform) && installer !== "source",
    installer,
    channel: effective.channel,
    schedule: effective.schedule,
    schedulerKind: autoUpdateSchedulerKind(platform),
    scheduler: isSupportedPlatform(platform) ? schedulerPresence(deps, paths) : "unknown",
    state: stored,
    paths,
  };
}

export function formatAutoUpdateStatus(status: AutoUpdateStatus): string[] {
  const lines = [
    `Automatic updates: ${status.enabled ? "enabled" : "disabled"}`,
    `Default: ${status.defaultEnabled ? "enabled for this installation" : "disabled"}`,
    `Installer: ${status.installer}`,
    `Channel: ${status.channel}`,
    `Schedule: daily at ${String(status.schedule.hour).padStart(2, "0")}:${String(status.schedule.minute).padStart(2, "0")} (local time)`,
    `Scheduler: ${status.schedulerKind ?? "unsupported"} (${status.scheduler})`,
    `State: ${status.paths.statePath}`,
    `Log: ${status.paths.logPath}`,
  ];
  if (status.installer === "source") lines.push("Enablement requires a global npm or Bun installation.");
  if (status.scheduler === "unknown") lines.push("Scheduler registration could not be verified.");
  if (status.state?.lastResult) lines.push(`Last result: ${status.state.lastResult}`);
  if (status.state?.currentVersion) lines.push(`Last known version: ${status.state.currentVersion}`);
  if (status.state?.targetVersion) lines.push(`Last target: ${status.state.targetVersion}`);
  if (status.state?.rollback) {
    lines.push(`Rollback: ${status.state.rollback.result} to v${status.state.rollback.version}`);
  }
  if (status.state?.lastErrorCode) lines.push(`Last error: ${status.state.lastErrorCode}`);
  return lines;
}

function schedulerArtifactsCurrent(
  deps: AutoUpdateSchedulerDeps,
  paths: AutoUpdatePaths,
  state: AutoUpdateState,
): boolean {
  try {
    const runtime = resolveAutoUpdateRuntimePaths({ ...deps, configDir: paths.configDir });
    const input = { ...runtime, hour: state.schedule.hour, minute: state.schedule.minute, logPath: paths.logPath };
    const platform = deps.platform ?? process.platform;
    if (platform === "win32") {
      return readFileSync(paths.windowsScriptPath, "utf16le") === `\uFEFF${buildWindowsAutoUpdateScript(input)}`
        && readFileSync(paths.windowsXmlPath, "utf16le") === `\uFEFF${buildWindowsAutoUpdateTaskXml(paths.windowsScriptPath, {
          hour: input.hour, minute: input.minute, commandPath: windowsCommandPath(),
        })}`;
    }
    if (platform === "darwin") {
      return readFileSync(paths.launchdPlistPath, "utf8") === buildLaunchdAutoUpdatePlist(input);
    }
    return platform === "linux"
      && readFileSync(paths.systemdServicePath, "utf8") === buildSystemdAutoUpdateService(input)
      && readFileSync(paths.systemdTimerPath, "utf8") === buildSystemdAutoUpdateTimer(input);
  } catch {
    return false;
  }
}

export function ensureDefaultAutoUpdateScheduler(
  deps: AutoUpdateSchedulerDeps = {},
): AutoUpdateState | null {
  const env = deps.env ?? process.env;
  if (env.OCX_AUTO_UPDATE === "1" || env.REMODEX_CONNECT_ONLY === "1") return null;
  const platform = deps.platform ?? process.platform;
  const installer = selectedInstaller(deps);
  if (installer === "source" || !isSupportedPlatform(platform)) return null;
  const paths = autoUpdatePaths(deps);
  const existing = readAutoUpdateState(paths.configDir);
  if (env.OCX_SERVICE === "1" && !existing?.enabled) return existing;
  if (existing?.enabled === false) return existing;
  if (stateFileExists(paths.configDir) && !existing) return null;

  let presence: AutoSchedulerPresence;
  try {
    presence = schedulerPresence(deps, paths);
  } catch {
    return null;
  }
  if (presence === "present" && existing?.schedulerRevision === 2
    && schedulerArtifactsCurrent(deps, paths, existing)) {
    return existing;
  }
  if (presence === "unknown") return null;
  try {
    return enableAutoUpdates(existing?.channel, deps);
  } catch (error) {
    // Default enablement must never prevent the proxy from starting. An explicit
    // `rmx system update auto on` surfaces the same error to the operator.
    console.error("Automatic update setup needs attention. Run: rmx system update auto on");
    return null;
  }
}

/** Ask the installed OS job to run; never execute a shell or replace this process's package. */
export async function requestAutomaticUpdate(deps: AutoUpdateSchedulerDeps = {}): Promise<void> {
  if (!deps.runCommand) {
    const status = publicAutomaticUpdateStatus();
    if (!status.enabled || !status.configured) throw new Error("Automatic update setup needs repair");
  }
  const platform = deps.platform ?? process.platform;
  let file: string;
  let args: string[];
  if (platform === "win32") {
    file = deps.schtasksPath ?? resolveTrustedWindowsSchtasksExe();
    args = ["/Run", "/TN", AUTO_UPDATE_WINDOWS_TASK_NAME];
  } else if (platform === "darwin") {
    file = deps.launchctlPath ?? "/bin/launchctl";
    args = ["kickstart", `${launchdDomain(deps.uid ?? process.getuid?.() ?? 0)}/${AUTO_UPDATE_LAUNCHD_LABEL}`];
  } else if (platform === "linux") {
    file = deps.systemctlPath ?? "systemctl";
    args = ["--user", "start", "--no-block", AUTO_UPDATE_SYSTEMD_SERVICE];
  } else throw new AutoUpdateError("Automatic updates are unsupported on this platform.", "unsupported_platform");
  if (deps.runCommand) { runChecked(deps.runCommand, file, args); return; }
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: "ignore", timeout: 10_000 });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolveRun() : reject(new Error("Automatic update job could not start")));
  });
}

export function setupOnboardUpdater(deps: AutoUpdateSchedulerDeps = {}): { status: "ready" | "disabled" | "source" | "unavailable"; message: string } {
  if (selectedInstaller(deps) === "source") return { status: "source", message: "Local source build: npm automatic installation does not apply." };
  try {
    const paths = autoUpdatePaths(deps);
    const existing = readAutoUpdateState(paths.configDir);
    if (existing?.enabled === false) return { status: "disabled", message: "Automatic updates remain disabled by your saved choice." };
    if (stateFileExists(paths.configDir) && !existing) throw new Error("Invalid updater state");
    // Onboarding is an explicit repair action. Refresh executable paths too,
    // since Node/version-manager updates can leave intact but unusable jobs.
    const state = enableAutoUpdates(existing?.channel, deps);
    if (state?.schedulerRevision === 2) return { status: "ready", message: "Automatic updates are ready. New versions install when tasks are idle." };
  } catch { /* report a partial setup without blocking phone pairing */ }
  return { status: "unavailable", message: "Phone setup is ready, but automatic updates need attention. Run: rmx system update auto on" };
}

/** Small, path-free status for desktop and paired-phone update screens. */
export function publicAutomaticUpdateStatus() {
  const state = readAutoUpdateState();
  const supported = detectInstall() !== "source" && isSupportedPlatform(process.platform);
  const paths = autoUpdatePaths();
  const configured = state?.schedulerRevision === 2 && (process.platform === "win32"
    ? existsSync(paths.windowsScriptPath) && existsSync(paths.windowsXmlPath)
    : process.platform === "darwin" ? existsSync(paths.launchdPlistPath)
    : existsSync(paths.systemdTimerPath) && existsSync(paths.systemdServicePath));
  return { supported, enabled: supported && state?.enabled !== false, configured,
    lastResult: state?.lastResult ?? null, lastError: state?.lastErrorCode ?? null,
    lastFinishedAt: state?.lastFinishedAt ?? null };
}

export interface AutoUpdateLock {
  release(): void;
}

function lockRecord(now: number): string {
  return JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date(now).toISOString() });
}

function lockIsReclaimable(
  path: string,
  now: number,
  isAlive: (pid: number) => boolean,
): boolean {
  let age = 0;
  try {
    age = Math.max(0, now - statSync(path).mtimeMs);
  } catch {
    return false;
  }
  if (age < AUTO_UPDATE_LOCK_STALE_MS) return false;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const pid = value.pid;
    if (Number.isSafeInteger(pid) && Number(pid) > 0) return !isAlive(Number(pid));
    return age >= AUTO_UPDATE_LOCK_MALFORMED_STALE_MS;
  } catch {
    return age >= AUTO_UPDATE_LOCK_MALFORMED_STALE_MS;
  }
}

export function tryAcquireAutoUpdateLock(options: {
  path?: string;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
} = {}): AutoUpdateLock | null {
  const path = options.path ?? autoUpdateLockPath();
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? isProcessAlive;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      if (attempt === 0 && lockIsReclaimable(path, now(), isAlive)) {
        try { unlinkSync(path); } catch { return null; }
        continue;
      }
      return null;
    }
    try {
      writeSync(fd, lockRecord(now()));
    } catch {
      try { closeSync(fd); } catch { /* best effort */ }
      try { unlinkSync(path); } catch { /* best effort */ }
      return null;
    }
    try { closeSync(fd); } catch { /* best effort */ }
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        try { unlinkSync(path); } catch { /* another run may have recovered it */ }
      },
    };
  }
  return null;
}

function readInstalledVersionFromPackageRoot(packageRoot = INSTALLED_PACKAGE_ROOT): string | null {
  try {
    const packagePath = join(packageRoot, "package.json");
    const value = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    return isAutoUpdateVersion(value.version) ? value.version : null;
  } catch {
    return null;
  }
}

function newAutoJobId(prefix = "auto"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function updateState(
  state: AutoUpdateState,
  patch: Partial<AutoUpdateState>,
  paths: AutoUpdatePaths,
): AutoUpdateState {
  const next: AutoUpdateState = {
    ...state,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeAutoUpdateState(next, paths);
  return next;
}

function activeManualUpdateExists(
  readJob: (jobId?: string | null) => UpdateJobState | null,
  isAlive: (pid: number) => boolean,
  now: number,
): boolean {
  const job = readJob();
  if (!job || (job.status !== "running" && job.status !== "restarting")) return false;
  return staleActiveUpdateJobReason(job, now, isAlive) === null;
}

async function defaultHealthProbe(): Promise<boolean> {
  return (await findLiveProxy()) !== null;
}

function checkResultWithExactTarget(
  check: UpdateCheckResult,
  target: string,
): UpdateCheckResult {
  return {
    ...check,
    latestVersion: target,
    updateAvailable: true,
    canUpdate: true,
    reason: undefined,
  };
}

async function runGuiWorker(
  deps: AutoUpdateWorkerDeps,
  jobId: string,
  channel: Channel,
  check: UpdateCheckResult,
  integrity: ReturnType<typeof checkUpdatePackageIntegrity>,
  target: string,
  requireIdle = true,
): Promise<UpdateJobState | null> {
  const runner = deps.runGuiWorkerFn ?? (
    (id, selectedChannel, restart, io) => runGuiUpdateWorker(id, selectedChannel, restart, io)
  );
  await runner(jobId, channel, true, {
    checkForUpdateFn: () => check,
    integrityFn: () => integrity,
    exactVersion: target,
    beforeStopFn: requireIdle ? async () => {
      const { readRunningUpdateActivity } = await import("./activity");
      const activity = await (deps.activityFn ?? readRunningUpdateActivity)();
      return activity.known && activity.running === 0 && activity.source !== true;
    } : undefined,
  });
  return (deps.readUpdateJobFn ?? readUpdateJob)(jobId);
}

async function attemptRollback(
  state: AutoUpdateState,
  paths: AutoUpdatePaths,
  check: UpdateCheckResult,
  previousVersion: string,
  deps: AutoUpdateWorkerDeps,
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const attemptedAt = nowIso(now);
  let next = updateState(state, {
    rollback: { attemptedAt, version: previousVersion, result: "running" },
    lastErrorCode: "rollback_failed",
  }, paths);
  appendAutoUpdateLog(paths, `rollback started to v${previousVersion}`);

  const integrity = (deps.integrityFn ?? ((version: string) => checkUpdatePackageIntegrity(version)))(previousVersion);
  if (integrity.ok !== true) {
    next = updateState(next, {
      rollback: { attemptedAt, version: previousVersion, result: "failed" },
      lastErrorCode: "rollback_integrity_unavailable",
      lastFinishedAt: nowIso(now),
      lastResult: "failed",
    }, paths);
    appendAutoUpdateLog(paths, `rollback refused because v${previousVersion} integrity could not be verified`);
    return false;
  }

  const rollbackCheck = checkResultWithExactTarget(check, previousVersion);
  const rollbackJobId = newAutoJobId("rollback");
  try {
    const job = await runGuiWorker(deps, rollbackJobId, check.channel, rollbackCheck, integrity, previousVersion, false);
    const healthy = await (deps.healthFn ?? defaultHealthProbe)();
    const ok = job?.status === "succeeded" && healthy;
    next = updateState(next, {
      rollback: { attemptedAt, version: previousVersion, result: ok ? "succeeded" : "failed" },
      lastErrorCode: ok ? "update_failed" : "rollback_failed",
      lastFinishedAt: nowIso(now),
      lastResult: "failed",
      currentVersion: previousVersion,
      targetVersion: check.latestVersion ?? previousVersion,
      lastJobId: rollbackJobId,
    }, paths);
    appendAutoUpdateLog(paths, ok
      ? `rollback completed to v${previousVersion}; health check passed`
      : `rollback failed for v${previousVersion}; health check did not pass`);
    return ok;
  } catch {
    updateState(next, {
      rollback: { attemptedAt, version: previousVersion, result: "failed" },
      lastErrorCode: "rollback_failed",
      lastFinishedAt: nowIso(now),
      lastResult: "failed",
      lastJobId: rollbackJobId,
    }, paths);
    appendAutoUpdateLog(paths, `rollback worker failed for v${previousVersion}`);
    return false;
  }
}

export async function runAutomaticUpdateWorker(
  deps: AutoUpdateWorkerDeps = {},
): Promise<AutoUpdateRunResult> {
  const paths = autoUpdatePaths({ configDir: deps.configDir });
  const now = deps.now ?? Date.now;
  const installer = deps.installer ?? detectInstall();
  const current = (deps.currentVersionFn ?? currentVersion)();
  const currentSafe = isAutoUpdateVersion(current) ? current : "?";
  const state = readAutoUpdateState(paths.configDir);
  if (stateFileExists(paths.configDir) && !state) {
    appendAutoUpdateLog(paths, "worker stopped because auto-update state is invalid");
    return { ok: false, result: "failed", currentVersion: currentSafe, targetVersion: null, rolledBack: false };
  }
  if (installer === "source") {
    return { ok: false, result: "skipped", currentVersion: currentSafe, targetVersion: null, rolledBack: false };
  }
  const effective = state ?? defaultState(now);
  if (!effective.enabled) {
    return { ok: true, result: "skipped", currentVersion: currentSafe, targetVersion: null, rolledBack: false };
  }
  const lock = tryAcquireAutoUpdateLock({ path: paths.lockPath, now, isAlive: deps.isProcessAliveFn });
  if (!lock) {
    const busy = updateState(effective, {
      lastResult: "busy",
      lastFinishedAt: nowIso(now),
      lastErrorCode: undefined,
    }, paths);
    appendAutoUpdateLog(paths, "worker skipped because another update is already running");
    return { ok: true, result: busy.lastResult ?? "busy", currentVersion: currentSafe, targetVersion: null, rolledBack: false };
  }

  try {
    const readJob = deps.readUpdateJobFn ?? readUpdateJob;
    if (activeManualUpdateExists(readJob, deps.isProcessAliveFn ?? isProcessAlive, now())) {
      updateState(effective, {
        lastResult: "busy",
        lastFinishedAt: nowIso(now),
        lastErrorCode: undefined,
      }, paths);
      appendAutoUpdateLog(paths, "worker skipped because a manual update job is active");
      return { ok: true, result: "busy", currentVersion: currentSafe, targetVersion: null, rolledBack: false };
    }

    const channel = effective.channel;
    const check = deps.checkForUpdateFn ? deps.checkForUpdateFn(channel)
      : await (await import("./remote-check")).checkRemoteUpdate(channel, true);
    const target = check.latestVersion;
    if (!isAutoUpdateVersion(target)) {
      updateState(effective, {
        lastResult: "failed",
        lastFinishedAt: nowIso(now),
        currentVersion: currentSafe === "?" ? undefined : currentSafe,
        targetVersion: undefined,
        lastErrorCode: "update_unavailable",
      }, paths);
      appendAutoUpdateLog(paths, "registry did not return a valid update version");
      return { ok: false, result: "failed", currentVersion: currentSafe, targetVersion: null, rolledBack: false };
    }
    if (target === current || !check.updateAvailable || !check.canUpdate) {
      updateState(effective, {
        lastResult: "already_current",
        lastFinishedAt: nowIso(now),
        currentVersion: currentSafe === "?" ? undefined : currentSafe,
        targetVersion: target,
        lastErrorCode: undefined,
        rollback: undefined,
      }, paths);
      appendAutoUpdateLog(paths, `already current at v${target}`);
      return { ok: true, result: "already_current", currentVersion: currentSafe, targetVersion: target, rolledBack: false };
    }

    // A failed replacement followed by rollback must not create an install/rollback loop.
    // A newer release or an explicit manual update can recover this installation.
    if (effective.targetVersion === target && effective.rollback) {
      return { ok: false, result: "failed", currentVersion: currentSafe, targetVersion: target, rolledBack: effective.rollback.result === "succeeded" };
    }

    const { readRunningUpdateActivity } = await import("./activity");
    const activity = await (deps.activityFn ?? readRunningUpdateActivity)();
    if (!activity.known || activity.running > 0 || activity.source === true) {
      updateState(effective, { lastResult: "busy", lastFinishedAt: nowIso(now), targetVersion: target, lastErrorCode: undefined,
        rollback: effective.targetVersion === target ? effective.rollback : undefined }, paths);
      appendAutoUpdateLog(paths, "Update deferred until the installed server confirms tasks are idle.");
      return { ok: true, result: "busy", currentVersion: currentSafe, targetVersion: target, rolledBack: false };
    }

    const integrity = (deps.integrityFn ?? ((version: string) => checkUpdatePackageIntegrity(version)))(target);
    if (integrity.ok !== true) {
      updateState(effective, {
        lastResult: "failed",
        lastFinishedAt: nowIso(now),
        currentVersion: currentSafe === "?" ? undefined : currentSafe,
        targetVersion: target,
        lastErrorCode: integrity.ok === false ? "integrity_invalid" : "integrity_unavailable",
        rollback: effective.targetVersion === target ? effective.rollback : undefined,
      }, paths);
      appendAutoUpdateLog(paths, `v${target} was not installed because integrity could not be verified`);
      return { ok: false, result: "failed", currentVersion: currentSafe, targetVersion: target, rolledBack: false };
    }

    const runningState = updateState(effective, {
      lastAttemptAt: nowIso(now),
      lastResult: "running",
      currentVersion: currentSafe === "?" ? undefined : currentSafe,
      previousVersion: currentSafe === "?" ? undefined : currentSafe,
      targetVersion: target,
      lastErrorCode: undefined,
      rollback: undefined,
      lastJobId: undefined,
    }, paths);
    appendAutoUpdateLog(paths, `verified v${target}; update started`);

    const jobId = newAutoJobId();
    const exactCheck = checkResultWithExactTarget(check, target);
    let job: UpdateJobState | null = null;
    try {
      job = await runGuiWorker(deps, jobId, channel, exactCheck, integrity, target);
    } catch {
      job = (deps.readUpdateJobFn ?? readUpdateJob)(jobId);
    }

    const runtimeVersion = deps.installedVersionFn
      ? deps.installedVersionFn()
      : readInstalledVersionFromPackageRoot();
    const packageChanged = runtimeVersion !== null && runtimeVersion !== current;
    const workerSucceeded = job?.status === "succeeded";
    const healthy = workerSucceeded && await (deps.healthFn ?? defaultHealthProbe)();
    if (workerSucceeded && healthy && (runtimeVersion === null || runtimeVersion === target)) {
      updateState(runningState, {
        lastResult: "updated",
        lastFinishedAt: nowIso(now),
        currentVersion: target,
        targetVersion: target,
        previousVersion: currentSafe === "?" ? undefined : currentSafe,
        lastJobId: jobId,
        lastErrorCode: undefined,
      }, paths);
      appendAutoUpdateLog(paths, `updated to v${target}; health check passed`);
      return { ok: true, result: "updated", currentVersion: target, targetVersion: target, rolledBack: false };
    }

    // A successful worker with an unreadable package root still replaced files in
    // practice, so a failed health check must not silently skip recovery. When the
    // version is readable, any non-current version (including an unexpected target)
    // is concrete evidence that rollback is required.
    const shouldRollback = currentSafe !== "?"
      && (packageChanged || (workerSucceeded && runtimeVersion === null));
    if (!shouldRollback) {
      updateState(runningState, {
        lastResult: "failed",
        lastFinishedAt: nowIso(now),
        lastErrorCode: workerSucceeded ? "health_failed" : "update_failed",
        lastJobId: jobId,
      }, paths);
      appendAutoUpdateLog(paths, workerSucceeded
        ? `v${target} installed but health check failed`
        : `update worker failed for v${target}`);
      return { ok: false, result: "failed", currentVersion: currentSafe, targetVersion: target, rolledBack: false };
    }

    const rolledBack = await attemptRollback(
      runningState,
      paths,
      exactCheck,
      currentSafe,
      deps,
    );
    return {
      ok: rolledBack,
      result: "failed",
      currentVersion: rolledBack ? currentSafe : (runtimeVersion ?? target),
      targetVersion: target,
      rolledBack,
    };
  } catch (error) {
    const latest = readAutoUpdateState(paths.configDir) ?? effective;
    updateState(latest, {
      lastResult: "failed",
      lastFinishedAt: nowIso(now),
      lastErrorCode: error instanceof AutoUpdateError ? error.code : "worker_failed",
    }, paths);
    appendAutoUpdateLog(paths, "automatic update worker failed");
    return { ok: false, result: "failed", currentVersion: currentSafe, targetVersion: latest.targetVersion ?? null, rolledBack: false };
  } finally {
    lock.release();
  }
}
