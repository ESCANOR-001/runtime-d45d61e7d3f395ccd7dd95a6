import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  OsAndroidRemoteCloudflareSecretStore,
  type AndroidRemoteCloudflareSecretStore,
} from "../src/android-remote/cloudflare-secret";
import {
  ManagedAndroidRemoteCloudflareTunnel,
  extractQuickTunnelUrl,
  normalizeNamedTunnelHostname,
  validateCloudflareTunnelToken,
  type AndroidRemoteCloudflareTunnelDeps,
} from "../src/android-remote/cloudflare-tunnel";
import {
  CLOUDFLARED_VERSION,
  cloudflaredReleaseAsset,
} from "../src/android-remote/cloudflared";
import {
  CloudflareProvisioningError,
  ManagedAndroidRemoteCloudflareProvisioner,
} from "../src/android-remote/cloudflare-provisioning";
import type { AndroidRemoteSettings } from "../src/android-remote/store";

class MemorySecretStore implements AndroidRemoteCloudflareSecretStore {
  token: string | null = null;

  async getToken(): Promise<string | null> {
    return this.token;
  }

  async setToken(token: string): Promise<void> {
    this.token = token;
  }

  async removeToken(): Promise<void> {
    this.token = null;
  }
}

function output(text = ""): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function fakeProcess(text = "", registered = true) {
  let resolveExit!: (code: number) => void;
  let exited = false;
  const exit = new Promise<number>(resolve => { resolveExit = resolve; });
  return {
    stdout: output(text + (registered ? "\nINF Registered tunnel connection connIndex=0 protocol=http2\n" : "")),
    stderr: output(),
    exited: exit,
    kill() {
      if (exited) return;
      exited = true;
      resolveExit(0);
    },
  };
}

function gatewayFetch(url: string | URL | Request): Promise<Response> {
  const path = new URL(url instanceof Request ? url.url : url).pathname;
  const body = path === "/healthz"
    ? { status: "ready", service: "opencodex-android-remote" }
    : { environmentId: "environment-test" };
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

function controlledProcess() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const child = fakeProcess("", false);
  return {
    ...child,
    stdout: new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } }),
    emit(text: string) { writer.enqueue(new TextEncoder().encode(text)); },
    kill() { child.kill(); },
  };
}

const quickInput = {
  enabled: true, port: 10105, expectedEnvironmentId: "environment-test",
  settings: { controlEnabled: true, keepAwake: false, tunnelMode: "quick" } as AndroidRemoteSettings,
};

test.each(["quick", "named"] as const)("%s tunnels refuse dashboard, private Codex, and preview ports", async tunnelMode => {
  for (const port of [10100, 10106, 10115]) {
    let launches = 0;
    const child = fakeProcess();
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), tunnelDeps(child, {
      spawn: () => { launches += 1; return child; },
    }));
    try {
      await tunnel.apply({ ...quickInput, port, settings: { ...quickInput.settings, tunnelMode } });
      expect(tunnel.state()).toMatchObject({ status: "error", publicUrl: null, error: "tunnel_failed" });
      expect(launches).toBe(0);
    } finally {
      await tunnel.stop();
    }
  }
});

function tunnelDeps(child: ReturnType<typeof fakeProcess>, overrides: Partial<AndroidRemoteCloudflareTunnelDeps> = {}): AndroidRemoteCloudflareTunnelDeps {
  return {
    resolveCloudflared: async () => ({ path: "/test/cloudflared", source: "managed", version: CLOUDFLARED_VERSION }),
    spawn: () => child, fetch: gatewayFetch as typeof fetch,
    sleep: () => new Promise(() => {}), ...overrides,
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(2);
  }
  throw new Error("Expected tunnel transition was not observed");
}

async function waitForReady(tunnel: ManagedAndroidRemoteCloudflareTunnel): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (tunnel.state().status === "ready") return;
    await Bun.sleep(2);
  }
  throw new Error(`tunnel did not become ready: ${JSON.stringify(tunnel.state())}`);
}

async function waitForTunnelState(
  tunnel: ManagedAndroidRemoteCloudflareTunnel,
  status: "ready" | "error",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (tunnel.state().status === status) return;
    await Bun.sleep(2);
  }
  throw new Error(`tunnel did not become ${status}: ${JSON.stringify(tunnel.state())}`);
}

