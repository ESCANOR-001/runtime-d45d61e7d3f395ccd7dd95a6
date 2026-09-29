import { isAndroidRemoteLocalUrl } from "../../android-remote/local-network";
import { DEFAULT_ANDROID_GATEWAY_PORT } from "../../android-remote/ports";
import { networkInterfaces, hostname as readHostname } from "node:os";
import {
  createAndroidRemoteStore,
  type AndroidRemoteState,
  type AndroidRemoteStore,
} from "../../android-remote/store";
import {
  androidRemotePairingUrls,
  type AndroidRemoteGatewayController,
  type AndroidRemoteGatewayLifecycleStatus,
} from "../../android-remote/gateway";
import type {
  AndroidRemoteCloudflareFailure,
  AndroidRemoteCloudflareState,
} from "../../android-remote/cloudflare-tunnel";
import {
  CloudflareProvisioningError,
  ManagedAndroidRemoteCloudflareProvisioner,
  type AndroidRemoteCloudflareProvisioner,
} from "../../android-remote/cloudflare-provisioning";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBodyOr } from "./body";
import type { ManagementContext } from "./context";
import { isPlainRecord } from "./shared";

export type AndroidRemoteClientDTO = {
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

export type AndroidRemoteStatusDTO = {
  version: 1;
  controlEnabled: boolean;
  keepAwake: boolean;
  localNetworkEnabled: boolean;
  connectionChoice: "local" | "quick" | "named";
  pairingAvailable: boolean;
  gateway: {
    status: AndroidRemoteGatewayLifecycleStatus;
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
      status: AndroidRemoteCloudflareState["status"];
      publicUrl: string | null;
      error: AndroidRemoteCloudflareFailure | null;
      phase?: NonNullable<AndroidRemoteCloudflareState["phase"]>;
    };
  };
  desktop: {
    id: "desktop";
    label: string;
    platform: NodeJS.Platform;
    address: string;
    online: true;
  };
  clients: AndroidRemoteClientDTO[];
};

export type AndroidRemotePairingDTO = {
  version: 1;
  id: string;
  expiresAt: string;
  qrPayload: string;
};

export function androidRemoteReachableAddresses(
  port = DEFAULT_ANDROID_GATEWAY_PORT,
  interfaces = networkInterfaces(),
): string[] {
  return androidRemotePairingUrls(port, interfaces);
}

function routeController(ctx: ManagementContext): AndroidRemoteGatewayController | undefined {
  return ctx.deps.androidRemoteController;
}

function routeCloudflareProvisioner(ctx: ManagementContext): AndroidRemoteCloudflareProvisioner {
  return ctx.deps.androidRemoteCloudflareProvisioner ?? new ManagedAndroidRemoteCloudflareProvisioner();
}

function cloudflareProvisioningError(error: unknown): { status: number; body: { error: string; code: string } } {
  if (error instanceof CloudflareProvisioningError) {
    const status = error.code === "invalid_input" || error.code === "hostname_outside_zone"
      ? 400
      : error.code === "authorization_failed" || error.code === "permission_missing"
      ? 403
      : error.code === "zone_not_found"
        ? 404
        : error.code === "rate_limited"
          ? 429
          : error.code === "cloudflare_unavailable" || error.code === "invalid_response"
            ? 502
            : 409;
    return { status, body: { error: error.message, code: error.code } };
  }
  if (error instanceof TypeError) {
    return { status: 400, body: { error: error.message, code: "invalid_input" } };
  }
  return {
    status: 502,
    body: { error: "Cloudflare could not complete the request. Try again.", code: "cloudflare_unavailable" },
  };
}

function pairingConnectionReady(
  state: AndroidRemoteState,
  gateway: { status: AndroidRemoteGatewayLifecycleStatus },
  tunnel: AndroidRemoteCloudflareState,
  localUrls: readonly string[] = [],
): boolean {
  return state.settings.controlEnabled
    && gateway.status === "ready"
    && ((state.settings.localNetworkEnabled === true && localUrls.some(isAndroidRemoteLocalUrl))
    || (tunnel.mode === state.settings.tunnelMode
    && tunnel.status === "ready"
    && tunnel.error === null
    && typeof tunnel.publicUrl === "string"
    && tunnel.publicUrl.startsWith("https://")));
}

