import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { NativeLogs, NativeUsage } from "../src/pages/NativeActivity";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let testWindow: Window;
let root: Root;
let container: HTMLDivElement;
const originalFetch = globalThis.fetch;
const at = Date.parse("2026-09-23T10:00:00Z");
const report = () => ({
  source: "native-codex", generatedAt: at,
  rows: [{ id: "turn", thread: "opaque", at, model: "gpt-native", state: "running", input: 10, output: 2, cached: 5, measured: true }],
  usage: [{ day: "2026-09-23", model: "gpt-native", turns: 1, input: 10, output: 2, cached: 5 }],
  diagnostics: { files: 1, pendingFiles: 0, skippedRecords: 0, unreadableFiles: 0, limited: false, missingHome: false, configReadOnly: true },
});

beforeEach(() => {
  clearClientResourceStoresForTests();
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  testWindow = new Window({ url: "http://localhost/#logs" });
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? testWindow : Reflect.get(testWindow, key) });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearClientResourceStoresForTests();
  testWindow.close();
  globalThis.fetch = originalFetch;
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

test("native logs refresh without provider selectors and retain an explicit stale-data error", async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    if (requests > 2) return new Response(null, { status: 503 });
    const next = report();
    if (requests === 2) next.rows[0]!.state = "completed";
    return Response.json(next);
  }) as typeof fetch;
  await act(async () => { root.render(<LanguageProvider><NativeLogs apiBase="" /></LanguageProvider>); });
  expect(container.textContent).toContain("Running");
  expect(container.textContent).not.toMatch(/Claude|Grok|Anthropic/);
  const refresh = () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Refresh")!.click();
  await act(async () => { refresh(); });
  expect(container.textContent).toContain("Completed");
  await act(async () => { refresh(); });
  expect(container.textContent).toContain("may be out of date");
  expect(container.textContent).toContain("Completed");
});

test("native usage filters dates and reports partial history without fabricated costs", async () => {
  const next = report();
  next.usage.push({ day: "2026-09-01", model: "gpt-older", turns: 1, input: 20, output: 3, cached: 0 });
  next.diagnostics.pendingFiles = 3;
  globalThis.fetch = (async () => Response.json(next)) as typeof fetch;
  await act(async () => { root.render(<LanguageProvider><NativeUsage apiBase="" /></LanguageProvider>); });
  expect(container.textContent).toContain("gpt-older");
  expect(container.textContent).toContain("still indexing");
  expect(container.textContent).toContain("not your ChatGPT subscription quota or bill");
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = "7";
    select.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as unknown as Event);
  });
  expect(container.textContent).not.toContain("gpt-older");
});

test("debug shows read-only collector health rather than legacy capture toggles", async () => {
  testWindow.location.hash = "#logs/debug";
  globalThis.fetch = (async () => Response.json(report())) as typeof fetch;
  await act(async () => { root.render(<LanguageProvider><NativeLogs apiBase="" /></LanguageProvider>); });
  expect(container.textContent).toContain("Session files");
  expect(container.textContent).toContain("configuration is read-only");
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Debug");
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
});
