import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { npmInvocation } from "../src/update/npm-invocation.mjs";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function validatePack(pack, expectedVersion) {
  assert.equal(pack.name, "@remodex/rmx");
  assert.equal(pack.version, expectedVersion);
  const paths = pack.files.map(file => file.path);
  for (const required of ["bin/ocx.mjs", "bin/package-main.mjs", "src/cli/connect.ts", "gui/dist/index.html"]) {
    assert(paths.includes(required), `Package is missing ${required}`);
  }
  assert(!paths.some(path => /(^|\/)(\.git|\.env|node_modules|android|src-tauri)(\/|$)|\.(jks|keystore)$/i.test(path)), "Unexpected private or build input in package");
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: sourceRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function npm(args, options = {}) {
  const invocation = npmInvocation(args);
  assert(invocation, "npm command could not be resolved");
  return run(invocation.file, invocation.args, { ...invocation.options, ...options });
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function runWindowsPackageSmoke() {
  assert.equal(process.platform, "win32", "This integration smoke requires Windows");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Only run inside a disposable GitHub Actions runner");
  const root = mkdtempSync(join(tmpdir(), "rmx package ü "));
  const prefix = join(root, "npm prefix");
  const home = join(root, "user home");
  const runtimeHome = join(home, ".remodex-connect");
  const codexHome = join(home, ".codex");
  for (const directory of [prefix, runtimeHome, codexHome, join(home, "AppData", "Local"), join(home, "AppData", "Roaming")]) {
    mkdirSync(directory, { recursive: true });
  }
  const config = 'model = "unchanged-smoke-model"\n';
  writeFileSync(join(codexHome, "config.toml"), config);
  writeFileSync(join(codexHome, "config.yml"), "unchanged: true\n");
  const environment = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, OPENCODEX_HOME: runtimeHome };
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === "path") ?? "PATH";
  environment[pathKey] = environment[pathKey].split(delimiter).filter(directory =>
    !["bun.exe", "bun.cmd", "bun"].some(name => existsSync(join(directory.replace(/^"|"$/g, ""), name))),
  ).join(delimiter);
  let child;
  let installed = false;
  try {
    const version = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")).version;
    const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", root]));
    assert.equal(packed.length, 1);
    validatePack(packed[0], version);
    console.log("PASS package contents and dashboard assets");
    npm(["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", join(root, packed[0].filename)]);
    installed = true;
    const packageRoot = join(prefix, "node_modules", "@remodex", "rmx");
    const launcher = join(packageRoot, "bin", "ocx.mjs");
    const cli = (...args) => run(process.execPath, [launcher, ...args], { cwd: home, env: environment });
    const standalone = spawnSync("bun", ["--version"], { env: environment, windowsHide: true, timeout: 10_000 });
    assert(standalone.error, "Standalone Bun must be absent from smoke PATH");
    assert.match(cli("help"), /Remodex Connect/);
    assert(cli("version").includes(version));
    const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    for (const extension of ["cmd", "ps1"]) {
      const escaped = join(prefix, `rmx.${extension}`).replaceAll("'", "''");
      const output = run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `& '${escaped}' help; exit $LASTEXITCODE`], { env: environment, cwd: home });
      assert.match(output, /Remodex Connect/);
    }
    console.log("PASS installed Node launcher and cmd/PowerShell shims without standalone Bun");
    const bun = join(packageRoot, "node_modules", "bun", "bin", "bun.exe");
    run(bun, ["-e", 'const sharp = (await import("sharp")).default; const image = await sharp({create:{width:2,height:2,channels:3,background:"red"}}).png().toBuffer(); if (!(image.length > 0)) throw new Error("image encoding failed"); await import("@napi-rs/keyring");'], { cwd: packageRoot, env: environment });
    console.log("PASS installed native image and keyring dependencies");
    const port = await unusedPort();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let output = "";
      let spawnError;
      child = spawn(process.execPath, [launcher, "start", "--port", String(port)], { cwd: home, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.on("error", error => { spawnError = error; });
      for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output = (output + data).slice(-32_000); });
      const deadline = Date.now() + 60_000;
      let ready = false;
      while (Date.now() < deadline && !spawnError && child.exitCode === null) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) });
          const health = await response.json();
          if (response.ok && health.service === "opencodex" && health.version === version && health.port === port) { ready = true; break; }
        } catch {}
        await delay(250);
      }
      assert(ready, `Installed server did not become healthy: ${spawnError ?? ""}\n${output}`);
      const dashboard = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) });
      assert(dashboard.ok);
      assert.match(await dashboard.text(), /<html/i);
      assert(cli("status", "--json").trim().startsWith("{"));
      cli("stop");
      const stoppedBy = Date.now() + 20_000;
      while (child.exitCode === null && Date.now() < stoppedBy) await delay(200);
      assert.notEqual(child.exitCode, null, `Installed server did not stop\n${output}`);
      child = undefined;
      assert.equal(readFileSync(join(codexHome, "config.toml"), "utf8"), config);
      assert.equal(readFileSync(join(codexHome, "config.yml"), "utf8"), "unchanged: true\n");
      console.log(`PASS installed server start/dashboard/status/stop cycle ${attempt + 1}; Codex configuration unchanged`);
    }
    npm(["uninstall", "--global", "--prefix", prefix, "--no-audit", "--no-fund", "@remodex/rmx"]);
    installed = false;
    assert(!existsSync(packageRoot));
    for (const alias of ["rmx", "remodex", "opencodex", "ocx"]) assert(!existsSync(join(prefix, `${alias}.cmd`)));
    console.log("PASS npm uninstall removed package and command shims");
  } finally {
    if (child?.pid && child.exitCode === null) {
      spawnSync(join(process.env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 15_000, stdio: "ignore" });
    }
    if (installed) npm(["uninstall", "--global", "--prefix", prefix, "--no-audit", "--no-fund", "@remodex/rmx"]);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runWindowsPackageSmoke();
