import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  loadServiceProviderEnvironmentFromFile,
  removeServiceProviderEnvFile,
  SERVICE_PROVIDER_ENV_FILE_ENV,
  serviceProviderEnvironmentReferences,
  serviceProviderEnvFilePath,
  shouldLoadServiceProviderEnvironment,
  unresolvedServiceProviderEnvironment,
  writeServiceProviderEnvironment,
} from "../src/lib/service-secrets";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-service-provider-environment");
const previousOpenCodexHome = process.env.OPENCODEX_HOME;

function config(): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "codex-lb",
    proxy: "${UPSTREAM_PROXY_URL}",
    providers: {
      "codex-lb": {
        adapter: "openai-responses",
        baseUrl: "https://provider.example.test/v1",
        authMode: "key",
        apiKey: "${CODEX_LB_API_KEY}",
        apiKeyPool: [
          { id: "active", key: "${CODEX_LB_API_KEY}" },
          { id: "standby", key: "$CODEX_LB_STANDBY_KEY" },
        ],
      },
      oauth: {
        adapter: "openai-responses",
        baseUrl: "https://oauth.example.test/v1",
        authMode: "oauth",
        apiKey: "${MUST_NOT_BE_SNAPSHOTTED}",
      },
      literal: {
        adapter: "openai-chat",
        baseUrl: "https://literal.example.test/v1",
        apiKey: "literal-value",
      },
    },
  } as OcxConfig;
}

beforeEach(() => {
  process.env.OPENCODEX_HOME = TEST_DIR;
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
});

describe("durable service provider environment", () => {
  test("only service and installed desktop actions hydrate the durable snapshot", () => {
    expect(shouldLoadServiceProviderEnvironment({ OCX_SERVICE: "1" })).toBe(true);
    expect(shouldLoadServiceProviderEnvironment({ OCX_DESKTOP: "1" })).toBe(true);
    expect(shouldLoadServiceProviderEnvironment({})).toBe(false);
  });
  test("collects only referenced key/proxy variables, including standby pool entries", () => {
    expect(serviceProviderEnvironmentReferences(config())).toEqual([
      "CODEX_LB_API_KEY",
      "CODEX_LB_STANDBY_KEY",
      "UPSTREAM_PROXY_URL",
    ]);
  });

  test("writes an owner-only snapshot and hydrates a service without overriding manager values", () => {
    const values = {
      CODEX_LB_API_KEY: "value-a",
      CODEX_LB_STANDBY_KEY: "value-b",
      UPSTREAM_PROXY_URL: "http://proxy.example.test:8080",
    };
    expect(writeServiceProviderEnvironment(config(), values)).toEqual({ missing: [], written: 3 });

    const path = serviceProviderEnvFilePath();
    expect(existsSync(path)).toBe(true);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("MUST_NOT_BE_SNAPSHOTTED");

    const serviceEnv: Record<string, string | undefined> = {
      [SERVICE_PROVIDER_ENV_FILE_ENV]: path,
      CODEX_LB_STANDBY_KEY: "manager-value",
    };
    expect(loadServiceProviderEnvironmentFromFile(serviceEnv)).toBe(2);
    expect(serviceEnv.CODEX_LB_API_KEY).toBe("value-a");
    expect(serviceEnv.CODEX_LB_STANDBY_KEY).toBe("manager-value");
    expect(serviceEnv.UPSTREAM_PROXY_URL).toBe("http://proxy.example.test:8080");
  });

  test("retains a prior snapshot during repair and reports genuinely unresolved references", () => {
    const live = config();
    const values = {
      CODEX_LB_API_KEY: "value-a",
      CODEX_LB_STANDBY_KEY: "value-b",
      UPSTREAM_PROXY_URL: "http://proxy.example.test:8080",
    };
    expect(writeServiceProviderEnvironment(live, values).missing).toEqual([]);
    expect(writeServiceProviderEnvironment(live, {}).missing).toEqual([]);
    expect(unresolvedServiceProviderEnvironment(live, {})).toEqual([]);

    live.providers["missing"] = {
      adapter: "openai-chat",
      baseUrl: "https://missing.example.test/v1",
      apiKey: "${MISSING_PROVIDER_KEY}",
    };
    expect(writeServiceProviderEnvironment(live, {})).toMatchObject({
      missing: ["MISSING_PROVIDER_KEY"],
      written: 0,
    });
  });

  test("rejects foreign pointers and over-permissive snapshots", () => {
    expect(writeServiceProviderEnvironment(config(), {
      CODEX_LB_API_KEY: "value-a",
      CODEX_LB_STANDBY_KEY: "value-b",
      UPSTREAM_PROXY_URL: "http://proxy.example.test:8080",
    }).missing).toEqual([]);

    const foreign: Record<string, string | undefined> = {
      [SERVICE_PROVIDER_ENV_FILE_ENV]: join(TEST_DIR, "other.json"),
    };
    expect(loadServiceProviderEnvironmentFromFile(foreign)).toBe(0);
    expect(foreign.CODEX_LB_API_KEY).toBeUndefined();

    if (process.platform !== "win32") {
      chmodSync(serviceProviderEnvFilePath(), 0o644);
      const exposed: Record<string, string | undefined> = {
        [SERVICE_PROVIDER_ENV_FILE_ENV]: serviceProviderEnvFilePath(),
      };
      expect(loadServiceProviderEnvironmentFromFile(exposed)).toBe(0);
      expect(exposed.CODEX_LB_API_KEY).toBeUndefined();
    }
  });

  test("removes the service snapshot without following a replacement symlink", () => {
    expect(writeServiceProviderEnvironment(config(), {
      CODEX_LB_API_KEY: "value-a",
      CODEX_LB_STANDBY_KEY: "value-b",
      UPSTREAM_PROXY_URL: "http://proxy.example.test:8080",
    }).missing).toEqual([]);
    removeServiceProviderEnvFile();
    expect(existsSync(serviceProviderEnvFilePath())).toBe(false);
  });
});
