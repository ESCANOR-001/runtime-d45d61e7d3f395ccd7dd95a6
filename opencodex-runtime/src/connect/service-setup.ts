import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { isProcessAlive } from "../lib/process-control";

type SetupJob = { id: string; pid: number; startedAt: number; status: "running" | "succeeded" | "failed" | "blocked" };
const jobPath = () => join(getConfigDir(), "connect-service-setup.json");

export function readServiceSetup(): SetupJob | null {
  if (!existsSync(jobPath())) return null;
  if (statSync(jobPath()).size > 8192) throw new Error("Invalid service setup state");
  const job = JSON.parse(readFileSync(jobPath(), "utf8")) as SetupJob;
  if (!job || typeof job.id !== "string" || !Number.isSafeInteger(job.pid) || job.pid <= 0
    || !Number.isFinite(job.startedAt) || !["running", "succeeded", "failed", "blocked"].includes(job.status)) throw new Error("Invalid service setup state");
  return job;
}

export function serviceSetupState(): "idle" | "running" | "indeterminate" | "blocked" | "failed" {
  try {
    const job = readServiceSetup();
    if (!job) return "idle";
    if (job.status === "blocked") return "blocked";
    if (isProcessAlive(job.pid)) return Date.now() - job.startedAt > 180_000 ? "indeterminate" : "running";
    return job.status === "succeeded" ? "idle" : "failed";
  } catch { return "blocked"; }
}

export function finishServiceSetup(id: string, status: "succeeded" | "failed" | "blocked"): void {
  const job = readServiceSetup();
  if (job?.id !== id || job.pid !== process.pid) throw new Error("Service setup ownership changed");
  const temporary = `${jobPath()}.${id}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...job, status }), { mode: 0o600 });
  renameSync(temporary, jobPath());
}

export async function startServiceSetup(action: "install" | "repair", spawnFn: typeof spawn = spawn): Promise<void> {
  if (!["idle", "failed"].includes(serviceSetupState())) throw new Error("Service setup is pending");
  if (existsSync(jobPath())) unlinkSync(jobPath());
  const lock = openSync(jobPath(), "wx", 0o600);
  const id = randomUUID();
  const startedAt = Date.now();
  let log: number | undefined;
  try {
    log = openSync(join(getConfigDir(), "connect-service-setup.log"), "a", 0o600);
    writeFileSync(lock, JSON.stringify({ id, pid: process.pid, startedAt, status: "running" }));
    const env = { ...process.env };
    delete env.OCX_SERVICE;
    await new Promise<void>((resolve, reject) => {
      const child = spawnFn(process.execPath, [join(import.meta.dir, "service-worker.ts"), id, action], {
        detached: true, windowsHide: true, shell: false, env, stdio: ["ignore", log, log],
      });
      child.once("error", reject);
      child.once("spawn", () => {
        try {
          writeFileSync(jobPath(), JSON.stringify({ id, pid: child.pid, startedAt, status: "running" }), { mode: 0o600 });
          child.unref();
          resolve();
        } catch (error) { child.unref(); reject(error); }
      });
    });
  } catch (error) {
    try { if (readServiceSetup()?.id === id) unlinkSync(jobPath()); } catch {}
    throw error;
  } finally { closeSync(lock); if (log !== undefined) closeSync(log); }
}
