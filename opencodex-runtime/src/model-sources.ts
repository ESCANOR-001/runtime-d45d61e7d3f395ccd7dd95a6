import { getProviderRegistryEntry } from "./providers/registry";
import type { OcxConfig } from "./types";

export const CHATGPT_MODEL_SOURCE_ID = "openai";

/**
 * Selector visibility is intentionally separate from provider.disabled.
 *
 * A hidden source remains configured and directly routable by its exact id so an
 * existing task does not break merely because the user simplified future model
 * pickers. Missing keys read as visible for backward and future-provider
 * compatibility.
 */
export function modelSourceVisible(
  config: Pick<OcxConfig, "modelSourceVisibility">,
  provider: string,
): boolean {
  return config.modelSourceVisibility?.[provider] !== false;
}

export function modelSourceDisplayName(provider: string, native = false): string {
  if (native || provider === CHATGPT_MODEL_SOURCE_ID) return "ChatGPT";
  if (provider === "codex-lb") return "Codex-LB";
  const registryLabel = getProviderRegistryEntry(provider)?.label?.trim();
  if (registryLabel) return registryLabel;
  return provider
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map(part => part.length <= 2
      ? part.toUpperCase()
      : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function friendlyGptModelName(modelId: string): string {
  if (!/^gpt-/iu.test(modelId)) return modelId;
  const suffix = modelId.slice(4)
    .split("-")
    .filter(Boolean)
    .map(part => /^[a-z]/u.test(part)
      ? `${part.charAt(0).toUpperCase()}${part.slice(1)}`
      : part)
    .join(" ");
  return `GPT-${suffix}`;
}

function normalizeModelDisplayName(value: string): string {
  const match = value.match(/^GPT-(\d+(?:\.\d+)*)(?:-(.*))?$/iu);
  if (!match) return value;
  const suffix = match[2]?.replace(/-/gu, " ").trim();
  return `GPT-${match[1]}${suffix ? ` ${suffix}` : ""}`;
}

/**
 * Human-facing picker label using the legacy model name only.
 *
 * Source visibility remains independent, but model names do not receive an
 * added provider suffix. The exact route id is never changed.
 */
export function sourceAwareModelDisplayName(input: {
  provider: string;
  modelId: string;
  displayName?: string;
  native?: boolean;
}): string {
  const candidate = input.displayName?.trim();
  const rawRouteLabel = candidate === `${input.provider}/${input.modelId}`
    || candidate === input.modelId;
  const base = !candidate || rawRouteLabel
    ? friendlyGptModelName(input.modelId)
    : normalizeModelDisplayName(candidate);
  return base;
}
