import { describe, expect, test } from "bun:test";
import { createDesktopUpdateRoutes, liveUpdateJob, publicUpdateJob } from "../src/android-remote/desktop-updates";
import { registryVersion, type RemoteUpdateCheck } from "../src/update/remote-check";
import type { UpdateJobState } from "../src/update/job";
import { AndroidRemoteGatewayController } from "../src/android-remote/gateway";

const check: RemoteUpdateCheck = {
  currentVersion: "1.0.0", latestVersion: "1.0.1", installer: "npm", channel: "latest",
  updateAvailable: true, canUpdate: true, command: "private command", releaseNotesUrl: "private path",
  checkedAt: "2026-09-09T00:00:00Z", releaseNotes: "Fixed reconnection.",
};
const job: UpdateJobState = {
  id: "update-test", status: "running", startedAt: check.checkedAt, updatedAt: check.checkedAt,
  currentVersion: "1.0.0", latestVersion: "1.0.1", installer: "npm", channel: "latest", restart: true,
  command: "private command", releaseNotesUrl: "private path", log: ["secret installer output"],
};
const request = (path: string, body?: unknown) => new Request(`http://localhost/api/desktop-update/${path}`, {
  method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("paired-phone desktop updates", () => {
  test("phone status awaits current activity independently of stale or missing sidebar data", async () => {
    let current = { known: true, running: 0 };
    const gateway = Object.assign(Object.create(AndroidRemoteGatewayController.prototype), {
      assets: { response: () => null },
      auth: { authenticateAccessToken: () => ({ client: { id: "test", scopes: ["terminal:operate"] } }) },
      shellCache: { threads: [{ session: { status: "idle", activeTurnId: null }, latestTurn: { state: "completed" } }] },
      knownActiveTurnIds: new Map(),
      shellUpdatedAt: 100_000,
      now: () => 100_000,
      refreshUpdateActivity: async () => { await Promise.resolve(); return current; },
      desktopUpdateRoutes: async (_req: Request, activity: () => unknown) => Response.json(await activity()),
    });
    const status = () => gateway.handleHttp(new Request("http://localhost/api/desktop-update/status", {
      headers: { Authorization: "Bearer paired-test-token" },
    }), { requestIP: () => ({ address: "127.0.0.1" }) });
    expect(await (await status()).json()).toEqual({ known: true, running: 0 });
    gateway.shellUpdatedAt = 1;
    expect(await (await status()).json()).toEqual({ known: true, running: 0 });
    gateway.shellUpdatedAt = 100_000;
    gateway.shellCache = { threads: [{ session: { status: "running", activeTurnId: "turn" }, latestTurn: { state: "running" } }] };
    expect(await (await status()).json()).toEqual({ known: true, running: 0 });
    gateway.shellCache = { threads: [{ session: { status: "error", activeTurnId: "turn" }, latestTurn: null }] };
    expect(await (await status()).json()).toEqual({ known: true, running: 0 });
    gateway.shellCache = null;
    current = { known: true, running: 1 };
    expect(await (await status()).json()).toEqual(current);
    current = { known: false, running: 0 };
    expect(await (await status()).json()).toEqual(current);
  });
  test("a dead worker does not leave the phone updating forever", () => {
    expect(liveUpdateJob({ ...job, pid: 42 }, Date.now(), () => false)?.status).toBe("failed");
    expect(liveUpdateJob({ ...job, pid: 42 }, Date.now(), () => true)?.status).toBe("running");
  });
  test("gateway rejects missing or revoked phone credentials before reaching updater", async () => {
    let reached = false;
    const gateway = Object.assign(Object.create(AndroidRemoteGatewayController.prototype), {
      assets: { response: () => null },
      auth: { authenticateAccessToken: () => null },
      desktopUpdateRoutes: () => { reached = true; return Response.json({}); },
    });
    for (const token of [null, "revoked-test-token"]) {
      const req = new Request("http://localhost/api/desktop-update/run", {
        method: "POST", body: JSON.stringify({ confirm: true }),
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
      const response = await gateway.handleHttp(req, { requestIP: () => ({ address: "127.0.0.1" }) });
      expect(response.status).toBe(401);
    }
    expect(reached).toBe(false);
    gateway.auth.authenticateAccessToken = () => ({ client: { id: "read-only", scopes: ["orchestration:read"] } });
    const denied = await gateway.handleHttp(new Request("http://localhost/api/desktop-update/run", {
      method: "POST", headers: { Authorization: "Bearer read-only-test-token" }, body: JSON.stringify({ confirm: true }),
    }), { requestIP: () => ({ address: "127.0.0.1" }) });
    expect(denied.status).toBe(403);
    expect(reached).toBe(false);
  });
  test("returns version and notes without commands, logs, or private paths", async () => {
    const route = createDesktopUpdateRoutes({ check: async () => check, readJob: () => job, start: () => job });
    const response = await route(request("check"), () => ({ known: true, running: 0 }));
    const body = await response.json();
    expect(body.currentVersion).toBe("1.0.0");
    expect(body.releaseNotes).toBe("Fixed reconnection.");
    expect(JSON.stringify(body)).not.toContain("private");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
  test("requires confirmation and rejects arbitrary install inputs", async () => {
    let starts = 0;
    const route = createDesktopUpdateRoutes({ check: async () => check, readJob: () => null, start: () => { starts++; return job; } });
    for (const body of [{}, { confirm: false }, { confirm: true, command: "anything" }]) {
      expect((await route(request("run", body), () => ({ known: true, running: 0 }))).status).toBe(400);
    }
    expect(starts).toBe(0);
  });
  test("never installs over a source checkout or after a failed version check", async () => {
    let starts = 0;
    for (const unavailable of [
      { ...check, installer: "source" as const, canUpdate: false },
      { ...check, latestVersion: null, canUpdate: false },
    ]) {
      const route = createDesktopUpdateRoutes({ check: async () => unavailable, readJob: () => null, start: () => { starts++; return job; } });
      expect((await route(request("run", { confirm: true }), () => ({ known: true, running: 0 }))).status).toBe(409);
    }
    expect(starts).toBe(0);
  });
  test("rechecks activity after fetching and does not interrupt active or unknown tasks", async () => {
    let starts = 0;
    const route = createDesktopUpdateRoutes({ check: async () => check, readJob: () => null, start: () => { starts++; return job; } });
    for (const activity of [{ known: false, running: 0 }, { known: true, running: 1 }]) {
      expect((await route(request("run", { confirm: true }), async () => activity)).status).toBe(409);
    }
    expect(starts).toBe(0);
    expect((await route(request("run", { confirm: true }), async () => ({ known: true, running: 0 }))).status).toBe(200);
    expect(starts).toBe(1);
  });
  test("serializes double taps while registry check is outstanding", async () => {
    let resolve!: (value: RemoteUpdateCheck) => void;
    let starts = 0;
    const route = createDesktopUpdateRoutes({ check: () => new Promise(r => { resolve = r; }), readJob: () => null, start: () => { starts++; return job; } });
    const activity = () => ({ known: true, running: 0 });
    const first = route(request("run", { confirm: true }), activity);
    while (!resolve) await new Promise(r => setTimeout(r, 1));
    expect((await route(request("run", { confirm: true }), activity)).status).toBe(409);
    resolve(check);
    expect((await first).status).toBe(200);
    expect(starts).toBe(1);
  });
  test("failure messages do not expose installer output", () => {
    const result = publicUpdateJob({ ...job, status: "failed", error: "secret" });
    expect(result?.error).not.toContain("secret");
  });
  test("checks a fixed npm package with no subprocess and rejects invalid metadata", async () => {
    const fetcher = (async (url: unknown) => {
      expect(String(url)).toBe("https://registry.npmjs.org/%40remodex%2Frmx/latest");
      return Response.json({ name: "@remodex/rmx", version: "1.2.10" });
    }) as typeof fetch;
    expect(await registryVersion("latest", fetcher)).toBe("1.2.10");
    expect(await registryVersion("latest", (async () => Response.json({ name: "other", version: "1.0.0" })) as typeof fetch)).toBeNull();
    expect(await registryVersion("latest", (async () => { throw new Error("offline"); }) as typeof fetch)).toBeNull();
  });
});
