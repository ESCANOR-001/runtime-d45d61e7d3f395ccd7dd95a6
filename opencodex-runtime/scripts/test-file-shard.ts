import { join } from "node:path";

export function selectTestShard(files: readonly string[], argument: string): string[] {
  const match = /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(argument);
  if (!match) throw new Error("Expected --shard=index/count.");
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count) {
    throw new Error("Invalid test shard index or count.");
  }
  const selected = [...files].sort().filter((_, position) => position % count === index - 1);
  if (selected.length === 0) throw new Error("The selected test shard is empty.");
  return selected;
}

export function discoverTestFiles(directory = join(import.meta.dir, "..", "tests")): string[] {
  return [...new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}").scanSync({
    cwd: directory,
    onlyFiles: true,
    followSymlinks: false,
  })].map(path => path.replaceAll("\\", "/"))
    .filter(path => !path.split("/").some(part => part.startsWith(".") || part === "node_modules"))
    .map(path => `./tests/${path}`)
    .sort();
}

export function runTestFiles(
  files: readonly string[],
  run: (file: string) => number,
): { passedFiles: number; failedFiles: string[] } {
  let passedFiles = 0;
  const failedFiles: string[] = [];
  for (const file of files) {
    if (run(file) === 0) passedFiles += 1;
    else failedFiles.push(file);
  }
  return { passedFiles, failedFiles };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw new Error("Expected exactly one --shard=index/count argument.");
    const files = selectTestShard(discoverTestFiles(), args[0]!);
    console.log(`Running ${files.length} test files in separate processes (${args[0]}).`);
    const result = runTestFiles(files, file => {
      console.log(`::group::${file}`);
      try {
        const child = Bun.spawnSync([process.execPath, "scripts/test.ts", file], {
          cwd: join(import.meta.dir, ".."),
          windowsHide: true,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        });
        return child.exitCode ?? 1;
      } catch (error) {
        console.error(error);
        return 1;
      } finally {
        console.log("::endgroup::");
      }
    });
    console.log(`${result.passedFiles} test files passed; ${result.failedFiles.length} failed.`);
    for (const file of result.failedFiles) console.error(`Failed test file: ${file}`);
    process.exitCode = result.failedFiles.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
