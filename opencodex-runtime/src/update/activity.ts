import type { UpdateActivity } from "./background";
let read: () => UpdateActivity | Promise<UpdateActivity> = () => ({ known: false, running: 0 });
export function setUpdateActivityReader(reader?: () => UpdateActivity | Promise<UpdateActivity>): void {
  read = reader ?? (() => ({ known: false, running: 0 }));
}
export async function readUpdateActivity(): Promise<UpdateActivity> {
  try { return await read(); } catch { return { known: false, running: 0 }; }
}
export async function readRunningUpdateActivity(): Promise<UpdateActivity & { source?: boolean }> {
  try {
    const { runtimeRequest } = await import("../cli/runtime-api");
    const value = await runtimeRequest<{ known?: unknown; running?: unknown; source?: boolean }>(
      "/api/update/activity", { signal: AbortSignal.timeout(8_000) },
    );
    if (typeof value.known !== "boolean" || typeof value.running !== "number" || !Number.isSafeInteger(value.running) || value.running < 0) {
      return { known: false, running: 0 };
    }
    return { known: value.known, running: value.running, source: value.source };
  } catch { return { known: false, running: 0 }; }
}
