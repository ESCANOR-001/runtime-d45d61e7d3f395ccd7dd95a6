import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests, setClientResourceData } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import AndroidRemote from "../src/pages/AndroidRemote";
import { androidRemoteResourceKey, updateAndroidRemoteTunnel } from "../src/pages/android-remote-api";
import { createRandomRemoteSubdomain } from "../src/pages/android-remote-subdomain";
import { hashBelongsToPage, readPageFromHash } from "../src/app-routing";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let controlEnabled = false;
let gatewayPort = 10105;
let localNetworkEnabled = false;
let connectionChoice: "local" | "quick" | "named" | undefined;
let settingsWrites: unknown[] = [];
let tunnelWrites: unknown[] = [];
let tunnelMode: "quick" | "named" = "quick";
let tunnelHostname = "";
let tunnelTokenSaved = false;
let tunnelRuntimeStatus: "stopped" | "starting" | "checking" | "ready" | "error" = "stopped";
let tunnelRuntimeError: "cloudflared_unavailable" | "named_tunnel_incomplete" | "tunnel_failed" | "verification_failed" | null = null;
let tunnelRuntimePhase: "activating" | "connecting" | "reconnecting" | undefined;
let tunnelPublicUrl: string | null = null;
let pairingCalls = 0;
let pairingTargets: Array<string | null> = [];
let cloudflareDiscoverTokens: string[] = [];
let cloudflareProvisionWrites: unknown[] = [];
let clients: Array<{
  id: string;
  label: string;
  deviceType: "mobile";
  os: string;
  address?: string;
  scopes: string[];
  createdAt: string;
  lastSeenAt?: string;
  online: boolean;
}> = [];
let deletedUrls: string[] = [];