describe("Android Remote Cloudflare tunnel", () => {
  for (const mode of ["quick", "named"] as const) {
    test(`does not probe a ${mode} website until registration, including dashboard checks`, async () => {
      const child = controlledProcess();
      let requests = 0;
      const secrets = new MemorySecretStore();
      secrets.token = "named-tunnel-secret-token-that-must-never-leak";
      const input = { ...quickInput, settings: { ...quickInput.settings, tunnelMode: mode, namedTunnelHostname: "codex.example.com" } };
      const tunnel = new ManagedAndroidRemoteCloudflareTunnel(secrets, tunnelDeps(child, {
        fetch: (async url => { requests += 1; return gatewayFetch(url); }) as typeof fetch,
      }));
      try {
        await tunnel.apply(input);
        child.emit("INF Your quick Tunnel has been created! https://registration-gate.trycloudflare.com\n");
        await until(() => tunnel.state().publicUrl !== null);
        await tunnel.check(input);
        expect(requests).toBe(0);
        expect(tunnel.state().status).toBe("starting");
        child.emit("INF Registered tunnel connec");
        await Bun.sleep(5);
        expect(requests).toBe(0);
        child.emit("tion connIndex=0 protocol=http2\n");
        await waitForReady(tunnel);
        expect(requests).toBe(2);
      } finally { await tunnel.stop(); }
    });
  }

  test("stopping before registration prevents late output from starting public checks", async () => {
    const child = controlledProcess();
    let requests = 0;
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), tunnelDeps(child, {
      fetch: (async url => { requests += 1; return gatewayFetch(url); }) as typeof fetch,
    }));
    await tunnel.apply(quickInput);
    child.emit("https://stopped-gate.trycloudflare.com\n");
    await until(() => tunnel.state().publicUrl !== null);
    await tunnel.stop();
    child.emit("INF Registered tunnel connection connIndex=0 protocol=http2\n");
    await Bun.sleep(10);
    expect(requests).toBe(0);
    expect(tunnel.state().status).toBe("stopped");
  });

  test("flushes the Windows DNS cache before checking a registered public host", async () => {
    const child = fakeProcess("https://windows-cache.trycloudflare.com\n");
    let flushes = 0;
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), tunnelDeps(child, {
      platform: "win32",
      flushDnsCache: async () => { flushes += 1; },
    }));
    try {
      await tunnel.apply(quickInput);
      await waitForReady(tunnel);
      expect(flushes).toBe(1);
    } finally { await tunnel.stop(); }
  });

  test("repairs IPv4 and IPv6 DNS only after local DNS fails and public DNS succeeds", async () => {
    const child = fakeProcess("https://dns-repair.trycloudflare.com\n");
    let repaired = 0;
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), tunnelDeps(child, {
      platform: "win32",
      fetch: (async () => { throw Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" }); }) as typeof fetch,
      lookupHostname: async () => { throw Object.assign(new Error("router NXDOMAIN"), { code: "ENOTFOUND" }); },
      publicLookupHostname: async hostname => { expect(hostname).toBe("dns-repair.trycloudflare.com"); return ["104.21.36.219"]; },
      repairWindowsDns: async hostname => { expect(hostname).toBe("dns-repair.trycloudflare.com"); repaired += 1; },
    }));
    try {
      await tunnel.apply(quickInput);
      await until(() => repaired === 1);
      expect(tunnel.state()).toMatchObject({ phase: "activating", publicUrl: "https://dns-repair.trycloudflare.com" });
    } finally { await tunnel.stop(); }
  });

  for (const [label, error] of [
    ["Error.code", Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" })],
    ["nested Error.cause", new Error("fetch failed", { cause: Object.assign(new Error("lookup failed"), { code: "EAI_AGAIN" }) })],
    ["plain error object", { code: "ENOTFOUND" }],
  ] as const) {
    test(`reports DNS failures from ${label} without a generic tunnel error`, async () => {
      const child = fakeProcess("https://dns-field.trycloudflare.com\n");
      const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), tunnelDeps(child, {
        fetch: (async () => { throw error; }) as typeof fetch,
        lookupHostname: async () => { throw new Error("A typed DNS failure needs no extra lookup"); },
      }));
      try {
        await tunnel.apply(quickInput);
        await until(() => tunnel.state().phase === "activating");
        expect(tunnel.state()).toMatchObject({ status: "checking", error: null, phase: "activating" });
      } finally { await tunnel.stop(); }
    });
  }

  for (const dnsFails of [true, false]) {
    test(`diagnoses ambiguous Windows ConnectionRefused correctly (DNS fails=${dnsFails})`, async () => {
      const child = fakeProcess("https://windows-dns.trycloudflare.com\n");
      let lookups = 0;
      const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), tunnelDeps(child, {
        fetch: (async () => { throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }); }) as typeof fetch,
        lookupHostname: async hostname => {
          expect(hostname).toBe("windows-dns.trycloudflare.com");
          lookups += 1;
          if (dnsFails) throw Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
          return { address: "104.16.230.132", family: 4 };
        },
      }));
      try {
        await tunnel.apply(quickInput);
        await until(() => lookups > 0);
        await Bun.sleep(5);
        expect(tunnel.state().phase).toBe(dnsFails ? "activating" : "connecting");
        expect(tunnel.state().status).not.toBe("ready");
      } finally { await tunnel.stop(); }
    });
  }

  test("keeps the same previously verified tunnel through repeated DNS failures and recovers it", async () => {
    const child = fakeProcess("https://stable-dns.trycloudflare.com\n");
    let failDns = false;
    let requests = 0;
    let spawns = 0;
    let releaseHealth!: () => void;
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), tunnelDeps(child, {
      spawn: () => { spawns += 1; return child; },
      fetch: (async url => {
        requests += 1;
        if (failDns) throw Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
        return gatewayFetch(url);
      }) as typeof fetch,
      sleep: ms => ms === 15_000 ? new Promise(resolve => { releaseHealth = resolve; }) : new Promise(() => {}),
    }));
    try {
      await tunnel.apply(quickInput);
      await waitForReady(tunnel);
      failDns = true;
      for (let i = 0; i < 4; i += 1) {
        const before = requests;
        releaseHealth();
        await until(() => requests >= before + 2 && tunnel.state().phase === "activating");
        await Bun.sleep(5);
      }
      await tunnel.check(quickInput);
      expect(spawns).toBe(1);
      expect(tunnel.state()).toMatchObject({ status: "checking", phase: "activating", error: null, publicUrl: "https://stable-dns.trycloudflare.com" });
      failDns = false;
      releaseHealth();
      await waitForReady(tunnel);
      expect(spawns).toBe(1);
    } finally { await tunnel.stop(); }
  });

  test("keeps the same previously verified tunnel through local setting changes and sustained HTTP failures", async () => {
    const child = fakeProcess("https://stable-network.trycloudflare.com\n");
    let failDns = false;
    let requests = 0;
    let spawns = 0;
    let releaseHealth!: () => void;
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), tunnelDeps(child, {
      spawn: () => { spawns += 1; return child; },
      fetch: (async url => {
        requests += 1;
        if (failDns) return new Response("unavailable", { status: 503 });
        return gatewayFetch(url);
      }) as typeof fetch,
      sleep: ms => ms === 15_000 ? new Promise(resolve => { releaseHealth = resolve; }) : new Promise(() => {}),
    }));
    try {
      await tunnel.apply(quickInput);
      await waitForReady(tunnel);
      for (const localNetworkEnabled of [true, false, true]) {
        await tunnel.apply({ ...quickInput, settings: { ...quickInput.settings, localNetworkEnabled } });
        expect(tunnel.state().status).toBe("ready");
        expect(spawns).toBe(1);
      }
      failDns = true;
      for (let i = 0; i < 4; i += 1) {
        const before = requests;
        releaseHealth();
        await until(() => requests >= before + 2 && tunnel.state().phase === "reconnecting");
        await Bun.sleep(5);
      }
      await tunnel.check(quickInput);
      expect(spawns).toBe(1);
      expect(tunnel.state()).toMatchObject({ status: "error", phase: "reconnecting", error: "verification_failed", publicUrl: "https://stable-network.trycloudflare.com" });
      failDns = false;
      releaseHealth();
      await waitForReady(tunnel);
      expect(spawns).toBe(1);
    } finally { await tunnel.stop(); }
  });

  for (const failure of ["process-exit"] as const) {
    test(`still replaces a failed connector after ${failure}`, async () => {
      const children = [fakeProcess("https://first-child.trycloudflare.com\n"), fakeProcess("https://next-child.trycloudflare.com\n")];
      let spawns = 0;
      let healthFails = false;
      let requests = 0;
      let releaseHealth!: () => void;
      const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), tunnelDeps(children[0]!, {
        spawn: () => children[spawns++]!,
        fetch: (async url => {
          requests += 1;
          return healthFails && spawns === 1 ? new Response("unavailable", { status: 503 }) : gatewayFetch(url);
        }) as typeof fetch,
        sleep: ms => ms === 15_000 ? new Promise(resolve => { releaseHealth = resolve; })
          : ms === 1_000 ? Promise.resolve() : new Promise(() => {}),
      }));
      try {
        await tunnel.apply(quickInput);
        await waitForReady(tunnel);
        if (failure === "process-exit") children[0]!.kill();
        else {
          healthFails = true;
          const before = requests;
          releaseHealth();
          await until(() => requests === before + 2 && tunnel.state().status === "error");
          await Bun.sleep(5);
          releaseHealth();
        }
        await until(() => spawns === 2 && tunnel.state().status === "ready");
        expect(tunnel.state().publicUrl).toBe("https://next-child.trycloudflare.com");
      } finally { await tunnel.stop(); }
    });
  }

  test("shares an in-flight check with the dashboard and does not publish after stop", async () => {
    const child = fakeProcess("https://flight-field.trycloudflare.com\n");
    let requests = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), tunnelDeps(child, {
      fetch: (async url => { requests += 1; await pending; return gatewayFetch(url); }) as typeof fetch,
    }));
    await tunnel.apply(quickInput);
    await until(() => requests === 2);
    const checking = tunnel.check(quickInput);
    expect(requests).toBe(2);
    await tunnel.stop();
    release();
    await checking;
    await Bun.sleep(5);
    expect(tunnel.state().status).toBe("stopped");
  });

  for (const path of ["/healthz", "/.well-known/t3/environment"]) {
    test(`requires exactly HTTP 200 from ${path} before readiness`, async () => {
      const child = fakeProcess("https://status-gate.trycloudflare.com\n");
      let responseStatus = 201;
      const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), tunnelDeps(child, {
        fetch: (async url => {
          const response = await gatewayFetch(url);
          return new URL(String(url)).pathname === path
            ? new Response(await response.text(), { status: responseStatus }) : response;
        }) as typeof fetch,
      }));
      try {
        await tunnel.apply(quickInput);
        await until(() => tunnel.state().status === "checking");
        await tunnel.check(quickInput);
        expect(tunnel.state().status).toBe("checking");
        responseStatus = 200;
        await tunnel.check(quickInput);
        expect(tunnel.state().status).toBe("ready");
      } finally { await tunnel.stop(); }
    });
  }

  test("rejects an HTTP 200 response from the wrong gateway instance", async () => {
    const child = fakeProcess("https://wrong-instance.trycloudflare.com\n");
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), tunnelDeps(child, {
      fetch: (async url => new URL(String(url)).pathname === "/healthz"
        ? gatewayFetch(url) : Response.json({ environmentId: "another-instance" })) as typeof fetch,
    }));
    try {
      await tunnel.apply(quickInput);
      await Bun.sleep(15);
      expect(tunnel.state().status).toBe("checking");
    } finally { await tunnel.stop(); }
  });

  test("bounds slow response bodies instead of hanging verification", async () => {
    const child = fakeProcess("https://slow-body.trycloudflare.com\n");
    let signal: AbortSignal | null | undefined;
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), tunnelDeps(child, {
      fetch: (async (_url, init) => {
        signal = init?.signal;
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }) as typeof fetch,
    }));
    try {
      await tunnel.apply(quickInput);
      await Bun.sleep(3_100);
      expect(signal?.aborted).toBe(true);
      expect(tunnel.state().status).not.toBe("ready");
    } finally { await tunnel.stop(); }
  }, 5_000);

  test("reads and wipes the plain byte arrays returned by Linux Secret Service", async () => {
    const secret = [...new TextEncoder().encode("connector-token-from-linux-keyring")];
    const store = new OsAndroidRemoteCloudflareSecretStore(async () => ({
      getSecret: async () => secret,
      setSecret: async () => undefined,
      deleteCredential: async () => true,
    }));

    expect(await store.getToken()).toBe("connector-token-from-linux-keyring");
    expect(secret.every(byte => byte === 0)).toBe(true);
  });

  test("pins managed cloudflared assets for every supported platform", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
      ["win32", "x64"],
      ["win32", "arm64"],
    ] as const) {
      const asset = cloudflaredReleaseAsset(platform, arch);
      expect(asset?.url).toContain(`/download/${CLOUDFLARED_VERSION}/`);
      expect(asset?.url.startsWith("https://")).toBe(true);
      expect(asset?.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(cloudflaredReleaseAsset("win32", "arm64")).toEqual(cloudflaredReleaseAsset("win32", "x64"));
    expect(cloudflaredReleaseAsset("win32", "arm64")?.url).toEndWith("cloudflared-windows-amd64.exe");
    expect(cloudflaredReleaseAsset("linux", "riscv64")).toBeNull();
  });

  test("accepts only safe public hostnames and bounded connector tokens", () => {
    expect(normalizeNamedTunnelHostname("Codex.Example.com.")).toBe("codex.example.com");
    expect(normalizeNamedTunnelHostname("https://opencodex.remodex.net/")).toBe("opencodex.remodex.net");
    for (const invalid of [
      "localhost",
      "127.0.0.1",
      "http://example.com",
      "https://example.com/path",
      "https://example.com?query=1",
      "https://user@example.com",
      "https://example.com:8443",
      "example.com/path",
      "bad_host.example",
    ]) {
      expect(() => normalizeNamedTunnelHostname(invalid)).toThrow();
    }
    const token = "connector-token-that-is-long-enough-for-cloudflare";
    expect(validateCloudflareTunnelToken(`  ${token}  `)).toBe(token);
    expect(() => validateCloudflareTunnelToken("short")).toThrow();
    expect(() => validateCloudflareTunnelToken(`${token} with-space`)).toThrow();
  });

  test("discovers, verifies, publishes, and stops a Quick Tunnel", async () => {
    const child = fakeProcess("INF Your quick Tunnel has been created! https://quiet-field.trycloudflare.com\n");
    const commands: string[][] = [];
    const deps: AndroidRemoteCloudflareTunnelDeps = {
      resolveCloudflared: async () => ({ path: "/test/cloudflared", source: "managed", version: CLOUDFLARED_VERSION }),
      spawn: command => {
        commands.push([...command]);
        return child;
      },
      fetch: gatewayFetch as typeof fetch,
      sleep: () => new Promise(() => {}),
      platform: "linux",
    };
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), deps);
    const settings: AndroidRemoteSettings = { controlEnabled: true, keepAwake: false, tunnelMode: "quick" };

    await tunnel.apply({ enabled: true, port: 10105, settings, expectedEnvironmentId: "environment-test" });
    await waitForReady(tunnel);

    expect(tunnel.state()).toEqual({
      mode: "quick",
      status: "ready",
      publicUrl: "https://quiet-field.trycloudflare.com",
      error: null,
    });
    expect(commands).toEqual([[
      "/test/cloudflared",
      "tunnel",
      "--url",
      "http://127.0.0.1:10105",
      "--no-autoupdate",
      "--protocol",
      "http2",
    ]]);

    await tunnel.stop();
    expect(tunnel.state().status).toBe("stopped");
  });

  test("uses HTTP/2 on Windows but does not trust a registration log as readiness", async () => {
    const child = fakeProcess([
      "INF Your quick Tunnel has been created! https://windows-field.trycloudflare.com",
      "INF Registered tunnel connection connIndex=0 protocol=http2",
      "",
    ].join("\n"));
    const commands: string[][] = [];
    const deps: AndroidRemoteCloudflareTunnelDeps = {
      resolveCloudflared: async () => ({ path: "C:\\Remodex\\cloudflared.exe", source: "managed", version: CLOUDFLARED_VERSION }),
      spawn: command => {
        commands.push([...command]);
        return child;
      },
      // Registration only proves that cloudflared reached the edge. The public
      // health and environment endpoints still have to answer.
      fetch: (async () => new Response("not ready", { status: 503 })) as typeof fetch,
      sleep: () => new Promise(() => {}),
      platform: "win32",
    };
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), deps);
    const settings: AndroidRemoteSettings = { controlEnabled: true, keepAwake: false, tunnelMode: "quick" };

    await tunnel.apply({ enabled: true, port: 10105, settings, expectedEnvironmentId: "environment-test" });
    await Bun.sleep(10);
    expect(tunnel.state().status).toBe("checking");
    expect(tunnel.state().publicUrl).toBe("https://windows-field.trycloudflare.com");

    expect(commands).toEqual([[
      "C:\\Remodex\\cloudflared.exe",
      "tunnel",
      "--url",
      "http://127.0.0.1:10105",
      "--no-autoupdate",
      "--protocol",
      "http2",
    ]]);
    await tunnel.stop();
  });

  test("keeps a connector alive when a failed precheck is followed by registration", async () => {
    const child = fakeProcess([
      "INF Your quick Tunnel has been created! https://recovering-field.trycloudflare.com",
      'INF precheck component="TCP Connectivity" status=fail target=region1.v2.argotunnel.com',
      "INF precheck complete hard_fail=true run_id=test",
      "INF Registered tunnel connection connIndex=0 protocol=http2",
      "",
    ].join("\n"));
    const commands: string[][] = [];
    const environments: Array<Record<string, string | undefined> | undefined> = [];
    const publishedStatuses: string[] = [];
    let verificationRound = 0;
    let quickUrlTimeoutSeen = false;
    const deps: AndroidRemoteCloudflareTunnelDeps = {
      resolveCloudflared: async () => ({ path: "/test/cloudflared", source: "managed", version: CLOUDFLARED_VERSION }),
      spawn: (command, environment) => {
        commands.push([...command]);
        environments.push(environment);
        return child;
      },
      fetch: (async input => {
        const url = new URL(input instanceof Request ? input.url : input);
        const currentRound = verificationRound;
        if (url.pathname === "/.well-known/t3/environment") verificationRound += 1;
        if (currentRound === 0) {
          await Bun.sleep(5);
          return new Response("not ready", { status: 503 });
        }
        return gatewayFetch(url);
      }) as typeof fetch,
      sleep: milliseconds => {
        if (milliseconds === 30_000 && !quickUrlTimeoutSeen) {
          quickUrlTimeoutSeen = true;
          return new Promise(() => {});
        }
        return milliseconds === 500 ? Promise.resolve() : new Promise(() => {});
      },
    };
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), deps);
    tunnel.subscribe(state => publishedStatuses.push(state.status));
    const settings: AndroidRemoteSettings = { controlEnabled: true, keepAwake: false, tunnelMode: "quick" };

    await tunnel.apply({ enabled: true, port: 10105, settings, expectedEnvironmentId: "environment-test" });
    await waitForReady(tunnel);

    expect(commands).toHaveLength(1);
    expect(environments[0]?.TUNNEL_NO_PRECHECKS).toBe("true");
    expect(publishedStatuses).not.toContain("error");
    expect(tunnel.state()).toEqual({
      mode: "quick",
      status: "ready",
      publicUrl: "https://recovering-field.trycloudflare.com",
      error: null,
    });
    await tunnel.stop();
  });

  test("falls back to QUIC when HTTP/2 cannot register a connector", async () => {
    const children = [
      fakeProcess("", false),
      fakeProcess("INF Registered tunnel connection connIndex=0 protocol=quic\n"),
    ];
    const commands: string[][] = [];
    let spawns = 0;
    let registrationTimeouts = 0;
    const secrets = new MemorySecretStore();
    secrets.token = "named-tunnel-secret-token-that-must-never-leak";
    const deps: AndroidRemoteCloudflareTunnelDeps = {
      resolveCloudflared: async () => ({ path: "/test/cloudflared", source: "managed", version: CLOUDFLARED_VERSION }),
      spawn: command => {
        commands.push([...command]);
        return children[spawns++]!;
      },
      fetch: (async input => {
        if (spawns < 2) return await new Promise<Response>(() => {});
        return gatewayFetch(input);
      }) as typeof fetch,
      sleep: milliseconds => {
        if (milliseconds === 45_000) {
          registrationTimeouts += 1;
          return registrationTimeouts === 1 ? Promise.resolve() : new Promise(() => {});
        }
        return Promise.resolve();
      },
    };
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(secrets, deps);
    const settings: AndroidRemoteSettings = {
      controlEnabled: true,
      keepAwake: false,
      tunnelMode: "named",
      namedTunnelHostname: "codex.example.com",
    };

    await tunnel.apply({ enabled: true, port: 10105, settings, expectedEnvironmentId: "environment-test" });
    await waitForReady(tunnel);

    expect(commands).toEqual([
      ["/test/cloudflared", "tunnel", "--no-autoupdate", "--protocol", "http2", "run"],
      ["/test/cloudflared", "tunnel", "--no-autoupdate", "--protocol", "quic", "run"],
    ]);
    await tunnel.stop();
  });

  test("keeps initial Cloudflare propagation in checking and reuses one Quick Tunnel URL", async () => {
    const child = fakeProcess("INF Your quick Tunnel has been created! https://steady-field.trycloudflare.com\n");
    const commands: string[][] = [];
    const requestedOrigins: string[] = [];
    const publishedStatuses: string[] = [];
    let verificationRound = 0;
    let quickUrlTimeoutSeen = false;
    const deps: AndroidRemoteCloudflareTunnelDeps = {
      resolveCloudflared: async () => ({ path: "/test/cloudflared", source: "managed", version: CLOUDFLARED_VERSION }),
      spawn: command => {
        commands.push([...command]);
        return child;
      },
      fetch: (async input => {
        const url = new URL(input instanceof Request ? input.url : input);
        requestedOrigins.push(url.origin);
        const currentRound = verificationRound;
        if (url.pathname === "/.well-known/t3/environment") verificationRound += 1;
        if (currentRound < 3) return new Response("not ready", { status: 503 });
        return gatewayFetch(url);
      }) as typeof fetch,
      sleep: milliseconds => {
        // The first 30s sleep races URL discovery and must remain pending. All
        // propagation delays resolve immediately so the test exercises retries.
        if (milliseconds === 30_000 && !quickUrlTimeoutSeen) {
          quickUrlTimeoutSeen = true;
          return new Promise(() => {});
        }
        if (milliseconds === 45_000) return new Promise(() => {});
        return Promise.resolve();
      },
      platform: "linux",
    };
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), deps);
    tunnel.subscribe(state => publishedStatuses.push(state.status));
    const settings: AndroidRemoteSettings = { controlEnabled: true, keepAwake: false, tunnelMode: "quick" };

    await tunnel.apply({ enabled: true, port: 10105, settings, expectedEnvironmentId: "environment-test" });
    await waitForReady(tunnel);

    expect(commands).toHaveLength(1);
    expect(new Set(requestedOrigins)).toEqual(new Set(["https://steady-field.trycloudflare.com"]));
    expect(publishedStatuses).toContain("checking");
    expect(publishedStatuses).not.toContain("error");
    expect(tunnel.state().publicUrl).toBe("https://steady-field.trycloudflare.com");

    await tunnel.stop();
  });

  test("reports a real readiness failure only after the propagation grace period", async () => {
    const child = fakeProcess("INF Your quick Tunnel has been created! https://slow-field.trycloudflare.com\n");
    let sleepCalls = 0;
    let quickUrlTimeoutSeen = false;
    const deps: AndroidRemoteCloudflareTunnelDeps = {
      resolveCloudflared: async () => ({ path: "/test/cloudflared", source: "managed", version: CLOUDFLARED_VERSION }),
      spawn: () => child,
      fetch: (async () => new Response("not ready", { status: 503 })) as typeof fetch,
      sleep: milliseconds => {
        if (milliseconds === 30_000 && !quickUrlTimeoutSeen) {
          quickUrlTimeoutSeen = true;
          return new Promise(() => {});
        }
        // Seven propagation delays complete. The eighth verification publishes
        // the error and then blocks on its next retry without replacing child.
        if (milliseconds === 45_000) return new Promise(() => {});
        sleepCalls += 1;
        return sleepCalls <= 7 ? Promise.resolve() : new Promise(() => {});
      },
    };
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), deps);
    const settings: AndroidRemoteSettings = { controlEnabled: true, keepAwake: false, tunnelMode: "quick" };

    await tunnel.apply({ enabled: true, port: 10105, settings, expectedEnvironmentId: "environment-test" });
    await waitForTunnelState(tunnel, "error");

    expect(tunnel.state()).toEqual({
      mode: "quick",
      status: "error",
      publicUrl: "https://slow-field.trycloudflare.com",
      error: "verification_failed",
      phase: "reconnecting",
    });

    await tunnel.stop();
  });

  test("recovers the same Quick Tunnel when Cloudflare becomes reachable after the grace period", async () => {
    const child = fakeProcess("INF Your quick Tunnel has been created! https://late-field.trycloudflare.com\n");
    const commands: string[][] = [];
    const publishedStatuses: string[] = [];
    let verificationRound = 0;
    let quickUrlTimeoutSeen = false;
    const deps: AndroidRemoteCloudflareTunnelDeps = {
      resolveCloudflared: async () => ({ path: "/test/cloudflared", source: "managed", version: CLOUDFLARED_VERSION }),
      spawn: command => {
        commands.push([...command]);
        return child;
      },
      fetch: (async input => {
        const url = new URL(input instanceof Request ? input.url : input);
        const currentRound = verificationRound;
        if (url.pathname === "/.well-known/t3/environment") verificationRound += 1;
        if (currentRound < 10) return new Response("not ready", { status: 503 });
        return gatewayFetch(url);
      }) as typeof fetch,
      sleep: milliseconds => {
        if (milliseconds === 30_000 && !quickUrlTimeoutSeen) {
          quickUrlTimeoutSeen = true;
          return new Promise(() => {});
        }
        if (milliseconds === 45_000) return new Promise(() => {});
        return Promise.resolve();
      },
    };
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(new MemorySecretStore(), deps);
    tunnel.subscribe(state => publishedStatuses.push(state.status));
    const settings: AndroidRemoteSettings = { controlEnabled: true, keepAwake: false, tunnelMode: "quick" };

    await tunnel.apply({ enabled: true, port: 10105, settings, expectedEnvironmentId: "environment-test" });
    await waitForReady(tunnel);

    expect(commands).toHaveLength(1);
    expect(publishedStatuses).toContain("error");
    expect(publishedStatuses.at(-1)).toBe("ready");
    expect(tunnel.state().publicUrl).toBe("https://late-field.trycloudflare.com");

    await tunnel.stop();
  });

  test("keeps a Named Tunnel token out of process arguments and public state", async () => {
    const token = "named-tunnel-secret-token-that-must-never-leak";
    const secrets = new MemorySecretStore();
    secrets.token = token;
    const child = fakeProcess();
    let command: readonly string[] = [];
    let environment: Record<string, string | undefined> | undefined;
    const deps: AndroidRemoteCloudflareTunnelDeps = {
      resolveCloudflared: async () => ({ path: "/test/cloudflared", source: "managed", version: CLOUDFLARED_VERSION }),
      spawn: (nextCommand, nextEnvironment) => {
        command = [...nextCommand];
        environment = nextEnvironment;
        return child;
      },
      fetch: gatewayFetch as typeof fetch,
      sleep: () => new Promise(() => {}),
      platform: "linux",
    };
    const tunnel = new ManagedAndroidRemoteCloudflareTunnel(secrets, deps);
    const settings: AndroidRemoteSettings = {
      controlEnabled: true,
      keepAwake: false,
      tunnelMode: "named",
      namedTunnelHostname: "codex.example.com",
    };

    await tunnel.apply({ enabled: true, port: 10105, settings, expectedEnvironmentId: "environment-test" });
    await waitForReady(tunnel);

    expect(command).toEqual([
      "/test/cloudflared",
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "run",
    ]);
    expect(command.join(" ")).not.toContain(token);
    expect(environment?.TUNNEL_TOKEN).toBe(token);
    expect(JSON.stringify(tunnel.state())).not.toContain(token);
    expect(await tunnel.configuration(settings)).toEqual({
      mode: "named",
      namedHostname: "codex.example.com",
      hasNamedTunnelToken: true,
    });

    await tunnel.stop();
  });

  test("extracts only canonical Quick Tunnel HTTPS addresses", () => {
    expect(extractQuickTunnelUrl("url=https://field-name.trycloudflare.com ok")).toBe("https://field-name.trycloudflare.com");
    expect(extractQuickTunnelUrl("http://field-name.trycloudflare.com")).toBeNull();
    expect(extractQuickTunnelUrl("https://trycloudflare.com.evil.example")).toBeNull();
  });
});

