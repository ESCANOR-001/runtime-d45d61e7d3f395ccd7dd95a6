import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AndroidRemoteState,
  AndroidRemoteStore,
} from "../src/android-remote/store";
import { createAndroidRemoteStore } from "../src/android-remote/store";
import { AndroidRemoteGatewayController } from "../src/android-remote/gateway";
import type {
  AndroidRemoteCloudflareState,
  AndroidRemoteCloudflareTunnel,
} from "../src/android-remote/cloudflare-tunnel";
import type { AndroidRemoteCloudflareProvisioner } from "../src/android-remote/cloudflare-provisioning";
import { handleManagementAPI } from "../src/server/management-api";
import { androidRemoteReachableAddresses } from "../src/server/management/android-remote-routes";
import type { ManagementPrincipal } from "../src/server/management-auth";
import type { OcxConfig } from "../src/types";

function config(hostname = "127.0.0.1"): OcxConfig {
  return {
    port: 10100,
    hostname,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    defaultProvider: "openai",
  } as OcxConfig;
}

test("Wi-Fi pairing remains ready while a named remote link is unavailable, only after opt-in", async () => {
  const store = memoryStore();
  store.updateSettings({ controlEnabled: true, tunnelMode: "named" });
  const controller = {
    status: () => ({ status: "ready", backgroundServer: "current-process", port: 10105 }),
    pairingUrls: () => ["http://192.168.1.3:10105"],
    onlineClientIds: () => new Set<string>(),
    cloudflareConfiguration: async () => ({ mode: "named", hasNamedTunnelToken: true }),
    cloudflareState: () => ({ mode: "named", status: "error", publicUrl: null, error: "verification_failed" }),
    applySettings: async () => {},
  } as unknown as AndroidRemoteGatewayController;
  const before = await api("/api/android-remote", store, {}, config(), controller);
  expect(await before.json()).toMatchObject({ pairingAvailable: false, localNetworkEnabled: false });
  const after = await api("/api/android-remote/settings", store, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ localNetworkEnabled: true }),
  }, config(), controller);
  expect(after.status).toBe(200);
  expect(await after.json()).toMatchObject({ pairingAvailable: true, localNetworkEnabled: true });
  expect(store.read().settings.tunnelMode).toBe("named");
});

test("connection choice persists across store recreation without restarting phone connections", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-connection-choice-"));
  try {
    const store = createAndroidRemoteStore(root);
    store.updateSettings({ tunnelMode: "named", namedTunnelHostname: "saved.example.com", localNetworkEnabled: true });
    let starts = 0;
    const controller = {
      status: () => ({ status: "ready", backgroundServer: "current-process", port: 10105 }),
      pairingUrls: () => ["http://192.168.1.3:10105"],
      onlineClientIds: () => new Set<string>(),
      cloudflareConfiguration: async () => ({ mode: "named", hasNamedTunnelToken: true }),
      cloudflareState: () => ({ mode: "named", status: "checking", publicUrl: null, error: null }),
      applySettings: async () => { starts++; },
    } as unknown as AndroidRemoteGatewayController;
    for (const choice of ["local", "quick", "named"]) {
      const saved = await api("/api/android-remote/settings", store, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionChoice: choice }),
      }, config(), controller);
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ connectionChoice: choice });
      const restored = createAndroidRemoteStore(root);
      const afterRestart = await api("/api/android-remote", restored);
      expect(await afterRestart.json()).toMatchObject({ connectionChoice: choice });
      expect(restored.read().settings).toMatchObject({ tunnelMode: "named", localNetworkEnabled: true, namedTunnelHostname: "saved.example.com" });
    }
    expect(starts).toBe(0);
    store.updateSettings({ keepAwake: true });
    expect(createAndroidRemoteStore(root).read().settings.connectionChoice).toBe("named");
    store.updateSettings({ tunnelMode: "quick", namedTunnelHostname: "" });
    expect(createAndroidRemoteStore(root).read().settings.connectionChoice).toBe("quick");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("older named settings restore Custom domain and invalid choices never change settings", async () => {
  const store = memoryStore();
  store.updateSettings({ tunnelMode: "named", namedTunnelHostname: "saved.example.com", localNetworkEnabled: true });
  expect(await (await api("/api/android-remote", store)).json()).toMatchObject({ connectionChoice: "named" });
  const before = store.read();
  for (const connectionChoice of [null, true, 1, "invalid", {}, []]) {
    const response = await api("/api/android-remote/settings", store, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionChoice, controlEnabled: true }),
    });
    expect(response.status).toBe(400);
    expect(store.read()).toEqual(before);
  }
});

