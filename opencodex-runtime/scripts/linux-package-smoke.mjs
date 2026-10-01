import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPosixPackageSmoke } from "./posix-package-smoke.mjs";

export { globalPackagePaths } from "./posix-package-smoke.mjs";

export async function runLinuxPackageSmoke() {
  return runPosixPackageSmoke("linux");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await runLinuxPackageSmoke();
