import { afterEach, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

const previous = process.env.REMODEX_CONNECT_ONLY;
afterEach(() => {
  if (previous === undefined) delete process.env.REMODEX_CONNECT_ONLY;
  else process.env.REMODEX_CONNECT_ONLY = previous;
});
const config = { providers: {}, defaultProvider: "openai", port: 10110 } as OcxConfig;
const service = { supported: true, installed: false, enabled: false, running: false, viable: false,
  startable: false, stale: false, conflict: false, backend: null, summary: "not installed" };

test("service setup is read-only until a same-origin dashboard explicitly confirms a fixed action", async () => {
  process.env.REMODEX_CONNECT_ONLY = "1";
  const calls: unknown[] = [];
  const deps: ManagementApiDeps = { connectServiceDiagnostic: () => service, assertConnectServiceOwnership: () => {},
    connectServiceSetupState: () => "idle", startConnectServiceSetup: async action => { calls.push(action); } };
  const request = (method: string, body?: unknown, principal: "gui-session" | "admin-token" = "gui-session", origin = "http://localhost:10110") => {
    const url = new URL("http://localhost:10110/api/connect/service");
    return handleManagementAPI(new Request(url, { method, headers: { Host: url.host, Origin: origin, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, config, deps, principal);
  };
  const status = await request("GET");
  expect(status?.status).toBe(200);
  expect(await status!.json()).toMatchObject({ installed: false, healthy: false, canManage: true, operation: "idle" });
  expect(calls).toEqual([]);
  for (const body of [{ action: "install" }, { action: "install", confirm: false }, { action: "install-shim", confirm: true },
    { action: "install", confirm: true, command: "anything" }, null]) expect((await request("POST", body))?.status).toBe(400);
  expect((await request("POST", { action: "install", confirm: true }, "admin-token"))?.status).toBe(403);
  expect((await request("POST", { action: "install", confirm: true }, "gui-session", "https://other.example"))?.status).toBe(403);
  expect((await request("POST", { action: "repair", confirm: true }))?.status).toBe(409);
  expect(calls).toEqual([]);
  expect((await request("POST", { action: "install", confirm: true }))?.status).toBe(202);
  expect(calls).toEqual(["install"]);
  deps.connectServiceDiagnostic = () => ({ ...service, installed: true });
  expect((await request("POST", { action: "repair", confirm: true }))?.status).toBe(202);
  expect(calls.at(-1)).toBe("repair");
  deps.connectServiceSetupState = () => "running";
  expect((await request("POST", { action: "repair", confirm: true }))?.status).toBe(409);
  expect(calls).toHaveLength(2);
});

test("unsupported services and foreign profiles cannot be modified", async () => {
  process.env.REMODEX_CONNECT_ONLY = "1";
  const url = new URL("http://localhost:10110/api/connect/service");
  for (const owned of [true, false]) {
    const deps: ManagementApiDeps = {
      connectServiceDiagnostic: () => ({ ...service, supported: false }),
      assertConnectServiceOwnership: () => { if (!owned) throw new Error("other profile"); },
      connectServiceSetupState: () => "idle", startConnectServiceSetup: async () => { throw new Error("must not run"); },
    };
    const status = await handleManagementAPI(new Request(url, { headers: { Host: url.host } }), url, config, deps);
    expect(await status!.json()).toMatchObject({ canManage: false });
    const action = await handleManagementAPI(new Request(url, { method: "POST", headers: { Host: url.host },
      body: JSON.stringify({ action: "install", confirm: true }) }), url, config, deps, "gui-session");
    expect([409, 503]).toContain(action!.status);
  }
});
