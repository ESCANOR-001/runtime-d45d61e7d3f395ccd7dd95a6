import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CODEX_CONFIG_PATH, CODEX_PROFILE_PATH } from "../codex/paths";
import { routedSlug } from "../providers/slug-codec";

type JsonRecord = Record<string, unknown>;
let cachedProvider: { value: string | null; expiresAt: number } | undefined;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** null means Desktop uses Remodex (or has no readable configuration yet). */
export function readDesktopDirectModelProvider(paths?: { configPath: string; remodexProfilePath: string }): string | null {
  if (paths) return readConfiguredDesktopDirectModelProvider(paths.configPath, paths.remodexProfilePath);
  if (cachedProvider && cachedProvider.expiresAt > Date.now()) return cachedProvider.value;
  const value = readConfiguredDesktopDirectModelProvider();
  cachedProvider = { value, expiresAt: Date.now() + 5_000 };
  return value;
}

function endpointIdentity(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.hostname = "localhost";
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.href;
  } catch { return null; }
}

function providerEndpoint(config: JsonRecord, provider: string): unknown {
  return provider === "openai" ? config.openai_base_url : record(record(config.model_providers)?.[provider])?.base_url;
}

function readConfiguredDesktopDirectModelProvider(
  configPath = CODEX_CONFIG_PATH,
  remodexProfilePath = CODEX_PROFILE_PATH,
): string | null {
  try {
    const document = record(Bun.TOML.parse(readFileSync(configPath, "utf8")));
    const profileName = typeof document?.profile === "string" ? document.profile : "";
    let profile = record(record(document?.profiles)?.[profileName]);
    if (profileName && /^[\w.-]+$/u.test(profileName)) {
      try {
        // Current Codex profiles are separate files; retain legacy inline profiles too.
        profile = record(Bun.TOML.parse(readFileSync(join(dirname(configPath), `${profileName}.config.toml`), "utf8")));
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
    }
    const config: JsonRecord = { ...document, ...profile, model_providers: {
      ...record(document?.model_providers), ...record(profile?.model_providers),
    } };
    const provider = typeof config.model_provider === "string" ? config.model_provider.trim() : "openai";
    if (!provider) return null;
    const endpoint = endpointIdentity(providerEndpoint(config, provider));
    // A custom provider may itself point at Remodex. Keep its qualified IDs intact.
    try {
      const routed = record(Bun.TOML.parse(readFileSync(remodexProfilePath, "utf8")));
      const routedProvider = typeof routed?.model_provider === "string" ? routed.model_provider : "openai";
      const routedEndpoint = endpointIdentity(providerEndpoint(routed ?? {}, routedProvider));
      if (endpoint && endpoint === routedEndpoint) return null;
    } catch {
      // Direct Desktop configurations do not require a generated Remodex profile.
    }
    return provider;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new Error("Desktop connection settings could not be read. Check config.toml before selecting a model.");
  }
}

function mapRuntimeModels(params: JsonRecord, map: (model: string) => string): JsonRecord {
  const collaborationMode = record(params.collaborationMode);
  const settings = record(collaborationMode?.settings);
  return {
    ...params,
    ...(typeof params.model === "string" ? { model: map(params.model) } : {}),
    ...(settings && typeof settings.model === "string" ? {
      collaborationMode: { ...collaborationMode, settings: { ...settings, model: map(settings.model) } },
    } : {}),
  };
}

/** A chat's explicit connection wins over a later change to Desktop's default. */
export function desktopModelProvider(params: JsonRecord, fallback: () => string | null = readDesktopDirectModelProvider): string | null {
  for (const key of ["modelProviderId", "modelProvider", "model_provider"] as const) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback();
}

/** Translate Desktop actions back to the private app-server's routing namespace. */
export function remodexRuntimeModelSelectors(params: JsonRecord): JsonRecord {
  const provider = desktopModelProvider(params);
  if (!provider || provider === "openai") return params;
  return mapRuntimeModels(params, model => model && !model.includes("/") ? routedSlug(provider, model) : model);
}

/** Only the Desktop presentation copy loses the active direct provider's route prefix. */
export function desktopConversationModelSelectors(state: JsonRecord): JsonRecord {
  const provider = desktopModelProvider(state);
  if (!provider) return state;
  const prefix = `${provider}/`;
  const model = (value: string): string => value.startsWith(prefix) ? value.slice(prefix.length) : value;
  const latest = mapRuntimeModels({ collaborationMode: state.latestCollaborationMode }, model);
  return {
    ...state,
    ...(typeof state.latestModel === "string" ? { latestModel: model(state.latestModel) } : {}),
    ...(typeof state.previousTurnModel === "string" ? { previousTurnModel: model(state.previousTurnModel) } : {}),
    ...(state.latestCollaborationMode ? { latestCollaborationMode: latest.collaborationMode } : {}),
    ...(Array.isArray(state.turns) ? {
      turns: state.turns.map(value => {
        const turn = record(value);
        const params = record(turn?.params);
        return turn && params ? { ...turn, params: mapRuntimeModels(params, model) } : value;
      }),
    } : {}),
  };
}
