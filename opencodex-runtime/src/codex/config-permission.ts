import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ensureConfigFile, loadConfig, mutatePersistedConfig } from "../config";
import type { OcxConfig } from "../types";
import { CODEX_CONFIG_PATH } from "./paths";
import { isConnectRuntime } from "../connect/mode";

export const CODEX_CONFIG_PERMISSION_MESSAGE =
  "Codex settings are read-only. Phone access does not authorize changes to config.toml, model catalogs, or chat history. To explicitly allow Remodex to manage this Codex configuration, run rmx sync --allow-config-change.";

/** Consent belongs to one Codex configuration, not every home on the computer. */
export function canManageCodexConfig(
  config: Pick<OcxConfig, "codexConfigWriteConsent"> = loadConfig(),
  configPath = CODEX_CONFIG_PATH,
): boolean {
  if (isConnectRuntime()) return false;
  const consent = config.codexConfigWriteConsent;
  if (!consent || !isAbsolute(consent)) return false;
  const canonical = (value: string) => {
    const absolute = resolve(value);
    const path = join(realpathSync.native(dirname(absolute)), basename(absolute));
    return process.platform === "win32" ? path.toLowerCase() : path;
  };
  try {
    return canonical(consent) === canonical(configPath);
  } catch {
    return false;
  }
}

/** Called only by an explicit permission action; never by startup or pairing. */
export function setCodexConfigPermission(allowed: boolean): void {
  if (isConnectRuntime()) throw new Error("Remodex Connect never manages Codex configuration files.");
  if (allowed) ensureConfigFile();
  const result = mutatePersistedConfig(config => {
    const previous = config.codexConfigWriteConsent;
    if (allowed) config.codexConfigWriteConsent = CODEX_CONFIG_PATH;
    else delete config.codexConfigWriteConsent;
    return { changed: previous !== config.codexConfigWriteConsent, value: allowed };
  });
  if (result.status !== "committed" && result.status !== "unchanged") {
    throw new Error("Could not save permission for Codex settings. No Codex files were changed.");
  }
}

export function assertCodexConfigPermission(configPath = CODEX_CONFIG_PATH): void {
  if (!canManageCodexConfig(loadConfig(), configPath)) throw new Error(CODEX_CONFIG_PERMISSION_MESSAGE);
}
