import type { OcxProviderConfig, ReasoningControlKind } from "./types";
import { modelInList } from "./types";

// Descriptions mirror the upstream bundled models.json canonical wording (openai/codex PR #31684).
export const CODEX_REASONING_LEVELS: { effort: string; description: string }[] = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
  { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
  { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
];

/** Canonical Codex presets that appear before the graded low..ultra ladder. */
export const CODEX_REASONING_PRESETS: { effort: string; description: string }[] = [
  { effort: "none", description: "Reasoning disabled" },
  { effort: "minimal", description: "Minimal reasoning" },
  ...CODEX_REASONING_LEVELS,
];

const CODEX_REASONING_ORDER = CODEX_REASONING_PRESETS.map(l => l.effort);
const CODEX_REASONING_SET = new Set(CODEX_REASONING_ORDER);
const CODEX_GRADED_REASONING_SET = new Set(CODEX_REASONING_LEVELS.map(level => level.effort));

/** True when `effort` is a member of the Codex reasoning ladder (low..ultra). */
export function isCodexReasoningEffort(effort: string): boolean {
  return CODEX_REASONING_SET.has(effort);
}

/** True only for graded levels that may be inferred from a provider wire map. */
export function isCodexGradedReasoningEffort(effort: string): boolean {
  return CODEX_GRADED_REASONING_SET.has(effort);
}

/**
 * Reasoning ladder accepted for the OpenAI vision sidecar. `ultra` is deliberately excluded:
 * the vision describer is a single helper call, and `ultra` would be collapsed to `max` by the
 * upstream client boundary anyway.
 */
export const VISION_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type VisionReasoningEffort = typeof VISION_REASONING_EFFORTS[number];

/** True when `effort` is one of the vision sidecar's supported Responses reasoning levels. */
export function isVisionReasoningEffort(effort: unknown): effort is VisionReasoningEffort {
  return typeof effort === "string" && (VISION_REASONING_EFFORTS as readonly string[]).includes(effort);
}

/**
 * Normalize a persisted/configured vision reasoning value. Invalid values (hand-edited config,
 * stale files) degrade to `undefined` so the caller falls back to the documented default instead
 * of forwarding an upstream-rejected effort.
 */
export function sanitizeVisionReasoning(effort: unknown): VisionReasoningEffort | undefined {
  return isVisionReasoningEffort(effort) ? effort : undefined;
}

/** Position of `effort` in the Codex ladder (none=0 .. ultra=7), or -1 when unknown. */
export function codexEffortRank(effort: string): number {
  return CODEX_REASONING_ORDER.indexOf(effort);
}

export function modelRecordValue<T>(record: Record<string, T> | undefined, modelId: string): T | undefined {
  if (!record) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, modelId)) return record[modelId];
  const colon = modelId.indexOf(":");
  if (colon > 0) {
    const family = modelId.slice(0, colon);
    if (Object.prototype.hasOwnProperty.call(record, family)) return record[family];
  }
  const folded = modelId.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === folded) return value;
  }
  return undefined;
}

export function sanitizeCodexReasoningEfforts(efforts: readonly string[] | undefined): string[] | undefined {
  if (efforts === undefined) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const effort of efforts) {
    if (!CODEX_REASONING_SET.has(effort) || seen.has(effort)) continue;
    seen.add(effort);
    out.push(effort);
  }
  return out.sort((a, b) => CODEX_REASONING_ORDER.indexOf(a) - CODEX_REASONING_ORDER.indexOf(b));
}

/**
 * Provider/model configured reasoning levels for the Codex catalog. `undefined` means “no override”,
 * while an empty array means “intentionally expose no effort control for this model”.
 */
export function configuredReasoningEfforts(provider: OcxProviderConfig, modelId: string): string[] | undefined {
  if (modelInList(provider.noReasoningModels, modelId)) return [];
  const control = reasoningControlKindFor(provider, modelId);
  if (control === "unsupported") return [];
  if (control === "unknown" || control === "automatic" || control === "toggle") return undefined;
  const modelEfforts = modelRecordValue(provider.modelReasoningEfforts, modelId);
  if (modelEfforts !== undefined) return healMappedTiers(provider, modelId, sanitizeCodexReasoningEfforts(modelEfforts) ?? []);
  if (provider.reasoningEfforts !== undefined) return healMappedTiers(provider, modelId, sanitizeCodexReasoningEfforts(provider.reasoningEfforts) ?? []);
  return undefined;
}

/** True when the selected model cannot accept an omitted/disabled reasoning effort. */
export function isReasoningEffortRequired(provider: OcxProviderConfig, modelId: string): boolean {
  if (modelInList(provider.noReasoningModels, modelId)) return false;
  const control = reasoningControlKindFor(provider, modelId);
  if (control !== undefined && control !== "effort" && control !== "automatic") return false;
  return modelRecordValue(provider.modelReasoningRequired, modelId) === true;
}

/** Runtime-selected evidence state for one routed model, when routing has resolved it. */
export function reasoningControlKindFor(
  provider: OcxProviderConfig,
  modelId: string,
): ReasoningControlKind | undefined {
  return modelRecordValue(provider.modelReasoningControls, modelId);
}

/**
 * Stale-ladder self-heal: a registry wire map is authoritative evidence of the upstream tiers
 * it can emit. Merge Codex-native map values into an older persisted ladder so newly documented
 * tiers appear without rewriting the user's config. Non-Codex values such as enabled/disabled
 * and Kimi's none sentinel are ignored here; they remain request-only wire aliases.
 */
