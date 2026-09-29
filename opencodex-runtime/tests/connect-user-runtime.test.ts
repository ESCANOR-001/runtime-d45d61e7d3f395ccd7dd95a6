import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createIsolatedTestEnvironment } from "../scripts/test";

test.each([false, true])("the detached runtime preserves Codex and survives launcher exit with an occupied port: %s", async (occupied) => {
  const isolated = createIsolatedTestEnvironment();
  const configPath = join(isolated.env.CODEX_HOME!, "config.toml");
  const configText = 'model="native-test"\n';
  writeFileSync(configPath, configText);
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("foreign listener") });
  const preferredPort = probe.port!;
  if (!occupied) probe.stop(true);
  const runtimeConfigPath = join(isolated.env.OPENCODEX_HOME!, "config.json");
  writeFileSync(runtimeConfigPath, JSON.stringify({ port: preferredPort, providers: {}, defaultProvider: "openai" }));
  const token = randomUUID();
  const module = new URL("../src/cli/user-runtime.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["-e", `const runtime = await import(${JSON.stringify(module)}); await runtime.startUserRuntime();`], {
    env: { ...isolated.env, REMODEX_CONNECT_ONLY: "1", OPENCODEX_ADMIN_AUTH_TOKEN: token },
    windowsHide: true, stdio: "ignore",
  });
  let pid: number | undefined;
  try {
    const exit = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    expect(exit).toBe(0);
    const port = JSON.parse(readFileSync(runtimeConfigPath, "utf8")).port;
    if (occupied) {
      expect(port).not.toBe(preferredPort);
      expect(await (await fetch(`http://127.0.0.1:${preferredPort}`)).text()).toBe("foreign listener");
    } else {
      expect(port).toBe(preferredPort);
    }
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${base}/api/system/memory`, { headers: { "x-opencodex-api-key": token }, signal: AbortSignal.timeout(500) }).catch(() => null);
      if (response?.ok) { pid = (await response.json()).pid; break; }
      await Bun.sleep(100);
    }
    expect(pid).toBeNumber();
    expect(pid).not.toBe(child.pid);
    expect((await fetch(`${base}/readyz`)).ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(configText);
    expect(await Bun.file(join(isolated.env.OPENCODEX_HOME!, "service-state.json")).exists()).toBe(false);
  } finally {
    probe.stop(true);
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      for (let attempt = 0; attempt < 50; attempt++) {
        try { process.kill(pid, 0); } catch { break; }
        await Bun.sleep(100);
      }
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    child.kill();
    isolated.cleanup();
  }
}, 20_000);
