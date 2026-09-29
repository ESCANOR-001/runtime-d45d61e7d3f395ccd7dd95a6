import { createHash } from "node:crypto";
import { ANDROID_TUNNEL_ORIGIN, DEFAULT_ANDROID_GATEWAY_PORT } from "./ports";
import { normalizeNamedTunnelHostname, validateCloudflareTunnelToken } from "./cloudflare-tunnel";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4/";
const CLOUDFLARE_API_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const PAGE_SIZE = 50;
const MAX_PAGES = 4;

export type CloudflareZoneStatus = "active" | "pending" | "initializing" | "moved" | "deactivated" | "unknown";

export type CloudflareAccountDTO = {
  id: string;
  name: string;
};

export type CloudflareZoneDTO = {
  id: string;
  name: string;
  accountId: string;
  accountName: string;
  status: CloudflareZoneStatus;
  nameServers: string[];
};

export type CloudflareDiscoveryDTO = {
  version: 1;
  accounts: CloudflareAccountDTO[];
  zones: CloudflareZoneDTO[];
};

export type CloudflareProvisioningInput = {
  apiToken: string;
  accountId: string;
  zoneId: string;
  hostname: string;
  gatewayPort?: number;
};

export type CloudflareProvisioningResult = {
  hostname: string;
  connectorToken: string;
  tunnelCreated: boolean;
  dnsCreated: boolean;
};

export type CloudflareProvisioningErrorCode =
  | "invalid_input"
  | "authorization_failed"
  | "permission_missing"
  | "zone_not_found"
  | "zone_not_active"
  | "hostname_outside_zone"
  | "hostname_conflict"
  | "tunnel_conflict"
  | "too_many_results"
  | "rate_limited"
  | "cloudflare_unavailable"
  | "invalid_response";

const SAFE_ERROR_MESSAGES: Record<CloudflareProvisioningErrorCode, string> = {
  invalid_input: "Enter a valid scoped Cloudflare API token and connection details.",
  authorization_failed: "Cloudflare rejected this API token.",
  permission_missing: "The API token needs Cloudflare Tunnel Edit and DNS Edit permissions for the selected domain.",
  zone_not_found: "The selected Cloudflare domain is no longer available to this token.",
  zone_not_active: "This domain is not active on Cloudflare yet. Finish the nameserver change, then try again.",
  hostname_outside_zone: "Choose one subdomain inside the selected Cloudflare domain.",
  hostname_conflict: "That hostname already has a DNS record. Remodex did not replace it.",
  tunnel_conflict: "An existing tunnel prevents safe automatic setup. Remove the conflicting tunnel or use Advanced manual setup.",
  too_many_results: "This token can access too many domains. Create a token scoped to the domain you want to use.",
  rate_limited: "Cloudflare rate-limited this request. Wait briefly, then try again.",
  cloudflare_unavailable: "Cloudflare could not complete the request. Try again.",
  invalid_response: "Cloudflare returned an unexpected response. Try again.",
};

export class CloudflareProvisioningError extends Error {
  constructor(readonly code: CloudflareProvisioningErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "CloudflareProvisioningError";
  }
}

export interface AndroidRemoteCloudflareProvisioner {
  discover(apiToken: string): Promise<CloudflareDiscoveryDTO>;
  provision(input: CloudflareProvisioningInput): Promise<CloudflareProvisioningResult>;
}

export type AndroidRemoteCloudflareProvisionerDeps = {
  fetch: typeof fetch;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function cloudflareId(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{32}$/iu.test(value) ? value.toLowerCase() : null;
}

function cloudflareTunnelId(value: unknown): string | null {
  return typeof value === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)
    ? value.toLowerCase()
    : null;
}

export function validateCloudflareApiToken(value: string): string {
  const token = value.trim();
  if (token.length < 20 || token.length > 1_024 || /\s/u.test(token)) {
    throw new CloudflareProvisioningError("invalid_input");
  }
  return token;
}

function zoneStatus(value: unknown): CloudflareZoneStatus {
  if (value === "active" || value === "pending" || value === "initializing"
    || value === "moved" || value === "deactivated") return value;
  return "unknown";
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new CloudflareProvisioningError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CloudflareProvisioningError("invalid_response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined)) as unknown;
  } catch {
    throw new CloudflareProvisioningError("invalid_response");
  } finally {
    joined.fill(0);
  }
}

function envelopeResult(value: unknown): unknown {
  const envelope = record(value);
  if (!envelope || envelope.success !== true || !("result" in envelope)) {
    throw new CloudflareProvisioningError("invalid_response");
  }
  return envelope.result;
}

function envelopeTotalPages(value: unknown): number {
  const info = record(record(value)?.result_info);
  const pages = info?.total_pages;
  return typeof pages === "number" && Number.isInteger(pages) && pages > 0 ? pages : 1;
}

function mapHttpFailure(status: number): CloudflareProvisioningError {
  if (status === 401) return new CloudflareProvisioningError("authorization_failed");
  if (status === 403) return new CloudflareProvisioningError("permission_missing");
  if (status === 404) return new CloudflareProvisioningError("zone_not_found");
  if (status === 409) return new CloudflareProvisioningError("hostname_conflict");
  if (status === 429) return new CloudflareProvisioningError("rate_limited");
  return new CloudflareProvisioningError("cloudflare_unavailable");
}

