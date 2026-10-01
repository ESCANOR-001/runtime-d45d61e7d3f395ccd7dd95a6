import { expect, test } from "bun:test";
import { validatePack } from "../scripts/windows-package-smoke.mjs";

const required = ["bin/ocx.mjs", "bin/package-main.mjs", "src/cli/connect.ts", "gui/dist/index.html"];
const pack = (paths = required) => ({ name: "@remodex/rmx", version: "1.2.21", files: paths.map(path => ({ path })) });

test("installed-package smoke rejects missing assets and private inputs", () => {
  expect(() => validatePack(pack(), "1.2.21")).not.toThrow();
  expect(() => validatePack(pack(required.slice(1)), "1.2.21")).toThrow();
  expect(() => validatePack(pack(), "1.2.22")).toThrow();
  for (const path of ["android/app/build.gradle", ".env", "src-tauri/key.jks", "node_modules/secret.txt"]) {
    expect(() => validatePack(pack([...required, path]), "1.2.21")).toThrow();
  }
});

test("deep Windows workflow is manual, Windows-only, read-only and immutable", async () => {
  const file = Bun.file(new URL("../../.github/workflows/windows-deep.yml", import.meta.url));
  if (!await file.exists()) return;
  const source = await file.text();
  const workflow = Bun.YAML.parse(source) as any;
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  for (const job of Object.values(workflow.jobs) as any[]) {
    expect(job.strategy.matrix.os).toEqual(["windows-2022", "windows-2025"]);
    expect(job.strategy["fail-fast"]).toBe(false);
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout@")) expect(step.with["persist-credentials"]).toBe(false);
    }
  }
  expect(workflow.jobs.runtime.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
  expect(workflow.jobs["npm-install"].strategy.matrix.node).toEqual([20, 22, 24]);
  expect(source).not.toMatch(/secrets\.|npm publish|pull_request_target|self-hosted/);
});
