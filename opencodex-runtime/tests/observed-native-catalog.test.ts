import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readObservedNativeCatalog } from "../src/codex/catalog/observed-native";
import { listManagementModelRows, replaceObservedNativeModelRows } from "../src/server/management/model-rows";
import { installIsolatedCodexHome } from "./helpers/isolated-codex-home";
import { nativeEffortClamp } from "../src/codex/catalog/effort";
import { nativeOpenAiSlugs, nativeReasoningEfforts } from "../src/codex/catalog/metadata";

const astra = {
  slug: "gpt-6-astra", display_name: "GPT-6 Astra", visibility: "list",
  supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map(effort => ({ effort })),
  default_reasoning_level: "medium",
  service_tiers: [{ id: "priority", name: "Fast" }],
};
function writeCache(root: string, models: unknown[]) {
  writeFileSync(join(root, "models_cache.json"), JSON.stringify({
    etag: "official-model-catalog", fetched_at: "2026-09-08T12:00:00Z", client_version: "0.153.4", models,
  }));
}

test("current native models replace retired fallback rows and preserve their exact settings", async () => {
  const isolated = installIsolatedCodexHome("native-model-inventory-");
  try {
    writeCache(isolated.path, [astra, { ...astra, slug: "gpt-next-test", display_name: "Future test model" },
      { ...astra, slug: "gpt-hidden-test", visibility: "hide" }]);
    const rows = await listManagementModelRows({ port: 0, defaultProvider: "none", providers: {} });
    expect(rows.map(row => row.id)).toEqual(["gpt-6-astra", "gpt-next-test", "gpt-hidden-test"]);
    expect(rows[0]).toMatchObject({ native: true, nativeCatalogCurrent: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "medium", serviceTiers: [{ id: "priority", name: "Fast" }],
    });
    expect(rows[2]?.sourceVisible).toBe(false);
    expect(rows.some(row => row.id === "gpt-5.4" || row.id === "gpt-5.4-mini")).toBe(false);
    expect(nativeOpenAiSlugs()).toEqual(["gpt-6-astra", "gpt-next-test"]);
    expect(nativeReasoningEfforts("gpt-6-astra")).toContain("ultra");
    expect(nativeEffortClamp("gpt-6-astra", "ultra")).toBeNull();
    expect(nativeEffortClamp("gpt-next-test", "max")).toBeNull();
  } finally { isolated.restore(); }
});

test("new cache contents refresh the roster and preserve explicit empty settings", () => {
  const root = mkdtempSync(join(tmpdir(), "native-model-refresh-"));
  try {
    writeCache(root, [astra]);
    const first = readObservedNativeCatalog(root)!;
    writeCache(root, [{ ...astra, slug: "gpt-next-test", supported_reasoning_levels: [], service_tiers: [] }]);
    const next = readObservedNativeCatalog(root)!;
    expect(next.version).not.toBe(first.version);
    expect(next.models).toHaveLength(1);
    expect(next.models[0]).toMatchObject({ id: "gpt-next-test", reasoningEfforts: [], serviceTiers: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("keeps compact native evidence across generated-cache replacement and a fresh reader", () => {
  const root = mkdtempSync(join(tmpdir(), "native-model-save-"));
  const restarted = mkdtempSync(join(tmpdir(), "native-model-restart-"));
  try {
    writeCache(root, [{ ...astra, base_instructions: "This must not be persisted", model_messages: { developer: "private" } }]);
    const first = readObservedNativeCatalog(root)!;
    const saved = join(root, "remodex-native-models.json");
    expect(readFileSync(saved, "utf8")).not.toContain("base_instructions");
    expect(readFileSync(saved, "utf8")).not.toContain("private");
    writeFileSync(join(root, "models_cache.json"), JSON.stringify({
      fetched_at: "2000-01-01T00:00:00Z", client_version: "0.0.0", models: [{ ...astra, slug: "gpt-5.4" }],
    }));
    expect(readObservedNativeCatalog(root)?.version).toBe(first.version);
    copyFileSync(saved, join(restarted, "remodex-native-models.json"));
    expect(readObservedNativeCatalog(restarted)?.models[0]?.id).toBe("gpt-6-astra");
    writeFileSync(join(root, "models_cache.json"), "{unfinished");
    expect(readObservedNativeCatalog(root)?.version).toBe(first.version);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(restarted, { recursive: true, force: true });
  }
});

test("ignores routed or generated entries and retains configured visibility and aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "native-model-sources-"));
  try {
    writeCache(root, [astra, { ...astra, slug: "codex-lb/gpt-next-test" },
      { ...astra, slug: "gpt-alias-test", opencodex_catalog_kind: "native-alias-v1" }]);
    const observed = readObservedNativeCatalog(root)!;
    expect(observed.models.map(model => model.id)).toEqual(["gpt-6-astra"]);
    const rows = replaceObservedNativeModelRows([{
      provider: "codex-lb", id: "gpt-5.4", namespaced: "codex-lb/gpt-5.4", disabled: false,
      sourceVisible: true, pickerDisplayName: "Provider's separate model",
    }], observed, { disabledModels: ["gpt-6-astra"], modelSourceVisibility: { openai: false } });
    expect(rows[0]).toMatchObject({ disabled: true, sourceVisible: false });
    expect(rows[1]?.namespaced).toBe("codex-lb/gpt-5.4");
    const aliased = replaceObservedNativeModelRows([{
      provider: "combo", id: "shared", namespaced: "gpt-6-astra", disabled: false,
      sourceVisible: true, pickerDisplayName: "Chosen connection",
    }], observed);
    expect(aliased).toHaveLength(1);
    expect(aliased[0]?.provider).toBe("combo");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an absent or unverified cache does not replace the fallback catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "native-model-missing-"));
  try {
    expect(readObservedNativeCatalog(root)).toBeNull();
    writeFileSync(join(root, "models_cache.json"), JSON.stringify({ models: [astra] }));
    expect(readObservedNativeCatalog(root)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