function expectedIngress(hostname: string): JsonRecord[] {
  return [
    { hostname, service: ANDROID_TUNNEL_ORIGIN, originRequest: {} },
    { service: "http_status:404" },
  ];
}

function isExpectedIngress(value: unknown, hostname: string): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const route = record(value[0]);
  const fallback = record(value[1]);
  if (!route || !fallback) return false;
  const originRequest = route.originRequest;
  return route.hostname === hostname
    && route.service === ANDROID_TUNNEL_ORIGIN
    && (originRequest === undefined || (record(originRequest) !== null && Object.keys(record(originRequest)!).length === 0))
    && Object.keys(route).every(key => key === "hostname" || key === "service" || key === "originRequest")
    && fallback.service === "http_status:404"
    && Object.keys(fallback).length === 1;
}

function automaticTunnelName(hostname: string): string {
  const digest = createHash("sha256").update(hostname).digest("hex").slice(0, 20);
  return `opencodex-android-v1-${digest}`;
}

function normalizeProvisionedHostname(hostnameInput: string, zoneNameInput: string): string {
  const hostname = normalizeNamedTunnelHostname(hostnameInput);
  const zoneName = normalizeNamedTunnelHostname(zoneNameInput);
  if (!hostname.endsWith(`.${zoneName}`)) {
    throw new CloudflareProvisioningError("hostname_outside_zone");
  }
  const subdomain = hostname.slice(0, -(zoneName.length + 1));
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(subdomain)) {
    throw new CloudflareProvisioningError("hostname_outside_zone");
  }
  return hostname;
}

export class ManagedAndroidRemoteCloudflareProvisioner implements AndroidRemoteCloudflareProvisioner {
  constructor(private readonly deps: AndroidRemoteCloudflareProvisionerDeps = { fetch }) {}

