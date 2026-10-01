import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { validatePack } from "./windows-package-smoke.mjs";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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

export function globalPackagePaths(prefix) {
  const packageRoot = join(prefix, "lib", "node_modules", "@remodex", "rmx");
  return { packageRoot, launcher: join(packageRoot, "bin", "ocx.mjs"), command: join(prefix, "bin", "rmx") };
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

export async function runMacosPackageSmoke() {
  assert.equal(process.platform, "darwin", "This integration smoke requires macOS");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Only run inside a disposable GitHub Actions runner");
  const root = mkdtempSync(join(tmpdir(), "rmx package ü "));
  const prefix = join(root, "npm prefix");
  const home = join(root, "user home");
  const runtimeHome = join(home, ".remodex-connect");
  const codexHome = join(home, ".codex");
  const nodeBin = join(root, "node bin");
  for (const directory of [prefix, runtimeHome, codexHome, nodeBin]) mkdirSync(directory, { recursive: true });
  symlinkSync(process.execPath, join(nodeBin, "node"));
  const config = 'model = "unchanged-smoke-model"\n';
  writeFileSync(join(codexHome, "config.toml"), config);
  writeFileSync(join(codexHome, "config.yml"), "unchanged: true\n");
  const environment = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    OPENCODEX_HOME: runtimeHome,
    PATH: [nodeBin, ...(process.env.PATH ?? "").split(delimiter).filter(directory => directory && !existsSync(join(directory, "bun")))].join(delimiter),
  };
  let child;
  let installed = false;
  try {
    const version = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")).version;
    const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", root]));
    assert.equal(packed.length, 1);
    validatePack(packed[0], version);
    console.log("PASS package contents and dashboard assets");
    run("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", join(root, packed[0].filename)]);
    installed = true;
    const { packageRoot, launcher, command } = globalPackagePaths(prefix);
    const cli = (...args) => run(process.execPath, [launcher, ...args], { cwd: home, env: environment });
    const standalone = spawnSync("bun", ["--version"], { env: environment, windowsHide: true, timeout: 10_000 });
    assert.equal(standalone.error?.code, "ENOENT", "Standalone Bun must be absent from smoke PATH");
    assert.match(cli("help"), /Remodex Connect/);
    assert(cli("version").includes(version));
    assert.equal(realpathSync(command), realpathSync(launcher));
    for (const shell of ["/bin/bash", "/bin/zsh"]) {
      assert.match(run(shell, ["-f", "-c", 'exec "$1" help', "rmx-smoke", command], { env: environment, cwd: home }), /Remodex Connect/);
    }
    console.log(`PASS installed Node launcher and bash/zsh command on ${process.arch} without standalone Bun`);
    const bunDirectory = join(packageRoot, "node_modules", "bun", "bin");
    const bun = ["bun.exe", "bun"].map(name => join(bunDirectory, name)).find(path => existsSync(path));
    assert(bun, "Installed package is missing bundled Bun");
    run(bun, ["-e", `if (process.arch !== ${JSON.stringify(process.arch)}) throw new Error("Bun architecture mismatch"); const sharp = (await import("sharp")).default; const image = await sharp({create:{width:2,height:2,channels:3,background:"red"}}).png().toBuffer(); if (!(image.length > 0)) throw new Error("image encoding failed"); await import("@napi-rs/keyring");`], { cwd: packageRoot, env: environment });
    console.log("PASS native architecture, image processing and Keychain dependencies");
    const port = await unusedPort();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let output = "";
      let spawnError;
      child = spawn(process.execPath, [launcher, "start", "--port", String(port)], { cwd: home, env: environment, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.on("error", error => { spawnError = error; });
      for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output = (output + data).slice(-32_000); });
      const deadline = Date.now() + 60_000;
      let ready = false;
      while (Date.now() < deadline && !spawnError && child.exitCode === null && child.signalCode === null) {
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
      while (child.exitCode === null && child.signalCode === null && Date.now() < stoppedBy) await delay(200);
      assert(child.exitCode !== null || child.signalCode !== null, `Installed server did not stop\n${output}`);
      child = undefined;
      assert.equal(readFileSync(join(codexHome, "config.toml"), "utf8"), config);
      assert.equal(readFileSync(join(codexHome, "config.yml"), "utf8"), "unchanged: true\n");
      console.log(`PASS installed server start/dashboard/status/stop cycle ${attempt + 1}; Codex configuration unchanged`);
    }
    run("npm", ["uninstall", "--global", "--prefix", prefix, "--no-audit", "--no-fund", "@remodex/rmx"]);
    installed = false;
    assert(!existsSync(packageRoot));
    for (const alias of ["rmx", "remodex", "opencodex", "ocx"]) assert(!existsSync(join(prefix, "bin", alias)));
    console.log("PASS npm uninstall removed package and command symlinks");
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    try {
      if (installed) run("npm", ["uninstall", "--global", "--prefix", prefix, "--no-audit", "--no-fund", "@remodex/rmx"]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await runMacosPackageSmoke();
