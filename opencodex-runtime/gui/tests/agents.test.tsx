import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Agents from "../src/pages/Agents";
import { resolveConnectHashChange } from "../src/connect-routing";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let win: Window;
let container: HTMLElement;
let root: Root;
let requests: Array<{ url: string; method: string }>;
let failing: boolean;
let desktopPreference: string;
let connection: { connectedSessions: number; verificationRequiredSessions: number; verificationIssue: string | null; desktopVerification: string } | undefined;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#agents" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  requests = []; failing = false; desktopPreference = "off"; connection = undefined;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method ?? "GET" });
    if (failing) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify({ connection, enabled: true, ready: true, binary: "", account: {}, desktopSync: true, autoConnect: { preference: true, blockedByUserSettings: false, desktopPreference, error: null } }));
  } });
  container = document.createElement("div"); document.body.appendChild(container);
});
afterEach(async () => {
  if (root) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); root.unmount(); });
  container.remove(); await win.happyDOM.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
});
async function mount(hash = "#agents") {
  win.history.replaceState(null, "", hash);
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root = createRoot(container); root.render(<LanguageProvider><Agents apiBase="" /></LanguageProvider>); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
}
function tab(id: string) { return container.querySelector(`#agent-tab-${id}`) as HTMLButtonElement; }
function panel(id: string) { return container.querySelector(`#agent-panel-${id}`) as HTMLElement; }

test("agent deep links survive routing and an unknown agent falls back safely", () => {
  for (const hash of ["agents", "agents/claude-code", "agents/codex"]) {
    expect(resolveConnectHashChange(hash)).toEqual({ page: "agents", replaceTo: null });
  }
  expect(resolveConnectHashChange("agents/unknown")).toEqual({ page: "agents", replaceTo: "agents" });
});

test("Claude setup warning lives in its tab; switching preserves drafts without changing either agent", async () => {
  await mount();
  expect(panel("claude-code").textContent).toContain("One-time Desktop setup needed");
  expect(panel("claude-code").textContent).toContain("One PC connection");
  const input = panel("claude-code").querySelector("input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "/custom/claude");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    tab("codex").click();
  });
  expect(panel("claude-code").hidden).toBe(true);
  expect(panel("codex").hidden).toBe(false);
  expect(panel("codex").textContent).toContain("Model and access");
  expect(panel("codex").querySelector('button.switch')).toBeNull();
  await act(async () => tab("claude-code").click());
  expect(input.value).toBe("/custom/claude");
  expect(requests.every(request => request.method === "GET" && request.url.includes("/claude-code"))).toBe(true);
});

test("Codex deep link loads no Claude data until selected and tabs follow keyboard and history", async () => {
  await mount("#agents/codex");
  expect(requests).toEqual([]);
  expect(tab("codex").getAttribute("aria-selected")).toBe("true");
  expect(panel("claude-code")).toBeNull();
  await act(async () => tab("codex").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(document.activeElement).toBe(tab("claude-code"));
  expect(tab("claude-code").tabIndex).toBe(0);
  expect(tab("codex").tabIndex).toBe(-1);
  await act(async () => {
    win.history.replaceState(null, "", "#agents/codex");
    win.dispatchEvent(new win.PopStateEvent("popstate"));
  });
  expect(panel("codex").hidden).toBe(false);
  expect(panel("claude-code").hidden).toBe(true);
});

test("status failure can be retried without turning an agent on", async () => {
  failing = true;
  await mount();
  expect(panel("claude-code").querySelector('[role="alert"]')).not.toBeNull();
  expect(panel("claude-code").querySelector('button.switch')?.hasAttribute("disabled")).toBe(true);
  failing = false; desktopPreference = "on";
  const refresh = [...panel("claude-code").querySelectorAll("button")].find(button => button.textContent === "Check again")!;
  await act(async () => refresh.click());
  expect(panel("claude-code").querySelector('[role="alert"]')).toBeNull();
  expect(panel("claude-code").textContent).toContain("Claude Desktop is set to connect new chats automatically");
  expect(requests.every(request => request.method === "GET")).toBe(true);
});


test("connection preferences never attest to Desktop verification and confirmed failures clear on refresh", async () => {
  desktopPreference = "on";
  connection = { connectedSessions: 1, verificationRequiredSessions: 1, verificationIssue: "device-verification", desktopVerification: "unconfirmed" };
  await mount();
  const content = () => panel("claude-code").textContent ?? "";
  expect(content()).toContain("Claude verification required");
  expect(content()).toContain("Confirmed session connections: 1");
  expect(content()).toContain("Desktop verification not confirmed");
  expect(content()).toContain("do not scan again");
  expect(content()).not.toContain("Claude Code is ready.");
  connection = { ...connection, connectedSessions: 2, verificationRequiredSessions: 0, verificationIssue: null };
  const refresh = [...panel("claude-code").querySelectorAll("button")].find(button => button.textContent === "Check again")!;
  await act(async () => refresh.click());
  expect(content()).not.toContain("Claude verification required");
  expect(content()).toContain("Confirmed session connections: 2");
  expect(content()).toContain("Desktop verification not confirmed");
  expect(requests.every(request => request.method === "GET")).toBe(true);
});
