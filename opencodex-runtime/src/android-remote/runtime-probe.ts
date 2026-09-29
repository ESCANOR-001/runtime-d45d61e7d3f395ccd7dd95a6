// Short-lived helper: synchronous filesystem/version probes must not block the
// main server's health checks, phone sockets, or active request handling.
import { resolveAndroidRuntime } from "./runtime-compatibility";

try {
  console.log(JSON.stringify({ selection: resolveAndroidRuntime() }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : "Could not verify the Codex Desktop runtime." }));
  process.exitCode = 1;
}
