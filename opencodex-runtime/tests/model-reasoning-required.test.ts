import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { buildCatalogEntries, clearGatherRoutedModelsInflight, gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache, setCached } from "../src/codex/model-cache";
import { getDefaultConfig, validateConfigCandidate } from "../src/config";
import { enrichProviderFromCatalog } from "../src/oauth/key-providers";
import { enrichProviderFromRegistry } from "../src/providers/derive";
import {
  configuredDefaultReasoningEffort,
  configuredReasoningEfforts,
  isReasoningEffortRequired,
  mapReasoningEffort,
} from "../src/reasoning-effort";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

const OPENCODE_BASE_URL = "https://opencode.ai/zen/go/v1";

function minimalOpenCodeConfig(provider: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat",
        baseUrl: OPENCODE_BASE_URL,
        authMode: "key",
        apiKey: "test-key-not-a-real-credential",
        liveModels: false,
        models: ["glm-5.3"],
        ...provider,
      },
    },
  };
}

function requestBody(provider: OcxProviderConfig, reasoning?: string): Record<string, unknown> {
  const parsed: OcxParsedRequest = {
    modelId: "glm-5.3",
    context: { messages: [{ role: "user", content: "test", timestamp: 0 }] },
    stream: false,
    options: reasoning === undefined ? {} : { reasoning },
  };
  const request = createOpenAIChatAdapter(provider).buildRequest(parsed);
  return JSON.parse(request.body as string) as Record<string, unknown>;
}

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "Native GPT model",
    visibility: "list",
    priority: 1,
    base_instructions: "You are Codex.",
    supported_reasoning_levels: [
      { effort: "low", description: "low" },
      { effort: "medium", description: "medium" },
      { effort: "high", description: "high" },
      { effort: "xhigh", description: "xhigh" },
    ],
  };
}

afterEach(() => {
  clearModelCache("opencode-go");
  clearModelCache("future-provider");
  clearGatherRoutedModelsInflight();
});

describe("mandatory model reasoning contract", () => {
  test("registry hydration gives GLM 5.3 one shared ladder, default, and required flag", () => {
    const route = routeModel(minimalOpenCodeConfig(), "opencode-go/glm-5.3");

    expect(route.providerName).toBe("opencode-go");
    expect(route.modelId).toBe("glm-5.3");
    expect(configuredReasoningEfforts(route.provider, route.modelId)).toEqual(["low", "high", "max"]);
    expect(configuredDefaultReasoningEffort(route.provider, route.modelId)).toBe("low");
    expect(isReasoningEffortRequired(route.provider, route.modelId)).toBe(true);
  });

  test("omitted, disabled, invalid, and stale efforts are normalized before the provider request", () => {
    const route = routeModel(minimalOpenCodeConfig(), "opencode-go/glm-5.3");
    const expected: Array<[string | undefined, string]> = [
      [undefined, "low"],
      ["none", "low"],
      ["disabled", "low"],
      ["minimal", "low"],
      ["medium", "low"],
      ["xhigh", "high"],
      ["ultra", "max"],
    ];

    for (const [requested, effective] of expected) {
      expect(mapReasoningEffort(route.provider, route.modelId, requested)).toBe(effective);
      expect(requestBody(route.provider, requested).reasoning_effort).toBe(effective);
    }
  });

  test("explicit false override and ordinary providers preserve optional-reasoning behavior", () => {
    const overridden = routeModel(minimalOpenCodeConfig({
      modelReasoningRequired: { "glm-5.3": false },
    }), "opencode-go/glm-5.3");
    expect(isReasoningEffortRequired(overridden.provider, overridden.modelId)).toBe(false);
    expect(mapReasoningEffort(overridden.provider, overridden.modelId, undefined)).toBeUndefined();
    expect(requestBody(overridden.provider)).not.toHaveProperty("reasoning_effort");

    const nativeLike: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      modelReasoningEfforts: { "glm-5.3": ["low", "high", "max"] },
    };
    expect(mapReasoningEffort(nativeLike, "glm-5.3", undefined)).toBeUndefined();
  });

  test("registry catalog updates fill missing model keys without overwriting user keys", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: OPENCODE_BASE_URL,
      modelReasoningEfforts: { "custom-model": ["high"] },
      modelDefaultReasoningEfforts: { "custom-model": "high" },
      modelReasoningRequired: { "custom-model": false },
      modelReasoningEffortMap: { "custom-model": { high: "provider-high" } },
    };

    enrichProviderFromRegistry("opencode-go", provider);

    expect(provider.modelReasoningEfforts?.["custom-model"]).toEqual(["high"]);
    expect(provider.modelReasoningEfforts?.["glm-5.3"]).toEqual(["low", "high", "max"]);
    expect(provider.modelDefaultReasoningEfforts).toMatchObject({
      "custom-model": "high",
      "glm-5.3": "low",
    });
    expect(provider.modelReasoningRequired).toMatchObject({
      "custom-model": false,
      "glm-5.3": true,
    });
    expect(provider.modelReasoningEffortMap?.["custom-model"]?.high).toBe("provider-high");
  });

  test("provider creation does not freeze registry-only reasoning requirements", () => {
    const created: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: OPENCODE_BASE_URL,
    };
    enrichProviderFromCatalog("opencode-go", created);
    expect(created.modelReasoningRequired).toBeUndefined();

    const submitted: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: OPENCODE_BASE_URL,
      modelReasoningRequired: { "glm-5.3": false },
    };
    enrichProviderFromCatalog("opencode-go", submitted);
    expect(submitted.modelReasoningRequired).toEqual({ "glm-5.3": false });
  });

  test("management and Codex catalogs expose the same GLM capability source", async () => {
    const models = await gatherRoutedModels(minimalOpenCodeConfig());
    const management = models.find(model => `${model.provider}/${model.id}` === "opencode-go/glm-5.3");
    expect(management).toMatchObject({
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "low",
    });

    const desktop = buildCatalogEntries(nativeTemplate(), [], models)
      .find(entry => entry.slug === "opencode-go/glm-5.3");
    expect((desktop?.supported_reasoning_levels as Array<{ effort: string }>).map(row => row.effort))
      .toEqual(["low", "high", "max"]);
    expect(desktop?.default_reasoning_level).toBe("low");
  });

  test("config validation accepts only a plain boolean requirement map", () => {
    const defaults = getDefaultConfig();
    const provider = {
      adapter: "openai-chat",
      baseUrl: OPENCODE_BASE_URL,
      modelReasoningRequired: { "glm-5.3": true },
    };
    expect(validateConfigCandidate({
      ...defaults,
      providers: { ...defaults.providers, "opencode-go": provider },
    }).ok).toBe(true);
    expect(validateConfigCandidate({
      ...defaults,
      providers: {
        ...defaults.providers,
        "opencode-go": { ...provider, modelReasoningRequired: { "glm-5.3": "yes" } },
      },
    }).ok).toBe(false);
    expect(validateConfigCandidate({
      ...defaults,
      providers: {
        ...defaults.providers,
        "opencode-go": { ...provider, modelReasoningControls: { "glm-5.3": "unknown" } },
      },
    }).ok).toBe(false);
  });
});

