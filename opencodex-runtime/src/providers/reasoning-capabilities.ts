import {
  getModelMetadata,
  getModelMetadataCaseInsensitive,
  resolveMetadataProvider,
} from "../generated/model-metadata";
import type {
  OcxProviderConfig,
  ReasoningControl,
} from "../types";
import { modelInList } from "../types";
import {
  isCodexGradedReasoningEffort,
  modelRecordValue,
  reasoningEffortMapFor,
  sanitizeCodexReasoningEfforts,
} from "../reasoning-effort";

export type ReasoningCapabilityProvider = Pick<
  OcxProviderConfig,
  | "reasoningEfforts"
  | "modelReasoningEfforts"
  | "modelDefaultReasoningEfforts"
  | "modelReasoningRequired"
  | "reasoningEffortMap"
  | "modelReasoningEffortMap"
  | "noReasoningModels"
  | "thinkingToggleModels"
  | "thinkingBudgetModels"
> & {
  /** Registry identity used to select the matching trusted bundled metadata source. */
  readonly id?: string;
  readonly jawcodeBundle?: string;
  /** Registry-only model-discovery dialect; never persisted in provider config. */
  readonly reasoningMetadataFormat?: "openrouter";
  /** Registry-only case-folding policy for the vendored metadata bundle. */
  readonly metadataModelIdNormalize?: "case-insensitive";
};

export interface DiscoveredReasoningCapability {
  /** Preferred evidence-aware representation. `unknown` is non-conclusive and falls through. */
  readonly control?: ReasoningControl;
  /** Backward-compatible exact ladder input for existing discovery/cache callers. */
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly required?: boolean;
}

export interface ResolvedReasoningCapability {
  readonly control: ReasoningControl;
  /** Present only when an exact ladder or confirmed unsupported state is safe to project. */
  readonly efforts?: string[];
  readonly defaultEffort?: string;
  readonly required: boolean;
  readonly source:
    | "disabled"
    | "model-config"
    | "live"
    | "registry-model"
    | "bundled"
    | "provider-config"
    | "registry-provider"
    | "unknown";
}

type ConclusiveControl = Exclude<ReasoningControl, { kind: "unknown" }>;

function sanitizeEvidence(
  provider: ReasoningCapabilityProvider,
  modelId: string,
  raw: readonly string[],
): string[] {
  const efforts = sanitizeCodexReasoningEfforts(raw) ?? [];
  if (efforts.length === 0) return efforts;
  const map = reasoningEffortMapFor(provider as OcxProviderConfig, modelId);
  const mapped = Object.values(map ?? {}).filter(isCodexGradedReasoningEffort);
  return sanitizeCodexReasoningEfforts([...efforts, ...mapped]) ?? efforts;
}

function effortControl(
  provider: ReasoningCapabilityProvider,
  modelId: string,
  raw: readonly string[],
): ConclusiveControl {
  const efforts = sanitizeEvidence(provider, modelId, raw);
  return efforts.length > 0
    ? { kind: "effort", efforts, required: false }
    : { kind: "unsupported" };
}

function mappedEffortControl(
  map: Record<string, string> | undefined,
): ConclusiveControl | undefined {
  if (!map) return undefined;
  // Map keys are the Codex-facing values the operator explicitly chose to support. Values are
  // provider wire aliases and must not be advertised as additional selector levels here.
  const efforts = sanitizeCodexReasoningEfforts(Object.keys(map)) ?? [];
  return efforts.length > 0
    ? { kind: "effort", efforts, required: false }
    : undefined;
}

function modelControl(
  provider: ReasoningCapabilityProvider | undefined,
  modelId: string,
): ConclusiveControl | undefined {
  if (!provider) return undefined;
  // The ladder historically attached to a binary-thinking model is only a many-to-one UI shim;
  // the upstream capability is still Off/On. Preserve that semantic state so Android and future
  // clients do not present five fake degrees of control.
  if (modelInList(provider.thinkingToggleModels, modelId)) return { kind: "toggle" };
  const raw = modelRecordValue(provider.modelReasoningEfforts, modelId);
  if (raw !== undefined) return effortControl(provider, modelId, raw);
  return undefined;
}

function modelMappedControl(
  provider: ReasoningCapabilityProvider | undefined,
  modelId: string,
): ConclusiveControl | undefined {
  return mappedEffortControl(modelRecordValue(provider?.modelReasoningEffortMap, modelId));
}