function status() {
  return {
    version: 1,
    controlEnabled,
    localNetworkEnabled,
    connectionChoice,
    keepAwake: false,
    pairingAvailable: controlEnabled,
    gateway: { status: controlEnabled ? "ready" : "stopped", backgroundServer: "current-process", port: gatewayPort },
    reachableAddresses: localNetworkEnabled ? ["http://192.168.1.3:10105"] : ["http://127.0.0.1:10105"],
    tunnel: {
      configuration: {
        mode: tunnelMode,
        ...(tunnelMode === "named" && tunnelHostname ? { namedHostname: tunnelHostname } : {}),
        hasNamedTunnelToken: tunnelTokenSaved,
      },
      runtime: {
        mode: tunnelMode,
        status: tunnelRuntimeStatus,
        publicUrl: tunnelPublicUrl,
        error: tunnelRuntimeError,
        ...(tunnelRuntimePhase ? { phase: tunnelRuntimePhase } : {}),
      },
    },
    desktop: {
      id: "desktop",
      label: "Remodex test PC",
      platform: "win32",
      address: "http://127.0.0.1:10105",
      online: true,
    },
    clients,
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/#android-remote" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  controlEnabled = false;
  gatewayPort = 10105;
  localNetworkEnabled = false;
  connectionChoice = undefined;
  settingsWrites = [];
  tunnelWrites = [];
  tunnelMode = "quick";
  tunnelHostname = "";
  tunnelTokenSaved = false;
  tunnelRuntimeStatus = "stopped";
  tunnelRuntimeError = null;
  tunnelRuntimePhase = undefined;
  tunnelPublicUrl = null;
  pairingCalls = 0;
  pairingTargets = [];
  cloudflareDiscoverTokens = [];
  cloudflareProvisionWrites = [];
  clients = [];
  deletedUrls = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const patch = JSON.parse(String(init.body)) as { controlEnabled?: boolean; localNetworkEnabled?: boolean; connectionChoice?: "local" | "quick" | "named" };
        if (url === "/api/android-remote/tunnel") {
          const tunnelPatch = patch as unknown as { mode: "quick" | "named"; hostname?: string; token?: string };
          tunnelWrites.push(tunnelPatch);
          tunnelMode = tunnelPatch.mode;
          connectionChoice = tunnelPatch.mode;
          if (tunnelPatch.hostname) tunnelHostname = tunnelPatch.hostname;
          if (tunnelPatch.token) tunnelTokenSaved = true;
        } else {
          settingsWrites.push(patch);
          if (typeof patch.controlEnabled === "boolean") controlEnabled = patch.controlEnabled;
          if (typeof patch.localNetworkEnabled === "boolean") localNetworkEnabled = patch.localNetworkEnabled;
          if (patch.connectionChoice) connectionChoice = patch.connectionChoice;
        }
      }
      if (init?.method === "DELETE") {
        deletedUrls.push(url);
        if (url === "/api/android-remote/tunnel/domain") {
          tunnelMode = "quick";
          connectionChoice = "quick";
          tunnelHostname = "";
          tunnelTokenSaved = false;
          tunnelRuntimeStatus = "starting";
        } else {
          clients = [];
        }
      }
      if (init?.method === "POST" && new URL(url, "http://localhost").pathname === "/api/android-remote/pairing") {
        pairingCalls += 1;
        pairingTargets.push(new URL(url, "http://localhost").searchParams.get("replaceClientId"));
        return new Response(JSON.stringify({
          version: 1,
          id: `pairing-${pairingCalls}`,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          qrPayload: JSON.stringify({ type: "remodex-mobile-pairing", version: 1,
            localUrls: localNetworkEnabled ? ["http://192.168.1.3:10105"] : [],
            cloudflareUrl: tunnelRuntimeStatus === "ready" ? tunnelPublicUrl : null,
            pairingToken: `test-token-${pairingCalls}` }),
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (init?.method === "POST" && url === "/api/android-remote/cloudflare/discover") {
        const body = JSON.parse(String(init.body)) as { apiToken: string };
        cloudflareDiscoverTokens.push(body.apiToken);
        return new Response(JSON.stringify({
          version: 1,
          accounts: [{ id: "a".repeat(32), name: "Example account" }],
          zones: [{
            id: "b".repeat(32),
            name: "example.com",
            accountId: "a".repeat(32),
            accountName: "Example account",
            status: "active",
            nameServers: ["aria.ns.cloudflare.com", "bob.ns.cloudflare.com"],
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (init?.method === "POST" && url === "/api/android-remote/cloudflare/provision") {
        const body = JSON.parse(String(init.body)) as { hostname: string };
        cloudflareProvisionWrites.push(body);
        controlEnabled = true;
        tunnelMode = "named";
        connectionChoice = "named";
        tunnelHostname = body.hostname;
        tunnelTokenSaved = true;
        tunnelRuntimeStatus = "checking";
      }
      return new Response(JSON.stringify(status()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><AndroidRemote apiBase="" /></LanguageProvider>);
  });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 20)); });
}

function readyTunnel() {
  controlEnabled = true;
  tunnelRuntimeStatus = "ready";
  tunnelRuntimeError = null;
  tunnelPublicUrl = "https://verified.trycloudflare.com";
}

async function publishStatus() {
  await act(async () => { setClientResourceData(androidRemoteResourceKey(""), status()); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 30)); });
}

test("the Android Remote hash is a first-class page", () => {
  expect(readPageFromHash("android-remote")).toBe("android-remote");
  expect(hashBelongsToPage("android-remote", "android-remote")).toBe(true);
  expect(readPageFromHash("android-remote/pair")).toBe("android-remote");
  expect(hashBelongsToPage("android-remote/pair", "android-remote")).toBe(true);
});

test("waits for a verified remote route by default even when local pairing is ready", async () => {
  controlEnabled = true;
  localNetworkEnabled = true;
  tunnelRuntimeStatus = "starting";
  testWindow.location.hash = "android-remote/pair";
  await mount();
  expect(container.querySelector("dialog svg[role=img]")).toBeNull();
  expect(pairingCalls).toBe(0);
  tunnelRuntimeStatus = "checking";
  tunnelPublicUrl = "https://checking.trycloudflare.com";
  await publishStatus();
  expect(pairingCalls).toBe(0);
  readyTunnel();
  await publishStatus();
  expect(pairingCalls).toBe(1);
  expect(container.querySelector("dialog svg[role=img]")).toBeTruthy();
  expect(container.querySelector("dialog")?.textContent).toContain("Remote fallback is ready");
  await publishStatus();
  expect(pairingCalls).toBe(1);
});

test("offers explicit local-only pairing and refreshes it when the verified tunnel changes", async () => {
  controlEnabled = true;
  localNetworkEnabled = true;
  tunnelRuntimeStatus = "starting";
  testWindow.location.hash = "android-remote/pair";
  await mount();
  const local = Array.from(container.querySelectorAll<HTMLButtonElement>("dialog button"))
    .find(button => button.textContent === "Use same-Wi-Fi QR now");
  await act(async () => { local!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 30)); });
  const firstQr = container.querySelector("dialog svg[role=img] path")?.getAttribute("d");
  expect(firstQr).toBeTruthy();
  expect(pairingCalls).toBe(1);
  expect(container.textContent).toContain("same trusted Wi-Fi");
  readyTunnel();
  await publishStatus();
  expect(pairingCalls).toBe(2);
  expect(container.querySelector("dialog svg[role=img] path")?.getAttribute("d")).not.toBe(firstQr);
  tunnelPublicUrl = "https://replacement.trycloudflare.com";
  await publishStatus();
  expect(pairingCalls).toBe(3);
  tunnelRuntimeStatus = "error";
  tunnelRuntimeError = "verification_failed";
  await publishStatus();
  expect(pairingCalls).toBe(4);
  expect(container.querySelector("dialog")?.textContent).toContain("remote access is unavailable");
  await act(async () => {
    setClientResourceData(androidRemoteResourceKey(""), { ...status(), reachableAddresses: ["http://192.168.1.4:10105"] });
  });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 30)); });
  expect(pairingCalls).toBe(5);
});

test("keeps a newly connected phone confirmed when tunnel status changes", async () => {
  localNetworkEnabled = true;
  readyTunnel();
  testWindow.location.hash = "android-remote/pair";
  await mount();
  clients = [{ id: "new-phone", label: "Phone", deviceType: "mobile", os: "Android", scopes: [],
    createdAt: new Date().toISOString(), online: true }];
  await publishStatus();
  expect(container.querySelector("dialog")?.textContent).toContain("New phone connected");
  tunnelPublicUrl = "https://replacement.trycloudflare.com";
  await publishStatus();
  expect(container.querySelector("dialog")?.textContent).toContain("New phone connected");
  expect(pairingCalls).toBe(1);
});

test("generates a non-obvious custom-domain label", () => {
  const subdomain = createRandomRemoteSubdomain({
    getRandomValues: array => {
      array.set([0x07, 0x2a, 0xb4, 0x90, 0xff]);
      return array;
    },
  } as Crypto);
  expect(subdomain).toBe("rmx-072ab490ff");
});

