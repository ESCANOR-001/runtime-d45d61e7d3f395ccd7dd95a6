import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { discoverAntigravityProject, refreshAntigravityToken } from "../src/oauth/google-antigravity";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCredential, saveCredential } from "../src/oauth/store";

const realFetch = globalThis.fetch;
const originalClientId = process.env.GOOGLE_ANTIGRAVITY_CLIENT_ID;
const originalClientSecret = process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET;
beforeEach(() => {
  process.env.GOOGLE_ANTIGRAVITY_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET = "test-client-secret";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (originalClientId === undefined) delete process.env.GOOGLE_ANTIGRAVITY_CLIENT_ID;
  else process.env.GOOGLE_ANTIGRAVITY_CLIENT_ID = originalClientId;
  if (originalClientSecret === undefined) delete process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET;
  else process.env.GOOGLE_ANTIGRAVITY_CLIENT_SECRET = originalClientSecret;
});

function routeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { calls };
}

describe("antigravity project discovery", () => {
  test("loadCodeAssist returns the project (cloudaicompanionProject)", async () => {
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({ cloudaicompanionProject: "proj-A" }), { status: 200 });
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBe("proj-A");
  });

  test("extracts project from a nested {id} shape", async () => {
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({ project: { id: "proj-nested" } }), { status: 200 });
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBe("proj-nested");
  });

  test("falls back to onboardUser poll loop (not-done then done)", async () => {
    let onboardCalls = 0;
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({}), { status: 200 }); // no project
      if (url.includes(":onboardUser")) {
        onboardCalls++;
        if (onboardCalls === 1) return new Response(JSON.stringify({ done: false }), { status: 200 });
        return new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: "proj-onboarded" } }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBe("proj-onboarded");
    expect(onboardCalls).toBe(2);
  });

  test("returns undefined when onboardUser aborts with a hard 4xx", async () => {
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({}), { status: 200 });
      if (url.includes(":onboardUser")) return new Response("forbidden", { status: 403 });
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBeUndefined();
  });

  test("onboardUser retries a transient 503 within the attempt budget then succeeds", async () => {
    let onboardCalls = 0;
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({}), { status: 200 });
      if (url.includes(":onboardUser")) {
        onboardCalls++;
        if (onboardCalls === 1) return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: "proj-T" } }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBe("proj-T");
    expect(onboardCalls).toBe(2);
  });
});

describe("antigravity refresh", () => {
  test.each(["GOOGLE_ANTIGRAVITY_CLIENT_ID", "GOOGLE_ANTIGRAVITY_CLIENT_SECRET"])("missing %s fails before network access", async variable => {
    delete process.env[variable];
    const requests = routeFetch(() => new Response("unexpected request", { status: 500 }));
    await expect(refreshAntigravityToken("refresh-tok")).rejects.toThrow("configured explicitly");
    expect(requests.calls).toEqual([]);
  });

  test("uses explicitly configured client values in token requests", async () => {
    routeFetch((url, init) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_id")).toBe("test-client-id");
        expect(body.get("client_secret")).toBe("test-client-secret");
        return Response.json({ access_token: "fresh-access", expires_in: 3600 });
      }
      return Response.json({ cloudaicompanionProject: "test-project" });
    });
    expect((await refreshAntigravityToken("refresh-tok")).access).toBe("fresh-access");
  });

  test("refreshes the access token and re-discovers project; never leaks the token in errors", async () => {
    routeFetch((url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({ cloudaicompanionProject: "proj-R" }), { status: 200 });
      return new Response("no", { status: 404 });
    });
    const issuedAt = 1_900_000_000_000;
    const nowSpy = spyOn(Date, "now").mockReturnValue(issuedAt);
    const cred = await (async () => {
      try {
        return await refreshAntigravityToken("refresh-tok");
      } finally {
        nowSpy.mockRestore();
      }
    })();
    expect(cred.access).toBe("fresh-access");
    expect(cred.refresh).toBe("refresh-tok");
    expect(cred.projectId).toBe("proj-R");
    // A one-hour Google token must retain roughly 55 minutes after the provider margin. The
    // previous 50-minute margin stored only ten minutes and caused repeated refreshes in use.
    expect(cred.expires - issuedAt).toBe(55 * 60 * 1000);
  });

  test("refresh failure carries status only, not the response body", async () => {
    routeFetch((url) => {
      if (url.includes("oauth2.googleapis.com/token")) return new Response("invalid_grant secret-detail", { status: 400 });
      return new Response("no", { status: 404 });
    });
    let caught: Error | undefined;
    try { await refreshAntigravityToken("refresh-tok"); } catch (e) { caught = e as Error; }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("400");
    expect(caught!.message).not.toContain("secret-detail");
  });
});

describe("antigravity credential persistence (projectId survives the store)", () => {
  const origHome = process.env.HOME;
  const origOcxHome = process.env.OPENCODEX_HOME;
  let tmp: string;

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("saveCredential + getCredential round-trips projectId (regression: was stripped by normalizeCredential)", async () => {
    tmp = join(tmpdir(), `ag-store-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmp, { recursive: true });
    process.env.HOME = tmp;
    process.env.OPENCODEX_HOME = join(tmp, "ocx");
    await saveCredential("google-antigravity", { access: "a", refresh: "r", expires: Date.now() + 3_600_000, projectId: "proj-persist" });
    expect(getCredential("google-antigravity")?.projectId).toBe("proj-persist");
  });
});
