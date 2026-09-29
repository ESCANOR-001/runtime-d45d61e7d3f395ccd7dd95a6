import { describe, expect, test } from "bun:test";
import {
  hydrateProviderEnvironment,
  parseEnvironmentAssignments,
  providerEnvironmentReferences,
} from "../src/lib/provider-environment";
import type { OcxConfig } from "../src/types";

function config(): OcxConfig {
  return {
    proxy: "${PROXY_FROM_ENV}",
    providers: {
      "codex-lb": {
        adapter: "openai-responses",
        baseUrl: "https://provider.example.test/v1",
        authMode: "key",
        apiKey: "${CODEX_LB_API_KEY}",
        apiKeyPool: [{ id: "standby", key: "$CODEX_LB_STANDBY_KEY" }],
      },
      oauth: {
        adapter: "openai-responses",
        baseUrl: "https://oauth.example.test/v1",
        authMode: "oauth",
        apiKey: "${OAUTH_VALUE_MUST_NOT_BE_READ}",
      },
      forward: {
        adapter: "openai-responses",
        baseUrl: "https://forward.example.test/v1",
        authMode: "forward",
        apiKey: "${FORWARD_VALUE_MUST_NOT_BE_READ}",
      },
    },
    defaultProvider: "codex-lb",
  } as OcxConfig;
}

describe("provider environment discovery", () => {
  test("builds an allowlist and skips non-key auth modes", () => {
    expect(providerEnvironmentReferences(config())).toEqual([
      "CODEX_LB_API_KEY",
      "CODEX_LB_STANDBY_KEY",
      "PROXY_FROM_ENV",
    ]);
  });

  test("process values win and only unresolved names reach the OS reader", () => {
    const calls: string[][] = [];
    const env: Record<string, string | undefined> = {
      CODEX_LB_API_KEY: "process-value",
    };
    const result = hydrateProviderEnvironment(config(), {
      platform: "linux",
      env,
      persistedFiles: [],
      runCommand: (_command, args) => {
        calls.push([...args]);
        return "CODEX_LB_API_KEY=should-not-win\nPROXY_FROM_ENV=http://proxy.test\nCODEX_LB_STANDBY_KEY=standby\n";
      },
    });

    expect(env.CODEX_LB_API_KEY).toBe("process-value");
    expect(env.PROXY_FROM_ENV).toBe("http://proxy.test");
    expect(env.CODEX_LB_STANDBY_KEY).toBe("standby");
    expect(result.loadedNames).toEqual(["CODEX_LB_STANDBY_KEY", "PROXY_FROM_ENV"]);
    expect(result.sources.CODEX_LB_API_KEY).toBe("process");
    expect(calls).toHaveLength(1);
  });

  test("reads launchctl values on macOS without reading unrelated names", () => {
    const calls: string[][] = [];
    const env: Record<string, string | undefined> = {};
    const result = hydrateProviderEnvironment(config(), {
      platform: "darwin",
      env,
      persistedFiles: [],
      runCommand: (_command, args) => {
        calls.push([...args]);
        const name = args[1];
        return name === "CODEX_LB_API_KEY" ? "mac-value\n" : null;
      },
    });

    expect(env.CODEX_LB_API_KEY).toBe("mac-value");
    expect(result.missing).toEqual(["CODEX_LB_STANDBY_KEY", "PROXY_FROM_ENV"]);
    expect(calls.map(args => args[1])).toEqual([
      "CODEX_LB_API_KEY",
      "CODEX_LB_STANDBY_KEY",
      "PROXY_FROM_ENV",
    ]);
  });

  test("prefers the Windows user registry value over machine value", () => {
    const env: Record<string, string | undefined> = { SystemRoot: "C:\\Windows" };
    const roots: string[] = [];
    const result = hydrateProviderEnvironment(config(), {
      platform: "win32",
      env,
      persistedFiles: [],
      resolveWindowsSystemDirectory: () => "C:\\Windows\\System32",
      runCommand: (_command, args) => {
        const root = args[1] ?? "";
        roots.push(root);
        if (root === "HKCU\\Environment" && args[2] === "/v" && args[3] === "CODEX_LB_API_KEY") {
          return "HKEY_CURRENT_USER\\Environment\n    CODEX_LB_API_KEY    REG_SZ    windows-user\n";
        }
        if (root === "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" && args[3] === "CODEX_LB_API_KEY") {
          return "CODEX_LB_API_KEY    REG_SZ    windows-machine\n";
        }
        return null;
      },
    });

    expect(env.CODEX_LB_API_KEY).toBe("windows-user");
    expect(result.sources.CODEX_LB_API_KEY).toBe("os");
    expect(roots).toContain("HKCU\\Environment");
  });

  test("does not let SystemRoot redirect the registry executable", () => {
    const env: Record<string, string | undefined> = { SystemRoot: "C:\\attacker" };
    const commands: string[] = [];
    const result = hydrateProviderEnvironment(config(), {
      platform: "win32",
      env,
      persistedFiles: [],
      resolveWindowsSystemDirectory: () => "C:\\Windows\\System32",
      runCommand: (command) => {
        commands.push(command);
        return "HKEY_CURRENT_USER\\Environment\n    CODEX_LB_API_KEY    REG_SZ    safe-value\n";
      },
    });

    expect(env.CODEX_LB_API_KEY).toBe("safe-value");
    expect(result.sources.CODEX_LB_API_KEY).toBe("os");
    expect(commands[0]).toBe("C:\\Windows\\System32\\reg.exe");
    expect(commands[0]).not.toContain("attacker");
  });

  test("parses safe assignments and rejects executable shell fragments", () => {
    const parsed = parseEnvironmentAssignments(`
# comments are ignored
CODEX_LB_API_KEY="quoted-value" # trailing comment
PROXY_FROM_ENV='http://proxy.test:8080'
CODEX_LB_STANDBY_KEY=$(cat /tmp/secret)
UNRELATED=must-not-be-imported
`, ["CODEX_LB_API_KEY", "PROXY_FROM_ENV", "CODEX_LB_STANDBY_KEY"]);

    expect(parsed).toEqual({
      CODEX_LB_API_KEY: "quoted-value",
      PROXY_FROM_ENV: "http://proxy.test:8080",
    });
  });

  test("falls back to persisted files only after OS lookup", () => {
    const env: Record<string, string | undefined> = {};
    const result = hydrateProviderEnvironment(config(), {
      platform: "linux",
      env,
      persistedFiles: ["first", "second"],
      runCommand: () => null,
      readFile: path => path === "first"
        ? "CODEX_LB_API_KEY=first\nPROXY_FROM_ENV=proxy-first\n"
        : "CODEX_LB_API_KEY=second\n",
    });

    expect(env.CODEX_LB_API_KEY).toBe("second");
    expect(env.PROXY_FROM_ENV).toBe("proxy-first");
    expect(result.sources.CODEX_LB_API_KEY).toBe("file");
    expect(result.missing).toEqual(["CODEX_LB_STANDBY_KEY"]);
  });
});