test("keeps connection methods visible with only its three nested disclosures collapsed", async () => {
  tunnelMode = "named";
  await mount();
  const sections = container.querySelectorAll(".android-remote-page > section, .android-remote-page > details");
  expect(sections).toHaveLength(3);
  expect(sections[0]?.getAttribute("aria-labelledby")).toBe("android-remote-settings-heading");
  expect(sections[1]?.getAttribute("aria-labelledby")).toBe("android-remote-tunnel-heading");
  expect(sections[1]?.closest("details")).toBeNull();
  expect(Array.from(sections[1]!.querySelectorAll("summary")).map(summary => summary.textContent)).toEqual([
    "What's the difference?",
    "Create the Cloudflare token onceCloudflare has no built-in template that combines Tunnel and DNS access. Follow these steps; Remodex handles everything after that.",
    "Advanced manual setup",
  ]);
  expect(sections[2]?.getAttribute("aria-labelledby")).toBe("android-remote-clients-heading");
  expect(container.querySelector(".android-remote-connect-card")).toBeNull();
  expect(container.querySelector(".android-remote-advanced-links")).toBeNull();
  expect(container.querySelector('a[href="#android-remote/account"]')).toBeNull();
  expect(container.textContent).not.toContain("rmx tray install");
  expect(Array.from(container.querySelectorAll("details")).every(details => !details.open)).toBe(true);
  expect(settingsWrites).toEqual([]);
  expect(tunnelWrites).toEqual([]);
});

test("focuses the visible connection methods heading from pairing", async () => {
  readyTunnel();
  testWindow.location.hash = "android-remote/pair";
  await mount();
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("dialog button"))
    .find(item => item.textContent === "Connection methods");
  await act(async () => { button!.click(); });
  expect(container.querySelector("dialog")).toBeNull();
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 20)); });
  expect(testWindow.document.activeElement?.id).toBe("android-remote-tunnel-heading");
});

test("shows preparation then scan progress and confirms only a new online phone", async () => {
  controlEnabled = true;
  tunnelRuntimeStatus = "starting";
  clients = [{ id: "existing-phone", label: "Existing phone", deviceType: "mobile", os: "Android", scopes: [],
    createdAt: new Date().toISOString(), online: true }];
  testWindow.location.hash = "android-remote/pair";
  await mount();
  expect(container.querySelector("dialog")?.textContent).toContain("Preparing your connection");
  expect(container.querySelector("dialog")?.textContent).not.toContain("New phone connected");
  readyTunnel();
  await publishStatus();
  expect(container.querySelector("dialog")?.textContent).toContain("Waiting for your phone");
  clients = [...clients, { id: "new-phone", label: "New phone", deviceType: "mobile", os: "Android", scopes: [],
    createdAt: new Date().toISOString(), online: false }];
  await publishStatus();
  expect(container.querySelector("dialog")?.textContent).toContain("Pairing received");
  expect(container.querySelector("dialog svg[role=img]")).toBeNull();
  expect(container.querySelector("dialog")?.textContent).not.toContain("New phone connected");
  clients = clients.map(client => ({ ...client, online: true }));
  await publishStatus();
  expect(container.querySelector("dialog")?.textContent).toContain("New phone connected");
  expect(container.querySelector("dialog svg[role=img]")).toBeNull();
  expect(pairingCalls).toBe(1);
});

test("allows retrying connection preparation without closing the dialog", async () => {
  testWindow.location.hash = "android-remote/pair";
  await mount();
  const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("dialog button"))
    .find(button => button.textContent?.includes("Prepare connection / retry"));
  expect(retry).toBeTruthy();
  await act(async () => { retry!.click(); });
  expect(settingsWrites).toEqual([{ controlEnabled: true }]);
  expect(container.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
});

test("a registered phone that never connects can retry with a fresh QR", async () => {
  readyTunnel();
  testWindow.location.hash = "android-remote/pair";
  await mount();
  clients = [{ id: "incomplete-phone", label: "Incomplete phone", deviceType: "mobile", os: "Android", scopes: [],
    createdAt: new Date().toISOString(), online: false }];
  await publishStatus();
  expect(container.querySelector("dialog")?.textContent).toContain("Pairing received");
  const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("dialog button"))
    .find(button => button.textContent?.includes("Create new code"));
  await act(async () => { retry!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 30)); });
  expect(pairingCalls).toBe(2);
  expect(container.querySelector("dialog svg[role=img]")).toBeTruthy();
  clients = clients.map(client => ({ ...client, online: true }));
  await publishStatus();
  expect(container.querySelector("dialog")?.textContent).toContain("Waiting for your phone");
  expect(container.querySelector("dialog")?.textContent).not.toContain("New phone connected");
});

test("failed QR creation shows recovery instead of claiming it is still preparing", async () => {
  readyTunnel();
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
    if (url === "/api/android-remote/pairing") throw new Error("offline");
    return originalFetch(url, init);
  } });
  testWindow.location.hash = "android-remote/pair";
  await mount();
  const dialog = container.querySelector("dialog");
  expect(dialog?.textContent).toContain("The pairing code could not be created");
  expect(dialog?.textContent).not.toContain("Preparing your connection");
  expect(dialog?.querySelector("svg[role=img]")).toBeNull();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("dialog button"))
    .find(button => button.textContent?.includes("Retry"));
  await act(async () => { retry!.click(); });
  expect(dialog?.querySelector("svg[role=img]")).toBeTruthy();
});

