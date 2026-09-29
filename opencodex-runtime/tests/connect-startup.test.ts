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
  probe.stop(true);
  const token = randomUUID();
  const child = spawn(process.execPath, [join(import.meta.dir, "../src/cli/connect.ts"), "start", "--port", String(port)], {
    env: { ...isolated.env, OPENCODEX_ADMIN_AUTH_TOKEN: token }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", chunk => { output = (output + chunk).slice(-8000); });
  child.stderr?.on("data", chunk => { output = (output + chunk).slice(-8000); });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      ready = await fetch(`${base}/readyz`).then(response => response.ok).catch(() => false);
      if (ready || child.exitCode !== null) break;
      await Bun.sleep(100);
    }
    if (!ready) throw new Error(`Isolated startup failed: ${output}`);
    expect((await fetch(`${base}/api/connect/activity`)).status).toBe(401);
    const headers = { "x-opencodex-api-key": token };
    const response = await fetch(`${base}/api/connect/activity`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).source).toBe("native-codex");
    const diagnostics = await fetch(`${base}/api/diagnostics/desktop-log`, { headers }).then(result => result.json());
    expect(diagnostics.logPath).toContain("[Connect profile]");
    expect(diagnostics.log).toContain("connected");
    expect(diagnostics.log).not.toContain("PRIVATE_MESSAGE");
    expect(diagnostics.log).not.toContain("PRIVATE_CONTINUATION");
    expect((await fetch(`${base}/api/integrations`, { method: "PUT", headers, body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/v1/responses`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/v1/responses`, { headers: { upgrade: "websocket" } })).status).toBe(404);
  } finally {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(killTimer);
    try {
      for (const [path, content] of fixtures) expect(readFileSync(path, "utf8")).toBe(content);
      expect(readdirSync(codexHome).sort()).toEqual(beforeFiles);
    } finally { isolated.cleanup(); }
  }
}, 20_000);
