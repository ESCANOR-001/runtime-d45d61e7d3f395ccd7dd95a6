import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { AndroidCodexRuntime, AndroidCodexResponseTooLargeError } from "../src/android-remote/codex-app-server";
import { selectAndroidRuntime, verifyAndroidRuntimePeer } from "../src/android-remote/runtime-compatibility";
import type { ResolvedCodexRuntime } from "../src/codex/runtime";

const desktop: ResolvedCodexRuntime = { command: "desktop/codex.exe", version: "0.153.4", source: "path" };
const stale: ResolvedCodexRuntime = { command: "npm/codex.exe", version: "0.147.0", source: "path" };
test.each(["thread/turns/list", "turn/start"])("oversized %s fails explicitly without replay and allows a fresh connection", async method => {
  const originalWebSocket = globalThis.WebSocket;
  if (process.env.REMODEX_TEST_TRANSPORT_DIAGNOSTICS === "1") {
    globalThis.WebSocket = class extends originalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", event => console.error(JSON.stringify({
          client: true, type: typeof event.data, constructor: event.data?.constructor?.name,
          length: event.data?.length, size: event.data?.size,
        })));
        this.addEventListener("close", event => console.error(JSON.stringify({ client: true, closed: event.code })));
      }
    };
  }
  const peer = spawn(process.execPath, [join(import.meta.dir, "helpers/codex-oversized-peer.ts"), method], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>(resolve => {
    peer.once("exit", () => resolve());
    peer.once("error", () => resolve());
  });
  let diagnostics = "";
  peer.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
  const listening = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Oversized peer startup timed out: ${diagnostics}`)), 10_000);
    let output = "";
    peer.stdout.on("data", chunk => {
      output += chunk;
      if (!output.includes("\n")) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(output.split("\n")[0]!).port); }
      catch (error) { reject(error); }
    });
    peer.once("error", error => { clearTimeout(timer); reject(error); });
    peer.once("exit", () => { clearTimeout(timer); reject(new Error(`Oversized peer exited: ${diagnostics}`)); });
  });
  let runtime: AndroidCodexRuntime | undefined;
  try {
    runtime = new AndroidCodexRuntime(await listening, () => ({ runtime: desktop, desktopVersion: desktop.version }));
    const client = await runtime.start();
    const failure = await client.request(method, { threadId: "oversized" }, 10_000).then(
      () => null,
      error => error,
    );
    expect(failure).toBeInstanceOf(AndroidCodexResponseTooLargeError);
    expect(await client.request("thread/read", { threadId: "oversized", includeTurns: false })).toEqual({ ready: true, requests: 1 });
  } finally {
    globalThis.WebSocket = originalWebSocket;
    if (diagnostics) console.error(diagnostics);
    await runtime?.stop();
    peer.kill("SIGTERM");
    const killTimer = setTimeout(() => peer.kill("SIGKILL"), 2_000);
    await exited;
    clearTimeout(killTimer);
    peer.stdout.destroy();
    peer.stderr.destroy();
  }
}, 30_000);
test("automatic Android selection uses the verified Desktop build", () => {
  expect(selectAndroidRuntime(stale, [desktop]).runtime.command).toBe(desktop.command);
  expect(selectAndroidRuntime(stale, []).runtime).toBe(stale);
});
test("preserves a matching environment override and explains mismatch without switching it", () => {
  expect(() => selectAndroidRuntime({ ...stale, source: "environment" }, [desktop])).toThrow("Update or remove CODEX_CLI_PATH");
  const explicit = { ...stale, source: "environment" as const, version: desktop.version };
  expect(selectAndroidRuntime(explicit, [desktop]).runtime).toBe(explicit);
});
test("a saved CLI version cannot strand Android after a Desktop update", () => {
  const configured = { ...stale, source: "configured" as const };
  const nextDesktop = { ...desktop, command: "new-desktop/codex.exe", version: "0.200.0" };
  expect(selectAndroidRuntime(configured, [desktop]).runtime).toBe(desktop);
  expect(selectAndroidRuntime(configured, [nextDesktop]).runtime).toBe(nextDesktop);
  expect(configured.command).toBe(stale.command);
  expect(configured.version).toBe("0.147.0");
  expect(selectAndroidRuntime(configured, []).runtime).toBe(configured);
});

test("slow runtime selection does not block health requests or duplicate a connection attempt", async () => {
  let finish!: (value: { runtime: ResolvedCodexRuntime; desktopVersion: string | null }) => void;
  let selections = 0;
  const pending = new Promise<{ runtime: ResolvedCodexRuntime; desktopVersion: string | null }>(resolve => { finish = resolve; });
  const health = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("healthy") });
  const runtime = new AndroidCodexRuntime(health.port!, () => { selections++; return pending; });
  const first = runtime.start();
  const second = runtime.start();
  const assertions = Promise.allSettled([first, second]);
  try {
    expect(await (await fetch(`http://127.0.0.1:${health.port}`, { signal: AbortSignal.timeout(1000) })).text()).toBe("healthy");
    expect(selections).toBe(1);
    const stop = runtime.stop();
    finish({ runtime: desktop, desktopVersion: desktop.version });
    expect((await assertions).every(result => result.status === "rejected")).toBe(true);
    await stop;
    expect(runtime.status().ownedProcess).toBe(false);
  } finally { await health.stop(true); }
});
test("ambiguous Desktop installations require an explicit repair instead of guessed compatibility", () => {
  expect(() => selectAndroidRuntime(stale, [desktop, stale])).toThrow("Multiple");
});

test("a healthy task connection is not replaced when a different Desktop version becomes available", async () => {
  let selections = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("ready"); },
    websocket: { message(socket, bytes) {
      const message = JSON.parse(String(bytes));
      if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: message.method === "initialize" ? { userAgent: "codex/0.153.4" } : { accepted: true } }));
    } },
  });
  const runtime = new AndroidCodexRuntime(server.port!, () => {
    if (++selections > 1) throw new Error("Desktop changed while work was active");
    return { runtime: desktop, desktopVersion: desktop.version };
  });
  try {
    const client = await runtime.start();
    expect(await runtime.start()).toBe(client);
    expect(await client.request("turn/start", { threadId: "test-thread", input: [] })).toEqual({ accepted: true });
    expect(selections).toBe(1);
    expect(runtime.status().connected).toBe(true);
  } finally { await runtime.stop(); await server.stop(true); }
});
test("checks the connected server's version, including an already listening server", async () => {
  expect(verifyAndroidRuntimePeer("codex/0.153.4", "0.153.4")).toBe("0.153.4");
  expect(() => verifyAndroidRuntimePeer("unrecognized", "0.153.4")).toThrow("unknown");
  const received: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("ready"); },
    websocket: { message(socket, bytes) {
      const message = JSON.parse(String(bytes));
      received.push(message.method);
      socket.send(JSON.stringify({ id: message.id, result: { userAgent: "codex/0.147.0" } }));
    } },
  });
  const runtime = new AndroidCodexRuntime(server.port!, () => ({ runtime: desktop, desktopVersion: desktop.version }));
  try {
    await expect(runtime.start()).rejects.toThrow("requires 0.153.4");
    expect(received).toEqual(["initialize"]);
    expect(runtime.status().connected).toBe(false);
    expect(runtime.status().ownedProcess).toBe(false);
  } finally {
    await runtime.stop();
    await server.stop(true);
  }
});