test("closing pairing aborts an outstanding QR request", async () => {
  readyTunnel();
  const originalFetch = globalThis.fetch;
  let signal: AbortSignal | null = null;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
    if (url !== "/api/android-remote/pairing") return originalFetch(url, init);
    signal = init?.signal ?? null;
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  } });
  testWindow.location.hash = "android-remote/pair";
  await mount();
  const close = container.querySelector<HTMLButtonElement>('dialog button[aria-label="Close"]');
  await act(async () => { close!.click(); });
  expect((signal as AbortSignal | null)?.aborted).toBe(true);
  expect(container.querySelector("dialog")).toBeNull();
});

test("a stalled QR request times out with a retry instead of an endless spinner", async () => {
  readyTunnel();
  const originalFetch = globalThis.fetch;
  const originalTimeout = testWindow.setTimeout.bind(testWindow);
  const timer = spyOn(testWindow, "setTimeout").mockImplementation((handler, delay, ...args) =>
    originalTimeout(handler, delay === 15_000 ? 5 : delay, ...args));
  try {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
      if (url !== "/api/android-remote/pairing") return originalFetch(url, init);
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timed out"))));
    } });
    testWindow.location.hash = "android-remote/pair";
    await mount();
    expect(container.querySelector("dialog")?.textContent).toContain("The pairing code could not be created");
    expect(container.querySelector("dialog")?.textContent).not.toContain("Creating a secure pairing code");
    expect(container.querySelector("dialog svg[role=img]")).toBeNull();
  } finally {
    timer.mockRestore();
  }
});

test("an expired QR is hidden with a clear action to create another", async () => {
  readyTunnel();
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
    if (url !== "/api/android-remote/pairing") return originalFetch(url, init);
    return Response.json({ version: 1, id: "expired-preview", expiresAt: new Date(Date.now() - 1_000).toISOString(),
      qrPayload: JSON.stringify({ cloudflareUrl: tunnelPublicUrl }) });
  } });
  testWindow.location.hash = "android-remote/pair";
  await mount();
  expect(container.querySelector("dialog")?.textContent).toContain("This pairing code has expired");
  expect(container.querySelector("dialog svg[role=img]")).toBeNull();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  const refresh = Array.from(container.querySelectorAll<HTMLButtonElement>("dialog button"))
    .find(button => button.textContent?.includes("Create new code"));
  await act(async () => { refresh!.click(); });
  expect(container.querySelector("dialog svg[role=img]")).toBeTruthy();
});

test("does not label a local-only QR as remote-ready if the tunnel fails during creation", async () => {
  readyTunnel();
  localNetworkEnabled = true;
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
    if (url !== "/api/android-remote/pairing") return originalFetch(url, init);
    return Response.json({ version: 1, id: "local-only", expiresAt: new Date(Date.now() + 300_000).toISOString(),
      qrPayload: JSON.stringify({ cloudflareUrl: null, localUrls: ["http://192.168.1.3:10105"] }) });
  } });
  testWindow.location.hash = "android-remote/pair";
  await mount();
  expect(container.querySelector("dialog svg[role=img]")).toBeNull();
  expect(container.querySelector("dialog")?.textContent).toContain("The pairing code could not be created");
  expect(container.querySelector("dialog")?.textContent).not.toContain("Remote fallback is ready");
});

test("renders honest gateway, address, desktop, and empty-phone states", async () => {
  await mount();
  expect(container.querySelector("h2")?.textContent).toBe("Android Remote");
  expect(container.textContent).toContain("Stopped");
  expect(container.textContent).toContain("http://127.0.0.1:10105");
  expect(container.textContent).toContain("Remodex test PC");
  expect(container.textContent).toContain("No phones paired yet");
});

test("keeps quiet poll status out of the Android Remote document flow", async () => {
  setClientResourceData(androidRemoteResourceKey(""), status());
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () => new Promise<Response>(() => {}),
  });

  await mount();

  const refreshStatus = container.querySelector<HTMLElement>(".android-remote-refresh-status");
  expect(refreshStatus).toBeTruthy();
  expect(refreshStatus?.getAttribute("role")).toBe("status");
  expect(refreshStatus?.textContent).toContain("Refreshing");
});

test("opens the Add phone readiness dialog and explains that control must be enabled", async () => {
  await mount();
  const add = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.includes("Add phone"));
  expect(add).toBeTruthy();
  await act(async () => { add!.click(); });
  const dialog = container.querySelector("dialog");
  expect(dialog?.open).toBe(true);
  expect(dialog?.querySelector("button.btn-icon svg")).toBeTruthy();
  expect(dialog?.textContent).toContain("Android gateway is stopped");
  expect(dialog?.textContent).toContain("Remote control must be enabled");
  expect(pairingCalls).toBe(0);
});

test("renders a real pairing QR code after the public tunnel is verified", async () => {
  readyTunnel();
  await mount();
  const add = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.includes("Add phone"));
  await act(async () => { add!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 30)); });
  expect(pairingCalls).toBe(1);
  expect(container.querySelector("dialog svg[role=img]")).toBeTruthy();
  expect(container.textContent).toContain("Scan with the Remodex app");
  expect(container.textContent).toContain("Code expires in");
});

