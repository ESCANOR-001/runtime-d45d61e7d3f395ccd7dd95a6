import { expect, test } from "bun:test";
import { join } from "node:path";
import { assertPackageSmokeEnvironment } from "../scripts/posix-package-smoke.mjs";
import { globalPackagePaths } from "../scripts/linux-package-smoke.mjs";

test("Linux global installation preserves spaces and Unicode in its POSIX layout", () => {
  const prefix = join("/tmp", "rmx package ü", "npm prefix");
  const paths = globalPackagePaths(prefix);
  expect(paths.packageRoot).toBe(join(prefix, "lib", "node_modules", "@remodex", "rmx"));
  expect(paths.launcher).toBe(join(paths.packageRoot, "bin", "ocx.mjs"));
  expect(paths.command).toBe(join(prefix, "bin", "rmx"));
});

test("POSIX smoke refuses personal machines and mismatched operating systems", () => {
  expect(() => assertPackageSmokeEnvironment("linux", "linux", "")).toThrow("disposable");
  expect(() => assertPackageSmokeEnvironment("linux", "linux", "false")).toThrow("disposable");
  expect(() => assertPackageSmokeEnvironment("linux", "darwin", "true")).toThrow("requires Linux");
  expect(() => assertPackageSmokeEnvironment("darwin", "linux", "true")).toThrow("requires macOS");
  expect(() => assertPackageSmokeEnvironment("win32", "win32", "true")).toThrow("Unsupported");
  expect(() => assertPackageSmokeEnvironment("linux", "linux", "true")).not.toThrow();
  expect(() => assertPackageSmokeEnvironment("darwin", "darwin", "true")).not.toThrow();
});

test("deep Linux workflow is manual, read-only and covers both Ubuntu versions", async () => {
  const file = Bun.file(new URL("../../.github/workflows/linux-deep.yml", import.meta.url));
  if (!await file.exists()) return;
  const source = await file.text();
  const workflow = Bun.YAML.parse(source) as any;
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  for (const job of Object.values(workflow.jobs) as any[]) {
    expect(job.strategy.matrix.os).toEqual(["ubuntu-22.04", "ubuntu-24.04"]);
    expect(job.strategy["fail-fast"]).toBe(false);
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout@")) expect(step.with["persist-credentials"]).toBe(false);
    }
  }
  expect(workflow.jobs.runtime.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
  expect(workflow.jobs["npm-install"].strategy.matrix.node).toEqual([20, 22, 24]);
  const keyring = workflow.jobs.runtime.steps.find((step: any) => step.name === "Real Linux Secret Service round trip");
  expect(keyring.run).toContain('HOME="$keyring_home" XDG_RUNTIME_DIR="$runtime_dir" dbus-run-session');
  expect(keyring.run).toContain('chmod 700 "$keyring_home" "$runtime_dir"');
  expect(keyring.run).toContain("trap cleanup EXIT");
  expect(keyring.run).toContain("gnome-keyring-daemon --unlock --components=secrets");
  expect(keyring.run).not.toContain("eval ");
  expect(source).not.toMatch(/secrets\.|npm publish|pull_request_target|self-hosted/);
});
