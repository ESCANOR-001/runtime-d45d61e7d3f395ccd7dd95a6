import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Updates from "../src/pages/Updates";
import { SidebarUpdateAction } from "../src/components/sidebar-update-action";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let testWindow: Window;
let root: Root;
let container: HTMLDivElement;
const originalFetch = globalThis.fetch;
const result = { currentVersion: "1.2.18", latestVersion: "1.2.19", channel: "latest", updateAvailable: true, canUpdate: false, releaseNotesVersion: "1.2.19", releaseNotes: "Pairing improvements", checkedAt: "2026-09-23T12:00:00Z" };

beforeEach(() => {
  clearClientResourceStoresForTests();
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  testWindow = new Window({ url: "http://localhost/#android-remote" });
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? testWindow : Reflect.get(testWindow, key) });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearClientResourceStoresForTests();
  testWindow.close(); globalThis.fetch = originalFetch;
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

test("opening the update dialog checks npm without loading removed dashboard features", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async url => { requests.push(String(url)); return Response.json(result); }) as typeof fetch;
  const triggerRef = { current: document.createElement("button") };
  let closed = 0;
  const render = (open: boolean) => root.render(<LanguageProvider><Updates apiBase="" open={open} onClose={() => { closed++; }} triggerRef={triggerRef} /></LanguageProvider>);
  await act(async () => render(false));
  expect(requests).toEqual([]);
  await act(async () => render(true));
  expect(requests).toEqual(["/api/update/check?tag=latest"]);
  expect(container.querySelector("dialog")?.open).toBe(true);
  expect(container.textContent).toContain("1.2.19");
  expect(container.textContent).toContain("Pairing improvements");
  expect(container.textContent).toContain("unpublished Connect copy");
  const update = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Update");
  expect(update?.disabled).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
  expect(closed).toBe(1);
});

test("a failed check offers Retry and never presents stale data as up to date", async () => {
  let attempts = 0;
  globalThis.fetch = (async () => ++attempts === 1 ? new Response(null, { status: 503 }) : Response.json(result)) as typeof fetch;
  await act(async () => root.render(<LanguageProvider><Updates apiBase="" open onClose={() => {}} triggerRef={{ current: null }} /></LanguageProvider>));
  expect(container.textContent).toContain("Could not read the latest version");
  expect(container.textContent).not.toContain("No newer published version");
  const retry = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Retry")!;
  await act(async () => retry.click());
  expect(attempts).toBe(2);
  expect(container.textContent).toContain("1.2.19");
  expect(container.textContent).not.toContain("Could not read the latest version");
});

test("sidebar network failures do not tell users to enable automatic installation", async () => {
  globalThis.fetch = (async () => Response.json({ ...result, latestVersion: null, registryError: { code: "network" } })) as typeof fetch;
  await act(async () => root.render(<LanguageProvider><SidebarUpdateAction onOpenUpdate={() => {}} /></LanguageProvider>));
  expect(container.textContent).toContain("Could not read the latest version");
  expect(container.textContent).not.toContain("rmx system update auto on");
});

test("unpublished channels and rate limits have actionable messages, not an up-to-date badge", async () => {
  for (const [status, message] of [[404, "No release is published"], [429, "too many update checks"]] as const) {
    globalThis.fetch = (async () => Response.json({ ...result, latestVersion: null, updateAvailable: false, registryError: { code: "http", status } })) as typeof fetch;
    await act(async () => root.render(<LanguageProvider><Updates apiBase={`/${status}`} open onClose={() => {}} triggerRef={{ current: null }} /></LanguageProvider>));
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain("No newer published version");
  }
});