test("the onboarding deep link opens a fresh pairing QR automatically", async () => {
  readyTunnel();
  testWindow.location.hash = "android-remote/pair";
  await mount();
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 30)); });

  expect(container.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
  expect(pairingCalls).toBe(1);
  expect(container.querySelector("dialog svg[role=img]")).toBeTruthy();

  const close = Array.from(container.querySelectorAll<HTMLButtonElement>("dialog button"))
    .find(button => button.textContent?.trim() === "Close");
  await act(async () => { close!.click(); });
  expect(testWindow.location.hash).toBe("#android-remote");
});

test("the pairing deep link opens after Android Remote is already mounted", async () => {
  readyTunnel();
  await mount();
  expect(container.querySelector("dialog")).toBeNull();

  await act(async () => {
    testWindow.location.hash = "android-remote/pair";
    testWindow.dispatchEvent(new testWindow.HashChangeEvent("hashchange") as never);
  });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 30)); });

  expect(container.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
  expect(pairingCalls).toBe(1);
  expect(container.querySelector("dialog svg[role=img]")).toBeTruthy();
});

test("refreshes the pairing QR and removes the previous one while creating a replacement", async () => {
  readyTunnel();
  await mount();
  const add = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.includes("Add phone"));
  await act(async () => { add!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 30)); });

  expect(pairingCalls).toBe(1);
  const firstQr = container.querySelector("dialog svg[role=img] path")?.getAttribute("d");
  expect(firstQr).toBeTruthy();
  const refresh = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.getAttribute("aria-label") === "Refresh QR code");
  expect(refresh).toBeTruthy();

  await act(async () => { refresh!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 30)); });

  expect(pairingCalls).toBe(2);
  const refreshedQr = container.querySelector("dialog svg[role=img] path")?.getAttribute("d");
  expect(refreshedQr).toBeTruthy();
  expect(refreshedQr).not.toBe(firstQr);
  expect(container.textContent).toContain("Code expires in");
});

for (const pending of ["starting", "checking", "error", "stopped"] as const) {
  test(`withholds the deep-linked QR while ${pending}, even if an older API offers localhost pairing`, async () => {
    controlEnabled = true;
    tunnelRuntimeStatus = pending;
    tunnelPublicUrl = "https://unverified.trycloudflare.com";
    testWindow.location.hash = "android-remote/pair";
    await mount();
    expect(container.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
    expect(container.textContent).toContain("No phone connection is ready yet");
    expect(container.querySelector("dialog svg[role=img]")).toBeNull();
    expect(pairingCalls).toBe(0);
    if (pending === "error") {
      expect(container.querySelector("dialog")?.textContent).not.toContain("Preparing your connection");
      expect(container.querySelector(".android-remote-onboard-progress .spin-icon")).toBeNull();
    }

    readyTunnel();
    await publishStatus();
    expect(pairingCalls).toBe(1);
    expect(container.querySelector("dialog svg[role=img]")).toBeTruthy();
    expect(container.textContent).not.toContain("No phone connection is ready yet");
  });
}

test("discards a visible QR on connection failure and creates a fresh one on recovery", async () => {
  readyTunnel();
  testWindow.location.hash = "android-remote/pair";
  await mount();
  const firstQr = container.querySelector("dialog svg[role=img] path")?.getAttribute("d");
  expect(firstQr).toBeTruthy();
  tunnelRuntimeStatus = "error";
  tunnelRuntimeError = "verification_failed";
  await publishStatus();
  expect(container.querySelector("dialog svg[role=img]")).toBeNull();
  expect(pairingCalls).toBe(1);
  readyTunnel();
  await publishStatus();
  expect(pairingCalls).toBe(2);
  const nextQr = container.querySelector("dialog svg[role=img] path")?.getAttribute("d");
  expect(nextQr).toBeTruthy();
  expect(nextQr).not.toBe(firstQr);
});

test("replaces the QR when the verified public address changes", async () => {
  readyTunnel();
  testWindow.location.hash = "android-remote/pair";
  await mount();
  const firstQr = container.querySelector("dialog svg[role=img] path")?.getAttribute("d");
  expect(firstQr).toBeTruthy();
  tunnelPublicUrl = "https://replacement.trycloudflare.com";
  await publishStatus();
  expect(pairingCalls).toBe(2);
  const nextQr = container.querySelector("dialog svg[role=img] path")?.getAttribute("d");
  expect(nextQr).toBeTruthy();
  expect(nextQr).not.toBe(firstQr);
});

for (const transition of ["failure", "replacement"] as const) {
  test(`ignores a late pairing response after tunnel ${transition}`, async () => {
    readyTunnel();
    testWindow.location.hash = "android-remote/pair";
    const originalFetch = globalThis.fetch;
    let resolveOld!: () => void;
    let oldResponse: Response | undefined;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (url: string, init?: RequestInit) => {
        const response = await originalFetch(url, init);
        if (url === "/api/android-remote/pairing" && !oldResponse) {
          oldResponse = response;
          await new Promise<void>(resolve => { resolveOld = resolve; });
        }
        return response;
      },
    });
    await mount();
    expect(pairingCalls).toBe(1);
    expect(container.querySelector("dialog svg[role=img]")).toBeNull();
    if (transition === "failure") tunnelRuntimeStatus = "checking";
    else tunnelPublicUrl = "https://replacement.trycloudflare.com";
    await publishStatus();
    const currentQr = container.querySelector("dialog svg[role=img] path")?.getAttribute("d") ?? null;
    if (transition === "replacement") expect(currentQr).toBeTruthy();
    else expect(currentQr).toBeNull();
    await act(async () => { resolveOld(); });
    await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 30)); });
    expect(container.querySelector("dialog svg[role=img] path")?.getAttribute("d") ?? null).toBe(currentQr);
    expect(pairingCalls).toBe(transition === "replacement" ? 2 : 1);
  });
}

