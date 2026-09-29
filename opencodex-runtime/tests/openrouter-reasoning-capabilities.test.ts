import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import {
  buildCatalogEntries,
  clearGatherRoutedModelsInflight,
  gatherRoutedModels,
} from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

function openRouterConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openrouter",
    providers: {
      openrouter: {
        adapter: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        authMode: "key",
        apiKey: "openrouter-test-key",
      },
    },
  };
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

function requestBody(
  provider: OcxProviderConfig,
  modelId: string,
  reasoning?: string,
): Record<string, unknown> {
  const parsed: OcxParsedRequest = {
    modelId,
    context: { messages: [{ role: "user", content: "test", timestamp: 0 }] },
    stream: false,
    options: reasoning === undefined ? {} : { reasoning },
  };
  const request = createOpenAIChatAdapter(provider).buildRequest(parsed);
  return JSON.parse(request.body as string) as Record<string, unknown>;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("openrouter");
  clearGatherRoutedModelsInflight();
});

describe("OpenRouter reasoning capability contract", () => {
  test("keeps discovery semantics registry-owned while routing with the unified reasoning object", () => {
    const entry = getProviderRegistryEntry("openrouter");
    expect(entry).toMatchObject({
      reasoningMetadataFormat: "openrouter",
      reasoningWireFormat: "gateway-object",
    });

    const seed = providerConfigSeed(entry!);
    expect(seed.reasoningWireFormat).toBe("gateway-object");
    expect(seed).not.toHaveProperty("reasoningMetadataFormat");
  });

  test("flows live effort ladders to Desktop and sends only representable OpenRouter requests", async () => {
    globalThis.fetch = (async () => Response.json({
      data: [
        {
          id: "openai/gpt-5.6-sol",
          reasoning: {
            mandatory: false,
            default_enabled: true,
            supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"],
            default_effort: "medium",
          },
        },
        {
          id: "x-ai/grok-4.5",
          reasoning: {
            mandatory: true,
            default_enabled: true,
            supported_efforts: ["high", "medium", "low"],
            default_effort: "high",
          },
        },
        {
          id: "anthropic/claude-sonnet-5",
          reasoning: {
            mandatory: false,
            default_enabled: true,
            supported_efforts: ["max", "xhigh", "high", "medium", "low"],
            default_effort: "high",
          },
        },
      ],
    })) as typeof fetch;

    const config = openRouterConfig();
    const models = await gatherRoutedModels(config);
    const byId = new Map(
      models.filter(model => model.provider === "openrouter").map(model => [model.id, model]),
    );

    expect(byId.get("openai/gpt-5.6-sol")).toMatchObject({
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      reasoningRequired: false,
    });
    expect(byId.get("x-ai/grok-4.5")).toMatchObject({
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "high",
      reasoningRequired: true,
    });
    expect(byId.get("anthropic/claude-sonnet-5")).toMatchObject({
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
      reasoningRequired: false,
    });

    const desktop = buildCatalogEntries(nativeTemplate(), [], models);
    const desktopEfforts = (slug: string) => {
      const levels = desktop.find(entry => entry.slug === slug)?.supported_reasoning_levels;
      return (levels as Array<{ effort: string }> | undefined)?.map(level => level.effort);
    };
    expect(desktopEfforts("openrouter/openai-gpt-5.6-sol"))
      .toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(desktopEfforts("openrouter/x-ai-grok-4.5"))
      .toEqual(["low", "medium", "high"]);
    expect(desktopEfforts("openrouter/anthropic-claude-sonnet-5"))
      .toEqual(["none", "low", "medium", "high", "xhigh", "max"]);

    const grok = routeModel(config, "openrouter/x-ai-grok-4.5");
    expect(grok.provider.reasoningWireFormat).toBe("gateway-object");
    expect(requestBody(grok.provider, grok.modelId)).toMatchObject({
      reasoning: { enabled: true, effort: "high" },
    });
    // A stale persisted Off choice cannot disable a mandatory model; normalize it to the
    // lowest supported tier so the repair does not silently raise cost.
    expect(requestBody(grok.provider, grok.modelId, "none")).toMatchObject({
      reasoning: { enabled: true, effort: "low" },
    });
    expect(requestBody(grok.provider, grok.modelId, "none")).not.toHaveProperty("reasoning_effort");

    const claude = routeModel(config, "openrouter/anthropic-claude-sonnet-5");
    expect(requestBody(claude.provider, claude.modelId, "none")).toMatchObject({
      reasoning: { enabled: false },
    });
    expect(requestBody(claude.provider, claude.modelId, "none")).not.toHaveProperty("reasoning_effort");
  });
});
