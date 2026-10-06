import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import AdvancedSettings from "../src/pages/AdvancedSettings";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let testWindow: Window;
let root: Root;
let container: HTMLDivElement;
const originalFetch = globalThis.fetch;
const initial = { supported: true, installed: false, healthy: false, canManage: true, operation: "idle" };

beforeEach(() => {
  clearClientResourceStoresForTests();
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  testWindow = new Window({ url: "http://localhost/#advanced" });
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
const actionButton = () => container.querySelector<HTMLButtonElement>(".btn-primary")!;
const render = () => root.render(<LanguageProvider><AdvancedSettings apiBase="" /></LanguageProvider>);

for (const platform of ["win32", "linux", "darwin"]) {
  test(`service remains optional and requires a deliberate confirmation on ${platform}`, async () => {
    const requests: Array<{ method: string; body: unknown }> = [];
    let installed = false;
    globalThis.fetch = (async (_url, options) => {
      const method = options?.method ?? "GET";
      requests.push({ method, body: options?.body ? JSON.parse(String(options.body)) : null });
      if (method === "POST") { installed = true; return Response.json({ ok: true }); }
      return Response.json({ ...initial, platform, installed, healthy: installed });
    }) as typeof fetch;
    await act(async () => render());
    expect(requests.map(request => request.method)).toEqual(["GET"]);
    expect(container.textContent).toContain("Not needed for QR pairing");
    await act(async () => actionButton().click());
    expect(requests).toHaveLength(1);
    expect(container.querySelector(".advanced-service-confirm")?.textContent).toContain("briefly disconnect");
    await act(async () => container.querySelector<HTMLButtonElement>(".advanced-service-confirm .btn-ghost")!.click());
    expect(requests).toHaveLength(1);
    await act(async () => actionButton().click());
    await act(async () => actionButton().click());
    expect(requests.filter(request => request.method === "POST")).toEqual([{ method: "POST", body: { action: "install", confirm: true } }]);
    expect(container.textContent).toContain("Background service is ready");
    expect(actionButton().textContent).toBe("Background service is ready.");
    expect(actionButton().disabled).toBe(true);
  });
}

test("an in-flight service action shows progress and failed confirmation does not claim success", async () => {
  let finish!: (response: Response) => void;
  globalThis.fetch = (async (_url, options) => options?.method === "POST"
    ? new Promise<Response>(resolve => { finish = resolve; }) : Response.json({ ...initial, platform: "linux" })) as typeof fetch;
  await act(async () => render());
  await act(async () => actionButton().click());
  await act(async () => actionButton().click());
  expect(actionButton().disabled).toBe(true);
  expect(container.textContent).toContain("Setting up the service — please wait");
  await act(async () => finish(new Response(null, { status: 503 })));
  expect(container.textContent).toContain("The result could not be confirmed");
  expect(container.textContent).not.toContain("Background service is ready");
});

test("unavailable status and conflicting service ownership never enable installation", async () => {
  for (const response of [new Response(null, { status: 503 }), Response.json({ ...initial, canManage: false })]) {
    clearClientResourceStoresForTests();
    globalThis.fetch = (async () => response) as typeof fetch;
    await act(async () => root.render(<LanguageProvider><AdvancedSettings key={response.status} apiBase={`/${response.status}`} /></LanguageProvider>));
    expect(actionButton().disabled).toBe(true);
  }
});

test("a refresh keeps the known status visible and does not disable a valid service action", async () => {
  let finish!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = (async () => ++calls === 1 ? Response.json(initial)
    : new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
  await act(async () => render());
  await act(async () => container.querySelector<HTMLButtonElement>(".btn-ghost")!.click());
  expect(container.textContent).toContain("Background service is not installed");
  expect(container.textContent).not.toContain("Checking service status");
  expect(actionButton().disabled).toBe(false);
  await act(async () => finish(Response.json(initial)));
});

test("a failed status request stays visible throughout the next retry", async () => {
  let finish!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = (async () => ++calls === 1 ? new Response(null, { status: 503 })
    : new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
  await act(async () => render());
  expect(container.textContent).toContain("Could not read service status");
  await act(async () => container.querySelector<HTMLButtonElement>(".btn-ghost")!.click());
  expect(container.textContent).toContain("Could not read service status");
  expect(container.textContent).not.toContain("Checking service status");
  expect(actionButton().disabled).toBe(true);
  await act(async () => finish(Response.json(initial)));
  expect(actionButton().disabled).toBe(false);
});

test("a recovered healthy service clears an earlier unconfirmed action warning", async () => {
  let installed = false;
  globalThis.fetch = (async (_url, options) => {
    if (options?.method === "POST") { installed = true; throw new Error("Server restarted"); }
    return Response.json({ ...initial, installed, healthy: installed });
  }) as typeof fetch;
  await act(async () => render());
  await act(async () => actionButton().click());
  await act(async () => actionButton().click());
  expect(container.textContent).toContain("Background service is ready");
  expect(container.textContent).not.toContain("The result could not be confirmed");
});
