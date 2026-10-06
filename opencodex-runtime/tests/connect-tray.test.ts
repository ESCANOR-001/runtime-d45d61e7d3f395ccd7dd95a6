import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIsolatedTestEnvironment } from "../scripts/test";

test("Connect exposes tray status while refusing Codex configuration and restart commands", () => {
  const isolated = createIsolatedTestEnvironment();
  const config = join(isolated.env.CODEX_HOME!, "config.toml");
  const original = 'model="keep-my-model"\n';
  writeFileSync(config, original);
  try {
    const cli = join(import.meta.dir, "../src/cli/connect.ts");
    for (const command of ["sync", "__desktop-restart-codex", "__desktop-restart-client"]) {
      const result = Bun.spawnSync([process.execPath, cli, command], { env: isolated.env, windowsHide: true });
      expect(result.exitCode).toBe(64);
    }
    const result = Bun.spawnSync([process.execPath, cli, "tray", "status", "--json"], { env: isolated.env, windowsHide: true });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout).trim())).toMatchObject({ installed: false, running: false });
    expect(readFileSync(config, "utf8")).toBe(original);
  } finally { isolated.cleanup(); }
}, 30_000);
