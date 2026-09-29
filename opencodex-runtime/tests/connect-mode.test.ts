import { afterEach, expect, test } from "bun:test";
import { connectManagementRouteAllowed, defaultProxyPort } from "../src/connect/mode";
import { getDefaultConfig, validateConfigCandidate } from "../src/config";
import { canManageCodexConfig, setCodexConfigPermission } from "../src/codex/config-permission";
import { integrationEnabled } from "../src/codex/desired-state";
import { remodexCodexAppServerArgs } from "../src/android-remote/codex-app-server";
import { installShellHook, revertSystemEnv } from "../src/server/system-env";
import { stripGrokConfig } from "../src/grok/inject";
import { ensureDefaultAutoUpdateScheduler } from "../src/update/auto-scheduler";

const previous = process.env.REMODEX_CONNECT_ONLY;
afterEach(() => {
  if (previous === undefined) delete process.env.REMODEX_CONNECT_ONLY;
  else process.env.REMODEX_CONNECT_ONLY = previous;
});

test("Connect uses the standard production dashboard port and preserves explicit ports", () => {
  process.env.REMODEX_CONNECT_ONLY = "1";
  expect(defaultProxyPort()).toBe(10100);
  expect(getDefaultConfig().port).toBe(10100);
  const config = { ...getDefaultConfig(), port: undefined };
  expect(validateConfigCandidate(config)).toMatchObject({ ok: true, config: { port: 10100 } });
  expect(validateConfigCandidate({ ...config, port: 12345 })).toMatchObject({ ok: true, config: { port: 12345 } });
  delete process.env.REMODEX_CONNECT_ONLY;
  expect(defaultProxyPort()).toBe(10100);
  expect(getDefaultConfig().port).toBe(10100);
  expect(validateConfigCandidate(config)).toMatchObject({ ok: true, config: { port: 10100 } });
});

test("Connect denies config consent and integration activation even with legacy consent", () => {
  process.env.REMODEX_CONNECT_ONLY = "1";
  expect(canManageCodexConfig({ codexConfigWriteConsent: "/tmp/config.toml" }, "/tmp/config.toml")).toBe(false);
  expect(() => setCodexConfigPermission(true)).toThrow("never manages");
  expect(integrationEnabled({ clientIntegrations: { codex: true } }, "codex")).toBe(false);
  expect(installShellHook().installed).toBe(false);
  expect(revertSystemEnv().reverted).toBe(false);
  expect(stripGrokConfig().changed).toBe(false);
  expect(ensureDefaultAutoUpdateScheduler({ env: { REMODEX_CONNECT_ONLY: "1" } })).toBeNull();
});

test("native app-server uses in-process OpenAI selection instead of a generated provider profile", () => {
  process.env.REMODEX_CONNECT_ONLY = "1";
  const args = remodexCodexAppServerArgs(10106, 'model_provider="opencodex"\nmodel_catalog_json="modified.json"');
  expect(args).toContain('model_provider="openai"');
  expect(args.join(" ")).not.toContain("opencodex");
  expect(args.join(" ")).not.toContain("modified.json");
});

test("removed provider, account, model, and integration routes cannot mutate configuration", () => {
  for (const path of ["/api/providers", "/api/models", "/api/integrations", "/api/debug", "/api/settings", "/api/oauth/accounts"]) {
    expect(connectManagementRouteAllowed(path, "PUT")).toBe(false);
    expect(connectManagementRouteAllowed(path, "POST")).toBe(false);
  }
  expect(connectManagementRouteAllowed("/api/connect/activity", "GET")).toBe(true);
  expect(connectManagementRouteAllowed("/api/connect/activity", "POST")).toBe(false);
  expect(connectManagementRouteAllowed("/api/update/check", "GET")).toBe(true);
  expect(connectManagementRouteAllowed("/api/update/check", "POST")).toBe(false);
  expect(connectManagementRouteAllowed("/api/update/run", "POST")).toBe(false);
  expect(connectManagementRouteAllowed("/api/android-remote/pairing", "POST")).toBe(true);
});
