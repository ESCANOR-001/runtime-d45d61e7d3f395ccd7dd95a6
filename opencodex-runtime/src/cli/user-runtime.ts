import { spawn, type SpawnOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, loadConfig, saveConfig } from "../config";
import { defaultProxyPort, isConnectRuntime } from "../connect/mode";
import { findAvailablePort } from "../server/ports";

export function userRuntimeLaunch(env: NodeJS.ProcessEnv, cli: string, port: number, log: number): { args: string[]; options: SpawnOptions } {
  const childEnv = { ...env };
  delete childEnv.OCX_SERVICE;
  return {
    args: [cli, "start", ...(port > 0 ? ["--port", String(port)] : [])],
    options: { env: childEnv, detached: true, windowsHide: true, shell: false, stdio: ["ignore", log, log] },
  };
}

export async function startUserRuntime(): Promise<void> {
  const home = getConfigDir();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const log = openSync(join(home, "service.log"), "a", 0o600);
  try {
    const cli = join(import.meta.dir, isConnectRuntime() ? "connect.ts" : "index.ts");
    const config = loadConfig();
    let port = config.port || defaultProxyPort();
    if (isConnectRuntime()) {
      const reservedPort = config.unauthenticatedLoopbackListener?.enabled
        ? config.unauthenticatedLoopbackListener.port : undefined;
      port = await findAvailablePort(port, config.hostname ?? "127.0.0.1", { reservedPort });
      if (port !== config.port) {
        config.port = port;
        saveConfig(config);
      }
    }
    const launch = userRuntimeLaunch(process.env, cli, port, log);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, launch.args, launch.options);
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  } finally { closeSync(log); }
}
