import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import CodexIntegrationPage from "../src/pages/integrations/CodexIntegrationPage";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let apiBase = "";
let mountSequence = 0;
let desiredEnabled = true;
let routingInjected = true;
let nextToggleResponse: ((enabled: boolean) => Response) | null = null;
let requests: Array<{ url: string; method: string; body: unknown }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  mountSequence += 1;
  apiBase = `http://codex-mode-${mountSequence}.invalid`;
  desiredEnabled = true;
  routingInjected = true;
  nextToggleResponse = null;
  requests = [];

  testWindow = new Window({ url: "http://localhost/#integrations/codex" });
  Object.defineProperty(testWindow.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });

    if (url.endsWith("/api/native-integrations/codex") && method === "PUT") {
      const enabled = (body as { enabled: boolean }).enabled;
      if (nextToggleResponse) return nextToggleResponse(enabled);
      desiredEnabled = enabled;
      routingInjected = enabled;
      return json({
        ok: true,
        clientId: "codex",
        changed: true,
        state: enabled ? "current" : "absent",
        desiredEnabled: enabled,
        message: enabled ? "routed" : "native",
      });
    }
    if (url.endsWith("/api/native-integrations")) {
      return json({
        clients: [{
          clientId: "codex",
          state: desiredEnabled ? "current" : "absent",
          installed: true,
          configPath: "/home/test/.codex/config.toml",
          desiredEnabled,
          disableBlocked: null,
        }],
      });
    }
    if (url.endsWith("/api/startup-health")) {
      return json({
        routingInjected,
        status: routingInjected ? "protected" : "native",
        recommendedCommand: null,
      });
    }
    return json({ error: "unexpected route" }, 404);
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: previousGlobals[key],
    });
  }
});

async function mount(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <CodexIntegrationPage apiBase={apiBase} />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30));
  });
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    candidate => candidate.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
  if (!found) throw new Error(`button not found: ${text}`);
  return found;
}

async function confirmMode(buttonText: string): Promise<void> {
  await act(async () => { button(buttonText).click(); });
  const confirm = container.querySelector<HTMLButtonElement>(
    ".integration-consequence-dialog .modal-actions .btn-primary",
  );
  if (!confirm) throw new Error("confirmation button not found");
  await act(async () => {
    confirm.click();
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30));
  });
}

test("explains both modes, Android continuity, and the protected config path", async () => {
  await mount();

  expect(container.textContent).toContain("Native ChatGPT + Android Remote");
  expect(container.textContent).toContain("Remodex model routing");
  expect(container.textContent).toContain("Recommended");
  expect(container.textContent).toContain("Android Remote stays available");
  expect(container.textContent).toContain("/home/test/.codex/config.toml");
  expect(container.textContent).toContain("commented line");
});

test("switches to native ChatGPT without calling a restart endpoint", async () => {
  await mount();
  await confirmMode("Use native ChatGPT");

  const mutation = requests.find(request =>
    request.url.endsWith("/api/native-integrations/codex") && request.method === "PUT");
  expect(mutation?.body).toEqual({ enabled: false });
  expect(requests.some(request => request.url.includes("/api/system/restart"))).toBe(false);
  expect(container.textContent).toContain(
    "Codex now uses native ChatGPT. Android Remote remains available.",
  );
});

test("switches from native ChatGPT to Remodex routing after confirmation", async () => {
  desiredEnabled = false;
  routingInjected = false;
  await mount();
  await confirmMode("Use Remodex routing");

  const mutation = requests.find(request =>
    request.url.endsWith("/api/native-integrations/codex") && request.method === "PUT");
  expect(mutation?.body).toEqual({ enabled: true });
  expect(container.textContent).toContain(
    "Codex and Android can now use Remodex-routed models.",
  );
});

test("treats a successful HTTP response with unsafe convergence as an error", async () => {
  nextToggleResponse = enabled => json({
    ok: true,
    clientId: "codex",
    changed: true,
    state: "unsafe",
    desiredEnabled: enabled,
    message: "Native intent was saved, but config restoration is incomplete.",
  });
  await mount();
  await confirmMode("Use native ChatGPT");

  expect(container.textContent).toContain(
    "Native intent was saved, but config restoration is incomplete.",
  );
  expect(container.textContent).not.toContain(
    "Codex now uses native ChatGPT. Android Remote remains available.",
  );
});