test("the Control this PC switch writes and publishes the saved value", async () => {
  await mount();
  const controlSwitch = container.querySelector<HTMLButtonElement>('button.switch[aria-label="Control this PC"]');
  expect(controlSwitch?.getAttribute("aria-pressed")).toBe("false");
  await act(async () => { controlSwitch!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 20)); });
  expect(settingsWrites).toEqual([{ controlEnabled: true }]);
  expect(container.querySelector<HTMLButtonElement>('button.switch[aria-label="Control this PC"]')?.getAttribute("aria-pressed")).toBe("true");
});

test("shows address lookup failures without claiming a blocked port or a live connection", async () => {
  controlEnabled = true;
  tunnelRuntimeStatus = "checking";
  tunnelRuntimePhase = "activating";
  tunnelPublicUrl = "https://lookup-pending.trycloudflare.com";
  await mount();
  expect(container.textContent).toContain("Address lookup pending");
  await act(async () => { container.querySelector<HTMLInputElement>('input[value="quick"]')!.click(); });
  expect(container.textContent).toContain("This computer cannot currently look up the tunnel address");
  expect(container.textContent).not.toContain("allow outbound TCP/UDP");
  expect(container.textContent).not.toContain("Verified public address");
});

test.each([10115, 17115])("manual tunnel instructions use the actual gateway port %s", async (port) => {
  gatewayPort = port;
  await mount();
  await act(async () => { container.querySelector<HTMLInputElement>('input[value="named"]')!.click(); });
  const note = container.querySelector(".android-remote-manual-setup .android-remote-tunnel-guide-note");
  expect(note?.textContent).toContain(`http://127.0.0.1:${port}`);
  expect(note?.textContent).not.toContain(":10105");
  expect(container.querySelector(".android-remote-gateway-row")?.textContent).toContain(`port ${port}`);
});

test("defaults to Local and explains all three connection choices", async () => {
  await mount();
  const quick = container.querySelector<HTMLInputElement>('input[name="android-tunnel-mode"][value="quick"]');
  const named = container.querySelector<HTMLInputElement>('input[name="android-tunnel-mode"][value="named"]');
  expect(container.querySelector<HTMLInputElement>('input[value="local"]')?.checked).toBe(true);
  expect(quick?.checked).toBe(false);
  expect(container.querySelectorAll('input[name="android-tunnel-mode"]')).toHaveLength(3);
  expect(tunnelWrites).toEqual([]);
  await act(async () => { quick!.click(); });
  expect(container.textContent).toContain("No domain needed");
  expect(container.textContent).toContain("Advanced");
  expect(container.textContent).toContain("What's the difference?");
  expect(container.textContent).toContain("no Cloudflare account, domain, or token");
  expect(container.textContent).toContain("without an uptime SLA");
  expect(container.textContent).toContain("encrypted Cloudflare Tunnel");

  await act(async () => { named!.click(); });
  expect(container.textContent).toContain("Automatic setup");
  expect(container.textContent).toContain("Create the Cloudflare token once");
  expect(container.textContent).toContain("Create Custom Token → Get started");
  expect(container.textContent).toContain("Account · Cloudflare Tunnel · Edit");
  expect(container.textContent).toContain("Zone · DNS · Edit");
  expect(container.textContent).toContain("Zone · Zone · Read");
  expect(container.textContent).toContain("Cloudflare shows it only once");
  expect(container.querySelector<HTMLAnchorElement>('a[href="https://dash.cloudflare.com/profile/api-tokens"]')).toBeTruthy();
  const tokenGuide = container.querySelector<HTMLDetailsElement>("details.android-remote-cloudflare-token-guide");
  expect(tokenGuide?.open).toBe(false);
  await act(async () => { tokenGuide!.querySelector("summary")!.click(); });
  expect(tokenGuide?.open).toBe(true);
  await act(async () => { tokenGuide!.querySelector("summary")!.click(); });
  expect(tokenGuide?.open).toBe(false);
  expect(container.textContent).toContain("Advanced manual setup");
  expect(container.querySelector<HTMLInputElement>('input[placeholder="Paste a scoped API token"]')).toBeTruthy();
  expect(container.querySelector<HTMLInputElement>('input[placeholder="codex.example.com"]')).toBeTruthy();
});

test("keeps the existing hostname and connector-token fields under Advanced manual setup", async () => {
  tunnelMode = "named";
  tunnelHostname = "codex.example.com";
  tunnelTokenSaved = true;
  await mount();
  await act(async () => { container.querySelector<HTMLInputElement>('input[value="named"]')!.click(); });
  const advanced = Array.from(container.querySelectorAll<HTMLElement>("summary"))
    .find(summary => summary.textContent?.includes("Advanced manual setup"));
  await act(async () => { advanced!.click(); });
  const save = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.includes("Save manual setup"));
  expect(save?.disabled).toBe(false);
  await act(async () => { save!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 20)); });
  expect(tunnelWrites).toEqual([{
    mode: "named",
    hostname: "codex.example.com",
  }]);
});

