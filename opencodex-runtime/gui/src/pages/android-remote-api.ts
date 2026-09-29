import { readJsonOrThrow } from "../fetch-json";

export type AndroidRemoteClient = {
  id: string;
  label: string;
  deviceType: "mobile";
  os: string;
  address?: string;
  scopes: string[];
  createdAt: string;
  lastSeenAt?: string;
  online: boolean;
};

export type AndroidRemoteStatus = {
  version: 1;
  controlEnabled: boolean;
  keepAwake: boolean;
  localNetworkEnabled?: boolean;
  connectionChoice?: "local" | "quick" | "named";
  pairingAvailable: boolean;
  gateway: {
    status: "stopped" | "starting" | "ready" | "error";
    backgroundServer: "current-process";
    port: number;
    error?: string;
  };
  reachableAddresses: string[];
  tunnel: {
    configuration: {
      mode: "quick" | "named";
      namedHostname?: string;
      hasNamedTunnelToken: boolean;
    };
    runtime: {
      mode: "quick" | "named";
      status: "stopped" | "starting" | "checking" | "ready" | "error";
      publicUrl: string | null;
      error: "cloudflared_unavailable" | "named_tunnel_incomplete" | "tunnel_failed" | "verification_failed" | null;
      phase?: "activating" | "connecting" | "reconnecting";
    };
  };
  desktop: {
    id: "desktop";
    label: string;
    platform: string;
    address: string;
    online: true;
  };
  clients: AndroidRemoteClient[];
};

export type AndroidRemotePairing = {
  version: 1;
  id: string;
  expiresAt: string;
  qrPayload: string;
};

export type AndroidRemoteCloudflareAccount = {
  id: string;
  name: string;
};

export type AndroidRemoteCloudflareZone = {
  id: string;
  name: string;
  accountId: string;
  accountName: string;
  status: "active" | "pending" | "initializing" | "moved" | "deactivated" | "unknown";
  nameServers: string[];
};

