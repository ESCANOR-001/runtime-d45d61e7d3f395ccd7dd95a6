import {
  mutatePersistedConfig,
  providerBaseUrlConfigError,
  type PersistedConfigMutationOutcome,
} from "../config";
import { existsSync, readFileSync } from "node:fs";
import { providerDestinationConfigError } from "../lib/destination-policy";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { rootTomlString } from "./injected-marker";
import { CODEX_CONFIG_PATH } from "./paths";

/** The one external Desktop provider Remodex can adopt without guessing its wire contract. */
export const CODEX_LB_PROVIDER_ID = "codex-lb";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface CodexLbDescriptor {
  id: typeof CODEX_LB_PROVIDER_ID;
  baseUrl: string;
  envKey: string;
  wireApi: "responses";
  requiresOpenAiAuth: boolean;
}

export type CodexLbInspection =
  | { kind: "inactive" }
  | { kind: "adoptable"; descriptor: CodexLbDescriptor }
  | { kind: "refused"; reason: string };

export type CodexLbAdoptionResult =
  | { kind: "inactive" }
  | {
      kind: "adopted" | "already-managed";
      descriptor: CodexLbDescriptor;
      provider: OcxProviderConfig;
    }
  | { kind: "refused" | "unavailable"; reason: string };

type PersistMutation = typeof mutatePersistedConfig;

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function endpointPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * Reject a literal route back into this Remodex process. Destination policy separately rejects
 * localhost, loopback, private, metadata, and link-local addresses; this comparison also covers a
 * concrete hostname used as the Remodex bind target.
 */
function isConfiguredRemodexEndpoint(baseUrl: string, config: Readonly<OcxConfig>): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  const targetHost = normalizedHostname(url.hostname);
  const configuredHost = normalizedHostname(config.hostname ?? "127.0.0.1");
  if (!targetHost || targetHost !== configuredHost) return false;
  const ports = new Set([config.port ?? 10100]);
  if (config.unauthenticatedLoopbackListener?.enabled) {
    ports.add(config.unauthenticatedLoopbackListener.port);
  }
  return ports.has(endpointPort(url));
}

/**
 * Parse only the active `codex-lb` provider from Codex Desktop's TOML. The resolved environment
 * value is deliberately never read: Remodex stores and routes with the reference `${NAME}`.
 */
export function inspectActiveCodexLbProvider(
  content: string,
  config: Readonly<OcxConfig>,
): CodexLbInspection {
  if (rootTomlString(content, "model_provider") !== CODEX_LB_PROVIDER_ID) {
    return { kind: "inactive" };
  }

  let document: Record<string, unknown>;
  try {
    document = plainRecord(Bun.TOML.parse(content.replace(/^\uFEFF/, ""))) ?? {};
  } catch {
    return { kind: "refused", reason: "Codex config.toml is not valid TOML" };
  }
  const providers = plainRecord(document.model_providers);
  const table = plainRecord(providers?.[CODEX_LB_PROVIDER_ID]);
  if (!table) {
    return { kind: "refused", reason: "active codex-lb has no [model_providers.codex-lb] table" };
  }

  const baseUrl = typeof table.base_url === "string" ? table.base_url.trim().replace(/\/+$/, "") : "";
  const wireApi = typeof table.wire_api === "string" ? table.wire_api.trim().toLowerCase() : "";
  const envKey = typeof table.env_key === "string" ? table.env_key.trim() : "";
  if (!baseUrl) return { kind: "refused", reason: "codex-lb base_url is missing" };
  if (wireApi !== "responses") {
    return { kind: "refused", reason: "codex-lb can be adopted only when wire_api is responses" };
  }
  if (!ENV_NAME.test(envKey)) {
    return { kind: "refused", reason: "codex-lb env_key is missing or invalid" };
  }
  const baseUrlError = providerBaseUrlConfigError(baseUrl);
  if (baseUrlError) return { kind: "refused", reason: `codex-lb ${baseUrlError}` };
  const destinationError = providerDestinationConfigError(CODEX_LB_PROVIDER_ID, { baseUrl });
  if (destinationError) return { kind: "refused", reason: `codex-lb ${destinationError}` };
  if (isConfiguredRemodexEndpoint(baseUrl, config)) {
    return { kind: "refused", reason: "codex-lb base_url points back to this Remodex server" };
  }
  if (table.requires_openai_auth !== undefined && typeof table.requires_openai_auth !== "boolean") {
    return { kind: "refused", reason: "codex-lb requires_openai_auth must be a boolean" };
  }

  return {
    kind: "adoptable",
    descriptor: {
      id: CODEX_LB_PROVIDER_ID,
      baseUrl,
      envKey,
      wireApi: "responses",
      requiresOpenAiAuth: table.requires_openai_auth === true,
    },
  };
}

