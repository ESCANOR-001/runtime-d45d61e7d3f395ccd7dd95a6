import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, saveConfig } from "../src/config";
import { CODEX_CONFIG_PATH, CODEX_MODELS_CACHE_PATH } from "../src/codex/paths";
import { canManageCodexConfig, setCodexConfigPermission } from "../src/codex/config-permission";
import { injectCodexConfig, removeCodexConfig, restoreNativeCodexAsync } from "../src/codex/inject";
import { reconcileJournal, restoreJournalState } from "../src/codex/journal";
import { syncModelsToCodex } from "../src/codex/sync";
import { syncCodexOnStartIfEnabled } from "../src/codex/desired-state";
import { handleManagementAPI } from "../src/server/management-api";
import { syncCatalogModels, restoreCodexCatalog } from "../src/codex/catalog";
import { getConfigPath } from "../src/config";
import { captureCodexPreImages, restoreCodexPreImages } from "../src/codex/inject-coordination";
import { runHistoryUnitUnderLock } from "../src/codex/history-worker";

let previousHome: string | undefined;
let root: string;
let originalConfig: Buffer | null;
const configText = '# user comment\r\nmodel_provider = "codex-lb"\r\nmodel = "gpt-6-astra"\r\nmodel_reasoning_effort = "high"\r\nservice_tier = "priority"\r\n[model_providers.codex-lb]\r\nname = "Codex-LB"\r\nbase_url = "https://example.invalid/v1"\r\n';

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "rmx-config-permission-"));
  process.env.OPENCODEX_HOME = root;
  saveConfig({ port: 10100, providers: {}, defaultProvider: "openai", clientIntegrations: { codex: true } });
  mkdirSync(dirname(CODEX_CONFIG_PATH), { recursive: true });
  originalConfig = existsSync(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH) : null;
  writeFileSync(CODEX_CONFIG_PATH, configText);
});