  private async request(apiToken: string, path: string, init: RequestInit = {}): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new CloudflareProvisioningError("invalid_input");
    }
    const url = new URL(path.slice(1), CLOUDFLARE_API_BASE);
    let response: Response;
    try {
      response = await this.deps.fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(CLOUDFLARE_API_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch {
      throw new CloudflareProvisioningError("cloudflare_unavailable");
    }
    const body = await readBoundedJson(response);
    if (!response.ok) throw mapHttpFailure(response.status);
    return body;
  }

  private async verifyToken(apiToken: string): Promise<void> {
    const body = await this.request(apiToken, "/user/tokens/verify");
    const result = record(envelopeResult(body));
    if (!result || result.status !== "active") {
      throw new CloudflareProvisioningError("authorization_failed");
    }
  }

  async discover(apiTokenInput: string): Promise<CloudflareDiscoveryDTO> {
    const apiToken = validateCloudflareApiToken(apiTokenInput);
    await this.verifyToken(apiToken);
    const zones: CloudflareZoneDTO[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await this.request(apiToken, `/zones?per_page=${PAGE_SIZE}&page=${page}`);
      const result = envelopeResult(body);
      if (!Array.isArray(result)) throw new CloudflareProvisioningError("invalid_response");
      for (const value of result) {
        const row = record(value);
        const account = record(row?.account);
        const id = cloudflareId(row?.id);
        const name = boundedString(row?.name, 253);
        const accountId = cloudflareId(account?.id);
        const accountName = boundedString(account?.name, 128);
        if (!id || !name || !accountId || !accountName) {
          throw new CloudflareProvisioningError("invalid_response");
        }
        const rawNameServers = Array.isArray(row?.name_servers) ? row.name_servers : [];
        const nameServers = rawNameServers
          .map(value => boundedString(value, 253))
          .filter((value): value is string => Boolean(value))
          .slice(0, 8);
        zones.push({
          id,
          name: name.toLowerCase(),
          accountId,
          accountName,
          status: zoneStatus(row?.status),
          nameServers,
        });
      }
      const totalPages = envelopeTotalPages(body);
      if (totalPages > MAX_PAGES) throw new CloudflareProvisioningError("too_many_results");
      if (page >= totalPages) break;
    }
    const accountsById = new Map<string, CloudflareAccountDTO>();
    for (const zone of zones) accountsById.set(zone.accountId, { id: zone.accountId, name: zone.accountName });
    return {
      version: 1,
      accounts: [...accountsById.values()].sort((left, right) => left.name.localeCompare(right.name)),
      zones: zones.sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async provision(input: CloudflareProvisioningInput): Promise<CloudflareProvisioningResult> {
    const gatewayPort = input.gatewayPort ?? DEFAULT_ANDROID_GATEWAY_PORT;
    if (gatewayPort !== DEFAULT_ANDROID_GATEWAY_PORT) {
      throw new CloudflareProvisioningError("invalid_input");
    }
    const apiToken = validateCloudflareApiToken(input.apiToken);
    const accountId = cloudflareId(input.accountId);
    const zoneId = cloudflareId(input.zoneId);
    if (!accountId || !zoneId) throw new CloudflareProvisioningError("invalid_input");
    await this.verifyToken(apiToken);

    const zoneBody = await this.request(apiToken, `/zones/${zoneId}`);
    const zone = record(envelopeResult(zoneBody));
    const zoneAccount = record(zone?.account);
    const zoneName = boundedString(zone?.name, 253);
    if (!zoneName || cloudflareId(zone?.id) !== zoneId || cloudflareId(zoneAccount?.id) !== accountId) {
      throw new CloudflareProvisioningError("zone_not_found");
    }
    if (zone?.status !== "active") throw new CloudflareProvisioningError("zone_not_active");
    const hostname = normalizeProvisionedHostname(input.hostname, zoneName);
    const tunnelName = automaticTunnelName(hostname);
    const tunnelTarget = (tunnelId: string) => `${tunnelId}.cfargotunnel.com`;
    let tunnelId: string | null = null;
    let createdTunnel = false;
    let createdDnsId: string | null = null;

    try {
      const tunnelsBody = await this.request(
        apiToken,
        `/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(tunnelName)}&per_page=100`,
      );
      const tunnelRows = envelopeResult(tunnelsBody);
      if (!Array.isArray(tunnelRows)) throw new CloudflareProvisioningError("invalid_response");
      const exactTunnels = tunnelRows.filter(value => record(value)?.name === tunnelName);
      if (exactTunnels.length > 1) throw new CloudflareProvisioningError("tunnel_conflict");
      if (exactTunnels.length === 1) {
        const tunnel = record(exactTunnels[0]);
        tunnelId = cloudflareTunnelId(tunnel?.id);
        if (!tunnelId || tunnel?.tun_type !== "cfd_tunnel" || tunnel?.remote_config !== true) {
          throw new CloudflareProvisioningError("tunnel_conflict");
        }
        const configurationBody = await this.request(
          apiToken,
          `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
        );
        const configuration = record(envelopeResult(configurationBody));
        if (!isExpectedIngress(record(configuration?.config)?.ingress, hostname)) {
          throw new CloudflareProvisioningError("tunnel_conflict");
        }
      } else {
        const createdBody = await this.request(apiToken, `/accounts/${accountId}/cfd_tunnel`, {
          method: "POST",
          body: JSON.stringify({ name: tunnelName, config_src: "cloudflare" }),
        });
        const created = record(envelopeResult(createdBody));
        tunnelId = cloudflareTunnelId(created?.id);
        if (!tunnelId) throw new CloudflareProvisioningError("invalid_response");
        createdTunnel = true;
        await this.request(apiToken, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
          method: "PUT",
          body: JSON.stringify({ config: { ingress: expectedIngress(hostname) } }),
        });
      }

      const dnsBody = await this.request(
        apiToken,
        `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
      );
      const dnsRows = envelopeResult(dnsBody);
      if (!Array.isArray(dnsRows)) throw new CloudflareProvisioningError("invalid_response");
      if (dnsRows.length > 1) throw new CloudflareProvisioningError("hostname_conflict");
      const target = tunnelTarget(tunnelId);
      if (dnsRows.length === 1) {
        const dns = record(dnsRows[0]);
        if (dns?.type !== "CNAME" || dns.name !== hostname || dns.content !== target || dns.proxied !== true) {
          throw new CloudflareProvisioningError("hostname_conflict");
        }
      } else {
        const createdDnsBody = await this.request(apiToken, `/zones/${zoneId}/dns_records`, {
          method: "POST",
          body: JSON.stringify({ type: "CNAME", proxied: true, name: hostname, content: target }),
        });
        const createdDns = record(envelopeResult(createdDnsBody));
        createdDnsId = cloudflareId(createdDns?.id);
        if (!createdDnsId) throw new CloudflareProvisioningError("invalid_response");
      }

      const tokenBody = await this.request(apiToken, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
      const tokenResult = envelopeResult(tokenBody);
      const connectorToken = validateCloudflareTunnelToken(typeof tokenResult === "string" ? tokenResult : "");
      const verifyBody = await this.request(apiToken, `/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
      const verifiedTunnel = record(envelopeResult(verifyBody));
      if (cloudflareTunnelId(verifiedTunnel?.id) !== tunnelId || verifiedTunnel?.tun_type !== "cfd_tunnel") {
        throw new CloudflareProvisioningError("invalid_response");
      }
      return { hostname, connectorToken, tunnelCreated: createdTunnel, dnsCreated: createdDnsId !== null };
    } catch (error) {
      if (createdDnsId) {
        await this.request(apiToken, `/zones/${zoneId}/dns_records/${createdDnsId}`, { method: "DELETE" }).catch(() => undefined);
      }
      if (createdTunnel && tunnelId) {
        await this.request(apiToken, `/accounts/${accountId}/cfd_tunnel/${tunnelId}`, { method: "DELETE" }).catch(() => undefined);
      }
      if (error instanceof CloudflareProvisioningError || error instanceof TypeError) throw error;
      throw new CloudflareProvisioningError("cloudflare_unavailable");
    }
  }
}