async function statusDTO(
  ctx: ManagementContext,
  state: AndroidRemoteState,
): Promise<AndroidRemoteStatusDTO> {
  const controller = routeController(ctx);
  const gateway = controller?.status() ?? {
    status: "stopped" as const,
    port: DEFAULT_ANDROID_GATEWAY_PORT,
    backgroundServer: "current-process" as const,
  };
  const pairingAddresses = (controller?.pairingUrls() ?? []).filter(isAndroidRemoteLocalUrl);
  const reachableAddresses = controller
    ? pairingAddresses
    : [];
  const onlineClientIds = controller?.onlineClientIds() ?? new Set<string>();
  const configuration = controller
    ? await controller.cloudflareConfiguration()
    : {
        mode: state.settings.tunnelMode,
        ...(state.settings.tunnelMode === "named" && state.settings.namedTunnelHostname
          ? { namedHostname: state.settings.namedTunnelHostname }
          : {}),
        hasNamedTunnelToken: false,
      };
  const tunnelState = controller?.cloudflareState() ?? {
    mode: state.settings.tunnelMode,
    status: "stopped" as const,
    publicUrl: null,
    error: null,
  };
  return {
    version: 1,
    controlEnabled: state.settings.controlEnabled,
    keepAwake: state.settings.keepAwake,
    localNetworkEnabled: state.settings.localNetworkEnabled === true,
    connectionChoice: state.settings.connectionChoice ?? (state.settings.tunnelMode === "named" ? "named" : "local"),
    pairingAvailable: pairingConnectionReady(state, gateway, tunnelState, pairingAddresses),
    gateway,
    reachableAddresses,
    tunnel: {
      configuration,
      runtime: tunnelState,
    },
    desktop: {
      id: "desktop",
      label: readHostname() || "Remodex Desktop",
      platform: process.platform,
      address: reachableAddresses[0] ?? `http://127.0.0.1:${gateway.port}`,
      online: true,
    },
    clients: state.clients.map(client => ({
      id: client.id,
      label: client.label,
      deviceType: client.deviceType,
      os: client.os,
      scopes: [...client.scopes],
      createdAt: client.createdAt,
      online: onlineClientIds.has(client.id),
      ...(client.address ? { address: client.address } : {}),
      ...(client.lastSeenAt ? { lastSeenAt: client.lastSeenAt } : {}),
    })),
  };
}

function routeStore(ctx: ManagementContext): AndroidRemoteStore {
  return ctx.deps.androidRemoteStore ?? createAndroidRemoteStore();
}

