import { expect, test } from "bun:test";
import { readConnectPageFromHash, resolveConnectHashChange } from "../src/connect-routing";

test("the new dashboard lands on Android Remote and retires unrelated routes", () => {
  for (const hash of ["", "#dashboard", "providers", "models", "subagents", "integrations", "startup", "constructor", "__proto__", "unknown"]) {
    expect(resolveConnectHashChange(hash)).toEqual({ page: "android-remote", replaceTo: "android-remote" });
  }
});

test("the sections including Advanced Settings and their subviews survive reload", () => {
  for (const hash of ["android-remote", "android-remote/pair", "logs", "logs/debug", "logs/desktop", "usage", "storage", "guide", "advanced"]) {
    expect(resolveConnectHashChange(`#/${hash}`)).toEqual({ page: hash.split("/")[0], replaceTo: null });
  }
});

test("legacy support links keep a useful destination", () => {
  expect(resolveConnectHashChange("desktop-logs")).toEqual({ page: "logs", replaceTo: "logs/desktop" });
  expect(resolveConnectHashChange("debug")).toEqual({ page: "logs", replaceTo: "logs/debug" });
  expect(resolveConnectHashChange("codex-auth")).toEqual({ page: "android-remote", replaceTo: "android-remote" });
  expect(resolveConnectHashChange("dashboard/update")).toEqual({ page: "android-remote", replaceTo: "android-remote" });
  expect(readConnectPageFromHash("#android-remote/update")).toBe("android-remote");
  expect(readConnectPageFromHash("#android-remote/account")).toBe("android-remote");
});

test("unknown suffixes normalize without adding a history entry", () => {
  expect(resolveConnectHashChange("logs/nope")).toEqual({ page: "logs", replaceTo: "logs" });
  expect(resolveConnectHashChange("usage/nope")).toEqual({ page: "usage", replaceTo: "usage" });
});