function providerControl(
  provider: ReasoningCapabilityProvider | undefined,
  modelId: string,
): ConclusiveControl | undefined {
  if (provider?.reasoningEfforts === undefined) return undefined;
  return effortControl(provider, modelId, provider.reasoningEfforts);
}

function providerMappedControl(
  provider: ReasoningCapabilityProvider | undefined,
): ConclusiveControl | undefined {
  return mappedEffortControl(provider?.reasoningEffortMap);
}

function validDefault(raw: string | undefined, efforts: readonly string[]): string | undefined {
  if (!raw) return undefined;
  const [normalized] = sanitizeCodexReasoningEfforts([raw]) ?? [];
  return normalized && efforts.includes(normalized) ? normalized : undefined;
}

function normalizedDiscoveredControl(
  discovered: DiscoveredReasoningCapability,
): ConclusiveControl | undefined {
  if (discovered.control && discovered.control.kind !== "unknown") {
    if (discovered.control.kind !== "effort") return discovered.control;
    const efforts = sanitizeCodexReasoningEfforts(discovered.control.efforts) ?? [];
    const defaultEffort = validDefault(discovered.control.defaultEffort, efforts);
    return efforts.length > 0
      ? {
          kind: "effort",
          efforts,
          required: discovered.control.required,
          ...(defaultEffort ? { defaultEffort } : {}),
        }
      : { kind: "unsupported" };
  }
  if (discovered.efforts === undefined) return undefined;
  const efforts = sanitizeCodexReasoningEfforts(discovered.efforts) ?? [];
  const defaultEffort = validDefault(discovered.defaultEffort, efforts);
  return efforts.length > 0
    ? {
        kind: "effort",
        efforts,
        required: discovered.required === true,
        ...(defaultEffort ? { defaultEffort } : {}),
      }
    : { kind: "unsupported" };
}

/**
 * Resolve the vendored provider/model snapshot only when the caller has already proved that the
 * configured provider still uses its registry transport. A same-named custom endpoint must never
 * inherit another service's capability contract.
 */
export function bundledReasoningCapability(
  providerName: string,
  modelId: string,
  trustedRegistry: ReasoningCapabilityProvider | undefined,
): DiscoveredReasoningCapability | undefined {
  if (!trustedRegistry) return undefined;
  const metadataProvider = resolveMetadataProvider(trustedRegistry.id ?? providerName)
    ?? (trustedRegistry.jawcodeBundle
      ? resolveMetadataProvider(trustedRegistry.jawcodeBundle)
      : undefined);
  if (!metadataProvider) return undefined;
  const metadata = getModelMetadata(metadataProvider, modelId)
    ?? (trustedRegistry.metadataModelIdNormalize === "case-insensitive"
      ? getModelMetadataCaseInsensitive(metadataProvider, modelId)
      : undefined);
  if (!metadata) return undefined;
  if (metadata.reasoning === false) return { control: { kind: "unsupported" } };
  const efforts = sanitizeCodexReasoningEfforts(metadata.thinking?.levels);
  if (efforts && efforts.length > 0) {
    const defaultEffort = validDefault(metadata.thinking?.defaultLevel, efforts);
    return {
      control: {
        kind: "effort",
        efforts,
        required: false,
        ...(defaultEffort ? { defaultEffort } : {}),
      },
    };
  }
  // A future thinking mode can still be positive reasoning evidence even when this runtime cannot
  // normalize its controls. Preserve it as automatic instead of inventing effort names.
  if (metadata.reasoning === true) return { control: { kind: "automatic", required: false } };
  return undefined;
}

/**
 * Resolve one routed model's reasoning contract from conclusive evidence only.
 *
 * Sparse/unknown live metadata deliberately falls through to trusted registry and bundled facts.
 * Confirmed unsupported, automatic, and toggle controls do not. Provider-wide defaults are last:
 * they are useful for explicit custom configurations but must not erase a more precise model row.
 */