function memoryStore(): AndroidRemoteStore {
  let state: AndroidRemoteState = {
    version: 1,
    settings: { controlEnabled: false, keepAwake: false, tunnelMode: "quick" },
    clients: [{
      id: "phone-1",
      label: "Android test phone",
      deviceType: "mobile",
      os: "android",
      address: "192.168.1.8",
      scopes: ["tasks.read", "tasks.write"],
      createdAt: "2026-08-10T00:00:00.000Z",
      lastSeenAt: "2026-08-10T01:00:00.000Z",
      credentialDigest: "private-digest-that-must-not-leave-the-store",
    }],
    threadAliases: [],
    taskSelections: [],
  };
  return {
    read: () => structuredClone(state),
    updateSettings(patch) {
      state = { ...state, settings: { ...state.settings, ...patch } };
      return structuredClone(state);
    },
    upsertClient(client) {
      state = { ...state, clients: [...state.clients.filter(row => row.id !== client.id), client] };
      return structuredClone(state);
    },
    updateClientMetadata(id, patch) {
      state = {
        ...state,
        clients: state.clients.map(client => client.id === id ? { ...client, ...patch } : client),
      };
      return structuredClone(state);
    },
    touchClient(id, patch) {
      state = {
        ...state,
        clients: state.clients.map(client => client.id === id ? { ...client, ...patch } : client),
      };
      return structuredClone(state);
    },
    revokeClient(id) {
      const clients = state.clients.filter(client => client.id !== id);
      const removed = clients.length !== state.clients.length;
      if (removed) state = { ...state, clients };
      return { removed, state: structuredClone(state) };
    },
    upsertThreadAlias(alias) {
      state = {
        ...state,
        threadAliases: [
          ...state.threadAliases.filter(row => row.remoteThreadId !== alias.remoteThreadId),
          alias,
        ],
      };
      return structuredClone(state);
    },
    removeThreadAlias(remoteThreadId) {
      state = { ...state, threadAliases: state.threadAliases.filter(row => row.remoteThreadId !== remoteThreadId) };
      return structuredClone(state);
    },
    upsertTaskSelection(input) {
      const existing = state.taskSelections.find(row =>
        row.nativeThreadId === input.nativeThreadId || row.remoteThreadId === input.remoteThreadId);
      if (existing?.updateId === input.updateId) {
        return { applied: false, duplicate: true, stale: false, selection: existing, state: structuredClone(state) };
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== (existing?.revision ?? 0)) {
        if (!existing) throw new Error("invalid selection revision");
        return { applied: false, duplicate: false, stale: true, selection: existing, state: structuredClone(state) };
      }
      const selection = { ...input, revision: (existing?.revision ?? 0) + 1 };
      delete (selection as { expectedRevision?: number }).expectedRevision;
      state = {
        ...state,
        taskSelections: [
          ...state.taskSelections.filter(row =>
            row.nativeThreadId !== selection.nativeThreadId && row.remoteThreadId !== selection.remoteThreadId),
          selection,
        ],
      };
      return { applied: true, duplicate: false, stale: false, selection, state: structuredClone(state) };
    },
    removeTaskSelection(threadId) {
      state = { ...state, taskSelections: state.taskSelections.filter(row =>
        row.nativeThreadId !== threadId && row.remoteThreadId !== threadId) };
      return structuredClone(state);
    },
  };
}

class FakeCloudflareTunnel implements AndroidRemoteCloudflareTunnel {
  token: string | null = null;
  current: AndroidRemoteCloudflareState = {
    mode: "quick",
    status: "stopped",
    publicUrl: null,
    error: null,
  };

  state(): AndroidRemoteCloudflareState {
    return { ...this.current };
  }

  async configuration(settings: AndroidRemoteState["settings"]) {
    return {
      mode: settings.tunnelMode,
      ...(settings.tunnelMode === "named" && settings.namedTunnelHostname
        ? { namedHostname: settings.namedTunnelHostname }
        : {}),
      hasNamedTunnelToken: this.token !== null,
    };
  }