describe("provider-agnostic reasoning capability precedence", () => {
  function futureConfig(provider: Partial<OcxProviderConfig> = {}): OcxConfig {
    return {
      port: 10100,
      defaultProvider: "future-provider",
      providers: {
        "future-provider": {
          adapter: "openai-chat",
          baseUrl: "https://future-provider.example/v1",
          authMode: "key",
          apiKey: "test-key-not-a-real-credential",
          ...provider,
        },
      },
    };
  }

  test("unknown models expose and send no fabricated reasoning effort", () => {
    const route = routeModel(futureConfig(), "future-provider/new-model");
    expect(route.provider.modelReasoningControls?.[route.modelId]).toBe("unknown");
    expect(configuredReasoningEfforts(route.provider, route.modelId)).toBeUndefined();
    expect(mapReasoningEffort(route.provider, route.modelId, "max")).toBeUndefined();
  });

  test("live per-model metadata outranks a provider-wide configured fallback", () => {
    setCached("future-provider", [{
      provider: "future-provider",
      id: "live-model",
      reasoningEfforts: ["minimal", "low", "high"],
      defaultReasoningEffort: "high",
      reasoningRequired: true,
    }]);
    const route = routeModel(futureConfig({ reasoningEfforts: ["low", "medium"] }), "future-provider/live-model");
    expect(configuredReasoningEfforts(route.provider, route.modelId)).toEqual(["minimal", "low", "high"]);
    expect(configuredDefaultReasoningEffort(route.provider, route.modelId)).toBe("high");
    expect(isReasoningEffortRequired(route.provider, route.modelId)).toBe(true);
    expect(mapReasoningEffort(route.provider, route.modelId, undefined)).toBe("high");
  });

  test("an explicit per-model override remains authoritative over live metadata", () => {
    setCached("future-provider", [{
      provider: "future-provider",
      id: "live-model",
      reasoningEfforts: ["minimal", "low", "high"],
      defaultReasoningEffort: "high",
      reasoningRequired: true,
    }]);
    const route = routeModel(futureConfig({
      modelReasoningEfforts: { "live-model": ["low"] },
      modelDefaultReasoningEfforts: { "live-model": "low" },
      modelReasoningRequired: { "live-model": false },
    }), "future-provider/live-model");
    expect(configuredReasoningEfforts(route.provider, route.modelId)).toEqual(["low"]);
    expect(configuredDefaultReasoningEffort(route.provider, route.modelId)).toBe("low");
    expect(isReasoningEffortRequired(route.provider, route.modelId)).toBe(false);
  });

  test("explicit wire maps are capability evidence without inventing unmapped selector levels", () => {
    const providerWide = routeModel(futureConfig({
      reasoningEffortMap: { xhigh: "provider-high" },
    }), "future-provider/mapped-model");
    expect(providerWide.provider.modelReasoningControls?.[providerWide.modelId]).toBe("effort");
    expect(configuredReasoningEfforts(providerWide.provider, providerWide.modelId)).toEqual(["xhigh"]);
    expect(mapReasoningEffort(providerWide.provider, providerWide.modelId, "xhigh")).toBe("provider-high");

    setCached("future-provider", [{
      provider: "future-provider",
      id: "mapped-model",
      reasoningEfforts: ["minimal", "low", "high"],
    }]);
    const modelSpecific = routeModel(futureConfig({
      modelReasoningEffortMap: { "mapped-model": { high: "provider-high" } },
    }), "future-provider/mapped-model");
    expect(configuredReasoningEfforts(modelSpecific.provider, modelSpecific.modelId))
      .toEqual(["minimal", "low", "high"]);
    expect(mapReasoningEffort(modelSpecific.provider, modelSpecific.modelId, "high")).toBe("provider-high");
  });

  test("registry model metadata outranks a provider-wide fallback", () => {
    const route = routeModel(minimalOpenCodeConfig({
      reasoningEfforts: ["medium"],
      models: ["glm-5.2"],
    }), "opencode-go/glm-5.2");
    expect(configuredReasoningEfforts(route.provider, route.modelId))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