export function resolveRoutedModelReasoningCapability(
  modelId: string,
  configured: ReasoningCapabilityProvider,
  registry: ReasoningCapabilityProvider | undefined,
  discovered: DiscoveredReasoningCapability = {},
  bundled: DiscoveredReasoningCapability | undefined = undefined,
): ResolvedReasoningCapability {
  if (modelInList(configured.noReasoningModels, modelId)) {
    return {
      control: { kind: "unsupported" },
      efforts: [],
      required: false,
      source: "disabled",
    };
  }

  const explicitModel = modelControl(configured, modelId);
  const live = normalizedDiscoveredControl(discovered);
  const registryDisabled = modelInList(registry?.noReasoningModels, modelId);
  const registryModel = registryDisabled ? { kind: "unsupported" as const } : modelControl(registry, modelId);
  const bundledModel = bundled ? normalizedDiscoveredControl(bundled) : undefined;
  // A wire map proves that its Codex-facing keys are representable, but it is not an exact
  // capability list. Prefer conclusive live/registry/bundled model evidence when available.
  const configuredModelMap = modelMappedControl(configured, modelId);
  const configuredProvider = providerControl(configured, modelId);
  const configuredProviderMap = providerMappedControl(configured);
  const registryModelMap = modelMappedControl(registry, modelId);
  const registryProvider = providerControl(registry, modelId);
  const registryProviderMap = providerMappedControl(registry);
  const selected = explicitModel
    ? { control: explicitModel, source: "model-config" as const }
    : live
      ? { control: live, source: "live" as const }
      : registryModel
        ? { control: registryModel, source: "registry-model" as const }
        : bundledModel
          ? { control: bundledModel, source: "bundled" as const }
          : configuredModelMap
            ? { control: configuredModelMap, source: "model-config" as const }
            : configuredProvider
              ? { control: configuredProvider, source: "provider-config" as const }
              : configuredProviderMap
                ? { control: configuredProviderMap, source: "provider-config" as const }
                : registryModelMap
                  ? { control: registryModelMap, source: "registry-model" as const }
                  : registryProvider
                    ? { control: registryProvider, source: "registry-provider" as const }
                    : registryProviderMap
                      ? { control: registryProviderMap, source: "registry-provider" as const }
                      : { control: { kind: "unknown" } as const, source: "unknown" as const };

  if (selected.control.kind === "unknown") {
    return { control: selected.control, required: false, source: selected.source };
  }
  if (selected.control.kind === "unsupported") {
    return {
      control: selected.control,
      efforts: [],
      required: false,
      source: selected.source,
    };
  }
  if (selected.control.kind === "toggle") {
    return { control: selected.control, required: false, source: selected.source };
  }

  const explicitRequired = modelRecordValue(configured.modelReasoningRequired, modelId);
  const registryRequired = modelRecordValue(registry?.modelReasoningRequired, modelId);
  const bundledRequired = bundled?.required
    ?? (bundled?.control?.kind === "effort" || bundled?.control?.kind === "automatic"
      ? bundled.control.required
      : undefined);
  const required = explicitRequired
    ?? discovered.required
    ?? (discovered.control?.kind === "effort" || discovered.control?.kind === "automatic"
      ? discovered.control.required
      : undefined)
    ?? registryRequired
    ?? bundledRequired
    ?? selected.control.required;

  if (selected.control.kind === "automatic") {
    const control: ReasoningControl = { kind: "automatic", required };
    return { control, required, source: selected.source };
  }

  const efforts = required
    ? selected.control.efforts.filter(effort => effort !== "none")
    : selected.control.efforts;
  const explicitDefault = modelRecordValue(configured.modelDefaultReasoningEfforts, modelId);
  const registryDefault = modelRecordValue(registry?.modelDefaultReasoningEfforts, modelId);
  const bundledDefault = bundled?.defaultEffort
    ?? (bundled?.control?.kind === "effort" ? bundled.control.defaultEffort : undefined);
  const discoveredDefault = discovered.defaultEffort
    ?? (discovered.control?.kind === "effort" ? discovered.control.defaultEffort : undefined);
  const defaultEffort = validDefault(
    explicitDefault
      ?? discoveredDefault
      ?? registryDefault
      ?? bundledDefault
      ?? selected.control.defaultEffort,
    efforts,
  ) ?? (required && efforts.length > 0 ? efforts[0] : undefined);
  const control: ReasoningControl = {
    kind: "effort",
    efforts,
    required,
    ...(defaultEffort ? { defaultEffort } : {}),
  };

  return {
    control,
    efforts,
    required,
    source: selected.source,
    ...(defaultEffort ? { defaultEffort } : {}),
  };
}
