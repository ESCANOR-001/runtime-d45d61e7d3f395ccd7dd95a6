import { join, resolve } from "node:path";
import { existsSync, lstatSync, mkdirSync, readFileSync, truncateSync, unlinkSync } from "node:fs";
import { atomicWriteFile, getConfigDir } from "../config";
import type { OcxConfig } from "../types";
import { providerEnvironmentReferences } from "./provider-environment";

export function serviceApiTokenFilePath(): string {
  return join(getConfigDir(), "service-api-token");
}

/** Pointer carried by every durable service wrapper; the file itself is owner-only. */
export const SERVICE_PROVIDER_ENV_FILE_ENV = "OCX_PROVIDER_ENV_FILE";

/**
 * The durable provider snapshot is safe to hydrate for both supervised service
 * children and the installed desktop shell's short-lived CLI actions. Keeping
 * this predicate here makes the trust boundary explicit: ordinary interactive
 * commands do not implicitly load a persisted secret file.
 */
export function shouldLoadServiceProviderEnvironment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.OCX_SERVICE === "1" || env.OCX_DESKTOP === "1";
}

const SERVICE_PROVIDER_ENV_FILE = "service-provider-env.json";
const SERVICE_PROVIDER_ENV_VERSION = 1;
const MAX_SERVICE_PROVIDER_ENV_BYTES = 256 * 1024;
const MAX_SERVICE_PROVIDER_ENV_VALUES = 128;
const MAX_SERVICE_PROVIDER_ENV_VALUE_BYTES = 64 * 1024;

type ServiceProviderEnvFile = {
  version: 1;
  variables: Record<string, string>;
};

function validEnvironmentName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

/**
 * Environment names which must survive an interactive shell → durable-service handoff.
 *
 * The config deliberately keeps these as `${NAME}` references rather than writing provider
 * credentials to config.json. A launchd/systemd/Task Scheduler service does not inherit the
 * user's shell, so the service installer snapshots only the referenced values into an owner-only
 * file and gives the child a pointer to it. OAuth/forward/local providers do not use apiKey.
 */
export function serviceProviderEnvironmentReferences(
  config: Pick<OcxConfig, "proxy" | "providers">,
): string[] {
  return providerEnvironmentReferences(config);
}

export function serviceProviderEnvFilePath(): string {
  return join(getConfigDir(), SERVICE_PROVIDER_ENV_FILE);
}

function safeReadServiceProviderEnvFile(path: string): Record<string, string> {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SERVICE_PROVIDER_ENV_BYTES) return {};
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ServiceProviderEnvFile>;
    if (parsed.version !== SERVICE_PROVIDER_ENV_VERSION || !parsed.variables || typeof parsed.variables !== "object" || Array.isArray(parsed.variables)) return {};
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, value] of Object.entries(parsed.variables)) {
      if (Object.keys(values).length >= MAX_SERVICE_PROVIDER_ENV_VALUES) break;
      if (!validEnvironmentName(name) || typeof value !== "string" || value.includes("\0")) continue;
      if (Buffer.byteLength(value, "utf8") > MAX_SERVICE_PROVIDER_ENV_VALUE_BYTES) continue;
      values[name] = value;
    }
    return values;
  } catch {
    return {};
  }
}

/** Values that a service can use now, without overriding explicitly supplied manager variables. */
export function unresolvedServiceProviderEnvironment(
  config: Pick<OcxConfig, "proxy" | "providers">,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const saved = safeReadServiceProviderEnvFile(serviceProviderEnvFilePath());
  return serviceProviderEnvironmentReferences(config).filter(name => !nonEmpty(env[name]) && !nonEmpty(saved[name]));
}

export function removeServiceProviderEnvFile(): void {
  const path = serviceProviderEnvFilePath();
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    try { truncateSync(path, 0); } catch { /* unlink may still succeed */ }
    unlinkSync(path);
  } catch {
    /* no owner-only snapshot to remove */
  }
}

/**
 * Persist the effective values for referenced provider/config env vars. The supplied process
 * environment wins; a previous owner-only snapshot is retained only when a repair runs from a
 * shell that no longer exports the value. Missing references are reported, never serialized.
 */
export function writeServiceProviderEnvironment(
  config: Pick<OcxConfig, "proxy" | "providers">,
  env: Record<string, string | undefined> = process.env,
): { missing: string[]; written: number } {
  const names = serviceProviderEnvironmentReferences(config);
  if (names.length === 0) {
    removeServiceProviderEnvFile();
    return { missing: [], written: 0 };
  }
  const previous = safeReadServiceProviderEnvFile(serviceProviderEnvFilePath());
  const variables: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = nonEmpty(env[name]) ?? nonEmpty(previous[name]);
    if (!value) {
      missing.push(name);
      continue;
    }
    variables[name] = value;
  }
  if (missing.length > 0) return { missing, written: 0 };

  const dir = getConfigDir();
  const path = serviceProviderEnvFilePath();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(
    path,
    `${JSON.stringify({ version: SERVICE_PROVIDER_ENV_VERSION, variables } satisfies ServiceProviderEnvFile)}\n`,
  );
  return { missing: [], written: Object.keys(variables).length };
}

/**
 * Hydrate an Remodex service process from its exact owner-only snapshot. A pointer outside the
 * active OPENCODEX_HOME is ignored so project-controlled dotenv files cannot make `rmx` read an
 * arbitrary path. Existing manager-provided variables always win over the snapshot.
 */
export function loadServiceProviderEnvironmentFromFile(
  env: Record<string, string | undefined> = process.env,
): number {
  const requested = env[SERVICE_PROVIDER_ENV_FILE_ENV]?.trim();
  if (!requested) return 0;
  const expected = serviceProviderEnvFilePath();
  if (resolve(requested) !== resolve(expected)) return 0;
  let loaded = 0;
  for (const [name, value] of Object.entries(safeReadServiceProviderEnvFile(expected))) {
    if (nonEmpty(env[name])) continue;
    env[name] = value;
    loaded += 1;
  }
  return loaded;
}

/**
 * App-side service token loading (WinSW native mode has no batch wrapper to read the
 * token file into the environment). Pure: returns the token or null — the CALLER
 * assigns it to process.env.OPENCODEX_API_AUTH_TOKEN. Loads only when the env token
 * is empty and OCX_API_TOKEN_FILE names a readable file.
 */
export function loadServiceTokenFromFile(env: Record<string, string | undefined>): string | null {
  if (env.OPENCODEX_API_AUTH_TOKEN?.trim()) return null;
  const file = env.OCX_API_TOKEN_FILE?.trim();
  if (!file) return null;
  try {
    const token = readFileSync(file, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}
