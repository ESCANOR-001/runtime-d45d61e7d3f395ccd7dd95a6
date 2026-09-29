import { expect, test } from "bun:test";
import { refreshCurrentNativeCatalog } from "../src/codex/catalog/current-native";
import type { RawCatalog, RawEntry } from "../src/codex/catalog/parsing";
import type { OcxConfig } from "../src/types";
import { CODEX_FORWARD_BASE_URL } from "../src/providers/openai-tiers";

const config = { providers: { openai: { adapter: "openai-responses", baseUrl: CODEX_FORWARD_BASE_URL, authMode: "forward" } }, defaultProvider: "openai" } as OcxConfig;
function entry(slug: string): RawEntry {
  return { slug, display_name: slug.toUpperCase(), visibility: "list", base_instructions: `Exact instructions for ${slug}`,
    supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }], default_reasoning_level: "low",
    service_tiers: [{ id: "priority", name: "Fast" }], default_service_tier: null, priority: 0, context_window: 999999 };
}
function cache(models = [entry("gpt-6-astra")]): RawCatalog {
  return { models, etag: "downloaded-models", fetched_at: "2026-09-09T00:00:00Z", client_version: "0.153.4" };
}

test("downloaded native definitions replace stale models without altering routed providers", () => {
  const routed = { ...entry("vendor/gpt-5.4"), opencodex_catalog_kind: "provider-model-v1" };
  const catalog = { models: [entry("gpt-5.4"), routed] };
  const downloaded = cache();
  const original = JSON.stringify(downloaded);
  refreshCurrentNativeCatalog(catalog, downloaded, null, config, false);
  expect(catalog.models.map(row => row.slug)).toEqual(["gpt-6-astra", "vendor/gpt-5.4"]);
  expect(catalog.models[0]).toMatchObject(entry("gpt-6-astra"));
  expect(catalog.models[1]).toEqual(routed);
  expect(JSON.stringify(downloaded)).toBe(original);
});

test("a restart with a generated or missing cache retains exact current native definitions", () => {
  const first: RawCatalog = { models: [] };
  refreshCurrentNativeCatalog(first, cache(), null, config, false);
  const next: RawCatalog = { models: [entry("gpt-5.4")] };
  refreshCurrentNativeCatalog(next, { ...cache([entry("gpt-5.4")]), client_version: "0.0.0" }, first, config, false);
  expect(next).toEqual(first);
  const third: RawCatalog = { models: [] };
  refreshCurrentNativeCatalog(third, null, next, config, false);
  expect(third).toEqual(first);
});

test("accepts modern Codex model_messages without requiring the old base_instructions field", () => {
  const modern = entry("gpt-6-astra");
  delete modern.base_instructions;
  modern.model_messages = { instructions_template: "Use the current model instructions.", persistent_instructions: "Keep these instructions." };
  const catalog: RawCatalog = { models: [] };
  refreshCurrentNativeCatalog(catalog, cache([modern]), null, config, false);
  expect(catalog.models?.[0]?.model_messages).toEqual(modern.model_messages);
  expect(catalog.models?.[0]?.base_instructions).toBeUndefined();
  expect(catalog.models?.[0]?.supports_parallel_tool_calls).toBe(true);
  expect(catalog.models?.[0]?.slug).toBe("gpt-6-astra");
});

test("new downloaded inventories remove retired entries and preserve explicitly hidden models", () => {
  const first: RawCatalog = { models: [] };
  refreshCurrentNativeCatalog(first, cache([entry("o-future")]), null, config, false);
  const next: RawCatalog = { models: first.models };
  const newest = entry("gpt-future");
  newest.visibility = "hide";
  refreshCurrentNativeCatalog(next, cache([newest]), first, config, false);
  expect(next.models?.map(row => row.slug)).toEqual(["gpt-future"]);
  expect(next.models?.[0]?.visibility).toBe("hide");
});

test("source visibility and disabled choices do not erase the saved native inventory", () => {
  const hidden: RawCatalog = { models: [] };
  refreshCurrentNativeCatalog(hidden, cache(), null, { ...config, modelSourceVisibility: { openai: false } }, false);
  expect(hidden.models).toEqual([]);
  const restored: RawCatalog = { models: [] };
  refreshCurrentNativeCatalog(restored, null, hidden, { ...config, disabledModels: ["gpt-6-astra"] }, false);
  expect(restored.models?.[0]?.slug).toBe("gpt-6-astra");
  expect(restored.models?.[0]?.visibility).toBe("hide");
});

test("malformed or generated native inventories cannot replace existing catalog rows", () => {
  for (const bad of [cache([{ ...entry("gpt-6-astra"), opencodex_catalog_kind: "generated" }]),
    cache([entry("vendor/model")]), { ...cache(), etag: undefined }, cache([])]) {
    const catalog = { models: [entry("gpt-5.5")] };
    const before = JSON.stringify(catalog);
    refreshCurrentNativeCatalog(catalog, bad, null, config, false);
    expect(JSON.stringify(catalog)).toBe(before);
  }
});

test("a new account-qualified model takes precedence over a colliding provider row", () => {
  const catalog: RawCatalog = { models: [entry("desktop/gpt-6-astra")] };
  refreshCurrentNativeCatalog(catalog, cache(), null, {
    ...config, codexAccountNamespaces: { desktop: "@main" }, codexAccountPickerEnabled: true,
  }, false);
  const matches = catalog.models?.filter(row => row.slug === "desktop/gpt-6-astra");
  expect(matches).toHaveLength(1);
  expect(matches?.[0]?.opencodex_catalog_kind).toBe("account-selector-v1");
});
