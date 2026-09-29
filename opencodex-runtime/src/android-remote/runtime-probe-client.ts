import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AndroidRuntimeSelection } from "./runtime-compatibility";

export function resolveAndroidRuntimeInBackground(): Promise<AndroidRuntimeSelection> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [fileURLToPath(new URL("./runtime-probe.ts", import.meta.url))], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    }, (error, stdout) => {
      let result: { selection?: AndroidRuntimeSelection; error?: string };
      try { result = JSON.parse(stdout.trim()); }
      catch {
        reject(new Error("Could not verify the Codex Desktop runtime in time. The phone connection will retry."));
        return;
      }
      if (error || !result.selection) {
        reject(new Error(result.error ?? "Could not verify the Codex Desktop runtime."));
        return;
      }
      resolve(result.selection);
    });
  });
}
