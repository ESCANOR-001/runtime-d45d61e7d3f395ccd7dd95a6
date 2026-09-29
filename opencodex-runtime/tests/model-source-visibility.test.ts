import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalogEntries, filterCatalogVisibleModels } from "../src/codex/catalog";
import { loadConfig, saveConfig } from "../src/config";
import {
  modelSourceDisplayName,
  modelSourceVisible,
  sourceAwareModelDisplayName,
} from "../src/model-sources";
import { handleManagementAPI } from "../src/server/management-api";
import { listManagementModelRows } from "../src/server/management/model-rows";
import type { AndroidRemoteGatewayController } from "../src/android-remote/gateway";
import type { CatalogModel } from "../src/codex/catalog";
import type { OcxConfig } from "../src/types";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";
import { ManagementRequest as Request } from "./helpers/management-auth";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const previousHome = process.env.OPENCODEX_HOME;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let configDir = "";

function config(): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
      "codex-lb": {
        adapter: "openai-responses",
        baseUrl: "https://lb.example.test/v1",
        liveModels: false,
        models: ["gpt-5.6-sol"],
        modelReasoningEfforts: {
          "gpt-5.6-sol": ["low", "high", "max"],
        },
      },
    },
  };
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "ocx-model-source-"));
  process.env.OPENCODEX_HOME = configDir;
  isolatedCodexHome = installIsolatedCodexHome("ocx-model-source-codex-");
});

afterEach(() => {
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  rmSync(configDir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
});

describe("model source visibility", () => {
  test("missing and future provider keys default visible", () => {
    expect(modelSourceVisible({}, "openai")).toBe(true);
    expect(modelSourceVisible({ modelSourceVisibility: {} }, "future-provider")).toBe(true);
    expect(modelSourceVisible({
      modelSourceVisibility: { "codex-lb": false },
    }, "codex-lb")).toBe(false);
  });

  test("model labels retain the legacy names without source suffixes", () => {
    expect(modelSourceDisplayName("codex-lb")).toBe("Codex-LB");
    expect(sourceAwareModelDisplayName({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      native: true,
    })).toBe("GPT-5.6 Sol");
    expect(sourceAwareModelDisplayName({
      provider: "codex-lb",
      modelId: "gpt-5.6-sol",
    })).toBe("GPT-5.6 Sol");
  });

  test("catalog filtering hides only the selected source", () => {
    const rows: CatalogModel[] = [
      { provider: "codex-lb", id: "gpt-5.6-sol" },
      { provider: "cursor", id: "gpt-5.6-sol" },
    ];
    const visible = filterCatalogVisibleModels(rows, {
      providers: config().providers,
      modelSourceVisibility: { "codex-lb": false },
    });
    expect(visible.map(row => `${row.provider}/${row.id}`)).toEqual(["cursor/gpt-5.6-sol"]);
  });

  test("Codex catalog preserves its legacy native and routed labels", () => {
    const entries = buildCatalogEntries(
      {
        slug: "gpt-5.5",
        display_name: "GPT-5.5",
        description: "native",
        priority: 1,
        visibility: "list",
        base_instructions: "native",
        supported_reasoning_levels: [],
      },
      ["gpt-5.6-sol"],
      [{ provider: "codex-lb", id: "gpt-5.6-sol", owned_by: "codex-lb" }],
      undefined,
      false,
      "default",
    );
    expect(entries.find(entry => entry.slug === "gpt-5.6-sol")?.display_name)
      .toBe("GPT-5.6-Sol");
    expect(entries.find(entry => entry.slug === "codex-lb/gpt-5.6-sol")?.display_name)
      .toBe("codex-lb/gpt-5.6-sol");
  });

  test("management rows retain hidden source inventory and provider-specific capabilities", async () => {
    const value = config();
    value.modelSourceVisibility = { "codex-lb": false };
    const rows = await listManagementModelRows(value);
    const native = rows.find(row => row.native && row.id === "gpt-5.6-sol");
    const routed = rows.find(row => row.provider === "codex-lb" && row.id === "gpt-5.6-sol");
    expect(native).toMatchObject({
      sourceVisible: true,
      pickerDisplayName: "GPT-5.6 Sol",
      serviceTiers: [{ id: "priority", name: "Fast" }],
    });
    expect(rows.find(row => row.native && row.id === "gpt-5.4-mini")?.serviceTiers).toEqual([]);
    expect(rows.find(row => row.native && row.id === "gpt-5.3-codex-spark")?.serviceTiers).toBeUndefined();
    expect(routed).toMatchObject({
      namespaced: "codex-lb/gpt-5.6-sol",
      sourceVisible: false,
      pickerDisplayName: "GPT-5.6 Sol",
      reasoningEfforts: ["low", "high", "max"],
    });
  });

  test("API updates persist, notify Android, and preserve provider configuration", async () => {
    const value = config();
    saveConfig(value);
    let notifications = 0;
    const androidRemoteController = {
      notifyModelCatalogChanged() { notifications += 1; },
    } as unknown as AndroidRemoteGatewayController;
    const request = new Request("http://127.0.0.1/api/model-source-visibility", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "codex-lb", visible: false }),
    });
    const response = await handleManagementAPI(request, new URL(request.url), value, {
      androidRemoteController,
      createManagementConvergeCodex: catalogConvergenceFactory(),
    });
    expect(response?.status).toBe(200);
    expect(value.modelSourceVisibility).toEqual({ "codex-lb": false });
    expect(value.providers["codex-lb"]?.models).toEqual(["gpt-5.6-sol"]);
    expect(loadConfig().modelSourceVisibility).toEqual({ "codex-lb": false });
    expect(loadConfig().providers["codex-lb"]?.models).toEqual(["gpt-5.6-sol"]);
    expect(notifications).toBe(1);

    const listRequest = new Request("http://127.0.0.1/api/model-sources");
    const listResponse = await handleManagementAPI(
      listRequest,
      new URL(listRequest.url),
      value,
      { androidRemoteController },
    );
    expect(listResponse?.status).toBe(200);
    expect(await listResponse?.json()).toEqual([
      {
        provider: "openai",
        displayName: "ChatGPT",
        kind: "chatgpt",
        visible: true,
        available: true,
        configured: true,
        modelCount: expect.any(Number),
      },
      {
        provider: "codex-lb",
        displayName: "Codex-LB",
        kind: "provider",
        visible: false,
        available: true,
        configured: true,
        modelCount: 1,
      },
    ]);

    const enableRequest = new Request("http://127.0.0.1/api/model-source-visibility", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "codex-lb", visible: true }),
    });
    const enableResponse = await handleManagementAPI(
      enableRequest,
      new URL(enableRequest.url),
      value,
      {
        androidRemoteController,
        createManagementConvergeCodex: catalogConvergenceFactory(),
      },
    );
    expect(enableResponse?.status).toBe(200);
    expect(value.modelSourceVisibility).toBeUndefined();
    expect(loadConfig().modelSourceVisibility).toBeUndefined();
    expect(loadConfig().providers["codex-lb"]?.models).toEqual(["gpt-5.6-sol"]);
    expect(notifications).toBe(2);
  });
});
