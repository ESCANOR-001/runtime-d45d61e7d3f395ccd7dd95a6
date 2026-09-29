import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../config";
import { getCodexHome } from "../paths";
import type { CatalogModel, CatalogServiceTier } from "./parsing";

type JsonRecord = Record<string, unknown>;
export type ObservedNativeModel = Partial<CatalogModel> & {
  id: string;
  displayName: string;
  visible: boolean;
};
export type ObservedNativeCatalog = {
  version: string;
  models: ObservedNativeModel[];
};
const memo = new Map<string, { stamp: string; value: ObservedNativeCatalog | null }>();

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

function fileStamp(path: string): string {
  try {
    const file = statSync(path);
    return `${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
  } catch { return "missing"; }
}

function readModels(path: string): ObservedNativeCatalog | null {
  try {
    if (statSync(path).size > 4 * 1024 * 1024) return null;
    const cache = record(JSON.parse(readFileSync(path, "utf8")));
    if (!cache || !text(cache.etag) || !text(cache.client_version)
      || cache.client_version === "0.0.0" || !text(cache.fetched_at)
      || !Number.isFinite(Date.parse(cache.fetched_at as string)) || !Array.isArray(cache.models)) return null;
    const models = cache.models.flatMap(value => {
      const entry = record(value);
      const id = text(entry?.slug);
      if (!entry || !id || !/^[a-z0-9][a-z0-9._-]{0,255}$/iu.test(id)
        || entry.opencodex_catalog_kind !== undefined) return [];
      const efforts = Array.isArray(entry.supported_reasoning_levels)
        ? [...new Set(entry.supported_reasoning_levels.flatMap(level => text(record(level)?.effort) ?? []))]
        : undefined;
      const tiers = Array.isArray(entry.service_tiers) ? entry.service_tiers.flatMap(value => {
        const tier = record(value);
        const id = text(tier?.id);
        return id ? [{ id, name: text(tier?.name) ?? id,
          ...(text(tier?.description) ? { description: text(tier?.description) } : {}),
        } as CatalogServiceTier] : [];
      }) : undefined;
      const model: ObservedNativeModel = {
        id, displayName: text(entry.display_name) ?? id,
        visible: entry.visibility === "list" && entry.hidden !== true,
        ...(efforts ? { reasoningEfforts: efforts } : {}),
        ...(text(entry.default_reasoning_level) ? { defaultReasoningEffort: text(entry.default_reasoning_level) } : {}),
        ...(tiers ? { serviceTiers: tiers } : {}),
        ...(Array.isArray(entry.additional_speed_tiers)
          ? { additionalSpeedTiers: entry.additional_speed_tiers.flatMap(value => text(value) ?? []) } : {}),
        ...(entry.default_service_tier === null || text(entry.default_service_tier)
          ? { defaultServiceTier: entry.default_service_tier as string | null } : {}),
        ...(typeof entry.context_window === "number" && entry.context_window > 0
          ? { contextWindow: entry.context_window } : {}),
      };
      return [model];
    });
    if (models.length === 0) return null;
    return { version: createHash("sha256").update(JSON.stringify(models)).digest("hex"), models };
  } catch { return null; }
}

export function readObservedNativeCatalog(codexHome = getCodexHome()): ObservedNativeCatalog | null {
  const cachePath = join(codexHome, "models_cache.json");
  const savedPath = join(codexHome, "remodex-native-models.json");
  const stamp = `${fileStamp(cachePath)}:${fileStamp(savedPath)}`;
  const previous = memo.get(codexHome);
  if (previous?.stamp === stamp) return previous.value;
  const observed = readModels(cachePath);
  const saved = readModels(savedPath);
  const value = observed ?? saved ?? previous?.value ?? null;
  if (observed && observed.version !== saved?.version) {
    const models = observed.models.map(model => ({
      slug: model.id, display_name: model.displayName, visibility: model.visible ? "list" : "hide",
      supported_reasoning_levels: model.reasoningEfforts?.map(effort => ({ effort })),
      default_reasoning_level: model.defaultReasoningEffort,
      service_tiers: model.serviceTiers, additional_speed_tiers: model.additionalSpeedTiers,
      default_service_tier: model.defaultServiceTier, context_window: model.contextWindow,
    }));
    try {
      atomicWriteFile(savedPath, JSON.stringify({ etag: observed.version, client_version: "observed",
        fetched_at: new Date().toISOString(), models }) + "\n");
    } catch { /* Keep the observed models usable when persistence is unavailable. */ }
  }
  memo.set(codexHome, { stamp: `${fileStamp(cachePath)}:${fileStamp(savedPath)}`, value });
  return value;
}