test("switching from a Named domain applies Quick Tunnel immediately", async () => {
  tunnelMode = "named";
  tunnelHostname = "codex.example.com";
  tunnelTokenSaved = true;
  tunnelRuntimeStatus = "ready";
  await mount();

  const quick = container.querySelector<HTMLInputElement>(
    'input[name="android-tunnel-mode"][value="quick"]',
  );
  await act(async () => {
    quick!.click();
    await new Promise(resolve => testWindow.setTimeout(resolve, 20));
  });

  expect(tunnelWrites).toEqual([{ mode: "quick" }]);
  expect(quick?.checked).toBe(true);
  expect(container.textContent).not.toContain("codex.example.com");
});

test("discovers a Cloudflare domain and provisions a random subdomain", async () => {
  await mount();
  const named = container.querySelector<HTMLInputElement>('input[name="android-tunnel-mode"][value="named"]');
  await act(async () => { named!.click(); });
  const apiTokenInput = container.querySelector<HTMLInputElement>('input[placeholder="Paste a scoped API token"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(apiTokenInput), "value")!
      .set!.call(apiTokenInput, "temporary-cloudflare-api-token");
    (apiTokenInput as unknown as { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue("");
    apiTokenInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
    apiTokenInput.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as never);
    await Promise.resolve();
  });
  const authorize = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.includes("Connect Cloudflare"));
  expect(authorize?.disabled).toBe(false);
  await act(async () => { authorize!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 20)); });

  expect(cloudflareDiscoverTokens).toEqual(["temporary-cloudflare-api-token"]);
  expect(container.textContent).toContain("Cloudflare authorized");
  expect(container.textContent).toContain("Example account");
  expect(container.textContent).toContain(".example.com");
  expect(container.textContent).toContain("Keep the generated random name");
  const generatedSubdomain = container.querySelector<HTMLInputElement>(".android-remote-subdomain-input input")?.value;
  expect(generatedSubdomain).toMatch(/^rmx-[0-9a-f]{10}$/);
  const connect = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.includes("Connect domain"));
  expect(connect?.disabled).toBe(false);
  await act(async () => { connect!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 20)); });

  expect(cloudflareProvisionWrites).toEqual([{
    apiToken: "temporary-cloudflare-api-token",
    accountId: "a".repeat(32),
    zoneId: "b".repeat(32),
    hostname: `${generatedSubdomain}.example.com`,
  }]);
  expect(container.querySelector<HTMLInputElement>('input[placeholder="Paste a scoped API token"]')?.value).toBe("");
  expect(container.textContent).toContain("Tunnel and DNS configured");
  const progressRows = Array.from(container.querySelectorAll<HTMLElement>(".android-remote-cloudflare-progress-row"));
  expect(progressRows[1]?.classList.contains("complete")).toBe(true);
  expect(progressRows[2]?.classList.contains("active")).toBe(true);
  expect(progressRows[2]?.querySelector("svg.spin-icon")).toBeTruthy();
  expect(container.textContent).toContain("Connect another domain");
  expect(container.textContent).toContain("Remove domain");
  const changeDomain = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.includes("Connect another domain"));
  await act(async () => { changeDomain!.click(); await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
  expect(testWindow.document.activeElement).toBe(container.querySelector<HTMLInputElement>('input[placeholder="Paste a scoped API token"]'));
  const disconnectDomain = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.includes("Remove domain"));
  await act(async () => { disconnectDomain!.click(); await new Promise(resolve => testWindow.setTimeout(resolve, 20)); });
  expect(deletedUrls).toContain("/api/android-remote/tunnel/domain");
  expect(container.querySelector<HTMLInputElement>('input[name="android-tunnel-mode"][value="quick"]')?.checked).toBe(true);
});

test("the Named Tunnel API adapter sends a replacement connector token", async () => {
  await updateAndroidRemoteTunnel("", {
    mode: "named",
    hostname: "codex.example.com",
    token: "private-cloudflare-connector-token",
  });
  expect(tunnelWrites).toEqual([{
    mode: "named",
    hostname: "codex.example.com",
    token: "private-cloudflare-connector-token",
  }]);
});

test("rejects a malformed phone row instead of rendering unsafe server data", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => new Response(JSON.stringify({ ...status(), clients: [{}] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await mount();
  expect(container.textContent).toContain("Android Remote settings could not be loaded.");
});

test("renders a phone's permissions and revokes only that client", async () => {
  clients = [{
    id: "phone-1",
    label: "Pixel test phone",
    deviceType: "mobile",
    os: "Android 16",
    address: "192.168.1.8",
    scopes: ["tasks.read", "tasks.write"],
    createdAt: "2026-08-10T00:00:00.000Z",
    lastSeenAt: "2026-08-10T01:00:00.000Z",
    online: false,
  }];
  Object.defineProperty(testWindow, "confirm", { configurable: true, value: () => true });
  await mount();

  expect(container.textContent).toContain("Pixel test phone");
  expect(container.textContent).toContain("tasks.read");
  const revoke = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find(button => button.textContent?.includes("Revoke"));
  expect(revoke).toBeTruthy();
  await act(async () => { revoke!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 20)); });

  expect(deletedUrls).toEqual(["/api/android-remote/clients/phone-1"]);
  expect(container.textContent).not.toContain("Pixel test phone");
});

