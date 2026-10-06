import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createIsolatedTestEnvironment } from "../scripts/test";

test("Connect startup, authenticated activity, and shutdown leave existing client files unchanged", async () => {
  const isolated = createIsolatedTestEnvironment();
  const codexHome = isolated.env.CODEX_HOME!;
  const configPath = join(codexHome, "config.toml");
  const fixtures = new Map([
    [configPath, 'model = "gpt-native"\nmodel_provider = "custom"\n'],
    [join(codexHome, "config.yml"), "provider: untouched\n"],
    [join(codexHome, "models_cache.json"), '{"models":[]}\n'],
    [join(isolated.root, ".bashrc"), "export KEEP_ME=yes\n"],
  ]);
  mkdirSync(join(isolated.root, ".grok"));
  fixtures.set(join(isolated.root, ".grok", "config.toml"), 'model="unchanged"\n');
  for (const [path, content] of fixtures) writeFileSync(path, content);
  writeFileSync(join(isolated.env.OPENCODEX_HOME!, "config.json"), JSON.stringify({
    port: 0, defaultProvider: "openai", providers: {}, codexConfigWriteConsent: configPath,
    clientIntegrations: { codex: true, grok: true },
  }));
  writeFileSync(join(isolated.env.OPENCODEX_HOME!, "service.log"), '2026-09-23T10:00:00Z ready\nprompt: PRIVATE_MESSAGE\nPRIVATE_CONTINUATION\n2026-09-23T10:01:00Z connected\n');
  const beforeFiles = readdirSync(codexHome).sort();
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  const token = randomUUID();
  const child = spawn(process.execPath, [join(import.meta.dir, "../src/cli/connect.ts"), "start", "--port", String(port)], {
    env: { ...isolated.env, OPENCODEX_ADMIN_AUTH_TOKEN: token }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", chunk => { output = (output + chunk).slice(-8000); });
  child.stderr?.on("data", chunk => { output = (output + chunk).slice(-8000); });
  let spawnError: Error | undefined;
  const exited = new Promise<void>(resolve => {
    child.once("exit", () => resolve());
    child.once("error", error => { spawnError = error; resolve(); });
  });
  const base = `http://127.0.0.1:${port}`;
  let stage = "startup";
  const request = (path: string, init?: RequestInit) => {
    stage = `${init?.method ?? "GET"} ${path}`;
    return fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
  };
  try {
    let ready = false;
    const startupDeadline = Date.now() + 20_000;
    while (Date.now() < startupDeadline) {
      ready = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(750) })
        .then(async response => { await response.body?.cancel(); return response.ok; }).catch(() => false);
      if (ready || child.exitCode !== null || child.signalCode !== null || spawnError) break;
      await Bun.sleep(100);
    }
    if (spawnError) throw spawnError;
    if (!ready) throw new Error(`Isolated startup failed: ${output}`);
    expect((await request("/api/connect/activity")).status).toBe(401);
    const headers = { "x-opencodex-api-key": token };
    expect((await request("/api/system/restart", { method: "POST" })).status).toBe(401);
    const restartHeaders = { ...headers, "x-opencodex-restart-expected-pid": "2147483647" };
    expect((await request("/api/system/restart", { method: "POST", headers: restartHeaders })).status).toBe(409);
    expect((await request("/api/system/restart", { method: "POST", headers: { ...restartHeaders, Origin: "https://unrelated.example" } })).status).toBe(403);
    const response = await request("/api/connect/activity", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).source).toBe("native-codex");
    const diagnostics = await request("/api/diagnostics/desktop-log", { headers }).then(result => result.json());
    expect(diagnostics.logPath).toContain("[Connect profile]");
    expect(diagnostics.log).toContain("connected");
    expect(diagnostics.log).not.toContain("PRIVATE_MESSAGE");
    expect(diagnostics.log).not.toContain("PRIVATE_CONTINUATION");
    expect((await request("/api/integrations", { method: "PUT", headers, body: "{}" })).status).toBe(404);
    expect((await request("/v1/responses", { method: "POST" })).status).toBe(404);
    expect((await request("/v1/responses", { headers: { upgrade: "websocket" } })).status).toBe(404);
  } catch (error) {
    throw new Error(`Connect lifecycle failed during ${stage}: ${error instanceof Error ? error.message : String(error)}\n${output}`, { cause: error });
  } finally {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(killTimer);
    child.stdout?.destroy();
    child.stderr?.destroy();
    try {
      for (const [path, content] of fixtures) expect(readFileSync(path, "utf8")).toBe(content);
      expect(readdirSync(codexHome).sort()).toEqual(beforeFiles);
    } finally { isolated.cleanup(); }
  }
}, 45_000);
