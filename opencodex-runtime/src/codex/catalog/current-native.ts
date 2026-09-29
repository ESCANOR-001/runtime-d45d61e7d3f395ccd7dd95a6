import type { OcxConfig } from "../../types";
import { websocketsEnabled } from "../../config";
import { accountBoundNativeDisplayName, CODEX_ACCOUNT_BOUND_CATALOG_KIND, trustedAccountBoundNativeCatalogSlug, visibleCodexAccountSelectors } from "./account-models";
import { desktopAllowlistSuppressedNativeSlugs, isNativeAliasCatalogEntry, shouldIncludeAccountBoundNativeOpenAi, shouldIncludeNativeOpenAi } from "./metadata";
import { ensureStrictCatalogFields, type RawCatalog, type RawEntry } from "./parsing";

const SNAPSHOT_KEY = "remodex_native_catalog";

export function retainCurrentNativeCatalogSnapshot(target: RawCatalog, source: RawCatalog): void {
  const saved = record(source[SNAPSHOT_KEY]);
  const models = saved?.version === 1 ? nativeModels(saved.models) : null;
  if (models) target[SNAPSHOT_KEY] = { version: 1, models };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function nativeModels(value: unknown): RawEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) return null;
  const rows: RawEntry[] = [];
  const slugs = new Set<string>();
  for (const valueRow of value) {
    const row = record(valueRow);
    if (!row || typeof row.slug !== "string" || !/^[a-z0-9][a-z0-9._-]{0,255}$/iu.test(row.slug)
      || row.opencodex_catalog_kind !== undefined || slugs.has(row.slug)
      || typeof row.display_name !== "string"
      || (typeof row.base_instructions !== "string" && typeof record(row.model_messages)?.instructions_template !== "string")
      || !Array.isArray(row.supported_reasoning_levels)
      || (row.visibility !== "list" && row.visibility !== "hide")) return null;
    slugs.add(row.slug);
    rows.push(structuredClone(row));
  }
  return rows;
}

/** Prefer a genuine downloaded catalog; retain its complete definitions across cache replacement. */
export function refreshCurrentNativeCatalog(
  catalog: RawCatalog,
  cache: RawCatalog | null,
  previous: RawCatalog | null,
  config: Readonly<OcxConfig>,
  multiAgentV2Enabled: boolean,
): void {
  const downloaded = cache && typeof cache.etag === "string" && cache.etag.length > 0
    && typeof cache.client_version === "string" && !["0.0.0", "observed", ""].includes(cache.client_version)
    && typeof cache.fetched_at === "string" && Number.isFinite(Date.parse(cache.fetched_at))
    ? nativeModels(cache.models) : null;
  const saved = record(previous?.[SNAPSHOT_KEY]);
  const savedModels = saved?.version === 1 ? nativeModels(saved.models) : null;
  const models = downloaded ?? savedModels;
  if (!models) return;
  // Keep original definitions separate from visibility/feature choices. Re-enabling a
  // source or restarting after Codex's cache was replaced must not lose those definitions.
  catalog[SNAPSHOT_KEY] = { version: 1, models: structuredClone(models) };
  const sourceSlugs = new Set([...models, ...(savedModels ?? [])].map(model => String(model.slug)));
  const existing = catalog.models ?? [];
  const retained = existing.filter(entry => {
    if (isNativeAliasCatalogEntry(entry)) return true;
    if (trustedAccountBoundNativeCatalogSlug(entry) !== undefined) return false;
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    return slug.includes("/") || (!sourceSlugs.has(slug) && !/^(?:gpt|codex)-/u.test(slug));
  });
  const aliases = new Set(retained.filter(isNativeAliasCatalogEntry).map(entry => entry.slug));
  const suppressed = desktopAllowlistSuppressedNativeSlugs(config);
  const featured = config.subagentModels ?? [];
  const oldRows = new Map(existing.map(entry => [entry.slug, entry]));
  const selectors = shouldIncludeAccountBoundNativeOpenAi(config) ? visibleCodexAccountSelectors(config) : [];
  const native: RawEntry[] = [];
  const prepare = (row: RawEntry, slug: string): RawEntry => {
    // Older sidecars require fields that newer Desktop caches omit. Add only
    // missing compatibility defaults; keep every supplied native value intact.
    const copy = { ...ensureStrictCatalogFields(structuredClone(row)), ...structuredClone(row) };
    copy.slug = slug;
    const rank = featured.indexOf(slug);
    const originalPriority = typeof row.priority === "number" ? row.priority : 9;
    copy.priority = rank >= 0 ? rank : oldRows.get(slug)?.priority
      ?? (featured.length ? Math.max(originalPriority, featured.length + 100) : originalPriority);
    if (websocketsEnabled(config)) copy.supports_websockets = true;
    else { delete copy.supports_websockets; delete copy.prefer_websockets; }
    return copy;
  };
  for (const row of models) {
    const slug = String(row.slug);
    if (shouldIncludeNativeOpenAi(config) && !aliases.has(slug) && !suppressed.has(slug)) {
      native.push(prepare(row, slug));
    }
    for (const selector of selectors) {
      const copy = prepare(row, `${selector}/${slug}`);
      copy.display_name = accountBoundNativeDisplayName(selector, row);
      copy.opencodex_catalog_kind = CODEX_ACCOUNT_BOUND_CATALOG_KIND;
      native.push(copy);
    }
  }
  const disabled = new Set(config.disabledModels ?? []);
  for (const row of native) {
    const slug = String(row.slug);
    const accountModel = trustedAccountBoundNativeCatalogSlug(row);
    if (row.hidden === true || disabled.has(accountModel ?? slug) || disabled.has(slug)
      || (!accountModel && selectors.length > 0)) row.visibility = "hide";
    if (config.multiAgentMode === "v1" || config.multiAgentMode === "v2") row.multi_agent_version = config.multiAgentMode;
    else if (multiAgentV2Enabled) row.multi_agent_version = "v2";
  }
  const accountSlugs = new Set(native.filter(row => trustedAccountBoundNativeCatalogSlug(row) !== undefined).map(row => row.slug));
  catalog.models = [...native, ...retained.filter(row => !accountSlugs.has(row.slug))];
}