  async configureToken(token: string): Promise<void> { this.token = token; }
  async removeToken(): Promise<void> { this.token = null; }
  async apply(): Promise<void> {}
  async retry(): Promise<void> {}
  async check(): Promise<void> {}
  async stop(): Promise<void> {}
  subscribe(): () => void { return () => undefined; }
}

async function api(
  path: string,
  store: AndroidRemoteStore,
  init: RequestInit = {},
  cfg = config(),
  controller?: AndroidRemoteGatewayController,
  principal?: ManagementPrincipal,
  cloudflareProvisioner?: AndroidRemoteCloudflareProvisioner,
): Promise<Response> {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const response = await handleManagementAPI(
    new Request(url, { ...init, headers: { Host: url.host, ...(init.headers ?? {}) } }),
    url,
    cfg,
    {
      androidRemoteStore: store,
      ...(controller ? { androidRemoteController: controller } : {}),
      ...(cloudflareProvisioner ? { androidRemoteCloudflareProvisioner: cloudflareProvisioner } : {}),
    },
    principal,
  );
  expect(response).not.toBeNull();
  return response!;
}

describe("Android Remote management API", () => {
  test("row-specific pairing validates its target without deleting the existing authorization", async () => {
    const store = memoryStore();
    store.updateSettings({ controlEnabled: true, localNetworkEnabled: true });
    const targets: Array<string | undefined> = [];
    const controller = {
      status: () => ({ status: "ready", backgroundServer: "current-process", port: 10105 }),
      pairingUrls: () => ["http://192.168.1.3:10105"],
      cloudflareState: () => ({ mode: "quick", status: "starting", publicUrl: null, error: null }),
      createPairingInvitation: (_name: string, replaceClientId?: string) => {
        targets.push(replaceClientId);
        return { id: "invitation", expiresAt: new Date(Date.now() + 60_000).toISOString(), qrPayload: "test-qr" };
      },
    } as unknown as AndroidRemoteGatewayController;
    const response = await api("/api/android-remote/pairing?replaceClientId=phone-1", store, { method: "POST" }, config(), controller);
    expect(response.status).toBe(201);
    expect(targets).toEqual(["phone-1"]);
    expect(store.read().clients).toHaveLength(1);
    const missing = await api("/api/android-remote/pairing?replaceClientId=missing", store, { method: "POST" }, config(), controller);
    expect(missing.status).toBe(404);
    expect(targets).toHaveLength(1);
  });
  for (const condition of ["starting", "checking", "error", "stopped", "missing-url", "http-url", "wrong-mode", "disabled", "gateway-starting", "ready-with-error", "ready"] as const) {
    test(`gates pairing on the verified public tunnel, not a localhost address: ${condition}`, async () => {
      const store = memoryStore();
      store.updateSettings({ controlEnabled: condition !== "disabled" });
      let invitations = 0;
      const tunnel: AndroidRemoteCloudflareState = {
        mode: condition === "wrong-mode" ? "named" : "quick",
        status: ["starting", "checking", "error", "stopped"].includes(condition)
          ? condition as "starting" | "checking" | "error" | "stopped" : "ready",
        publicUrl: condition === "missing-url" ? null : condition === "http-url"
          ? "http://unverified.example.com" : "https://verified.trycloudflare.com",
        error: condition === "error" || condition === "ready-with-error" ? "verification_failed" : null,
      };
      const controller = {
        status: () => ({ status: condition === "gateway-starting" ? "starting" : "ready", backgroundServer: "current-process", port: 10105 }),
        pairingUrls: () => ["http://127.0.0.1:10105"],
        onlineClientIds: () => new Set<string>(),
        cloudflareConfiguration: async () => ({ mode: "quick", hasNamedTunnelToken: false }),
        cloudflareState: () => ({ ...tunnel }),
        createPairingInvitation: () => {
          invitations += 1;
          return { id: "test-invitation", expiresAt: new Date(Date.now() + 60_000).toISOString(), qrPayload: "test-pairing-payload" };
        },
      } as unknown as AndroidRemoteGatewayController;
      const ready = condition === "ready";
      const response = await api("/api/android-remote", store, {}, config(), controller);
      expect(await response.json()).toMatchObject({ pairingAvailable: ready });
      const pairing = await api("/api/android-remote/pairing", store, { method: "POST" }, config(), controller);
      expect(pairing.status).toBe(ready ? 201 : 409);
      expect(invitations).toBe(ready ? 1 : 0);
      if (ready) {
        tunnel.status = "checking";
        const failedStatus = await api("/api/android-remote", store, {}, config(), controller);
        expect(await failedStatus.json()).toMatchObject({ pairingAvailable: false });
        const blocked = await api("/api/android-remote/pairing", store, { method: "POST" }, config(), controller);
        expect(blocked.status).toBe(409);
        expect(invitations).toBe(1);
      } else {
        expect(await pairing.text()).toContain("No phone connection is ready");
      }
    });
  }

  test("persists settings in the explicitly selected protected store folder", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-android-remote-"));
    try {
      const store = createAndroidRemoteStore(root);
      expect(store.read().settings).toEqual({ controlEnabled: false, keepAwake: false, tunnelMode: "quick" });
      store.updateSettings({ controlEnabled: true, keepAwake: true });

      expect(createAndroidRemoteStore(root).read().settings).toEqual({
        controlEnabled: true,
        keepAwake: true,
        tunnelMode: "quick",
      });
      expect(readFileSync(join(root, "android-remote.json"), "utf8")).not.toContain("ocx_admin_");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports the honest foundation state and never serializes client credentials", async () => {
    const response = await api("/api/android-remote", memoryStore());
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      version: 1,
      controlEnabled: false,
      keepAwake: false,
      pairingAvailable: false,
      gateway: { status: "stopped", backgroundServer: "current-process", port: 10105 },
    });
    expect(body.reachableAddresses).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("credentialDigest");
    expect(JSON.stringify(body)).not.toContain("private-digest");
  });

  test("does not label a remembered Named hostname as the active Quick Tunnel", async () => {
    const store = memoryStore();
    store.updateSettings({
      tunnelMode: "quick",
      namedTunnelHostname: "remembered.example.com",
    });

    const response = await api("/api/android-remote", store);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      tunnel: { configuration: { mode: string; namedHostname?: string } };
    };
    expect(body.tunnel.configuration).toEqual({
      mode: "quick",
      hasNamedTunnelToken: false,
    });
  });

  test("accepts only the two boolean settings and persists a valid patch", async () => {
    const store = memoryStore();
    const valid = await api("/api/android-remote/settings", store, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ controlEnabled: true, keepAwake: true }),
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ controlEnabled: true, keepAwake: true });

    for (const body of [{}, { controlEnabled: "yes" }, { unknown: true }]) {
      const rejected = await api("/api/android-remote/settings", store, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(rejected.status).toBe(400);
    }
  });

  test("configures Named Tunnel without ever returning its connector token", async () => {
    const store = memoryStore();
    const tunnel = new FakeCloudflareTunnel();
    const controller = new AndroidRemoteGatewayController(store, { cloudflareTunnel: tunnel });
    const token = "private-cloudflare-connector-token-that-must-not-leak";
    const response = await api("/api/android-remote/tunnel", store, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "named", hostname: "https://opencodex.remodex.net/", token }),
    }, config(), controller);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toMatchObject({
      tunnel: {
        configuration: {
          mode: "named",
          namedHostname: "opencodex.remodex.net",
          hasNamedTunnelToken: true,
        },
      },
    });
    expect(store.read().settings).toMatchObject({
      tunnelMode: "named",
      namedTunnelHostname: "opencodex.remodex.net",
    });
  });

  test("strictly rejects malformed tunnel configuration", async () => {
    const store = memoryStore();
    const controller = new AndroidRemoteGatewayController(store, {
      cloudflareTunnel: new FakeCloudflareTunnel(),
    });
    for (const body of [
      { mode: "temporary" },
      { mode: "quick", token: "not-allowed" },
      { mode: "named" },
      { mode: "named", hostname: "https://example.com/not-a-hostname", token: "private-cloudflare-connector-token-that-is-valid" },
    ]) {
      const response = await api("/api/android-remote/tunnel", store, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, config(), controller);
      expect(response.status).toBe(400);
    }
  });

  test("discovers Cloudflare domains without returning or retaining the submitted API token", async () => {
    const store = memoryStore();
    const submitted = "temporary-cloudflare-api-token-for-discovery";
    let observedToken = "";
    const provisioner: AndroidRemoteCloudflareProvisioner = {
      async discover(token) {
        observedToken = token;
        return {
          version: 1,
          accounts: [{ id: "a".repeat(32), name: "Test account" }],
          zones: [{
            id: "b".repeat(32),
            name: "example.com",
            accountId: "a".repeat(32),
            accountName: "Test account",
            status: "active",
            nameServers: [],
          }],
        };
      },
      async provision() { throw new Error("not used"); },
    };
    const response = await api("/api/android-remote/cloudflare/discover", store, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiToken: submitted }),
    }, config(), undefined, undefined, provisioner);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(observedToken).toBe(submitted);
    expect(text).not.toContain(submitted);
    expect(JSON.parse(text)).toMatchObject({ version: 1, zones: [{ name: "example.com" }] });
  });

  test("requires a real dashboard session before provisioning mutates Cloudflare", async () => {
    const store = memoryStore();
    let provisionCalls = 0;
    const provisioner: AndroidRemoteCloudflareProvisioner = {
      async discover() { return { version: 1, accounts: [], zones: [] }; },
      async provision() {
        provisionCalls += 1;
        return {
          hostname: "opencodex.example.com",
          connectorToken: "connector-token-that-must-never-leave-the-server",
          tunnelCreated: true,
          dnsCreated: true,
        };
      },
    };
    const request = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiToken: "temporary-cloudflare-api-token-for-provisioning",
        accountId: "a".repeat(32),
        zoneId: "b".repeat(32),
        hostname: "opencodex.example.com",
      }),
    } satisfies RequestInit;

    for (const principal of [undefined, "admin-token" as const]) {
      const response = await api(
        "/api/android-remote/cloudflare/provision",
        store,
        request,
        config(),
        undefined,
        principal,
        provisioner,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "dashboard_session_required" });
    }
    expect(provisionCalls).toBe(0);
  });

  test("a dashboard Connect click stores the connector server-side and returns no Cloudflare secret", async () => {
    const store = memoryStore();
    const submittedApiToken = "temporary-cloudflare-api-token-for-dashboard-connect";
    const connectorToken = "connector-token-that-must-never-leave-the-server";
    let configured: { mode: "quick" | "named"; namedHostname?: string; token?: string } | null = null;
    const controller = {
      status: () => ({ status: "ready", backgroundServer: "current-process", port: 10105 }),
      localUrls: () => ["http://127.0.0.1:10105"],
      pairingUrls: () => [],
      onlineClientIds: () => new Set<string>(),
      cloudflareConfiguration: async () => ({
        mode: "named" as const,
        namedHostname: "opencodex.example.com",
        hasNamedTunnelToken: true,
      }),
      cloudflareState: () => ({
        mode: "named" as const,
        status: "starting" as const,
        publicUrl: "https://opencodex.example.com",
        error: null,
      }),
      configureCloudflareTunnel: async (input: {
        mode: "quick" | "named";
        namedHostname?: string;
        token?: string;
      }) => { configured = input; },
    } as unknown as AndroidRemoteGatewayController;
    const provisioner: AndroidRemoteCloudflareProvisioner = {
      async discover() { return { version: 1, accounts: [], zones: [] }; },
      async provision(input) {
        expect(input.apiToken).toBe(submittedApiToken);
        expect(input.gatewayPort).toBe(10105);
        return {
          hostname: "opencodex.example.com",
          connectorToken,
          tunnelCreated: true,
          dnsCreated: true,
        };
      },
    };
    const response = await api("/api/android-remote/cloudflare/provision", store, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiToken: submittedApiToken,
        accountId: "a".repeat(32),
        zoneId: "b".repeat(32),
        hostname: "opencodex.example.com",
      }),
    }, config(), controller, "gui-session", provisioner);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(configured).toEqual({ mode: "named", namedHostname: "opencodex.example.com", token: connectorToken });
    expect(text).not.toContain(submittedApiToken);
    expect(text).not.toContain(connectorToken);
    expect(JSON.parse(text)).toMatchObject({
      controlEnabled: true,
      tunnel: { configuration: { mode: "named", hasNamedTunnelToken: true } },
    });
  });

  test("disconnecting a named domain clears its local credential and returns to Quick Tunnel", async () => {
    const store = memoryStore();
    store.updateSettings({ tunnelMode: "named", namedTunnelHostname: "opencodex.example.com" });
    const tunnel = new FakeCloudflareTunnel();
    tunnel.token = "connector-token-that-must-be-removed";
    const controller = new AndroidRemoteGatewayController(store, { cloudflareTunnel: tunnel });

    const response = await api(
      "/api/android-remote/tunnel/domain",
      store,
      { method: "DELETE" },
      config(),
      controller,
    );

    expect(response.status).toBe(200);
    expect(tunnel.token).toBeNull();
    expect(await response.json()).toMatchObject({
      tunnel: {
        configuration: {
          mode: "quick",
          hasNamedTunnelToken: false,
        },
      },
    });
    expect(store.read().settings.tunnelMode).toBe("quick");
    expect(store.read().settings.namedTunnelHostname).toBe("");
  });

  test("revokes only the named phone and returns 404 for an unknown client", async () => {
    const store = memoryStore();
    const removed = await api("/api/android-remote/clients/phone-1", store, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await removed.json() as { clients: unknown[] }).clients).toEqual([]);

    const missing = await api("/api/android-remote/clients/phone-1", store, { method: "DELETE" });
    expect(missing.status).toBe(404);
  });

  test("desktop status uses the phone-safe address instead of a Windows link-local address", async () => {
    const store = memoryStore();
    const controller = {
      status: () => ({ status: "ready", backgroundServer: "current-process", port: 10105 }),
      // This is what the old dashboard path would have displayed.
      localUrls: () => ["http://169.254.83.107:10105"],
      pairingUrls: () => ["http://192.168.1.3:10105"],
      onlineClientIds: () => new Set<string>(),
      cloudflareConfiguration: async () => ({
        mode: "quick" as const,
        hasNamedTunnelToken: false,
      }),
      cloudflareState: () => ({
        mode: "quick" as const,
        status: "stopped" as const,
        publicUrl: null,
        error: null,
      }),
    } as unknown as AndroidRemoteGatewayController;

    const response = await api("/api/android-remote", store, {}, config(), controller);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      reachableAddresses: string[];
      desktop: { address: string };
    };
    expect(body.reachableAddresses).toEqual(["http://192.168.1.3:10105"]);
    expect(body.desktop.address).toBe("http://192.168.1.3:10105");
  });

  test("reachable addresses exclude Windows link-local and virtual adapters", () => {
    const interfaces = {
      Ethernet: [
        { address: "10.152.46.1", netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: false, cidr: "10.152.46.1/24" },
      ],
      Tailscale: [
        { address: "169.254.83.107", netmask: "255.255.0.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: false, cidr: "169.254.83.107/16" },
      ],
      "vEthernet (Default Switch)": [
        { address: "172.26.240.1", netmask: "255.255.240.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: false, cidr: "172.26.240.1/20" },
      ],
      Loopback: [
        { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" },
      ],
    };
    expect(androidRemoteReachableAddresses(10105, interfaces)).toEqual([
      "http://10.152.46.1:10105",
    ]);
  });

  test("persists task model selections, rejects stale writes, and deduplicates echoes", () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-selection-store-"));
    try {
      const store = createAndroidRemoteStore(root);
      const first = store.upsertTaskSelection({
        nativeThreadId: "native-selection-1",
        remoteThreadId: "remote-selection-1",
        providerInstanceId: "cursor",
        model: "cursor/gpt-5.6-sol",
        options: [
          { id: "reasoningEffort", value: "xhigh" },
          { id: "apiKey", value: { secret: "should-not-be-stored" } },
          { id: "accessToken", value: "primitive-secret-should-not-be-stored" },
          { id: "unknownFutureField", value: true },
        ],
        source: "android",
        updateId: "selection-1",
        updatedAt: "2026-08-19T00:00:00.000Z",
        expectedRevision: 0,
      });
      expect(first.applied).toBe(true);
      expect(first.selection.revision).toBe(1);
      const restored = createAndroidRemoteStore(root).read();
      expect(restored.taskSelections).toMatchObject([{
        nativeThreadId: "native-selection-1",
        providerInstanceId: "cursor",
        model: "cursor/gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      }]);
      expect(readFileSync(join(root, "android-remote.json"), "utf8"))
        .not.toContain("primitive-secret-should-not-be-stored");
      const duplicate = createAndroidRemoteStore(root).upsertTaskSelection({
        ...first.selection,
        expectedRevision: 1,
      });
      expect(duplicate.duplicate).toBe(true);
      const stale = createAndroidRemoteStore(root).upsertTaskSelection({
        ...first.selection,
        model: "opencode/glm-5.2",
        updateId: "selection-stale",
        source: "android",
        expectedRevision: 0,
      });
      expect(stale.stale).toBe(true);
      expect(stale.selection.model).toBe("cursor/gpt-5.6-sol");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