export async function handleAndroidRemoteRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname === "/api/android-remote" && req.method === "GET") {
    return jsonResponse(await statusDTO(ctx, routeStore(ctx).read()), 200, req, config);
  }

  if (url.pathname === "/api/android-remote/pairing" && req.method === "POST") {
    const replaceClientId = url.searchParams.get("replaceClientId") ?? undefined;
    if (replaceClientId !== undefined && !routeStore(ctx).read().clients.some(client => client.id === replaceClientId)) {
      return jsonResponse({ error: "The phone authorization no longer exists" }, 404, req, config);
    }
    const controller = routeController(ctx);
    if (!controller) {
      return jsonResponse({ error: "Android Remote gateway is unavailable" }, 503, req, config);
    }
    // Enforce this server-side as well as in the UI. A localhost address is not
    // a usable phone route, and old dashboards must not mint a premature QR.
    if (!pairingConnectionReady(routeStore(ctx).read(), controller.status(), controller.cloudflareState(), controller.pairingUrls())) {
      return jsonResponse({ error: "No phone connection is ready. Enable Same Wi-Fi on a trusted network, or wait for remote access before creating a QR code." }, 409, req, config);
    }
    try {
      const invitation = controller.createPairingInvitation(readHostname() || "Remodex Desktop", replaceClientId);
      const response: AndroidRemotePairingDTO = {
        version: 1,
        id: invitation.id,
        expiresAt: invitation.expiresAt,
        qrPayload: invitation.qrPayload,
      };
      return jsonResponse(response, 201, req, config);
    } catch {
      return jsonResponse({ error: "Android Remote gateway is not ready" }, 409, req, config);
    }
  }

  if (url.pathname === "/api/android-remote/settings" && req.method === "PUT") {
    const body = await readManagementJsonBodyOr(req, null);
    if (!isPlainRecord(body)) {
      return jsonResponse({ error: "settings body must be an object" }, 400, req, config);
    }
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some(key => key !== "controlEnabled" && key !== "keepAwake" && key !== "localNetworkEnabled" && key !== "connectionChoice")) {
      return jsonResponse({ error: "provide controlEnabled, keepAwake, localNetworkEnabled, or connectionChoice only" }, 400, req, config);
    }
    if ("connectionChoice" in body && body.connectionChoice !== "local" && body.connectionChoice !== "quick" && body.connectionChoice !== "named") {
      return jsonResponse({ error: "connectionChoice must be local, quick, or named" }, 400, req, config);
    }
    if (("controlEnabled" in body && typeof body.controlEnabled !== "boolean")
      || ("keepAwake" in body && typeof body.keepAwake !== "boolean")
      || ("localNetworkEnabled" in body && typeof body.localNetworkEnabled !== "boolean")) {
      return jsonResponse({ error: "Android Remote settings must be boolean" }, 400, req, config);
    }
    const next = routeStore(ctx).updateSettings({
      ...(typeof body.controlEnabled === "boolean" ? { controlEnabled: body.controlEnabled } : {}),
      ...(typeof body.keepAwake === "boolean" ? { keepAwake: body.keepAwake } : {}),
      ...(typeof body.localNetworkEnabled === "boolean" ? { localNetworkEnabled: body.localNetworkEnabled } : {}),
      ...(body.connectionChoice === "local" || body.connectionChoice === "quick" || body.connectionChoice === "named"
        ? { connectionChoice: body.connectionChoice } : {}),
    });
    try {
      // Choosing a dashboard section must not restart a working phone connection.
      if (keys.some(key => key !== "connectionChoice")) await routeController(ctx)?.applySettings(next.settings);
    } catch {
      // The controller records a safe error state. Return that honest state so the
      // dashboard can explain that the saved switch is on but the gateway failed.
    }
    return jsonResponse(await statusDTO(ctx, next), 200, req, config);
  }

  if (url.pathname === "/api/android-remote/cloudflare/discover" && req.method === "POST") {
    const body = await readManagementJsonBodyOr(req, null);
    if (!isPlainRecord(body)
      || Object.keys(body).some(key => key !== "apiToken")
      || typeof body.apiToken !== "string") {
      return jsonResponse({ error: "provide a Cloudflare API token only", code: "invalid_input" }, 400, req, config);
    }
    try {
      const discovery = await routeCloudflareProvisioner(ctx).discover(body.apiToken);
      return jsonResponse(discovery, 200, req, config);
    } catch (error) {
      const failure = cloudflareProvisioningError(error);
      return jsonResponse(failure.body, failure.status, req, config);
    }
  }

  if (url.pathname === "/api/android-remote/cloudflare/provision" && req.method === "POST") {
    // This call creates a tunnel and DNS record in the user's Cloudflare account.
    // A raw admin token can be read by local agents, so only the browser session
    // minted by the dashboard is accepted as evidence of the user's Connect click.
    if (ctx.principal !== "gui-session") {
      return jsonResponse({
        error: "Open the dashboard and choose Connect to authorize changes to Cloudflare.",
        code: "dashboard_session_required",
      }, 403, req, config);
    }
    const controller = routeController(ctx);
    if (!controller) {
      return jsonResponse({ error: "Android Remote gateway is unavailable" }, 503, req, config);
    }
    const body = await readManagementJsonBodyOr(req, null);
    const allowed = new Set(["apiToken", "accountId", "zoneId", "hostname"]);
    if (!isPlainRecord(body)
      || Object.keys(body).some(key => !allowed.has(key))
      || typeof body.apiToken !== "string"
      || typeof body.accountId !== "string"
      || typeof body.zoneId !== "string"
      || typeof body.hostname !== "string") {
      return jsonResponse({ error: "provide the selected Cloudflare account, domain, and hostname", code: "invalid_input" }, 400, req, config);
    }
    try {
      const provisioned = await routeCloudflareProvisioner(ctx).provision({
        apiToken: body.apiToken,
        accountId: body.accountId,
        zoneId: body.zoneId,
        hostname: body.hostname,
        gatewayPort: controller.status().port,
      });
      routeStore(ctx).updateSettings({ controlEnabled: true });
      await controller.configureCloudflareTunnel({
        mode: "named",
        namedHostname: provisioned.hostname,
        token: provisioned.connectorToken,
      });
      return jsonResponse(await statusDTO(ctx, routeStore(ctx).read()), 200, req, config);
    } catch (error) {
      const failure = cloudflareProvisioningError(error);
      return jsonResponse(failure.body, failure.status, req, config);
    }
  }

  if (url.pathname === "/api/android-remote/tunnel" && req.method === "PUT") {
    const controller = routeController(ctx);
    if (!controller) {
      return jsonResponse({ error: "Android Remote gateway is unavailable" }, 503, req, config);
    }
    const body = await readManagementJsonBodyOr(req, null);
    if (!isPlainRecord(body)) {
      return jsonResponse({ error: "tunnel body must be an object" }, 400, req, config);
    }
    if (body.mode !== "quick" && body.mode !== "named") {
      return jsonResponse({ error: "tunnel mode must be quick or named" }, 400, req, config);
    }
    const allowed = body.mode === "quick"
      ? new Set(["mode"])
      : new Set(["mode", "hostname", "token"]);
    if (Object.keys(body).some(key => !allowed.has(key))) {
      return jsonResponse({ error: "tunnel body contains unsupported fields" }, 400, req, config);
    }
    if (body.mode === "named" && typeof body.hostname !== "string") {
      return jsonResponse({ error: "Named Tunnel requires a hostname" }, 400, req, config);
    }
    if ("token" in body && typeof body.token !== "string") {
      return jsonResponse({ error: "connector token must be a string" }, 400, req, config);
    }
    try {
      await controller.configureCloudflareTunnel({
        mode: body.mode,
        ...(typeof body.hostname === "string" ? { namedHostname: body.hostname } : {}),
        ...(typeof body.token === "string" ? { token: body.token } : {}),
      });
      return jsonResponse(await statusDTO(ctx, routeStore(ctx).read()), 200, req, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tunnel configuration failed";
      return jsonResponse({ error: message }, error instanceof TypeError ? 400 : 409, req, config);
    }
  }

  if (url.pathname === "/api/android-remote/tunnel/retry" && req.method === "POST") {
    const controller = routeController(ctx);
    if (!controller) {
      return jsonResponse({ error: "Android Remote gateway is unavailable" }, 503, req, config);
    }
    try {
      await controller.retryCloudflareTunnel();
      return jsonResponse(await statusDTO(ctx, routeStore(ctx).read()), 200, req, config);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "Tunnel retry failed" }, 409, req, config);
    }
  }

  if (url.pathname === "/api/android-remote/tunnel/check" && req.method === "POST") {
    const controller = routeController(ctx);
    if (!controller) {
      return jsonResponse({ error: "Android Remote gateway is unavailable" }, 503, req, config);
    }
    try {
      await controller.checkCloudflareTunnel();
      return jsonResponse(await statusDTO(ctx, routeStore(ctx).read()), 200, req, config);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "Tunnel check failed" }, 409, req, config);
    }
  }

  if (url.pathname === "/api/android-remote/tunnel/token" && req.method === "DELETE") {
    const controller = routeController(ctx);
    if (!controller) {
      return jsonResponse({ error: "Android Remote gateway is unavailable" }, 503, req, config);
    }
    try {
      await controller.removeCloudflareTunnelToken();
      return jsonResponse(await statusDTO(ctx, routeStore(ctx).read()), 200, req, config);
    } catch {
      return jsonResponse({ error: "Could not remove the connector token" }, 409, req, config);
    }
  }

  if (url.pathname === "/api/android-remote/tunnel/domain" && req.method === "DELETE") {
    const controller = routeController(ctx);
    if (!controller) {
      return jsonResponse({ error: "Android Remote gateway is unavailable" }, 503, req, config);
    }
    try {
      await controller.disconnectCloudflareNamedTunnel();
      return jsonResponse(await statusDTO(ctx, routeStore(ctx).read()), 200, req, config);
    } catch {
      return jsonResponse({ error: "Could not disconnect the named domain" }, 409, req, config);
    }
  }

  const revokeMatch = url.pathname.match(/^\/api\/android-remote\/clients\/([^/]+)$/);
  if (revokeMatch && req.method === "DELETE") {
    let id: string;
    try {
      id = decodeURIComponent(revokeMatch[1]);
    } catch {
      return jsonResponse({ error: "invalid client id encoding" }, 400, req, config);
    }
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id)) {
      return jsonResponse({ error: "invalid client id" }, 400, req, config);
    }
    const result = routeStore(ctx).revokeClient(id);
    if (!result.removed) return jsonResponse({ error: "client not found" }, 404, req, config);
    routeController(ctx)?.revokeClient(id);
    return jsonResponse(await statusDTO(ctx, result.state), 200, req, config);
  }

  return null;
}
