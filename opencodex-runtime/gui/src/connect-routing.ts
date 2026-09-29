import type { AppHashChangeAction, Page } from "./app-routing";
import { normalizeHashPath } from "./hash-routing";

export function resolveConnectHashChange(hash: string): AppHashChangeAction {
  const raw = normalizeHashPath(hash);
  const aliases: Record<string, string> = {
    "desktop-logs": "logs/desktop",
    debug: "logs/debug",
    "codex-auth": "android-remote",
    "android-remote/account": "android-remote",
    "dashboard/update": "android-remote",
    "android-remote/update": "android-remote",
  };
  const target = Object.hasOwn(aliases, raw) ? aliases[raw] : raw;
  const routes: Record<string, Page> = {
    "android-remote": "android-remote",
    "android-remote/pair": "android-remote",
    logs: "logs",
    "logs/debug": "logs",
    "logs/desktop": "logs",
    usage: "usage",
    storage: "storage",
    guide: "guide",
    advanced: "advanced",
  };
  const page = Object.hasOwn(routes, target) ? routes[target] : undefined;
  if (page) return { page, replaceTo: target === raw ? null : target };
  const parent = target.split("/")[0];
  if (parent && Object.hasOwn(routes, parent)) {
    return { page: routes[parent], replaceTo: parent };
  }
  return { page: "android-remote", replaceTo: "android-remote" };
}

export function readConnectPageFromHash(hash?: string): Page {
  return resolveConnectHashChange(hash ?? (typeof window === "undefined" ? "" : window.location.hash)).page;
}
