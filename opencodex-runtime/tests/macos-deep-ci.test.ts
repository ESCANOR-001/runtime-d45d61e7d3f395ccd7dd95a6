import { expect, test } from "bun:test";
import { join } from "node:path";
import { globalPackagePaths, runMacosPackageSmoke } from "../scripts/macos-package-smoke.mjs";

test("macOS global installation uses lib/node_modules and bin without losing spaces or Unicode", () => {
  const prefix = join("/tmp", "rmx package ü", "npm prefix");
  const paths = globalPackagePaths(prefix);
  expect(paths.packageRoot).toBe(join(prefix, "lib", "node_modules", "@remodex", "rmx"));
  expect(paths.launcher).toBe(join(paths.packageRoot, "bin", "ocx.mjs"));
  expect(paths.command).toBe(join(prefix, "bin", "rmx"));
});

test.skipIf(process.platform === "darwin")("macOS integration refuses other operating systems before modifying anything", async () => {
  await expect(runMacosPackageSmoke()).rejects.toThrow("requires macOS");
});

test("deep macOS workflow covers both architectures with manual read-only CI", async () => {
  const file = Bun.file(new URL("../../.github/workflows/macos-deep.yml", import.meta.url));
  if (!await file.exists()) return;
  const source = await file.text();
  const workflow = Bun.YAML.parse(source) as any;
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  for (const job of Object.values(workflow.jobs) as any[]) {
    expect(job.strategy.matrix.os).toEqual(["macos-15", "macos-15-intel"]);
    expect(job.strategy["fail-fast"]).toBe(false);
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout@")) expect(step.with["persist-credentials"]).toBe(false);
    }
  }
  expect(workflow.jobs.runtime.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
  expect(workflow.jobs["npm-install"].strategy.matrix.node).toEqual([20, 22, 24]);
  expect(source).not.toMatch(/secrets\.|npm publish|pull_request_target|self-hosted|macos-\S*(?:large|xlarge)/);
});
