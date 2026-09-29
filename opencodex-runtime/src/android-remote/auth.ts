import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isAndroidRemoteLocalUrl } from "./local-network";
import { DEFAULT_ANDROID_GATEWAY_PORT } from "./ports";
import type {
  AndroidRemoteState,
  AndroidRemoteStore,
  AndroidRemoteStoredClient,
} from "./store";

const PAIRING_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const WEBSOCKET_TICKET_TTL_MS = 30 * 1000;
const CLIENT_TOUCH_INTERVAL_MS = 60 * 1000;

export const ANDROID_REMOTE_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
] as const;

export type AndroidRemoteClientMetadata = {
  label?: string;
  deviceType?: string;
  os?: string;
  installationId?: string;
};

export type AndroidRemotePairingPayload = {
  type: "remodex-mobile-pairing";
  version: 1;
  desktopName: string;
  localUrls: string[];
  cloudflareUrl: string | null;
  directUrl: string;
  pairingToken: string;
  pairingLinkId: string;
  expiresAt: string;
};

export type AndroidRemotePairingInvitation = {
  id: string;
  expiresAt: string;
  payload: AndroidRemotePairingPayload;
  qrPayload: string;
};

type StoredInvitation = {
  id: string;
  tokenDigest: string;
  expiresAtMs: number;
  replaceClientId?: string;
};

type StoredTicket = {
  clientId: string;
  expiresAtMs: number;
};

export type AuthenticatedAndroidClient = {
  client: AndroidRemoteStoredClient;
  state: AndroidRemoteState;
};

function token(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export function digestAndroidRemoteCredential(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function installationDigest(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 160) return undefined;
  return digestAndroidRemoteCredential(`remodex-installation-v1:${normalized}`);
}

function equalDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  } catch {
    return false;
  }
}

function cleanLabel(value: string | undefined): string {
  const trimmed = value?.trim().slice(0, 160);
  return trimmed || "Android phone";
}

function cleanOs(value: string | undefined): string {
  const trimmed = value?.trim().slice(0, 64);
  return trimmed || "android";
}

function safeRemoteAddress(value: string | undefined): string | undefined {
  const trimmed = value?.trim().slice(0, 256);
  return trimmed || undefined;
}

export class AndroidRemoteAuth {
  private readonly invitations = new Map<string, StoredInvitation>();
  private readonly websocketTickets = new Map<string, StoredTicket>();
  private readonly lastTouchedAt = new Map<string, number>();

  constructor(
    private readonly store: AndroidRemoteStore,
    private readonly now: () => number = Date.now,
  ) {}

  createInvitation(input: {
    desktopName: string;
    localUrls: string[];
    cloudflareUrl?: string | null;
    replaceClientId?: string;
  }): AndroidRemotePairingInvitation {
    this.pruneExpired();
    if (input.replaceClientId && !this.store.read().clients.some(client => client.id === input.replaceClientId)) {
      throw new TypeError("The phone authorization no longer exists");
    }
    const id = randomUUID();
    const rawToken = token("ocx_pair_");
    const expiresAtMs = this.now() + PAIRING_TTL_MS;
    const expiresAt = new Date(expiresAtMs).toISOString();
    this.invitations.set(id, {
      id,
      tokenDigest: digestAndroidRemoteCredential(rawToken),
      expiresAtMs,
      ...(input.replaceClientId ? { replaceClientId: input.replaceClientId } : {}),
    });
    const cloudflareUrl = input.cloudflareUrl?.trim() || null;
    const directUrl = input.localUrls.find(isAndroidRemoteLocalUrl) ?? cloudflareUrl ?? input.localUrls[0] ?? `http://127.0.0.1:${DEFAULT_ANDROID_GATEWAY_PORT}`;
    const payload: AndroidRemotePairingPayload = {
      type: "remodex-mobile-pairing",
      version: 1,
      desktopName: input.desktopName.trim() || "Remodex Desktop",
      localUrls: [...new Set(input.localUrls)],
      cloudflareUrl,
      directUrl,
      pairingToken: rawToken,
      pairingLinkId: id,
      expiresAt,
    };
    return { id, expiresAt, payload, qrPayload: JSON.stringify(payload) };
  }