afterEach(() => {
  if (originalConfig) writeFileSync(CODEX_CONFIG_PATH, originalConfig);
  else rmSync(CODEX_CONFIG_PATH, { force: true });
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

test.each([
  configText,
  'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n',
  '# Auto-injected by Remodex\nopenai_base_url = "http://127.0.0.1:10100/v1"\nmodel_catalog_json = "opencodex-catalog.json"\n',
])("enabling integration is not consent to edit Codex files: %s", async (nativeConfig) => {
  writeFileSync(CODEX_CONFIG_PATH, nativeConfig);
  expect(canManageCodexConfig()).toBe(false);
  const before = readFileSync(CODEX_CONFIG_PATH);
  const cacheBefore = existsSync(CODEX_MODELS_CACHE_PATH) ? readFileSync(CODEX_MODELS_CACHE_PATH) : null;
  let startupWrites = 0;
  expect(await syncCodexOnStartIfEnabled(10100, loadConfig(), async () => {
    startupWrites++;
    return { ok: true };
  })).toMatchObject({ ran: false });
  expect(startupWrites).toBe(0);
  expect(await syncModelsToCodex()).toMatchObject({ ok: true, skippedReason: "permission_required", catalogWritten: false });
  expect(await injectCodexConfig(10100, loadConfig(), { takeoverExistingRouting: true })).toMatchObject({ skippedReason: "permission_required" });
  expect(removeCodexConfig().success).toBe(true);
  expect((await restoreNativeCodexAsync()).artifacts.config.changed).toBe(false);
  expect(reconcileJournal()).toBe(false);
  expect(restoreJournalState().configRestored).toBe(false);
  expect(readFileSync(CODEX_CONFIG_PATH)).toEqual(before);
  expect(existsSync(CODEX_MODELS_CACHE_PATH) ? readFileSync(CODEX_MODELS_CACHE_PATH) : null).toEqual(cacheBefore);
});

test("permission is explicit, durable, revocable, and scoped to one Codex configuration", () => {
  const before = readFileSync(CODEX_CONFIG_PATH);
  setCodexConfigPermission(true);
  expect(canManageCodexConfig()).toBe(true);
  expect(canManageCodexConfig(loadConfig(), join(root, "another-config.toml"))).toBe(false);
  expect(readFileSync(CODEX_CONFIG_PATH)).toEqual(before);
  setCodexConfigPermission(false);
  expect(canManageCodexConfig()).toBe(false);
  expect(loadConfig().codexConfigWriteConsent).toBeUndefined();
  expect(readFileSync(CODEX_CONFIG_PATH)).toEqual(before);
});

test("missing native config is never created by an unapproved sync", async () => {
  rmSync(CODEX_CONFIG_PATH);
  expect(await injectCodexConfig(10100)).toMatchObject({ skippedReason: "permission_required" });
  expect(await syncModelsToCodex()).toMatchObject({ skippedReason: "permission_required" });
  expect(existsSync(CODEX_CONFIG_PATH)).toBe(false);
});

test("permission resolves aliases of the same home without authorizing another file or home", () => {
  const nativeHome = join(root, "native-home");
  const aliasHome = join(root, "alias-home");
  const otherHome = join(root, "other-home");
  mkdirSync(nativeHome);
  mkdirSync(otherHome);
  symlinkSync(nativeHome, aliasHome, process.platform === "win32" ? "junction" : "dir");
  const canonicalConfig = join(realpathSync.native(nativeHome), "config.toml");
  const consent = { codexConfigWriteConsent: join(aliasHome, "config.toml") };
  expect(canManageCodexConfig(consent, canonicalConfig)).toBe(true);
  expect(canManageCodexConfig(consent, join(nativeHome, "other.toml"))).toBe(false);
  expect(canManageCodexConfig(consent, join(otherHome, "config.toml"))).toBe(false);
  expect(existsSync(canonicalConfig)).toBe(false);
  unlinkSync(aliasHome);
  expect(canManageCodexConfig(consent, canonicalConfig)).toBe(false);
});

test("Connect mode refuses consent even when both paths resolve to the same home", () => {
  const previous = process.env.REMODEX_CONNECT_ONLY;
  try {
    process.env.REMODEX_CONNECT_ONLY = "1";
    expect(canManageCodexConfig({ codexConfigWriteConsent: CODEX_CONFIG_PATH })).toBe(false);
    expect(() => setCodexConfigPermission(true)).toThrow("never manages");
    expect(readFileSync(CODEX_CONFIG_PATH, "utf8")).toBe(configText);
  } finally {
    if (previous === undefined) delete process.env.REMODEX_CONNECT_ONLY;
    else process.env.REMODEX_CONNECT_ONLY = previous;
  }
});

test("repair cannot restore an earlier config after permission is revoked", () => {
  setCodexConfigPermission(true);
  const earlier = captureCodexPreImages();
  setCodexConfigPermission(false);
  const userEdit = configText + "\n# The user changed this after stopping Remodex access.\n";
  writeFileSync(CODEX_CONFIG_PATH, userEdit);
  expect(restoreCodexPreImages(earlier)).toMatchObject({ complete: false });
  expect(readFileSync(CODEX_CONFIG_PATH, "utf8")).toBe(userEdit);
});

test("an automatic OFF restore cannot treat missing permission as approval", () => {
  saveConfig({ ...loadConfig(), clientIntegrations: { codex: false } });
  const home = dirname(CODEX_CONFIG_PATH);
  const statePath = join(home, "permission-test.sqlite");
  writeFileSync(statePath, "user history must remain unopened");
  try {
    expect(runHistoryUnitUnderLock({
      type: "run", requestId: "permission-test", jobId: "permission-test",
      operation: "restore-openai", canonicalCodexHome: home,
      canonicalStateDbPath: statePath, canonicalBackupPath: join(root, "history-backup.json"),
      expectedDesiredEnabled: false,
    })).toMatchObject({ type: "blocked", reason: "permission_required" });
    expect(readFileSync(statePath, "utf8")).toBe("user history must remain unopened");
  } finally {
    rmSync(statePath);
  }
});

test("dashboard sync and integration switches cannot silently grant configuration access", async () => {
  const nativeBefore = readFileSync(CODEX_CONFIG_PATH);
  const remodexBefore = readFileSync(getConfigPath());
  for (const [path, method, body] of [
    ["/api/sync", "POST", { takeoverExistingRouting: true, hardRestartDesktop: true }],
    ["/api/native-integrations/codex", "PUT", { enabled: true }],
    ["/api/native-integrations/codex", "PUT", { enabled: false }],
  ] as const) {
    const url = new URL(path, "http://localhost");
    const response = await handleManagementAPI(new Request(url, {
      method, headers: { Host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), url, loadConfig());
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ code: "codex_config_permission_required" });
  }
  expect(readFileSync(CODEX_CONFIG_PATH)).toEqual(nativeBefore);
  expect(readFileSync(getConfigPath())).toEqual(remodexBefore);
});

test("automatic catalog refresh and cleanup remain read-only without permission", async () => {
  const before = readFileSync(CODEX_CONFIG_PATH);
  expect((await syncCatalogModels(loadConfig())).catalogWritten).toBe(false);
  expect(restoreCodexCatalog().removed).toBe(0);
  expect(readFileSync(CODEX_CONFIG_PATH)).toEqual(before);
  expect(canManageCodexConfig({ codexConfigWriteConsent: "config.toml" })).toBe(false);
});
