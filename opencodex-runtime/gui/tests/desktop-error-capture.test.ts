import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installDesktopFrontendErrorCapture } from "../src/desktop-error-capture";

test("captures window errors once and forwards only bounded fields", async () => {
  const testWindow = new Window({ url: "http://localhost/#providers" });
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const bridgeRoot = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown };
  const previousBridge = bridgeRoot.__TAURI_INTERNALS__;
  bridgeRoot.__TAURI_INTERNALS__ = {
    async invoke(command: string, args?: Record<string, unknown>) {
      calls.push({ command, args });
    },
  };

  try {
    installDesktopFrontendErrorCapture(testWindow as unknown as Window);
    const event = new testWindow.ErrorEvent("error", {
      message: "window render failed",
      error: new Error("window render failed"),
      filename: "http://localhost/assets/app.js",
      lineno: 42,
      colno: 7,
    });
    testWindow.dispatchEvent(event);
    testWindow.dispatchEvent(event);
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "record_desktop_frontend_error",
      args: {
        event: {
          kind: "window-error",
          message: "window render failed",
          source: "http://localhost/assets/app.js:42:7",
          page: "#providers",
        },
      },
    });
  } finally {
    testWindow.close();
    if (previousBridge === undefined) delete bridgeRoot.__TAURI_INTERNALS__;
    else bridgeRoot.__TAURI_INTERNALS__ = previousBridge;
  }
});
