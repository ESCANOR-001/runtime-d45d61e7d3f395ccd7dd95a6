import type { KeyboardEvent } from "react";

export type LogsTab = "logs" | "debug" | "desktop";

const tabs: LogsTab[] = ["logs", "debug", "desktop"];

export function readTabFromHash(): LogsTab {
  const hash = window.location.hash.replace(/^#\/?/, "");
  return hash === "logs/desktop" ? "desktop" : hash === "logs/debug" ? "debug" : "logs";
}

export function selectLogsTab(next: LogsTab) {
  window.location.hash = next === "logs" ? "logs" : `logs/${next}`;
}

export function logsTabKeyDown(event: KeyboardEvent) {
  const current = tabs.indexOf(readTabFromHash());
  const index = event.key === "Home" ? 0
    : event.key === "End" ? tabs.length - 1
    : event.key === "ArrowLeft" ? (current + tabs.length - 1) % tabs.length
    : event.key === "ArrowRight" ? (current + 1) % tabs.length
    : -1;
  if (index < 0) return;
  const next = tabs[index];
  event.preventDefault();
  selectLogsTab(next);
  document.getElementById(`logs-tab-${next}`)?.focus();
}
