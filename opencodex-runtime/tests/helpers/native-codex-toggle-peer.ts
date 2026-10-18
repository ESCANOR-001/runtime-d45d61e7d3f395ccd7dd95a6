import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import { liveStorageWorkerCount } from "../../src/storage/worker-lifecycle";
import type { OcxConfig } from "../../src/types";

// Exercise real management routes and history workers outside Bun's test timer
// registry. All requests in a scenario share this process and its route guards.
const input = JSON.parse(await Bun.stdin.text()) as {
  config: OcxConfig;
  steps: { path: string; body?: unknown }[];
  observeRefresh: boolean;
};
let refreshes = 0;
const deps = {
  fetchAllModels: async () => [],
  ...(input.observeRefresh ? {
    androidRemoteController: { notifyModelCatalogChanged() { refreshes += 1; } },
  } : {}),
} as ManagementApiDeps;
const results = [];
for (const step of input.steps) {
  const url = new URL(`http://127.0.0.1:10100${step.path}`);
  const response = await handleManagementAPI(new Request(url, {
    method: step.body === undefined ? "GET" : "PUT",
    headers: { Host: url.host, "Content-Type": "application/json" },
    ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
  }), url, structuredClone(input.config), deps);
  if (!response) throw new Error(`Management route was not handled: ${step.path}`);
  const persisted = JSON.parse(readFileSync(join(process.env.OPENCODEX_HOME!, "config.json"), "utf8"));
  results.push({
    status: response.status,
    body: await response.json(),
    intent: persisted.clientIntegrations?.codex,
    refreshes,
    liveWorkers: liveStorageWorkerCount(),
  });
}
console.log(`NATIVE_TOGGLE_RESULT=${JSON.stringify(results)}`);
