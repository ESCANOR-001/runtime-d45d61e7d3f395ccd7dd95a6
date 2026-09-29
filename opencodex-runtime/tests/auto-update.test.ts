import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  AUTO_UPDATE_LAUNCHD_LABEL,
  AUTO_UPDATE_LOCK_STALE_MS,
  AUTO_UPDATE_SYSTEMD_SERVICE,
  AUTO_UPDATE_SYSTEMD_TIMER,
  AUTO_UPDATE_WINDOWS_TASK_NAME,
  AutoUpdateError,
  autoUpdatePaths,
  buildLaunchdAutoUpdatePlist,
  buildSystemdAutoUpdateService,
  buildSystemdAutoUpdateTimer,
  buildWindowsAutoUpdateScript,
  buildWindowsAutoUpdateTaskXml,
  disableAutoUpdates,
  enableAutoUpdates,
  ensureDefaultAutoUpdateScheduler,
  parseAutoUpdateState,
  readAutoUpdateState,
  readAutoUpdateStatus,
  requestAutomaticUpdate,
  setupOnboardUpdater,
  runAutomaticUpdateWorker,
  tryAcquireAutoUpdateLock,
  type AutoSchedulerPresence,
  type AutoUpdateCommandRunner,
  type AutoUpdateSchedulerDeps,
} from "../src/update/auto-scheduler";
import {
  CONFIG_OWNER_FILE,
  CONFIG_UNINSTALL_MANIFEST,
} from "../src/lib/config-ownership";
import type { UpdateJobState } from "../src/update/job";

const FIXED_NOW = Date.parse("2026-09-01T12:00:00.000Z");
const VALID_INTEGRITY = {
  ok: true as const,
  integrity: "sha512-dGVzdC1hdXRvLXVwZGF0ZS1pbnRlZ3JpdHk=",
};

let root = "";
let configDir = "";
let homeDir = "";
let nodePath = "";
let windowsNodePath = "";
let launcherPath = "";
let previousOpenCodexHome: string | undefined;
let previousServiceMarker: string | undefined;
let previousAutoUpdateMarker: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rmx-auto-update-"));
  configDir = join(root, ".remodex");
  homeDir = join(root, "home");
  nodePath = join(root, "node");
  windowsNodePath = join(root, "node.exe");
  launcherPath = join(root, "ocx.mjs");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(nodePath, "", { mode: 0o700 });
  writeFileSync(windowsNodePath, "", { mode: 0o700 });
  writeFileSync(launcherPath, "", { mode: 0o700 });

  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  previousServiceMarker = process.env.OCX_SERVICE;
  previousAutoUpdateMarker = process.env.OCX_AUTO_UPDATE;
  process.env.OPENCODEX_HOME = configDir;
  delete process.env.OCX_SERVICE;
  delete process.env.OCX_AUTO_UPDATE;
});

afterEach(() => {
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousServiceMarker === undefined) delete process.env.OCX_SERVICE;
  else process.env.OCX_SERVICE = previousServiceMarker;
  if (previousAutoUpdateMarker === undefined) delete process.env.OCX_AUTO_UPDATE;
  else process.env.OCX_AUTO_UPDATE = previousAutoUpdateMarker;
  rmSync(root, { recursive: true, force: true });
});

function baseDeps(
  platform: NodeJS.Platform,
  overrides: Partial<AutoUpdateSchedulerDeps> = {},
): AutoUpdateSchedulerDeps {
  return {
    platform,
    installer: "npm",
    currentVersion: "1.0.2",
    configDir,
    homeDir,
    nodePath: platform === "win32" ? windowsNodePath : nodePath,
    launcherPath,
    now: () => FIXED_NOW,
    env: {
      OPENCODEX_HOME: configDir,
      PATH: join(root, "bin"),
    },
    ...overrides,
  };
}