  exchangePairingToken(input: {
    pairingToken: string;
    metadata: AndroidRemoteClientMetadata;
    address?: string;
  }): { accessToken: string; expiresAt: string; client: AndroidRemoteStoredClient; replacedClientIds: string[] } | null {
    this.pruneExpired();
    const presentedDigest = digestAndroidRemoteCredential(input.pairingToken);
    const invitation = [...this.invitations.values()].find(row =>
      row.expiresAtMs > this.now() && equalDigest(row.tokenDigest, presentedDigest));
    if (!invitation) return null;
    const clients = this.store.read().clients;
    if (invitation.replaceClientId && !clients.some(client => client.id === invitation.replaceClientId)) return null;
    const digest = installationDigest(input.metadata.installationId);
    const replacedClientIds = clients.filter(client => client.id === invitation.replaceClientId
      || (digest && client.installationDigest === digest)).map(client => client.id);
    const accessToken = token("ocx_android_");
    const createdAtMs = this.now();
    const expiresAt = new Date(createdAtMs + ACCESS_TOKEN_TTL_MS).toISOString();
    const client: AndroidRemoteStoredClient = {
      id: randomUUID(),
      label: cleanLabel(input.metadata.label),
      deviceType: "mobile",
      os: cleanOs(input.metadata.os),
      scopes: [...ANDROID_REMOTE_SCOPES],
      createdAt: new Date(createdAtMs).toISOString(),
      lastSeenAt: new Date(createdAtMs).toISOString(),
      credentialExpiresAt: expiresAt,
      credentialDigest: digestAndroidRemoteCredential(accessToken),
      ...(digest ? { installationDigest: digest } : {}),
      ...(safeRemoteAddress(input.address) ? { address: safeRemoteAddress(input.address) } : {}),
    };
    this.store.upsertClient(client, replacedClientIds);
    // A failed disk write must not consume the only way to pair this phone.
    this.invitations.delete(invitation.id);
    for (const clientId of replacedClientIds) this.revokeClient(clientId);
    return { accessToken, expiresAt, client, replacedClientIds };
  }

  authenticateAccessToken(rawToken: string, address?: string): AuthenticatedAndroidClient | null {
    if (!rawToken.startsWith("ocx_android_")) return null;
    const digest = digestAndroidRemoteCredential(rawToken);
    const state = this.store.read();
    const now = this.now();
    const client = state.clients.find(row => equalDigest(row.credentialDigest, digest));
    if (!client) return null;
    const expiresAtMs = client.credentialExpiresAt ? Date.parse(client.credentialExpiresAt) : NaN;
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= now) return null;
    const previousTouch = this.lastTouchedAt.get(client.id) ?? 0;
    if (now - previousTouch >= CLIENT_TOUCH_INTERVAL_MS) {
      this.lastTouchedAt.set(client.id, now);
      const next = this.store.touchClient(client.id, {
        lastSeenAt: new Date(now).toISOString(),
        ...(safeRemoteAddress(address) ? { address: safeRemoteAddress(address) } : {}),
      });
      return { client: next.clients.find(row => row.id === client.id) ?? client, state: next };
    }
    return { client, state };
  }

  issueWebSocketTicket(clientId: string): { ticket: string; expiresAt: string } {
    this.pruneExpired();
    const ticket = token("ocx_ws_", 24);
    const expiresAtMs = this.now() + WEBSOCKET_TICKET_TTL_MS;
    this.websocketTickets.set(digestAndroidRemoteCredential(ticket), { clientId, expiresAtMs });
    return { ticket, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  updateClientMetadata(
    clientId: string,
    metadata: AndroidRemoteClientMetadata,
  ): AndroidRemoteStoredClient | null {
    const existing = this.store.read().clients.find(client => client.id === clientId);
    const digest = existing?.installationDigest ?? installationDigest(metadata.installationId);
    const state = this.store.updateClientMetadata(clientId, {
      ...(metadata.label ? { label: cleanLabel(metadata.label) } : {}),
      ...(metadata.os ? { os: cleanOs(metadata.os) } : {}),
      ...(digest ? { installationDigest: digest } : {}),
    });
    return state.clients.find(client => client.id === clientId) ?? null;
  }

  consumeWebSocketTicket(ticket: string): AndroidRemoteStoredClient | null {
    this.pruneExpired();
    const digest = digestAndroidRemoteCredential(ticket);
    const stored = this.websocketTickets.get(digest);
    if (!stored || stored.expiresAtMs <= this.now()) return null;
    this.websocketTickets.delete(digest);
    return this.store.read().clients.find(client => client.id === stored.clientId) ?? null;
  }

  revokeClient(clientId: string): void {
    for (const [id, invitation] of this.invitations) {
      if (invitation.replaceClientId === clientId) this.invitations.delete(id);
    }
    for (const [digest, ticket] of this.websocketTickets) {
      if (ticket.clientId === clientId) this.websocketTickets.delete(digest);
    }
    this.lastTouchedAt.delete(clientId);
  }

  hasInvitation(id: string): boolean {
    this.pruneExpired();
    return this.invitations.has(id);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [id, invitation] of this.invitations) {
      if (invitation.expiresAtMs <= now) this.invitations.delete(id);
    }
    for (const [digest, ticket] of this.websocketTickets) {
      if (ticket.expiresAtMs <= now) this.websocketTickets.delete(digest);
    }
  }
}
