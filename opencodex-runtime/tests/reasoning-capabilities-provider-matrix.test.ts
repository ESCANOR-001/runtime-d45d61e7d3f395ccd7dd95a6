import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { clearModelCache, setCached } from "../src/codex/model-cache";
import {
  bundledReasoningCapability,
  resolveRoutedModelReasoningCapability,
  type DiscoveredReasoningCapability,
} from "../src/providers/reasoning-capabilities";
import { getProviderRegistryEntry, PROVIDER_REGISTRY } from "../src/providers/registry";
import {
  configuredReasoningEfforts,
  mapReasoningEffort,
} from "../src/reasoning-effort";
import { routeModel } from "../src/router";
import { applyReasoningCapability } from "../src/server/effort-policy";
import type {
  OcxConfig,
  OcxParsedRequest,
  OcxProviderConfig,
  ReasoningControlKind,
} from "../src/types";

const CONTROL_KINDS = new Set<ReasoningControlKind>([
  "effort",
  "toggle",
  "automatic",
  "unsupported",
  "unknown",
]);

function resolveRegistryModel(
  providerId: string,
  modelId: string,
  discovered: DiscoveredReasoningCapability = {},
) {
  const registry = getProviderRegistryEntry(providerId);
  if (!registry) throw new Error(`missing test registry provider: ${providerId}`);
  const configured: OcxProviderConfig = {
    adapter: registry.adapter,
    baseUrl: registry.baseUrl,
  };
  return resolveRoutedModelReasoningCapability(
    modelId,
    configured,
    registry,
    discovered,
    bundledReasoningCapability(providerId, modelId, registry),
  );
}

function parsedRequest(reasoning?: string): OcxParsedRequest {
  const raw: Record<string, unknown> = { model: "model", input: [] };
  if (reasoning !== undefined) raw.reasoning = { effort: reasoning };
  return {
    modelId: "model",
    context: { messages: [{ role: "user", content: "test", timestamp: 0 }] },
    stream: false,
    options: reasoning === undefined ? {} : { reasoning },
    _rawBody: raw,
  };
}

function rawEffort(parsed: OcxParsedRequest): unknown {
  return (parsed._rawBody as { reasoning?: { effort?: unknown } }).reasoning?.effort;
}

