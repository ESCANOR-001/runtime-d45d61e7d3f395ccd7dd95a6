import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import DesktopLogs from "../src/pages/DesktopLogs";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let previousBridge: unknown;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  previousBridge = (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  testWindow = new Window({ url: "http://localhost/#desktop-logs" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
  const bridgeRoot = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown };
  if (previousBridge === undefined) delete bridgeRoot.__TAURI_INTERNALS__;
  else bridgeRoot.__TAURI_INTERNALS__ = previousBridge;
});

test("shows the exact redacted report and opens a prefilled support email", async () => {
  const emailReports: string[] = [];
  const bridgeRoot = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown };
  bridgeRoot.__TAURI_INTERNALS__ = {
    async invoke(command: string, args?: Record<string, unknown>) {
      if (command === "read_desktop_diagnostics") {
        return {
          reportVersion: 1,
          generatedAtMs: Date.UTC(2026, 8, 1, 0, 0, 0),
          appVersion: "1.0.1",
          platform: "windows",
          architecture: "x86_64",
          runtime: { state: "degraded", endpoint: null },
          logPath: ".remodex/desktop-runtime.log",
          logExists: true,
          sourceBytes: 128,
          includedBytes: 64,
          truncated: false,
          log: "Apply Changes Failed\n[redacted sensitive data]",
        };
      }
      if (command === "open_support_email") {
        emailReports.push(String(args?.report ?? ""));
        return;
      }
      throw new Error(`unexpected command: ${command}`);
    },
  };

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<LanguageProvider><DesktopLogs /></LanguageProvider>);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Desktop logs");
    expect(container.textContent).toContain("Apply Changes Failed");
    expect(container.textContent).toContain("[redacted sensitive data]");
    expect(container.textContent).toContain(".remodex/desktop-runtime.log");
    expect(container.textContent).toContain("Copy report");
    expect(container.textContent).not.toContain("Save report");
    const send = Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent?.includes("Send to support"));
    expect(send?.disabled).toBe(false);

    await act(async () => {
      send?.click();
      await Promise.resolve();
    });

    expect(emailReports).toHaveLength(1);
    expect(emailReports[0]).toContain("Remodex desktop diagnostics");
    expect(emailReports[0]).toContain("Apply Changes Failed");
    expect(emailReports[0]).toContain("[redacted sensitive data]");
    expect(container.textContent).toContain("Gmail opened with the redacted report");
  } finally {
    await act(async () => {
      root?.unmount();
    });
  }
});
