import { describe, expect, test } from "bun:test";
import { requestProxyStop } from "../src/stop-proxy";
import {
  desktopRuntimeBridgeAvailable,
  readDesktopDiagnostics,
  readDesktopRuntimeStatus,
  recordDesktopFrontendError,
  setDesktopProxyRunning,
} from "../src/desktop-runtime";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("App proxy stop", () => {
  test("releases the pending UI and exposes a non-2xx server message", async () => {
    const outcome = await requestProxyStop("", {
      fetchFn: (async () => response({
        success: false,
        message: "native Codex restore failed",
      }, 500)) as typeof fetch,
      formatFailure: status => `Failed to stop proxy (HTTP ${status}).`,
    });

    expect(outcome).toEqual({ accepted: false, message: "native Codex restore failed" });
  });

  test("rejects an HTTP 200 cleanup failure and exposes its server message", async () => {
    const outcome = await requestProxyStop("", {
      fetchFn: (async () => response({
        success: false,
        message: "native Codex cleanup failed",
      })) as typeof fetch,
      formatFailure: status => `Failed to stop proxy (HTTP ${status}).`,
    });

    expect(outcome).toEqual({ accepted: false, message: "native Codex cleanup failed" });
  });

  test("treats a stop timeout like a dropped connection", async () => {
    const outcome = await requestProxyStop("", {
      fetchFn: (async () => {
        throw new DOMException("The operation timed out.", "AbortError");
      }) as typeof fetch,
      timeoutMs: 1,
    });

    expect(outcome).toEqual({ accepted: true });
  });

  test("uses the localized fallback when the server omits a message", async () => {
    const outcome = await requestProxyStop("", {
      fetchFn: (async () => response({}, 503)) as typeof fetch,
      formatFailure: status => `HTTP ${status} stop failed`,
    });

    expect(outcome).toEqual({ accepted: false, message: "HTTP 503 stop failed" });
  });

  test("App clears its pending state and alerts for every rejected stop outcome", async () => {
    const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
    const handleStopIdx = app.indexOf("const handleProxyToggle");
    const brandIdx = app.indexOf("const brand");
    expect(handleStopIdx).toBeGreaterThanOrEqual(0);
    expect(brandIdx).toBeGreaterThan(handleStopIdx);
    const handler = app.slice(handleStopIdx, brandIdx);

    expect(handler).toContain("await requestProxyStop(API_BASE");
    expect(handler).toContain("if (!outcome.accepted)");
    expect(handler).toContain("setProxyActionPending(false)");
    expect(handler).toContain("alert(outcome.message)");
  });

  test("desktop bridge exposes health-derived status and one lifecycle command", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const root = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown };
    const previous = root.__TAURI_INTERNALS__;
    root.__TAURI_INTERNALS__ = {
      async invoke(command: string, args?: Record<string, unknown>) {
        calls.push({ command, args });
        if (command === "read_desktop_diagnostics") {
          return {
            reportVersion: 1,
            generatedAtMs: 1_788_163_200_000,
            appVersion: "1.0.1",
            platform: "windows",
            architecture: "x86_64",
            runtime: { state: "degraded", endpoint: null },
            logPath: ".remodex/desktop-runtime.log",
            logExists: true,
            sourceBytes: 32,
            includedBytes: 24,
            truncated: false,
            log: "redacted desktop error",
          };
        }
        if (command === "record_desktop_frontend_error") return undefined;
        return { state: command === "runtime_status" ? "offline" : "starting", endpoint: null };
      },
    };
    try {
      expect(await readDesktopRuntimeStatus()).toEqual({ state: "offline", endpoint: null });
      expect(await setDesktopProxyRunning(true)).toEqual({ state: "starting", endpoint: null });
      expect(desktopRuntimeBridgeAvailable()).toBe(true);
      expect((await readDesktopDiagnostics())?.log).toBe("redacted desktop error");
      expect(await recordDesktopFrontendError({
        kind: "window-error",
        message: "render failed",
        page: "#providers",
      })).toBe(true);
      expect(calls).toEqual([
        { command: "runtime_status", args: undefined },
        { command: "set_proxy_running", args: { running: true } },
        { command: "read_desktop_diagnostics", args: undefined },
        {
          command: "record_desktop_frontend_error",
          args: {
            event: {
              kind: "window-error",
              message: "render failed",
              page: "#providers",
            },
          },
        },
      ]);
    } finally {
      if (previous === undefined) delete root.__TAURI_INTERNALS__;
      else root.__TAURI_INTERNALS__ = previous;
    }
  });

  test("ordinary browsers do not claim desktop lifecycle support", async () => {
    const root = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown };
    const previous = root.__TAURI_INTERNALS__;
    delete root.__TAURI_INTERNALS__;
    try {
      expect(await readDesktopRuntimeStatus()).toBeNull();
      expect(desktopRuntimeBridgeAvailable()).toBe(false);
      // Browser diagnostics use the runtime HTTP API; lifecycle controls still require the desktop bridge.
      expect(await recordDesktopFrontendError({
        kind: "window-error",
        message: "ignored in browser",
      })).toBe(false);
    } finally {
      if (previous !== undefined) root.__TAURI_INTERNALS__ = previous;
    }
  });
});