test("the phone QR button reconnects that authorization without revoking it on opening", async () => {
  readyTunnel();
  clients = [{ id: "phone-1", label: "Vivo test phone", deviceType: "mobile", os: "android", scopes: [],
    createdAt: new Date().toISOString(), online: false }];
  await mount();
  const qrButton = container.querySelector<HTMLButtonElement>('button[aria-label="Reconnect Vivo test phone"]');
  expect(qrButton).not.toBeNull();
  await act(async () => { qrButton!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 30)); });
  expect(pairingTargets).toEqual(["phone-1"]);
  expect(deletedUrls).toEqual([]);
  expect(clients).toHaveLength(1);
  expect(container.querySelector("dialog")?.textContent).toContain("Reconnect Vivo test phone");
  expect(container.querySelector("dialog")?.textContent).toContain("only after pairing succeeds");
  expect(container.querySelector("dialog svg[role=img]")).not.toBeNull();
  clients = [{ ...clients[0]!, id: "phone-repaired", online: true }];
  await publishStatus();
  expect(container.querySelector("dialog")?.textContent).toContain("New phone connected");
  expect(container.querySelectorAll(".android-remote-client-row:not(.desktop)")).toHaveLength(1);
  expect(pairingCalls).toBe(1);
});

test("the desktop QR button opens normal pairing without selecting an existing phone", async () => {
  readyTunnel();
  await mount();
  const qrButton = container.querySelector<HTMLButtonElement>('.android-remote-client-row.desktop button[aria-label="Add phone"]');
  expect(qrButton).not.toBeNull();
  await act(async () => { qrButton!.click(); });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 30)); });
  expect(pairingTargets).toEqual([null]);
  expect(container.querySelector("dialog svg[role=img]")).not.toBeNull();
});

test("Local is selected inside Connection methods and its switch never changes the temporary tunnel", async () => {
  readyTunnel();
  localNetworkEnabled = true;
  await mount();
  expect(container.querySelector<HTMLInputElement>('input[value="local"]')?.checked).toBe(true);
  expect(container.querySelector("#android-remote-tunnel-heading")?.closest("details")).toBeNull();
  const toggle = container.querySelector<HTMLButtonElement>('button.switch[aria-label="Local"]');
  expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => { toggle!.click(); });
  expect(settingsWrites).toEqual([{ localNetworkEnabled: false }]);
  expect(tunnelWrites).toEqual([]);
  expect(tunnelPublicUrl).toBe("https://verified.trycloudflare.com");
  await act(async () => { container.querySelector<HTMLInputElement>('input[value="quick"]')!.click(); });
  expect(container.textContent).toContain("https://verified.trycloudflare.com");
  await act(async () => { container.querySelector<HTMLInputElement>('input[value="local"]')!.click(); });
  expect(tunnelWrites).toEqual([]);
  expect(settingsWrites).toEqual([{ localNetworkEnabled: false }, { connectionChoice: "quick" }, { connectionChoice: "local" }]);
});

for (const choice of ["local", "quick", "named"] as const) {
  test(`restores the saved ${choice} selection after dashboard remount`, async () => {
    tunnelMode = "named";
    tunnelHostname = "saved.example.com";
    tunnelTokenSaved = true;
    localNetworkEnabled = true;
    await mount();
    expect(container.querySelector<HTMLInputElement>('input[value="named"]')?.checked).toBe(true);
    if (choice === "named") {
      await act(async () => { container.querySelector<HTMLInputElement>('input[value="local"]')!.click(); });
    }
    await act(async () => { container.querySelector<HTMLInputElement>(`input[value="${choice}"]`)!.click(); });
    expect(connectionChoice).toBe(choice);
    await act(async () => { root!.unmount(); root = null; });
    clearClientResourceStoresForTests();
    await mount();
    expect(container.querySelector<HTMLInputElement>(`input[value="${choice}"]`)?.checked).toBe(true);
    expect(localNetworkEnabled).toBe(true);
    if (choice !== "quick") expect(tunnelWrites).toEqual([]);
  });
}

test("saved Custom domain survives a temporary tunnel error and status refresh", async () => {
  connectionChoice = "named";
  tunnelMode = "named";
  tunnelHostname = "saved.example.com";
  tunnelRuntimeStatus = "error";
  tunnelRuntimeError = "verification_failed";
  await mount();
  expect(container.querySelector<HTMLInputElement>('input[value="named"]')?.checked).toBe(true);
  tunnelRuntimeStatus = "ready";
  tunnelRuntimeError = null;
  await publishStatus();
  expect(container.querySelector<HTMLInputElement>('input[value="named"]')?.checked).toBe(true);
  expect(settingsWrites).toEqual([]);
});

test("a failed selection save restores the saved option and shows an error", async () => {
  await mount();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/settings') && init?.method === 'PUT') return new Response('{"error":"Save failed"}', {status: 500});
    return originalFetch(input, init);
  }) as typeof fetch;
  await act(async () => { container.querySelector<HTMLInputElement>('input[value="named"]')!.click(); });
  expect(container.querySelector<HTMLInputElement>('input[value="local"]')?.checked).toBe(true);
  expect(connectionChoice).toBeUndefined();
  expect(container.textContent).toContain("The Android Remote change could not be saved. Try again.");
});
