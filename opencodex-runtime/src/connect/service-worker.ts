import { finishServiceSetup, readServiceSetup } from "./service-setup";
import { getStartupInstallState, runStartupInstallAction } from "../server/startup-action-control";
import { findLiveProxy } from "../server/proxy-liveness";
import { startUserRuntime } from "../cli/user-runtime";

const [id, action] = process.argv.slice(2);
if (process.env.REMODEX_CONNECT_ONLY !== "1" || !id || !["install", "repair"].includes(action ?? "")) {
  throw new Error("Invalid service setup worker invocation");
}
let ownsJob = false;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    const job = readServiceSetup();
    ownsJob = job?.id === id && job.pid === process.pid;
  } catch {}
  if (ownsJob) break;
  await Bun.sleep(50);
}
if (!ownsJob) throw new Error("Service setup worker does not own this attempt");
try {
  await runStartupInstallAction("install-service", { repair: action === "repair" });
  finishServiceSetup(id, "succeeded");
} catch {
  const state = getStartupInstallState();
  if (state.status === "indeterminate") await state.reconciliation.catch(() => undefined);
  try {
    if (!await findLiveProxy()) await startUserRuntime();
  } catch {}
  finishServiceSetup(id, getStartupInstallState().status === "blocked" ? "blocked" : "failed");
  process.exitCode = 1;
}