export type AndroidRemoteCloudflareDiscovery = {
  version: 1;
  accounts: AndroidRemoteCloudflareAccount[];
  zones: AndroidRemoteCloudflareZone[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isClient(value: unknown): value is AndroidRemoteClient {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.label === "string"
    && value.deviceType === "mobile"
    && typeof value.os === "string"
    && isOptionalString(value.address)
    && Array.isArray(value.scopes)
    && value.scopes.every(scope => typeof scope === "string")
    && typeof value.createdAt === "string"
    && isOptionalString(value.lastSeenAt)
    && typeof value.online === "boolean";
}

function isTunnel(value: unknown): value is AndroidRemoteStatus["tunnel"] {
  if (!isRecord(value) || !isRecord(value.configuration) || !isRecord(value.runtime)) return false;
  return ["quick", "named"].includes(String(value.configuration.mode))
    && isOptionalString(value.configuration.namedHostname)
    && typeof value.configuration.hasNamedTunnelToken === "boolean"
    && ["quick", "named"].includes(String(value.runtime.mode))
    && ["stopped", "starting", "checking", "ready", "error"].includes(String(value.runtime.status))
    && (value.runtime.publicUrl === null || typeof value.runtime.publicUrl === "string")
    && (value.runtime.phase === undefined || ["activating", "connecting", "reconnecting"].includes(String(value.runtime.phase)))
    && (value.runtime.error === null || [
      "cloudflared_unavailable",
      "named_tunnel_incomplete",
      "tunnel_failed",
      "verification_failed",
    ].includes(String(value.runtime.error)));
}

function isStatus(value: unknown): value is AndroidRemoteStatus {
  if (!isRecord(value) || !isRecord(value.gateway) || !isRecord(value.desktop)) return false;
  return value.version === 1
    && typeof value.controlEnabled === "boolean"
    && typeof value.keepAwake === "boolean"
    && (value.connectionChoice === undefined || value.connectionChoice === "local" || value.connectionChoice === "quick" || value.connectionChoice === "named")
    && typeof value.pairingAvailable === "boolean"
    && ["stopped", "starting", "ready", "error"].includes(String(value.gateway.status))
    && value.gateway.backgroundServer === "current-process"
    && typeof value.gateway.port === "number"
    && Number.isInteger(value.gateway.port)
    && isOptionalString(value.gateway.error)
    && Array.isArray(value.reachableAddresses)
    && value.reachableAddresses.every(address => typeof address === "string")
    && isTunnel(value.tunnel)
    && value.desktop.id === "desktop"
    && typeof value.desktop.label === "string"
    && typeof value.desktop.platform === "string"
    && typeof value.desktop.address === "string"
    && value.desktop.online === true
    && Array.isArray(value.clients)
    && value.clients.every(isClient);
}

function isPairing(value: unknown): value is AndroidRemotePairing {
  return isRecord(value)
    && value.version === 1
    && typeof value.id === "string"
    && typeof value.expiresAt === "string"
    && Number.isFinite(Date.parse(value.expiresAt))
    && typeof value.qrPayload === "string"
    && value.qrPayload.length > 0;
}

function isCloudflareAccount(value: unknown): value is AndroidRemoteCloudflareAccount {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
}

function isCloudflareZone(value: unknown): value is AndroidRemoteCloudflareZone {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.accountId === "string"
    && typeof value.accountName === "string"
    && ["active", "pending", "initializing", "moved", "deactivated", "unknown"].includes(String(value.status))
    && Array.isArray(value.nameServers)
    && value.nameServers.every(nameServer => typeof nameServer === "string");
}

function isCloudflareDiscovery(value: unknown): value is AndroidRemoteCloudflareDiscovery {
  return isRecord(value)
    && value.version === 1
    && Array.isArray(value.accounts)
    && value.accounts.every(isCloudflareAccount)
    && Array.isArray(value.zones)
    && value.zones.every(isCloudflareZone);
}

async function readStatus(response: Response): Promise<AndroidRemoteStatus> {
  const body = await readJsonOrThrow<unknown>(response);
  if (!isStatus(body)) throw new Error("invalid Android Remote response");
  return body;
}

export function androidRemoteResourceKey(apiBase: string): string {
  return `android-remote:${apiBase}`;
}

export async function loadAndroidRemoteStatus(apiBase: string, signal?: AbortSignal): Promise<AndroidRemoteStatus> {
  return readStatus(await fetch(`${apiBase}/api/android-remote`, { signal }));
}

export async function updateAndroidRemoteSettings(
  apiBase: string,
  patch: Partial<Pick<AndroidRemoteStatus, "controlEnabled" | "keepAwake" | "localNetworkEnabled" | "connectionChoice">>,
): Promise<AndroidRemoteStatus> {
  return readStatus(await fetch(`${apiBase}/api/android-remote/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(30_000),
  }));
}

export async function updateAndroidRemoteTunnel(
  apiBase: string,
  input: { mode: "quick" } | { mode: "named"; hostname: string; token?: string },
): Promise<AndroidRemoteStatus> {
  return readStatus(await fetch(`${apiBase}/api/android-remote/tunnel`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function discoverAndroidRemoteCloudflare(
  apiBase: string,
  apiToken: string,
): Promise<AndroidRemoteCloudflareDiscovery> {
  const response = await fetch(`${apiBase}/api/android-remote/cloudflare/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiToken }),
  });
  const body = await readJsonOrThrow<unknown>(response);
  if (!isCloudflareDiscovery(body)) throw new Error("invalid Cloudflare discovery response");
  return body;
}

export async function provisionAndroidRemoteCloudflare(
  apiBase: string,
  input: { apiToken: string; accountId: string; zoneId: string; hostname: string },
): Promise<AndroidRemoteStatus> {
  return readStatus(await fetch(`${apiBase}/api/android-remote/cloudflare/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function retryAndroidRemoteTunnel(apiBase: string): Promise<AndroidRemoteStatus> {
  return readStatus(await fetch(`${apiBase}/api/android-remote/tunnel/retry`, { method: "POST" }));
}

export async function checkAndroidRemoteTunnel(apiBase: string): Promise<AndroidRemoteStatus> {
  return readStatus(await fetch(`${apiBase}/api/android-remote/tunnel/check`, { method: "POST" }));
}

export async function removeAndroidRemoteTunnelToken(apiBase: string): Promise<AndroidRemoteStatus> {
  return readStatus(await fetch(`${apiBase}/api/android-remote/tunnel/token`, { method: "DELETE" }));
}

export async function disconnectAndroidRemoteDomain(apiBase: string): Promise<AndroidRemoteStatus> {
  return readStatus(await fetch(`${apiBase}/api/android-remote/tunnel/domain`, { method: "DELETE" }));
}

export async function revokeAndroidRemoteClient(apiBase: string, id: string): Promise<AndroidRemoteStatus> {
  return readStatus(await fetch(`${apiBase}/api/android-remote/clients/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }));
}

export async function createAndroidRemotePairing(apiBase: string, signal?: AbortSignal, replaceClientId?: string): Promise<AndroidRemotePairing> {
  const query = replaceClientId ? `?replaceClientId=${encodeURIComponent(replaceClientId)}` : "";
  const response = await fetch(`${apiBase}/api/android-remote/pairing${query}`, { method: "POST", signal });
  const body = await readJsonOrThrow<unknown>(response);
  if (!isPairing(body)) throw new Error("invalid Android Remote pairing response");
  return body;
}
