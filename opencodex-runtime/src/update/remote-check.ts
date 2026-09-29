import { readBoundedResponseBody } from "../lib/bounded-body";
import { currentVersion, detectInstall, PKG, type Channel } from "./index";
import { checkForUpdate, type UpdateCheckResult } from "./job";
import { fetchReleaseNotesForVersion } from "./release-notes";
import { fetchUpdateReleaseInfo, type UpdateReleaseInfo } from "./release-info";
import { isNewer } from "./notify";

// Capture the loaded version once. Replacing package.json does not update this process.
const runningVersion = currentVersion();
const runningInstaller = detectInstall();
const cache = new Map<Channel, { value: RemoteUpdateCheck; at: number }>();
const flights = new Map<Channel, Promise<RemoteUpdateCheck>>();

export type RemoteUpdateCheck = UpdateCheckResult & {
  checkedAt: string;
  releaseNotes: string | null;
  releaseInfo?: UpdateReleaseInfo;
  registryError?: RegistryError;
};

export type RegistryError = { code: "network" | "timeout" | "http" | "invalid_response"; status?: number };
type RegistryResult = { version: string; error?: never } | { version: null; error: RegistryError };

async function registryAttempt(channel: Channel, fetchFn: typeof fetch): Promise<RegistryResult> {
  try {
    const response = await fetchFn(`https://registry.npmjs.org/${encodeURIComponent(PKG)}/${channel}`, {
      signal: AbortSignal.timeout(8_000), redirect: "error",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { version: null, error: { code: "http", status: response.status } };
    }
    const body = await readBoundedResponseBody(response, {
      maxBytes: 512 * 1024, totalTimeoutMs: 8_000, inactivityTimeoutMs: 4_000,
    });
    if (body.timedOut) return { version: null, error: { code: "timeout" } };
    if (!body.displaySafe || body.oversized) return { version: null, error: { code: "invalid_response" } };
    let data;
    try { data = JSON.parse(body.text); }
    catch { return { version: null, error: { code: "invalid_response" } }; }
    return data?.name === PKG && typeof data.version === "string"
      && data.version.length <= 64
      && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(data.version)
      ? { version: data.version } : { version: null, error: { code: "invalid_response" } };
  } catch (error) {
    return { version: null, error: { code: error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
      ? "timeout" : "network" } };
  }
}

export async function checkRegistryVersion(
  channel: Channel,
  fetchFn: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<RegistryResult> {
  const result = await registryAttempt(channel, fetchFn);
  const error = result.error;
  if (error && (error.code === "network" || error.code === "timeout"
    || (error.code === "http" && (error.status ?? 0) >= 500))) {
    await wait(250);
    return registryAttempt(channel, fetchFn);
  }
  return result;
}

export async function registryVersion(channel: Channel, fetchFn: typeof fetch = fetch): Promise<string | null> {
  return (await checkRegistryVersion(channel, fetchFn)).version;
}

/** Shared by phone and dashboard: no npm subprocess or blocking network check. */
export function checkRemoteUpdate(channel: Channel, force = false): Promise<RemoteUpdateCheck> {
  const flight = flights.get(channel);
  if (flight) return flight;
  const cached = cache.get(channel);
  const ttl = cached?.value.latestVersion ? (force ? 5_000 : 5 * 60_000) : (force ? 0 : 30_000);
  if (cached && Date.now() - cached.at < ttl) return Promise.resolve(cached.value);
  const pending = (async () => {
    const registry = await checkRegistryVersion(channel);
    const latest = registry.version;
    const check = checkForUpdate(channel, {
      currentVersion: () => runningVersion,
      detectInstall: () => runningInstaller,
      latestVersion: () => latest,
    });
    // Source builds may display the published version, but must never replace another install.
    const [releaseNotes, releaseInfo] = latest ? await Promise.all([
      fetchReleaseNotesForVersion(latest), fetchUpdateReleaseInfo(latest, runningVersion),
    ]) : [null, { urgency: "normal" as const, message: "" }];
    const value = {
      ...check, latestVersion: latest, updateAvailable: !!latest && isNewer(latest, runningVersion, channel), checkedAt: new Date().toISOString(),
      releaseNotes, releaseInfo,
      ...(registry.error ? { registryError: registry.error } : {}),
    };
    cache.set(channel, { value, at: Date.now() });
    return value;
  })().finally(() => flights.delete(channel));
  flights.set(channel, pending);
  return pending;
}