function healMappedTiers(provider: OcxProviderConfig, modelId: string, efforts: string[]): string[] {
  if (efforts.length === 0) return efforts;
  const wireMap = reasoningEffortMapFor(provider, modelId);
  if (!wireMap) return efforts;
  const mappedTiers = Object.values(wireMap).filter(isCodexGradedReasoningEffort);
  if (mappedTiers.length === 0) return efforts;
  return sanitizeCodexReasoningEfforts([...efforts, ...mappedTiers]) ?? efforts;
}

function requestToCodexEffort(requested: string): string | undefined {
  return CODEX_REASONING_SET.has(requested) ? requested : undefined;
}

function legacyRequestToCodexEffort(requested: string): string | undefined {
  if (requested === "none") return undefined;
  if (requested === "minimal") return "low";
  return requestToCodexEffort(requested);
}

function clampToSupportedCodexEffort(requested: string, supported: readonly string[]): string | undefined {
  if (supported.length === 0) return undefined;
  const codex = requestToCodexEffort(requested);
  if (!codex) return undefined;
  if (supported.includes(codex)) return codex;

  const requestedRank = CODEX_REASONING_ORDER.indexOf(codex);
  let best = supported[0];
  let bestRank = CODEX_REASONING_ORDER.indexOf(best);
  for (const effort of supported) {
    const rank = CODEX_REASONING_ORDER.indexOf(effort);
    if (rank <= requestedRank && rank >= bestRank) {
      best = effort;
      bestRank = rank;
    }
  }
  // If every supported tier is above the requested tier, choose the lowest supported tier.
  return best;
}

/**
 * Resolve the catalog/request default against the model's actual ladder. This repairs stale
 * persisted defaults rather than advertising or forwarding a value the upstream rejects.
 */
export function configuredDefaultReasoningEffort(provider: OcxProviderConfig, modelId: string): string | undefined {
  const supported = configuredReasoningEfforts(provider, modelId);
  const configured = modelRecordValue(provider.modelDefaultReasoningEfforts, modelId);
  const required = isReasoningEffortRequired(provider, modelId);
  if (configured) {
    const codex = requestToCodexEffort(configured);
    const normalized = supported === undefined
      ? codex
      : codex && supported.includes(codex)
        ? codex
        : required
          ? clampToSupportedCodexEffort(configured, supported)
          : undefined;
    if (normalized) return normalized;
  }
  if (!required || !supported || supported.length === 0) {
    return undefined;
  }
  // When no valid explicit default survives, prefer the lowest supported tier. That is the
  // closest safe interpretation of a stale `none` selection and avoids silently raising cost.
  return supported[0];
}

export function reasoningEffortMapFor(provider: OcxProviderConfig, modelId: string): Record<string, string> | undefined {
  return modelRecordValue(provider.modelReasoningEffortMap, modelId) ?? provider.reasoningEffortMap;
}

/**
 * Translate Codex's reasoning label into the provider's real wire value. Prefer identity labels
 * (`xhigh` stays `xhigh`, `max` stays `max`); provider maps are only for real upstream aliases.
 */
export function mapReasoningEffort(provider: OcxProviderConfig, modelId: string, requested: string | undefined): string | undefined {
  if (modelInList(provider.noReasoningModels, modelId)) return undefined;
  const control = reasoningControlKindFor(provider, modelId);
  if (control === "unsupported" || control === "unknown" || control === "automatic") return undefined;

  const required = isReasoningEffortRequired(provider, modelId);
  if (!requested && !required) return undefined;

  if (required) {
    const supported = configuredReasoningEfforts(provider, modelId) ?? [];
    const normalizedRequested = requested === "ultra" ? "max" : requested;
    const effective = normalizedRequested
      ? clampToSupportedCodexEffort(normalizedRequested, supported)
      : undefined;
    // Includes omitted, `none`, invalid labels, and stale values that cannot be represented by
    // the current ladder. A contradictory required+empty-ladder config still fails closed by
    // returning undefined instead of inventing an undocumented provider value.
    requested = effective ?? configuredDefaultReasoningEffort(provider, modelId);
    if (!requested) return undefined;
  }

  const selected = requested;
  if (!selected) return undefined;

  // Upstream codex-rs converts ultra -> max before ANY provider request (core/src/client.rs
  // `reasoning_effort_for_request`), so "ultra" must never influence the provider wire — not even
  // through a raw alias. Apply the boundary before alias/clamp resolution.
  const boundary = selected === "ultra" ? "max" : selected;

  const wireMap = reasoningEffortMapFor(provider, modelId);
  if (wireMap && Object.prototype.hasOwnProperty.call(wireMap, boundary)) return wireMap[boundary];
  if (control === "toggle") return undefined;

  const supported = configuredReasoningEfforts(provider, modelId);
  const codexEffort = supported !== undefined
    ? clampToSupportedCodexEffort(boundary, supported)
    : legacyRequestToCodexEffort(boundary);
  if (!codexEffort) return undefined;

  // Belt for the odd config where the supported ladder is ultra-only and the clamp lands on it.
  const wire = codexEffort === "ultra" ? "max" : codexEffort;
  if (wireMap && Object.prototype.hasOwnProperty.call(wireMap, wire)) return wireMap[wire];
  return wire;
}
