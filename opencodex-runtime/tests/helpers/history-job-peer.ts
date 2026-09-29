import { runCodexHistoryJob, type CodexHistoryJobRequest } from "../../src/codex/history-job";
import { liveStorageWorkerCount } from "../../src/storage/worker-lifecycle";

const input = JSON.parse(await Bun.stdin.text()) as {
  requests: CodexHistoryJobRequest[];
  options?: { timeoutMs?: number };
};
const results = [];
for (const request of input.requests) {
  process.env.CODEX_HOME = request.canonicalCodexHome;
  const started = Date.now();
  const outcome = await runCodexHistoryJob(request, input.options);
  results.push({ outcome, liveWorkers: liveStorageWorkerCount(), elapsedMs: Date.now() - started });
}
console.log(JSON.stringify(results));