describe("provider-agnostic reasoning capability matrix", () => {
  test("covers representative native, gateway, subscription, and compatible providers", () => {
    expect(resolveRegistryModel("anthropic", "claude-sonnet-5")).toMatchObject({
      control: { kind: "effort", efforts: ["minimal", "low", "medium", "high"] },
      source: "bundled",
    });
    expect(resolveRegistryModel("google", "gemini-3.6-flash")).toMatchObject({
      control: { kind: "effort", efforts: ["minimal", "low", "medium", "high"] },
      source: "registry-model",
    });
    expect(resolveRegistryModel("groq", "openai/gpt-oss-120b")).toMatchObject({
      control: { kind: "effort", efforts: ["minimal", "low", "medium", "high", "xhigh"] },
      source: "bundled",
    });
    expect(resolveRegistryModel("cursor", "gpt-5.6-sol")).toMatchObject({
      control: { kind: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
      source: "registry-model",
    });
    expect(resolveRegistryModel("kiro", "claude-sonnet-4.6")).toMatchObject({
      control: { kind: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
      source: "registry-model",
    });
    expect(resolveRegistryModel("xai", "grok-4.20-0309-non-reasoning")).toMatchObject({
      control: { kind: "unsupported" },
      source: "registry-model",
    });
    expect(resolveRegistryModel("opencode-go", "mimo-v2.5")).toMatchObject({
      control: { kind: "toggle" },
      source: "registry-model",
    });
  });

  test("treats sparse, binary, automatic, negative, and mismatched evidence distinctly", () => {
    // Sparse live data falls through to the trusted Anthropic bundle.
    expect(resolveRegistryModel("anthropic", "claude-sonnet-5", {
      control: { kind: "unknown" },
    })).toMatchObject({
      control: { kind: "effort", efforts: ["minimal", "low", "medium", "high"] },
      source: "bundled",
    });
    expect(resolveRegistryModel("openrouter", "future-toggle", {
      control: { kind: "toggle", defaultEnabled: false },
    })).toEqual({
      control: { kind: "toggle", defaultEnabled: false },
      required: false,
      source: "live",
    });
    expect(resolveRegistryModel("openrouter", "future-auto", {
      control: { kind: "automatic", required: true },
    })).toEqual({
      control: { kind: "automatic", required: true },
      required: true,
      source: "live",
    });
    expect(resolveRegistryModel("openrouter", "future-off", {
      control: { kind: "unsupported" },
    })).toEqual({
      control: { kind: "unsupported" },
      efforts: [],
      required: false,
      source: "live",
    });

    const custom: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://unrelated.example/v1",
    };
    expect(bundledReasoningCapability("openrouter", "anthropic/claude-sonnet-5", undefined))
      .toBeUndefined();
    expect(resolveRoutedModelReasoningCapability(
      "anthropic/claude-sonnet-5",
      custom,
      undefined,
    )).toEqual({
      control: { kind: "unknown" },
      required: false,
      source: "unknown",
    });
  });

  test("every registry provider and declared model resolves to one internally consistent state", () => {
    let providersChecked = 0;
    let modelsChecked = 0;
    for (const registry of PROVIDER_REGISTRY) {
      providersChecked += 1;
      const ids = new Set<string>([
        ...(registry.models ?? []),
        ...(registry.defaultModel ? [registry.defaultModel] : []),
        ...Object.keys(registry.modelReasoningEfforts ?? {}),
        ...Object.keys(registry.modelDefaultReasoningEfforts ?? {}),
        ...Object.keys(registry.modelReasoningRequired ?? {}),
        ...Object.keys(registry.modelReasoningEffortMap ?? {}),
        ...(registry.noReasoningModels ?? []),
        ...(registry.thinkingToggleModels ?? []),
        ...(registry.thinkingBudgetModels ?? []),
      ]);
      if (ids.size === 0) ids.add("__unknown-model-probe__");
      const configured: OcxProviderConfig = {
        adapter: registry.adapter,
        baseUrl: registry.baseUrl,
      };
      for (const modelId of ids) {
        modelsChecked += 1;
        const resolved = resolveRoutedModelReasoningCapability(
          modelId,
          configured,
          registry,
          {},
          bundledReasoningCapability(registry.id, modelId, registry),
        );
        expect(CONTROL_KINDS.has(resolved.control.kind)).toBe(true);
        if (resolved.control.kind === "effort") {
          expect(resolved.control.efforts.length).toBeGreaterThan(0);
          expect(new Set(resolved.control.efforts).size).toBe(resolved.control.efforts.length);
          expect(resolved.efforts).toEqual(resolved.control.efforts);
          if (resolved.defaultEffort) expect(resolved.efforts).toContain(resolved.defaultEffort);
        } else if (resolved.control.kind === "unsupported") {
          expect(resolved.efforts).toEqual([]);
          expect(resolved.defaultEffort).toBeUndefined();
        } else {
          expect(resolved.efforts).toBeUndefined();
          expect(resolved.defaultEffort).toBeUndefined();
        }
      }
    }
    expect(providersChecked).toBe(PROVIDER_REGISTRY.length);
    expect(modelsChecked).toBeGreaterThan(providersChecked);
  });

  test("normalizes every canonical state before an adapter can serialize it", () => {
    const unknown = parsedRequest("max");
    expect(applyReasoningCapability(unknown, {
      provider: { baseUrl: "https://example.test", modelReasoningControls: { model: "unknown" } },
      modelId: "model",
    })).toEqual({ from: "max", to: "none" });
    expect(unknown.options.reasoning).toBeUndefined();
    expect(rawEffort(unknown)).toBeUndefined();

    const automatic = parsedRequest("high");
    expect(applyReasoningCapability(automatic, {
      provider: { baseUrl: "https://example.test", modelReasoningControls: { model: "automatic" } },
      modelId: "model",
    })).toEqual({ from: "high", to: "auto" });
    expect(automatic.options.reasoning).toBeUndefined();
    expect(rawEffort(automatic)).toBeUndefined();

    const unsupported = parsedRequest("high");
    expect(applyReasoningCapability(unsupported, {
      provider: { baseUrl: "https://example.test", modelReasoningControls: { model: "unsupported" } },
      modelId: "model",
    })).toEqual({ from: "high", to: "none" });
    expect(unsupported.options.reasoning).toBeUndefined();
    expect(rawEffort(unsupported)).toBeUndefined();

    const toggle = parsedRequest("high");
    expect(applyReasoningCapability(toggle, {
      provider: { baseUrl: "https://example.test", modelReasoningControls: { model: "toggle" } },
      modelId: "model",
    })).toBeNull();
    expect(toggle.options.reasoning).toBe("high");
    expect(rawEffort(toggle)).toBe("high");

    const effort = parsedRequest("max");
    expect(applyReasoningCapability(effort, {
      provider: {
        baseUrl: "https://example.test",
        modelReasoningControls: { model: "effort" },
        modelReasoningEfforts: { model: ["low", "high"] },
      },
      modelId: "model",
    })).toEqual({ from: "max", to: "high" });
    expect(effort.options.reasoning).toBe("high");
    expect(rawEffort(effort)).toBe("high");
  });

  test("recognizes a renamed fixed endpoint but isolates a transport mismatch", () => {
    const renamedConfig: OcxConfig = {
      port: 10100,
      defaultProvider: "my-anthropic",
      providers: {
        "my-anthropic": {
          adapter: "anthropic",
          baseUrl: "https://api.anthropic.com",
          authMode: "key",
          apiKey: "test-key-not-a-real-credential",
          models: ["claude-sonnet-5"],
        },
      },
    };
    const renamed = routeModel(renamedConfig, "my-anthropic/claude-sonnet-5");
    expect(renamed.provider.modelReasoningControls?.[renamed.modelId]).toBe("effort");
    expect(configuredReasoningEfforts(renamed.provider, renamed.modelId))
      .toEqual(["minimal", "low", "medium", "high"]);

    const mismatchedConfig: OcxConfig = {
      port: 10100,
      defaultProvider: "mimo",
      providers: {
        mimo: {
          adapter: "openai-chat",
          baseUrl: "https://unrelated.example/v1",
          authMode: "key",
          apiKey: "test-key-not-a-real-credential",
          models: ["mimo-v2.5-pro"],
        },
      },
    };
    const mismatched = routeModel(mismatchedConfig, "mimo/mimo-v2.5-pro");
    expect(mismatched.provider.modelReasoningControls?.[mismatched.modelId]).toBe("unknown");
    expect(configuredReasoningEfforts(mismatched.provider, mismatched.modelId)).toBeUndefined();
    expect(mapReasoningEffort(mismatched.provider, mismatched.modelId, "high")).toBeUndefined();
  });

  test("a renamed OpenRouter endpoint keeps live binary semantics and the gateway wire", () => {
    clearModelCache("my-router");
    setCached("my-router", [{
      provider: "my-router",
      id: "future-toggle",
      reasoningControl: { kind: "toggle", defaultEnabled: true },
    }]);
    try {
      const config: OcxConfig = {
        port: 10100,
        defaultProvider: "my-router",
        providers: {
          "my-router": {
            adapter: "openai-chat",
            baseUrl: "https://openrouter.ai/api/v1",
            authMode: "key",
            apiKey: "test-key-not-a-real-credential",
          },
        },
      };
      const route = routeModel(config, "my-router/future-toggle");
      expect(route.provider.modelReasoningControls?.[route.modelId]).toBe("toggle");
      expect(route.provider.reasoningWireFormat).toBe("gateway-object");

      const parsed: OcxParsedRequest = {
        modelId: route.modelId,
        context: { messages: [{ role: "user", content: "test", timestamp: 0 }] },
        stream: false,
        options: { reasoning: "none" },
      };
      const request = createOpenAIChatAdapter(route.provider).buildRequest(parsed);
      expect(JSON.parse(request.body as string)).toMatchObject({ reasoning: { enabled: false } });
    } finally {
      clearModelCache("my-router");
    }
  });
});
