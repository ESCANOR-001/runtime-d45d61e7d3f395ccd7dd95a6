/**
 * The Codex switch route.
 *
 * The thing worth proving here is not that a boolean lands in a file. It is that
 * turning Codex OFF is not `ocx stop`: the proxy keeps serving, `/healthz` keeps
 * answering, other clients keep routing, and only Codex goes back to its own
 * path. A per-client switch that took the whole proxy down would be a kill
 * switch with a misleading label.
 *
 * The second thing is ordering. Intent is persisted BEFORE artifacts converge,
 * so a process that dies between the two leaves a decision the next start can
 * act on — rather than artifacts the next start silently undoes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { OcxConfig } from "../src/types";
import { CODEX_CONFIG_PATH } from "../src/codex/paths";

let fixtureRoot = "";
let previousOpencodexHome: string | undefined;
const cleanup: string[] = [];

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    codexConfigWriteConsent: CODEX_CONFIG_PATH,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    } as OcxConfig["providers"],
    defaultProvider: "openai",
  };
}

type ToggleStep = { path: string; body?: unknown };
type ToggleResult = { status: number; body: Record<string, unknown>; intent?: boolean; refreshes: number; liveWorkers: number };
function toggle(body: unknown): ToggleStep { return { path: "/api/native-integrations/codex", body }; }
function runSteps(steps: ToggleStep[], observeRefresh = false): ToggleResult[] {
  const child = spawnSync(process.execPath, [join(import.meta.dir, "helpers/native-codex-toggle-peer.ts")], {
    windowsHide: true,
    env: { ...process.env, OPENCODEX_HOME: fixtureRoot },
    input: JSON.stringify({ config: baseConfig(), steps, observeRefresh }),
    encoding: "utf8",
    timeout: (steps.length + 1) * 5_000,
  });
  if (child.error || child.status !== 0) {
    throw new Error(`Native toggle peer failed: ${child.error?.message ?? child.stderr}\n${child.stdout}`);
  }
  const line = child.stdout.split(/\r?\n/).find(line => line.startsWith("NATIVE_TOGGLE_RESULT="));
  if (!line) throw new Error(`Native toggle peer returned no result: ${child.stdout}`);
  const results = JSON.parse(line.slice("NATIVE_TOGGLE_RESULT=".length)) as ToggleResult[];
  expect(results).toHaveLength(steps.length);
  for (const result of results) expect(result.liveWorkers).toBe(0);
  return results;
}

function persistedCodexIntent(): unknown {
  const raw = JSON.parse(readFileSync(join(fixtureRoot, "config.json"), "utf8")) as Record<string, unknown>;
  return (raw.clientIntegrations as Record<string, unknown> | undefined)?.codex;
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  fixtureRoot = mkdtempSync(join(tmpdir(), "ocx-codex-toggle-"));
  cleanup.push(fixtureRoot);
  process.env.OPENCODEX_HOME = fixtureRoot;
  writeFileSync(join(fixtureRoot, "config.json"), JSON.stringify(baseConfig(), null, 2));
  writeFileSync(join(fixtureRoot, "service-state.json"), JSON.stringify({
    version: 2,
    codexHome: process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
    opencodexHome: fixtureRoot,
    backend: "scheduler",
  }));
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("request validation", () => {
  test("a non-boolean enabled is rejected before anything is written", async () => {
    const [result] = runSteps([toggle({ enabled: "false" })]);
    expect(result!.status).toBe(400);
    expect(persistedCodexIntent()).toBeUndefined();
  }, 30_000);

  test("a missing enabled is rejected before anything is written", async () => {
    const [result] = runSteps([toggle({})]);
    expect(result!.status).toBe(400);
    expect(persistedCodexIntent()).toBeUndefined();
  }, 30_000);
});

describe("turning Codex off", () => {
  test("refreshes Android Remote so the phone immediately receives the native-only catalog", async () => {
    const [result] = runSteps([toggle({ enabled: false })], true);
    expect(result!.status).toBe(200);
    expect(result!.refreshes).toBe(1);
  }, 30_000);

  test("persists the decision so it survives the next start", async () => {
    const result = runSteps([toggle({ enabled: false })])[0]!;
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, clientId: "codex" });
    expect(result.body.artifacts).toMatchObject({
      config: { state: expect.any(String) },
      catalog: { state: expect.any(String) },
      history: { state: expect.any(String) },
    });
    // The decision is on disk. Without this, an OFF lasts until the next
    // `ocx start` re-syncs over it, which is the defect this phase exists for.
    expect(persistedCodexIntent()).toBe(false);
  }, 30_000);

  /**
   * THE PROXY STAYS UP. The user asked for this in exactly these terms: they may
   * want everything except Codex routed. If turning Codex off stopped the proxy,
   * every other client would lose its routing too.
   */
  test("the management API keeps serving other routes afterwards", async () => {
    const [first, others, again] = runSteps([
      toggle({ enabled: false }),
      { path: "/api/native-integrations" },
      toggle({ enabled: false }),
    ]);
    expect(first!.status).toBe(200);

    // `/healthz` is served by the request router rather than the management API,
    // so the observable claim HERE is that the management surface itself is
    // still answering — the route did not tear the process down or leave a
    // lock/flight wedged behind it.
    expect(others!.status).toBe(200);
    const body = others!.body as { clients: { clientId: string }[] };
    expect(body.clients.some(c => c.clientId === "claude")).toBe(true);

    // And the switch is re-usable immediately: a wedged in-flight guard would
    // return 409 here rather than a normal answer.
    expect(again!.status).toBe(200);
  }, 30_000);

  test("turning it off twice is honest about the second one changing nothing", async () => {
    const [first, second] = runSteps([toggle({ enabled: false }), toggle({ enabled: false })]);
    expect(first!.body.changed).toBe(true);
    expect(second!.body.changed).toBe(false);
    expect(persistedCodexIntent()).toBe(false);
  }, 30_000);
});

describe("turning Codex back on", () => {
  test("removes the key rather than storing true", async () => {
    const [first, result] = runSteps([toggle({ enabled: false }), toggle({ enabled: true })]);
    expect(first!.status).toBe(200);
    expect(first!.intent).toBe(false);
    expect(result!.status).toBe(200);
    // Absence is ON, so an untouched config and a re-enabled one are identical.
    expect(persistedCodexIntent()).toBeUndefined();
  }, 30_000);
});
