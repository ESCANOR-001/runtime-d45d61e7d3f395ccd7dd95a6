import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test.each(["1", "0"])("production ports remain standard with Connect mode %s", connectMode => {
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { androidRemoteGatewayUrls } from "./src/android-remote/gateway";
    import { AndroidCodexRuntime } from "./src/android-remote/codex-app-server";
    const interfaces = { wlan: [{ address: "192.168.1.2", family: "IPv4", internal: false }] };
    console.log(JSON.stringify({
      urls: androidRemoteGatewayUrls(undefined, interfaces),
      codexPort: new AndroidCodexRuntime().status().port,
    }));
  `], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, REMODEX_CONNECT_ONLY: connectMode },
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
    urls: ["http://127.0.0.1:10105", "http://192.168.1.2:10105"],
    codexPort: 10106,
  });
});