const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);
const tunnelId = "c1744f8b-faa1-48a4-9e5c-02ac921467fa";
const dnsId = "d".repeat(32);
const apiToken = "cloudflare-api-token-that-is-scoped-for-tests";
const connectorToken = "cloudflare-connector-token-that-is-long-enough-for-tests";

function cloudflareResponse(result: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("Android Remote Cloudflare automatic provisioning", () => {
  test.each([0, -1, 10100, 10106, 10115, 65536, NaN])("rejects non-gateway port %s without contacting Cloudflare", async gatewayPort => {
    let requests = 0;
    const provisioner = new ManagedAndroidRemoteCloudflareProvisioner({
      fetch: (async () => { requests += 1; throw new Error("unexpected request"); }) as typeof fetch,
    });
    await expect(provisioner.provision({ apiToken, accountId, zoneId, hostname: "opencodex.example.com", gatewayPort }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(requests).toBe(0);
  });

  test("discovers bounded account and domain metadata without returning the API token", async () => {
    const requests: Request[] = [];
    const provisioner = new ManagedAndroidRemoteCloudflareProvisioner({
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/user/tokens/verify")) return cloudflareResponse({ status: "active" });
        if (path.endsWith("/zones")) {
          return new Response(JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: [{
              id: zoneId,
              name: "Example.com",
              account: { id: accountId, name: "Example account" },
              status: "pending",
              name_servers: ["aria.ns.cloudflare.com", "bob.ns.cloudflare.com"],
            }],
            result_info: { page: 1, total_pages: 1 },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        throw new Error(`unexpected test request: ${request.url}`);
      }) as typeof fetch,
    });

    const discovery = await provisioner.discover(apiToken);
    expect(discovery).toEqual({
      version: 1,
      accounts: [{ id: accountId, name: "Example account" }],
      zones: [{
        id: zoneId,
        name: "example.com",
        accountId,
        accountName: "Example account",
        status: "pending",
        nameServers: ["aria.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      }],
    });
    expect(JSON.stringify(discovery)).not.toContain(apiToken);
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.headers.get("authorization") === `Bearer ${apiToken}`)).toBe(true);
  });

  test.each([undefined, 10105])("creates gateway ingress for port %s and retrieves the connector token", async gatewayPort => {
    const writes: Array<{ method: string; path: string; body: string }> = [];
    const provisioner = new ManagedAndroidRemoteCloudflareProvisioner({
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;
        const body = method === "GET" ? "" : await request.text();
        if (method !== "GET") writes.push({ method, path, body });
        if (path.endsWith("/user/tokens/verify")) return cloudflareResponse({ status: "active" });
        if (path.endsWith(`/zones/${zoneId}`)) {
          return cloudflareResponse({ id: zoneId, name: "example.com", status: "active", account: { id: accountId } });
        }
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel`) && method === "GET") return cloudflareResponse([]);
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel`) && method === "POST") return cloudflareResponse({ id: tunnelId });
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`)) return cloudflareResponse({});
        if (path.endsWith(`/zones/${zoneId}/dns_records`) && method === "GET") return cloudflareResponse([]);
        if (path.endsWith(`/zones/${zoneId}/dns_records`) && method === "POST") return cloudflareResponse({ id: dnsId });
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`)) return cloudflareResponse(connectorToken);
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel/${tunnelId}`)) return cloudflareResponse({ id: tunnelId, tun_type: "cfd_tunnel" });
        throw new Error(`unexpected test request: ${method} ${request.url}`);
      }) as typeof fetch,
    });

    const result = await provisioner.provision({
      apiToken,
      accountId,
      zoneId,
      hostname: "opencodex.example.com",
      gatewayPort,
    });
    expect(result).toEqual({
      hostname: "opencodex.example.com",
      connectorToken,
      tunnelCreated: true,
      dnsCreated: true,
    });
    const configuration = writes.find(write => write.path.endsWith("/configurations"));
    expect(JSON.parse(configuration?.body ?? "{}")).toEqual({
      config: {
        ingress: [
          { hostname: "opencodex.example.com", service: `http://127.0.0.1:${gatewayPort ?? 10105}`, originRequest: {} },
          { service: "http_status:404" },
        ],
      },
    });
    const dns = writes.find(write => write.path.endsWith("/dns_records"));
    expect(JSON.parse(dns?.body ?? "{}")).toEqual({
      type: "CNAME",
      proxied: true,
      name: "opencodex.example.com",
      content: `${tunnelId}.cfargotunnel.com`,
    });
    expect(writes.every(write => !write.body.includes(apiToken))).toBe(true);
  });

  test("reuses only an exact Remodex configuration and refuses to overwrite conflicting DNS", async () => {
    const mutations: string[] = [];
    const tunnelName = `opencodex-android-v1-${createHash("sha256").update("opencodex.example.com").digest("hex").slice(0, 20)}`;
    const provisioner = new ManagedAndroidRemoteCloudflareProvisioner({
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method !== "GET") mutations.push(`${request.method} ${path}`);
        if (path.endsWith("/user/tokens/verify")) return cloudflareResponse({ status: "active" });
        if (path.endsWith(`/zones/${zoneId}`)) {
          return cloudflareResponse({ id: zoneId, name: "example.com", status: "active", account: { id: accountId } });
        }
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel`)) {
          return cloudflareResponse([{ id: tunnelId, name: tunnelName, tun_type: "cfd_tunnel", remote_config: true }]);
        }
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`)) {
          return cloudflareResponse({ config: { ingress: [
            { hostname: "opencodex.example.com", service: "http://127.0.0.1:10105", originRequest: {} },
            { service: "http_status:404" },
          ] } });
        }
        if (path.endsWith(`/zones/${zoneId}/dns_records`)) {
          return cloudflareResponse([{ id: dnsId, type: "A", name: "opencodex.example.com", content: "192.0.2.1", proxied: true }]);
        }
        throw new Error(`unexpected test request: ${request.url}`);
      }) as typeof fetch,
    });

    await expect(provisioner.provision({ apiToken, accountId, zoneId, hostname: "opencodex.example.com" }))
      .rejects.toBeInstanceOf(CloudflareProvisioningError);
    expect(mutations).toEqual([]);
  });

  test.each([10105, 10100, 10106, 10115])("only reuses an existing ingress on gateway port 10105, not %s", async ingressPort => {
    const mutations: string[] = [];
    const tunnelName = `opencodex-android-v1-${createHash("sha256").update("opencodex.example.com").digest("hex").slice(0, 20)}`;
    const provisioner = new ManagedAndroidRemoteCloudflareProvisioner({
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method !== "GET") mutations.push(`${request.method} ${path}`);
        if (path.endsWith("/user/tokens/verify")) return cloudflareResponse({ status: "active" });
        if (path.endsWith(`/zones/${zoneId}`)) {
          return cloudflareResponse({ id: zoneId, name: "example.com", status: "active", account: { id: accountId } });
        }
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel`)) {
          return cloudflareResponse([{ id: tunnelId, name: tunnelName, tun_type: "cfd_tunnel", remote_config: true }]);
        }
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`)) {
          return cloudflareResponse({ config: { ingress: [
            { hostname: "opencodex.example.com", service: `http://127.0.0.1:${ingressPort}`, originRequest: {} },
            { service: "http_status:404" },
          ] } });
        }
        if (path.endsWith(`/zones/${zoneId}/dns_records`)) {
          return cloudflareResponse([{
            id: dnsId,
            type: "CNAME",
            name: "opencodex.example.com",
            content: `${tunnelId}.cfargotunnel.com`,
            proxied: true,
          }]);
        }
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`)) return cloudflareResponse(connectorToken);
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel/${tunnelId}`)) return cloudflareResponse({ id: tunnelId, tun_type: "cfd_tunnel" });
        throw new Error(`unexpected test request: ${request.url}`);
      }) as typeof fetch,
    });

    const result = provisioner.provision({ apiToken, accountId, zoneId, hostname: "opencodex.example.com" });
    if (ingressPort === 10105) {
      expect(await result).toEqual({ hostname: "opencodex.example.com", connectorToken, tunnelCreated: false, dnsCreated: false });
    } else {
      await expect(result).rejects.toMatchObject({ code: "tunnel_conflict" });
    }
    expect(mutations).toEqual([]);
  });

  test("rolls back a newly created tunnel when the requested hostname already has DNS", async () => {
    const mutations: string[] = [];
    const provisioner = new ManagedAndroidRemoteCloudflareProvisioner({
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method !== "GET") mutations.push(`${request.method} ${path}`);
        if (path.endsWith("/user/tokens/verify")) return cloudflareResponse({ status: "active" });
        if (path.endsWith(`/zones/${zoneId}`)) {
          return cloudflareResponse({ id: zoneId, name: "example.com", status: "active", account: { id: accountId } });
        }
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel`) && request.method === "GET") return cloudflareResponse([]);
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel`) && request.method === "POST") return cloudflareResponse({ id: tunnelId });
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`)) return cloudflareResponse({});
        if (path.endsWith(`/zones/${zoneId}/dns_records`)) {
          return cloudflareResponse([{ id: dnsId, type: "A", name: "opencodex.example.com", content: "192.0.2.1", proxied: true }]);
        }
        if (path.endsWith(`/accounts/${accountId}/cfd_tunnel/${tunnelId}`) && request.method === "DELETE") return cloudflareResponse({ id: tunnelId });
        throw new Error(`unexpected test request: ${request.method} ${request.url}`);
      }) as typeof fetch,
    });

    await expect(provisioner.provision({ apiToken, accountId, zoneId, hostname: "opencodex.example.com" }))
      .rejects.toMatchObject({ code: "hostname_conflict" });
    expect(mutations).toEqual([
      `POST /client/v4/accounts/${accountId}/cfd_tunnel`,
      `PUT /client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
      `DELETE /client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}`,
    ]);
  });
});
