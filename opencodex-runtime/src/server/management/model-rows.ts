/**
 * The `/api/models` row list and its projection into export models.
 *
 * Extracted from model-routes.ts so `/api/client-config` and the integration
 * routes read the SAME visible-model list. Two callers computing "which models
 * does this user actually have" independently is how the export and the toggle
 * would quietly disagree about what a client was told.
 *
 * Bodies are unchanged from their previous home; only `export` was added.
 */
import type { CatalogModel } from "../../codex/catalog";
import { nativeDefaultReasoningEffort, nativeServiceTierMetadata } from "../../codex/catalog/metadata";
import { readObservedNativeCatalog, type ObservedNativeCatalog } from "../../codex/catalog/observed-native";
import { configuredNativeAliasSlugs } from "../../codex/catalog/metadata";
import { catalogModelSlug, nativeModelRows, nativeReasoningEfforts, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
import type { ExportModel } from "../../clients/config-export";
import { providerContextCap } from "../../providers/context-cap";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import type { OcxConfig } from "../../types";
import { modelSourceVisible, sourceAwareModelDisplayName } from "../../model-sources";
import { fetchAllModels } from "./shared";

/**
 * One row of the `/api/models` list. Routed rows spread a `CatalogModel`, so the shape is
 * that model plus the identity/visibility fields this boundary computes for every row
 * regardless of source. `disabled` is always present; the rest vary by row origin.
 */
export type ManagementModelRow = Partial<CatalogModel> & {
  provider: string;
  id: string;
  namespaced: string;
  disabled: boolean;
  sourceVisible: boolean;
  pickerDisplayName: string;
  native?: boolean;
  nativeCatalogCurrent?: boolean;
  custom?: boolean;
  customId?: string;
};

/**
 * The exact row list `/api/models` returns. Extracted so `/api/client-config` exports the
 * models the GUI's Models tab shows — including this function's `disabled` computation,
 * which the export core (src/clients/config-export.ts) deliberately does not perform.
 */
export async function listManagementModelRows(config: OcxConfig): Promise<ManagementModelRow[]> {
  const observedNative = readObservedNativeCatalog();
  const models = await fetchAllModels(config);
  const disabled = new Set(config.disabledModels ?? []);
  // Native GPT passthrough rows lead (provider "openai", bare-slug namespaced ids): sourced
  // from the static supported set so a disabled model stays listed and re-enableable.
  const native: ManagementModelRow[] = nativeModelRows(config).map(row => ({
    provider: "openai",
    id: row.slug,
    namespaced: row.slug,
    disabled: row.disabled,
    sourceVisible: modelSourceVisible(config, "openai"),
    pickerDisplayName: sourceAwareModelDisplayName({
      provider: "openai",
      modelId: row.slug,
      native: true,
    }),
    native: true,
    // This is the shared model catalogue, not the vision-sidecar request boundary. Preserve the
    // complete Codex ladder here; the image describer validates its narrower effort vocabulary
    // independently when it builds its own request.
    reasoningEfforts: nativeReasoningEfforts(row.slug),
    defaultReasoningEffort: nativeDefaultReasoningEffort(row.slug),
    ...nativeServiceTierMetadata(row.slug),
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
  }));
  const customModels: ManagementModelRow[] = (config.customModels ?? []).map(cm => {
    const namespaced = routedSlug(cm.provider, cm.modelId);
    return {
      provider: cm.provider,
      id: cm.modelId,
      namespaced,
      disabled: [...disabled].some(stored => slugEquals(stored, cm.provider, cm.modelId)),
      sourceVisible: modelSourceVisible(config, cm.provider),
      pickerDisplayName: sourceAwareModelDisplayName({
        provider: cm.provider,
        modelId: cm.modelId,
        displayName: cm.displayName,
      }),
      custom: true,
      customId: cm.id,
      displayName: cm.displayName,
      ...(cm.contextWindow ? { contextWindow: cm.contextWindow } : {}),
      ...(cm.inputModalities ? { inputModalities: cm.inputModalities } : {}),
    };
  });
  const publicModels = uniqueCatalogModelsForPublicList(models);
  const comboNamespaced = new Set(
    publicModels.filter(model => model.provider === "combo").map(catalogModelSlug),
  );
  const visibleCustomModels = customModels.filter(model => !comboNamespaced.has(model.namespaced));
  // Custom metadata wins when a physical live/static row resolves to the same Codex-facing
  // slug, while a combo keeps the same precedence it has in routing and /v1/models.
  const customNamespaced = new Set(visibleCustomModels.map(c => c.namespaced));
  const dedupedRouted = publicModels.map((m): ManagementModelRow | null => {
    // Codex-facing slug (one "/", slug-codec); disabledModels compares tolerate both forms.
    const namespaced = catalogModelSlug(m);
    if (m.provider !== "combo" && customNamespaced.has(namespaced)) return null;
    const contextCap = providerContextCap(config, m.provider);
    const nativeAlias = m.provider === "combo" && m.nativeAlias === true;
    return {
      ...m,
      namespaced,
      disabled: [...disabled].some(stored => (
        (!nativeAlias && stored === namespaced) || slugEquals(stored, m.provider, m.id)
      )),
      sourceVisible: modelSourceVisible(config, m.provider),
      pickerDisplayName: sourceAwareModelDisplayName({
        provider: m.provider,
        modelId: m.id,
        displayName: m.displayName,
      }),
      ...(contextCap !== undefined ? { contextCap, contextCapped: m.contextCapped === true } : {}),
    };
  }).filter((row): row is ManagementModelRow => row !== null);
  return replaceObservedNativeModelRows([...native, ...dedupedRouted, ...visibleCustomModels], observedNative, config);
}

export function replaceObservedNativeModelRows(
  rows: readonly ManagementModelRow[],
  observed: ObservedNativeCatalog | null,
  config?: Pick<OcxConfig, "disabledModels" | "combos" | "modelSourceVisibility">,
): ManagementModelRow[] {
  if (!observed) return [...rows];
  const disabled = new Set(config?.disabledModels ?? []);
  const shadowed = new Set([
    ...configuredNativeAliasSlugs(config ?? {}),
    ...rows.filter(row => row.provider === "combo" && !row.namespaced.includes("/")).map(row => row.namespaced),
  ]);
  const previous = new Map(rows.filter(row => row.native).map(row => [row.id, row]));
  const native = observed.models.filter(model => !shadowed.has(model.id)).map(model => ({
    ...model,
    provider: "openai",
    namespaced: model.id,
    native: true,
    nativeCatalogCurrent: true,
    disabled: config ? disabled.has(model.id) : previous.get(model.id)?.disabled ?? false,
    sourceVisible: model.visible && (config ? modelSourceVisible(config, "openai") : previous.get(model.id)?.sourceVisible !== false),
    pickerDisplayName: model.displayName,
  }));
  return [...native, ...rows.filter(row => !row.native)];
}

/** `/api/models` row → the narrower input the client-config serializers accept. */
export function toExportModel(row: ManagementModelRow): ExportModel {
  return {
    namespaced: row.namespaced,
    provider: row.provider,
    id: row.id,
    ...(row.native ? { native: true } : {}),
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
  };
}

/**
 * Visible (non-disabled) rows as export models — the ONE loader both
 * `/api/client-config` and the integration routes use, so the two can never
 * disagree about which models a client is told about.
 *
 * The visibility filter lives HERE rather than at each call site: the export
 * core serializes what it is given, so a model the user disabled in the Models
 * tab is absent from `/v1/models` and exporting it would hand the client a
 * selector the proxy refuses to route.
 */
export async function loadExportModels(config: OcxConfig): Promise<ExportModel[]> {
  const rows = await listManagementModelRows(config);
  return rows.filter(row => !row.disabled && row.sourceVisible).map(toExportModel);
}