export function providerForCodexLb(descriptor: CodexLbDescriptor): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: descriptor.baseUrl,
    responsesPath: "/responses",
    authMode: "key",
    apiKey: `\${${descriptor.envKey}}`,
    liveModels: true,
    note: "Imported automatically from Codex Desktop's codex-lb provider.",
  };
}

function sameEndpoint(left: string, right: string): boolean {
  return left.trim().replace(/\/+$/, "") === right.trim().replace(/\/+$/, "");
}

function mergeManagedProvider(
  existing: OcxProviderConfig | undefined,
  expected: OcxProviderConfig,
): { kind: "changed" | "unchanged"; provider: OcxProviderConfig } | { kind: "conflict" } {
  if (!existing) return { kind: "changed", provider: expected };
  if (
    existing.adapter !== "openai-responses"
    || !sameEndpoint(existing.baseUrl, expected.baseUrl)
    || (existing.responsesPath !== undefined && existing.responsesPath !== "/responses")
    || (existing.authMode !== undefined && existing.authMode !== "key")
  ) {
    return { kind: "conflict" };
  }

  // A user-managed credential already attached to the exact same upstream wins. Otherwise retain
  // the environment reference imported from Codex Desktop. Never resolve or copy the env value.
  const provider: OcxProviderConfig = {
    ...existing,
    responsesPath: existing.responsesPath ?? "/responses",
    authMode: existing.authMode ?? "key",
    apiKey: existing.apiKey?.trim() ? existing.apiKey : expected.apiKey,
  };
  const changed = JSON.stringify(provider) !== JSON.stringify(existing);
  return { kind: changed ? "changed" : "unchanged", provider };
}

/**
 * Import an active Codex Desktop codex-lb descriptor into the protected Remodex config. The
 * mutation rebases under the shared config lock, so a concurrent provider edit is never silently
 * overwritten. The caller's live config is updated only after a committed/unchanged result.
 */
export function adoptActiveCodexLbProvider(
  content: string,
  config: OcxConfig,
  mutate: PersistMutation = mutatePersistedConfig,
): CodexLbAdoptionResult {
  const inspection = inspectActiveCodexLbProvider(content, config);
  if (inspection.kind !== "adoptable") return inspection;
  const expected = providerForCodexLb(inspection.descriptor);
  type MutationValue =
    | { kind: "managed"; provider: OcxProviderConfig; changed: boolean }
    | { kind: "conflict" };
  const outcome: PersistedConfigMutationOutcome<MutationValue> = mutate<MutationValue>((persisted) => {
    const merged = mergeManagedProvider(persisted.providers[CODEX_LB_PROVIDER_ID], expected);
    if (merged.kind === "conflict") {
      return { changed: false, value: { kind: "conflict" } };
    }
    if (merged.kind === "changed") persisted.providers[CODEX_LB_PROVIDER_ID] = merged.provider;
    return {
      changed: merged.kind === "changed",
      value: { kind: "managed", provider: merged.provider, changed: merged.kind === "changed" },
    };
  });

  if (outcome.status === "unavailable") {
    return { kind: "unavailable", reason: `Remodex provider config is ${outcome.reason}` };
  }
  if (outcome.value.kind === "conflict") {
    return {
      kind: "refused",
      reason: "Remodex already has an incompatible codex-lb provider; it was not overwritten",
    };
  }
  config.providers[CODEX_LB_PROVIDER_ID] = structuredClone(outcome.value.provider);
  return {
    kind: outcome.status === "committed" && outcome.value.changed ? "adopted" : "already-managed",
    descriptor: inspection.descriptor,
    provider: outcome.value.provider,
  };
}

export function adoptCurrentCodexLbProvider(
  config: OcxConfig,
  mutate: PersistMutation = mutatePersistedConfig,
): CodexLbAdoptionResult {
  if (!existsSync(CODEX_CONFIG_PATH)) return { kind: "inactive" };
  return adoptActiveCodexLbProvider(readFileSync(CODEX_CONFIG_PATH, "utf8"), config, mutate);
}

/** Read-only admission predicate: true only when the active Desktop descriptor is already managed. */
export function isManagedActiveCodexLbProvider(
  content: string,
  config: Readonly<OcxConfig>,
): boolean {
  const inspection = inspectActiveCodexLbProvider(content, config);
  if (inspection.kind !== "adoptable") return false;
  const merged = mergeManagedProvider(
    config.providers[CODEX_LB_PROVIDER_ID],
    providerForCodexLb(inspection.descriptor),
  );
  return merged.kind !== "conflict" && merged.kind === "unchanged";
}
