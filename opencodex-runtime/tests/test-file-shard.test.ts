import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverTestFiles, runTestFiles, selectTestShard } from "../scripts/test-file-shard";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("four deterministic shards cover each test file exactly once", () => {
  const files = ["z.test.ts", "nested/c.test.ts", "a.test.ts", "b.test.ts", "d.test.ts"];
  const shards = [1, 2, 3, 4].map(index => selectTestShard(files, `--shard=${index}/4`));
  const combined = shards.flat();
  expect(combined.sort()).toEqual([...files].sort());
  expect(new Set(combined).size).toBe(files.length);
  expect(selectTestShard([...files].reverse(), "--shard=1/4")).toEqual(shards[0]);
});

test.each(["", "--shard=0/4", "--shard=5/4", "--shard=1/0", "--shard=1/4 extra"])(
  "invalid shard arguments fail rather than silently dropping coverage: %s", argument => {
    expect(() => selectTestShard(["test.ts"], argument)).toThrow();
  },
);

test("empty shards fail", () => {
  expect(() => selectTestShard([], "--shard=1/4")).toThrow("empty");
});

test("discovery includes nested tests but excludes dependencies and scratch fixtures", () => {
  const root = mkdtempSync(join(tmpdir(), "rmx-test-shard-"));
  roots.push(root);
  for (const directory of ["nested", "node_modules", ".tmp-fixture"]) mkdirSync(join(root, directory));
  for (const path of ["one.test.ts", "nested/two.spec.ts", "helper.ts", "node_modules/vendor.test.ts", ".tmp-fixture/stale.test.ts"]) {
    writeFileSync(join(root, path), "");
  }
  expect(discoverTestFiles(root)).toEqual(["./tests/nested/two.spec.ts", "./tests/one.test.ts"]);
});

test("failed and crashed files remain failures while later files still run", () => {
  const calls: string[] = [];
  const files = ["pass.test.ts", "fail.test.ts", "crash.test.ts", "last.test.ts"];
  const result = runTestFiles(files, file => {
    calls.push(file);
    return file === "fail.test.ts" ? 1 : file === "crash.test.ts" ? 134 : 0;
  });
  expect(calls).toEqual(files);
  expect(result).toEqual({ passedFiles: 2, failedFiles: ["fail.test.ts", "crash.test.ts"] });
});