function successfulJob(
  id: string,
  latestVersion: string,
  channel: "latest" | "preview",
): UpdateJobState {
  const timestamp = new Date(FIXED_NOW).toISOString();
  return {
    id,
    status: "succeeded",
    startedAt: timestamp,
    updatedAt: timestamp,
    currentVersion: "1.0.2",
    latestVersion,
    channel,
    installer: "npm",
    restart: true,
    restarted: true,
    command: `node <path> __exact-update ${latestVersion}`,
    releaseNotesUrl: "https://github.com/ESCANOR-001/remodex-android/releases/latest",
    log: [],
  };
}

describe("automatic update state and default policy", () => {
  test("parses only bounded version-1 state", () => {
    const timestamp = new Date(FIXED_NOW).toISOString();
    const valid = {
      version: 1,
      enabled: true,
      channel: "latest",
      schedule: { kind: "daily", hour: 3, minute: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
      lastResult: "updated",
      currentVersion: "1.0.2",
      targetVersion: "1.0.3",
      rollback: {
        attemptedAt: timestamp,
        version: "1.0.2",
        result: "succeeded",
      },
    };

    expect(parseAutoUpdateState(valid)).toEqual(valid);
    expect(parseAutoUpdateState({ ...valid, channel: "nightly" })).toBeNull();
    expect(parseAutoUpdateState({
      ...valid,
      schedule: { kind: "daily", hour: 24, minute: 0 },
    })).toBeNull();
    expect(parseAutoUpdateState({
      ...valid,
      targetVersion: "../../profile",
    })).toBeNull();
  });

  test("global installs report default-on before a state file exists", () => {
    const status = readAutoUpdateStatus(baseDeps("win32", {
      probeWindows: () => "absent",
    }));

    expect(status.enabled).toBe(true);
    expect(status.defaultEnabled).toBe(true);
    expect(status.supported).toBe(true);
    expect(status.state).toBeNull();
    expect(status.paths.statePath).toBe(join(configDir, "auto-update.json"));
    expect(status.paths.statePath).not.toContain(".opencodex");

    const sourceStatus = readAutoUpdateStatus(baseDeps("win32", {
      installer: "source",
      probeWindows: () => "absent",
    }));
    expect(sourceStatus.enabled).toBe(false);
    expect(sourceStatus.defaultEnabled).toBe(false);
    expect(sourceStatus.supported).toBe(false);
  });

  test("rejects unknown channels before creating scheduler artifacts", () => {
    expect(() => enableAutoUpdates(
      "nightly" as "latest",
      baseDeps("win32", { probeWindows: () => "absent" }),
    )).toThrow(AutoUpdateError);
    expect(existsSync(join(configDir, "auto-update.json"))).toBe(false);
    expect(existsSync(join(configDir, "auto-update.vbs"))).toBe(false);
  });
});

describe("platform scheduler artifacts", () => {
  test.skipIf(process.platform !== "win32")("Windows hidden wrapper handles Unicode and percent-sign paths without cmd", () => {
    const directory = join(root, "日本 & %TEMP% updater");
    mkdirSync(directory);
    const launcher = join(directory, "probe.mjs");
    writeFileSync(launcher, 'import {writeFileSync} from "node:fs"; import {join} from "node:path"; writeFileSync(join(process.env.OPENCODEX_HOME,"probe.json"),JSON.stringify({argument:process.argv.at(-1),automatic:process.env.OCX_AUTO_UPDATE}));');
    const wrapper = join(directory, "auto-update.vbs");
    writeFileSync(wrapper, `\uFEFF${buildWindowsAutoUpdateScript({nodePath:process.execPath,launcherPath:launcher,configDir:directory})}`, "utf16le");
    const child = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe"), ["//B", "//NoLogo", wrapper], { windowsHide:true, timeout:10_000, stdio:"ignore" });
    expect(child.status).toBe(0);
    expect(JSON.parse(readFileSync(join(directory,"probe.json"),"utf8"))).toEqual({argument:"__auto-update",automatic:"1"});
  });
  const artifactInput = () => ({
    nodePath,
    launcherPath,
    configDir,
    codexHome: join(root, ".codex"),
    path: join(root, "bin"),
    hour: 4,
    minute: 15,
  });

  test("Windows wrapper and task XML preserve exact quoted paths and local schedule", () => {
    const windowsInput = {
      ...artifactInput(),
      nodePath: join(root, "Node & Runtime", "node.exe"),
      launcherPath: join(root, "Remodex % Runtime", "ocx.mjs"),
      configDir: join(root, ".remodex & state"),
    };
    const script = buildWindowsAutoUpdateScript(windowsInput);
    expect(script).toContain('CreateObject("WScript.Shell")');
    expect(script).toContain('env("OCX_AUTO_UPDATE") = "1"');
    expect(script).toContain("__auto-update");
    expect(script).toContain(windowsInput.nodePath);
    expect(script).toContain(windowsInput.launcherPath);
    expect(script).toContain(', 0, True)');
    expect(script).not.toContain('cmd.exe');

    const xml = buildWindowsAutoUpdateTaskXml(
      join(root, "Remodex & State", "auto-update.vbs"),
      {
        hour: 4,
        minute: 15,
        commandPath: "C:\\Windows\\System32\\wscript.exe",
      },
    );
    expect(xml).toContain(`<URI>\\${AUTO_UPDATE_WINDOWS_TASK_NAME}</URI>`);
    expect(xml).toContain("<StartBoundary>2000-01-01T04:15:00</StartBoundary>");
    expect(xml).toContain("Remodex &amp; State");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
  });

  test("launchd plist is a daily, non-persistent background worker", () => {
    const plist = buildLaunchdAutoUpdatePlist(artifactInput());
    expect(plist).toContain(`<string>${AUTO_UPDATE_LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>__auto-update</string>");
    expect(plist).toContain("<key>Hour</key>\n    <integer>4</integer>");
    expect(plist).toContain("<key>Minute</key>\n    <integer>15</integer>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <false/>");
    expect(plist).toContain("<key>OCX_AUTO_UPDATE</key>");
  });

  test("systemd service and timer run one exact worker daily and catch missed runs", () => {
    // The generated Linux service uses Linux paths even when this test runs on Windows.
    const input = {
      ...artifactInput(),
      nodePath: "/opt/Remodex/node",
      launcherPath: "/opt/Remodex/ocx.mjs",
      configDir: "/home/test/.remodex",
    };
    const service = buildSystemdAutoUpdateService(input);
    const timer = buildSystemdAutoUpdateTimer({ hour: 4, minute: 15 });
    expect(service).toContain(`ExecStart="${input.nodePath}" "${input.launcherPath}" __auto-update`);
    expect(service).toContain('Environment="OPENCODEX_HOME=');
    expect(service).toContain('Environment="OCX_AUTO_UPDATE=1"');
    expect(service).toContain("Type=oneshot");
    expect(service).toContain(`WorkingDirectory=${input.configDir}`);
    expect(service).not.toContain(`WorkingDirectory="${input.configDir}"`);
    expect(timer).toContain("OnCalendar=*-*-* 04:15:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain(`Unit=${AUTO_UPDATE_SYSTEMD_SERVICE}`);

    const spaced = buildSystemdAutoUpdateService({
      ...input,
      configDir: "/home/test/Remodex state",
    });
    expect(spaced).toContain("WorkingDirectory=/home/test/Remodex\\x20state");
  });
});

describe("scheduler registration lifecycle", () => {
  for (const platform of ["win32", "linux"] as const) {
    test(`service startup migrates enabled legacy scheduler state on ${platform}`, () => {
      let registrations = 0;
      const deps = baseDeps(platform, {
        probeWindows: () => "present", probeSystemd: () => "present",
        runCommand: () => { registrations += 1; return { status: 0 }; },
      });
      const original = enableAutoUpdates("preview", deps);
      const paths = autoUpdatePaths(deps);
      const { schedulerRevision: _revision, ...legacy } = original;
      writeFileSync(paths.statePath, JSON.stringify(legacy));
      deps.env = { ...deps.env, OCX_SERVICE: "1" };
      const before = registrations;
      const repaired = ensureDefaultAutoUpdateScheduler(deps);
      expect(repaired?.schedulerRevision).toBe(2);
      expect(repaired?.channel).toBe("preview");
      expect(repaired?.schedule).toEqual(original.schedule);
      expect(registrations).toBeGreaterThan(before);
      const after = registrations;
      ensureDefaultAutoUpdateScheduler(deps);
      expect(registrations).toBe(after);
    });

    test(`service startup repairs stale scheduler artifacts at the current revision on ${platform}`, () => {
      let registrations = 0;
      const deps = baseDeps(platform, {
        probeWindows: () => "present", probeSystemd: () => "present",
        runCommand: () => { registrations += 1; return { status: 0 }; },
      });
      enableAutoUpdates("latest", deps);
      const paths = autoUpdatePaths(deps);
      const artifact = platform === "win32" ? paths.windowsScriptPath : paths.systemdServicePath;
      const encoding = platform === "win32" ? "utf16le" : "utf8";
      const expected = readFileSync(artifact, encoding);
      writeFileSync(artifact, platform === "win32"
        ? expected.replace(windowsNodePath, "C:\\old-node\\node.exe")
        : expected.replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory="/old/remodex"'), encoding);
      deps.env = { ...deps.env, OCX_SERVICE: "1" };
      const before = registrations;
      ensureDefaultAutoUpdateScheduler(deps);
      expect(readFileSync(artifact, encoding)).toBe(expected);
      expect(registrations).toBeGreaterThan(before);
    });

    test(`service repair respects opt-out, source installs, workers and uncertain scheduler ownership on ${platform}`, () => {
      let registrations = 0;
      let presence: AutoSchedulerPresence = "present";
      const deps = baseDeps(platform, {
        probeWindows: () => presence, probeSystemd: () => presence,
        runCommand: () => { registrations += 1; return { status: 0 }; },
      });
      const state = enableAutoUpdates("latest", deps);
      const paths = autoUpdatePaths(deps);
      writeFileSync(paths.statePath, JSON.stringify({ ...state, schedulerRevision: 1 }));
      const before = registrations;
      ensureDefaultAutoUpdateScheduler({ ...deps, env: { ...deps.env, OCX_AUTO_UPDATE: "1" } });
      ensureDefaultAutoUpdateScheduler({ ...deps, installer: "source", env: { ...deps.env, OCX_SERVICE: "1" } });
      presence = "unknown";
      expect(ensureDefaultAutoUpdateScheduler({ ...deps, env: { ...deps.env, OCX_SERVICE: "1" } })).toBeNull();
      presence = "present";
      writeFileSync(paths.statePath, JSON.stringify({ ...state, enabled: false }));
      expect(ensureDefaultAutoUpdateScheduler({ ...deps, env: { ...deps.env, OCX_SERVICE: "1" } })?.enabled).toBe(false);
      expect(registrations).toBe(before);
    });
  }
  for (const platform of ["win32", "darwin", "linux"] as const) {
    test(`repairs missing scheduler files on ${platform} and starts its native job`, async () => {
      let presence: AutoSchedulerPresence = "absent";
      const calls: string[][] = [];
      const deps = baseDeps(platform, {
        uid: 501, schtasksPath: "schtasks.exe",
        probeWindows: () => presence, probeLaunchd: () => presence, probeSystemd: () => presence,
        runCommand: (_file, args) => { calls.push([...args]); presence = "present"; return { status: 0 }; },
      });
      expect(ensureDefaultAutoUpdateScheduler(deps)?.schedulerRevision).toBe(2);
      const paths = autoUpdatePaths(deps);
      const artifact = platform === "win32" ? paths.windowsScriptPath : platform === "darwin" ? paths.launchdPlistPath : paths.systemdTimerPath;
      rmSync(artifact);
      const before = calls.length;
      expect(ensureDefaultAutoUpdateScheduler(deps)?.schedulerRevision).toBe(2);
      expect(existsSync(artifact)).toBe(true); expect(calls.length).toBeGreaterThan(before);
      await requestAutomaticUpdate(deps);
      expect(calls.at(-1)).toEqual(platform === "win32" ? ["/Run", "/TN", AUTO_UPDATE_WINDOWS_TASK_NAME]
        : platform === "darwin" ? ["kickstart", `gui/501/${AUTO_UPDATE_LAUNCHD_LABEL}`]
        : ["--user", "start", "--no-block", AUTO_UPDATE_SYSTEMD_SERVICE]);
      const registrations = calls.length;
      expect(setupOnboardUpdater(deps).status).toBe("ready");
      expect(calls.length).toBeGreaterThan(registrations);
    });
  }
  test("registers and unregisters the Windows task with UTF-16 XML", () => {
    let presence: AutoSchedulerPresence = "absent";
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runCommand: AutoUpdateCommandRunner = (file, args) => {
      calls.push({ file, args: [...args] });
      if (args[0] === "/Create") presence = "present";
      if (args[0] === "/Delete") presence = "absent";
      return { status: 0 };
    };
    const deps = baseDeps("win32", {
      schtasksPath: "C:\\Windows\\System32\\schtasks.exe",
      probeWindows: () => presence,
      runCommand,
    });

    const enabled = enableAutoUpdates("preview", deps);
    const paths = autoUpdatePaths({ configDir, homeDir });
    expect(enabled.enabled).toBe(true);
    expect(enabled.channel).toBe("preview");
    expect(presence).toBe("present");
    expect(readAutoUpdateState(configDir)?.enabled).toBe(true);
    expect(readFileSync(paths.windowsScriptPath, "utf16le")).toContain("__auto-update");
    const xmlBytes = readFileSync(paths.windowsXmlPath);
    expect([...xmlBytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(xmlBytes.toString("utf16le")).toContain(AUTO_UPDATE_WINDOWS_TASK_NAME);
    expect(calls.some(call => call.args[0] === "/Create")).toBe(true);

    const disabled = disableAutoUpdates(deps);
    expect(disabled.enabled).toBe(false);
    expect(presence).toBe("absent");
    expect(existsSync(paths.windowsScriptPath)).toBe(false);
    expect(existsSync(paths.windowsXmlPath)).toBe(false);
    expect(calls.some(call => call.args[0] === "/Delete")).toBe(true);
  });

  test("initializes config ownership before scheduler artifacts on a fresh root", () => {
    let presence: AutoSchedulerPresence = "absent";
    const deps = baseDeps("win32", {
      probeWindows: () => presence,
      runCommand: (_file, args) => {
        if (args[0] === "/Create") presence = "present";
        if (args[0] === "/Delete") presence = "absent";
        return { status: 0 };
      },
    });

    enableAutoUpdates("latest", deps);

    expect(existsSync(join(configDir, CONFIG_OWNER_FILE))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(configDir, CONFIG_UNINSTALL_MANIFEST), "utf8"),
    ) as { paths: string[] };
    expect(manifest.paths).toContain("auto-update.vbs");
    expect(manifest.paths).toContain("auto-update-task.xml");
    expect(manifest.paths).toContain("auto-update.json");
    expect(manifest.paths).toContain("auto-update.log");
  });

  test("registers and unregisters launchd without touching tray definitions", () => {
    let presence: AutoSchedulerPresence = "absent";
    const calls: Array<readonly string[]> = [];
    const deps = baseDeps("darwin", {
      uid: 501,
      probeLaunchd: () => presence,
      runCommand: (_file, args) => {
        calls.push([...args]);
        if (args[0] === "bootstrap") presence = "present";
        if (args[0] === "bootout" && presence === "present") presence = "absent";
        return { status: 0 };
      },
    });
    const paths = autoUpdatePaths({ configDir, homeDir });

    enableAutoUpdates("latest", deps);
    expect(presence).toBe("present");
    expect(readFileSync(paths.launchdPlistPath, "utf8")).toContain("__auto-update");
    expect(calls.some(args => args[0] === "bootstrap")).toBe(true);

    disableAutoUpdates(deps);
    expect(presence).toBe("absent");
    expect(existsSync(paths.launchdPlistPath)).toBe(false);
    expect(calls.some(args => args[0] === "bootout")).toBe(true);
  });

  test("registers and unregisters the Linux systemd user timer", () => {
    let presence: AutoSchedulerPresence = "absent";
    const calls: Array<readonly string[]> = [];
    const deps = baseDeps("linux", {
      probeSystemd: () => presence,
      runCommand: (_file, args) => {
        calls.push([...args]);
        if (args.includes("enable")) presence = "present";
        if (args.includes("disable")) presence = "absent";
        return { status: 0 };
      },
    });
    const paths = autoUpdatePaths({ configDir, homeDir });

    enableAutoUpdates("latest", deps);
    expect(presence).toBe("present");
    expect(readFileSync(paths.systemdTimerPath, "utf8")).toContain("Persistent=true");
    expect(calls.some(args => args.includes("enable") && args.includes("--now"))).toBe(true);

    disableAutoUpdates(deps);
    expect(presence).toBe("absent");
    expect(existsSync(paths.systemdServicePath)).toBe(false);
    expect(existsSync(paths.systemdTimerPath)).toBe(false);
    expect(calls.some(args => args.includes("disable") && args.includes("--now"))).toBe(true);
  });

  test("first normal bootstrap enables updates, while an explicit opt-out persists", () => {
    let presence: AutoSchedulerPresence = "absent";
    let creates = 0;
    const deps = baseDeps("win32", {
      probeWindows: () => presence,
      runCommand: (_file, args) => {
        if (args[0] === "/Create") {
          creates += 1;
          presence = "present";
        }
        if (args[0] === "/Delete") presence = "absent";
        return { status: 0 };
      },
    });

    const provisioned = ensureDefaultAutoUpdateScheduler(deps);
    expect(provisioned?.enabled).toBe(true);
    expect(creates).toBe(1);

    disableAutoUpdates(deps);
    expect(readAutoUpdateState(configDir)?.enabled).toBe(false);
    const afterOptOut = ensureDefaultAutoUpdateScheduler(deps);
    expect(afterOptOut?.enabled).toBe(false);
    expect(creates).toBe(1);
  });

  test("service children never provision a scheduler without an existing opt-in", () => {
    let probes = 0;
    const skipped = ensureDefaultAutoUpdateScheduler(baseDeps("win32", {
      env: { OCX_SERVICE: "1" },
      probeWindows: () => {
        probes += 1;
        return "absent";
      },
    }));
    expect(skipped).toBeNull();
    expect(probes).toBe(0);
  });
});

describe("automatic update overlap and recovery", () => {
  test("lock prevents overlap and is released idempotently", () => {
    const lockPath = join(configDir, "auto-update.lock");
    const first = tryAcquireAutoUpdateLock({ path: lockPath, now: () => FIXED_NOW });
    expect(first).not.toBeNull();
    expect(tryAcquireAutoUpdateLock({ path: lockPath, now: () => FIXED_NOW })).toBeNull();
    first?.release();
    first?.release();
    const second = tryAcquireAutoUpdateLock({ path: lockPath, now: () => FIXED_NOW });
    expect(second).not.toBeNull();
    second?.release();
  });

  test("recovers an old lock only after its recorded process is dead", () => {
    const lockPath = join(configDir, "auto-update.lock");
    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      pid: 424242,
      startedAt: new Date(FIXED_NOW - AUTO_UPDATE_LOCK_STALE_MS - 1_000).toISOString(),
    }));
    const old = new Date(FIXED_NOW - AUTO_UPDATE_LOCK_STALE_MS - 1_000);
    utimesSync(lockPath, old, old);

    expect(tryAcquireAutoUpdateLock({
      path: lockPath,
      now: () => FIXED_NOW,
      isAlive: () => true,
    })).toBeNull();

    const recovered = tryAcquireAutoUpdateLock({
      path: lockPath,
      now: () => FIXED_NOW,
      isAlive: () => false,
    });
    expect(recovered).not.toBeNull();
    recovered?.release();
  });
});

describe("automatic update worker", () => {
  for (const activity of [{ known: false, running: 0 }, { known: true, running: 1 }, { known: true, running: 0, source: true }]) {
    test(`defers before touching packages when activity is ${JSON.stringify(activity)}`, async () => {
      let installs = 0;
      const result = await runAutomaticUpdateWorker({
        configDir, installer: "npm", now: () => FIXED_NOW, currentVersionFn: () => "1.0.2",
        activityFn: async () => activity,
        checkForUpdateFn: channel => ({ currentVersion: "1.0.2", latestVersion: "1.0.3", channel, installer: "npm", updateAvailable: true, canUpdate: true, command: "", releaseNotesUrl: "" }),
        integrityFn: () => { throw new Error("should not inspect package"); },
        runGuiWorkerFn: async () => { installs++; }, readUpdateJobFn: () => null,
      });
      expect(result.result).toBe("busy"); expect(installs).toBe(0);
    });
  }
  test("installs the registry-resolved exact version and records a healthy update", async () => {
    const jobs = new Map<string, UpdateJobState>();
    const exactTargets: string[] = [];
    const result = await runAutomaticUpdateWorker({
      activityFn: async () => ({ known: true, running: 0 }),
      configDir,
      installer: "npm",
      now: () => FIXED_NOW,
      currentVersionFn: () => "1.0.2",
      installedVersionFn: () => "1.0.3",
      checkForUpdateFn: channel => ({
        currentVersion: "1.0.2",
        latestVersion: "1.0.3",
        channel,
        installer: "npm",
        updateAvailable: true,
        canUpdate: true,
        command: "npm install -g @remodex/rmx@1.0.3",
        releaseNotesUrl: "https://github.com/ESCANOR-001/remodex-android/releases/latest",
      }),
      integrityFn: () => VALID_INTEGRITY,
      runGuiWorkerFn: async (jobId, channel, _restart, io) => {
        expect(await io.beforeStopFn?.()).toBe(true);
        exactTargets.push(io.exactVersion ?? "");
        jobs.set(jobId, successfulJob(jobId, io.exactVersion ?? "?", channel));
      },
      readUpdateJobFn: jobId => jobId ? jobs.get(jobId) ?? null : null,
      healthFn: async () => true,
    });

    expect(result).toEqual({
      ok: true,
      result: "updated",
      currentVersion: "1.0.3",
      targetVersion: "1.0.3",
      rolledBack: false,
    });
    expect(exactTargets).toEqual(["1.0.3"]);
    expect(readAutoUpdateState(configDir)).toMatchObject({
      enabled: true,
      lastResult: "updated",
      currentVersion: "1.0.3",
      targetVersion: "1.0.3",
      previousVersion: "1.0.2",
    });
  });

  test("rolls back to the verified previous version when restart health fails", async () => {
    const jobs = new Map<string, UpdateJobState>();
    const exactTargets: string[] = [];
    const integrityTargets: string[] = [];
    let healthCalls = 0;
    const result = await runAutomaticUpdateWorker({
      activityFn: async () => ({ known: true, running: 0 }),
      configDir,
      installer: "npm",
      now: () => FIXED_NOW,
      currentVersionFn: () => "1.0.2",
      installedVersionFn: () => "1.0.3",
      checkForUpdateFn: channel => ({
        currentVersion: "1.0.2",
        latestVersion: "1.0.3",
        channel,
        installer: "npm",
        updateAvailable: true,
        canUpdate: true,
        command: "npm install -g @remodex/rmx@1.0.3",
        releaseNotesUrl: "https://github.com/ESCANOR-001/remodex-android/releases/latest",
      }),
      integrityFn: version => {
        integrityTargets.push(version);
        return VALID_INTEGRITY;
      },
      runGuiWorkerFn: async (jobId, channel, _restart, io) => {
        const target = io.exactVersion ?? "";
        exactTargets.push(target);
        jobs.set(jobId, successfulJob(jobId, target, channel));
      },
      readUpdateJobFn: jobId => jobId ? jobs.get(jobId) ?? null : null,
      healthFn: async () => {
        healthCalls += 1;
        return healthCalls > 1;
      },
    });

    expect(result).toEqual({
      ok: true,
      result: "failed",
      currentVersion: "1.0.2",
      targetVersion: "1.0.3",
      rolledBack: true,
    });
    expect(integrityTargets).toEqual(["1.0.3", "1.0.2"]);
    expect(exactTargets).toEqual(["1.0.3", "1.0.2"]);
    expect(readAutoUpdateState(configDir)).toMatchObject({
      lastResult: "failed",
      currentVersion: "1.0.2",
      targetVersion: "1.0.3",
      lastErrorCode: "update_failed",
      rollback: {
        version: "1.0.2",
        result: "succeeded",
      },
    });
    const retry = await runAutomaticUpdateWorker({
      configDir, installer: "npm", currentVersionFn: () => "1.0.2", readUpdateJobFn: () => null,
      checkForUpdateFn: channel => ({ currentVersion: "1.0.2", latestVersion: "1.0.3", channel, installer: "npm", updateAvailable: true, canUpdate: true, command: "", releaseNotesUrl: "" }),
      activityFn: async () => { throw new Error("blocked version must not start another attempt"); },
    });
    expect(retry.result).toBe("failed");
    expect(exactTargets).toEqual(["1.0.3", "1.0.2"]);
    const newer = {
      configDir, installer: "npm" as const, currentVersionFn: () => "1.0.2", readUpdateJobFn: () => null,
      checkForUpdateFn: (channel: "latest" | "preview") => ({ currentVersion: "1.0.2", latestVersion: "1.0.4", channel, installer: "npm" as const, updateAvailable: true, canUpdate: true, command: "", releaseNotesUrl: "" }),
    };
    // Deferring a newer version must not attach the older version's rollback to it.
    const busyNewer = await runAutomaticUpdateWorker({ ...newer, activityFn: async () => ({ known: true, running: 1 }) });
    expect(busyNewer.result).toBe("busy");
    expect(readAutoUpdateState(configDir)?.rollback).toBeUndefined();
    let verifiedNewer = false;
    await runAutomaticUpdateWorker({ ...newer, activityFn: async () => ({ known: true, running: 0 }),
      integrityFn: () => { verifiedNewer = true; return { ok: "skipped", reason: "offline" }; },
    });
    expect(verifiedNewer).toBe(true);
  });

  test("fails closed before package replacement when integrity cannot be verified", async () => {
    let workerRuns = 0;
    const result = await runAutomaticUpdateWorker({
      activityFn: async () => ({ known: true, running: 0 }),
      configDir,
      installer: "npm",
      now: () => FIXED_NOW,
      currentVersionFn: () => "1.0.2",
      checkForUpdateFn: channel => ({
        currentVersion: "1.0.2",
        latestVersion: "1.0.3",
        channel,
        installer: "npm",
        updateAvailable: true,
        canUpdate: true,
        command: "npm install -g @remodex/rmx@1.0.3",
        releaseNotesUrl: "https://github.com/ESCANOR-001/remodex-android/releases/latest",
      }),
      integrityFn: () => ({ ok: "skipped", reason: "registry unavailable" }),
      runGuiWorkerFn: async () => {
        workerRuns += 1;
      },
      readUpdateJobFn: () => null,
    });

    expect(result.ok).toBe(false);
    expect(result.result).toBe("failed");
    expect(workerRuns).toBe(0);
    expect(readAutoUpdateState(configDir)).toMatchObject({
      lastResult: "failed",
      lastErrorCode: "integrity_unavailable",
      targetVersion: "1.0.3",
    });
  });
});
