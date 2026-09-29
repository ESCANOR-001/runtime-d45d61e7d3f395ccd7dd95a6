import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");
const binPath = join(repoRoot, "bin", "ocx.mjs");

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("CLI subcommand help", () => {
  test("version commands print a single script-friendly line", () => {
    for (const args of [["--version"], ["-v"], ["version"]]) {
      const result = runCli(args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toMatch(/^Remodex \d+\.\d+\.\d+/);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
    }

    const binResult = spawnSync(process.execPath, [binPath, "--version"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    });
    expect(binResult.status).toBe(0);
    expect(binResult.stdout.trim()).toMatch(/^Remodex \d+\.\d+\.\d+/);
    expect(binResult.stdout.trim().split("\n")).toHaveLength(1);
  }, { timeout: 20_000 });

  test("help command routes to subcommand help", () => {
    const result = runCli(["help", "start"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: rmx start [--port <port>]");
    expect(result.stdout).not.toContain("Usage: ocx start");
    expect(result.stdout).toContain("Start the proxy; Codex sync requires configuration permission.");
  });

  test("top-level help forms exit before Codex shim auto-restore can mutate launchers", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-help-shim-home-"));
    const binDir = mkdtempSync(join(tmpdir(), "ocx-help-shim-bin-"));
    try {
      const wrapper = join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
      const backup = join(binDir, process.platform === "win32" ? "codex.opencodex-real.cmd" : "codex.opencodex-real");
      const statePath = join(opencodexHome, "codex-shim.json");
      const replacement = "replacement that help must not promote\n";
      writeFileSync(wrapper, replacement, "utf8");
      writeFileSync(backup, "known-good prior launcher\n", "utf8");
      if (process.platform !== "win32") chmodSync(wrapper, 0o755);
      writeFileSync(statePath, `${JSON.stringify({
        platform: process.platform,
        wrapperPath: wrapper,
        originalPath: wrapper,
        backupPath: backup,
      }, null, 2)}\n`, "utf8");
      const stateBefore = readFileSync(statePath);
      const backupBefore = readFileSync(backup);
      Bun.sleepSync(120);

      for (const args of [[], ["help"], ["--help"], ["-h"]]) {
        const result = runCli(args, { OPENCODEX_HOME: opencodexHome, PATH: binDir });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Remodex (rmx)");
        expect(result.stdout).toContain("Compatibility aliases: remodex, opencodex, ocx");
        expect(result.stdout).toContain("These aliases accept the same commands as rmx.");
        expect(result.stdout).not.toContain("\n  ocx ");
        expect(readFileSync(wrapper, "utf8")).toBe(replacement);
        expect(readFileSync(backup)).toEqual(backupBefore);
        expect(readFileSync(statePath)).toEqual(stateBefore);
      }
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("tray help documents the install-only no-start flag", () => {
    const result = runCli(["help", "tray"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--no-start");
  });

  test("onboard help documents the complete one-command setup", () => {
    const result = runCli(["onboard", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: rmx onboard [--verbose] [--json] [--no-open]");
    expect(result.stdout).toContain("three stages");
    expect(result.stdout).toContain("same trusted Wi-Fi");
    expect(result.stdout).toContain("Windows tray setup are in Advanced Settings");
  });

  test("system help documents npm package update controls", () => {
    const result = runCli(["help", "system"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("update auto on");
    expect(result.stdout).toContain("update auto off");
    expect(result.stdout).toContain("enabled by default for global installs");
    expect(result.stdout).not.toContain("desktop-update");
    expect(result.stdout).not.toContain("desktop shell");
  });

  test("unknown command with help flag remains an error", () => {
    const result = runCli(["foobar", "--help"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: foobar");
    expect(result.stdout).toContain("Remodex (rmx)");
  });

  test("status prints diagnostics without starting the proxy", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-status-"));
    try {
      const configPath = join(opencodexHome, "config.json");
      writeFileSync(configPath, JSON.stringify({
        port: 9,
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
          },
        },
        defaultProvider: "openai",
        codexAutoStart: false,
      }), "utf8");

      const result = spawnSync(process.execPath, [cliPath, "status"], {
        cwd: repoRoot,
        env: { ...process.env, OPENCODEX_HOME: opencodexHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Proxy:");
      expect(result.stdout).toContain("Health: http://127.0.0.1:9/healthz");
      expect(result.stdout).toContain("Dashboard: http://localhost:9/");
      expect(result.stdout).toContain(`Config: ${configPath}`);
      expect(result.stdout).toContain(`PID file: ${join(opencodexHome, "ocx.pid")}`);
      expect(result.stdout).toContain("Runtime:");
      expect(result.stdout).toContain("Runtime source:");
      expect(result.stdout).toContain("Default provider: openai");
      expect(result.stdout).toContain("Codex autostart: disabled");
      expect(result.stdout).toContain("Service:");
      expect(result.stdout).toContain(join(opencodexHome, "service.log"));
      expect(result.stdout).toContain("Codex autostart shim");
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
    }
  });

  test("restore --help prints usage without mutating Codex config", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-help-"));
    try {
      const configPath = join(codexHome, "config.toml");
      const before = [
        'model_provider = "opencodex"',
        "",
        "[model_providers.opencodex]",
        'base_url = "http://localhost:10100/v1"',
        'wire_api = "responses"',
        "",
      ].join("\n");
      writeFileSync(configPath, before, "utf8");

      const result = spawnSync(process.execPath, [cliPath, "restore", "--help"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: rmx restore");
      expect(result.stdout).not.toContain("Plain `codex` now runs natively");
      expect(readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("mutating command help exits before local state changes", () => {
    const opencodexHome = mkdtempSync(join(tmpdir(), "ocx-help-state-"));
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-help-codex-"));
    try {
      const configPath = join(codexHome, "config.toml");
      const markerPath = join(opencodexHome, "service-state.json");
      const before = 'model_provider = "opencodex"\n';
      writeFileSync(configPath, before, "utf8");
      writeFileSync(markerPath, '{"installed":true}', "utf8");

      const cases = [
        { args: ["stop", "--help"], expected: "Usage: rmx stop" },
        { args: ["uninstall", "--help"], expected: "Usage: rmx uninstall" },
        { args: ["service", "uninstall", "--help"], expected: "Usage: rmx service" },
        { args: ["codex-shim", "uninstall", "--help"], expected: "Usage: rmx codex-shim" },
      ];

      for (const testCase of cases) {
        const result = runCli(testCase.args, {
          CODEX_HOME: codexHome,
          OPENCODEX_HOME: opencodexHome,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(testCase.expected);
        expect(readFileSync(configPath, "utf8")).toBe(before);
        expect(readFileSync(markerPath, "utf8")).toBe('{"installed":true}');
      }
    } finally {
      rmSync(opencodexHome, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("recover-history --help prints usage without opening history database", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ocx-help-"));
    try {
      const statePath = join(codexHome, "state_5.sqlite");

      const result = spawnSync(process.execPath, [cliPath, "recover-history", "--help"], {
        cwd: repoRoot,
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: rmx recover-history --legacy-openai");
      expect(result.stdout).toContain("Explicitly recover pre-backup syncResumeHistory rows.");
      expect(result.stdout).not.toContain("Recovered");
      expect(result.stderr).toBe("");
      expect(existsSync(statePath)).toBe(false);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("start rejects unknown and partially numeric port arguments", () => {
    const cases = [
      { args: ["start", "--port", "123abc"], expected: "Invalid port number" },
      { args: ["start", "--bad"], expected: "Usage: rmx start [--port <port>]" },
      { args: ["start", "--port", "1234", "--extra"], expected: "Usage: rmx start [--port <port>]" },
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(testCase.expected);
      expect(result.stdout).not.toContain("Plain `codex`");
    }
  });

  test("start help wins before port validation", () => {
    const result = runCli(["start", "--port", "123abc", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: rmx start [--port <port>]");
  });

  test("invalid service and codex-shim usage include remove alias", () => {
    const cases = [
      { args: ["service", "nope"], expected: "Usage: rmx service [install|repair|start|stop|status|uninstall|remove] [--native|--scheduler]" },
      { args: ["codex-shim", "nope"], expected: "Usage: rmx codex-shim <install|status|uninstall|remove>" },
    ];

    for (const testCase of cases) {
      const result = runCli(testCase.args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(testCase.expected);
      expect(result.stdout).toBe("");
    }
  });
});
