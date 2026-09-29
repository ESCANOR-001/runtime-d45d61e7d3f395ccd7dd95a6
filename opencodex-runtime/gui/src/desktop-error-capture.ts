import { recordDesktopFrontendError, type DesktopFrontendError } from "./desktop-runtime";

const installedTargets = new WeakSet<Window>();
const recentEvents = new Map<string, number>();
const DUPLICATE_WINDOW_MS = 5_000;
const MAX_RECENT_EVENTS = 64;
const MAX_CAPTURE_CHARS = 8_000;

function bounded(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length <= MAX_CAPTURE_CHARS
    ? value
    : `${value.slice(0, MAX_CAPTURE_CHARS - 1)}…`;
}

function reasonDetails(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) {
    return {
      message: bounded(reason.message) || reason.name || "Unhandled error",
      stack: bounded(reason.stack),
    };
  }
  if (typeof reason === "string") return { message: bounded(reason) || "Unhandled rejection" };
  if (reason === null) return { message: "Unhandled rejection: null" };
  if (reason === undefined) return { message: "Unhandled rejection: undefined" };
  // Do not JSON-serialize arbitrary rejected objects: they may contain credentials,
  // request bodies, or prompts. Rust performs another redaction pass as defense in depth.
  return { message: `Unhandled rejection: ${Object.prototype.toString.call(reason)}` };
}

function shouldRecord(event: DesktopFrontendError): boolean {
  const now = Date.now();
  const signature = `${event.kind}\u0000${event.message}\u0000${event.source ?? ""}`;
  const previous = recentEvents.get(signature);
  if (previous !== undefined && now - previous < DUPLICATE_WINDOW_MS) return false;
  recentEvents.set(signature, now);
  if (recentEvents.size > MAX_RECENT_EVENTS) {
    const oldest = [...recentEvents.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) recentEvents.delete(oldest[0]);
  }
  return true;
}

function submit(event: DesktopFrontendError): void {
  if (!shouldRecord(event)) return;
  void recordDesktopFrontendError(event);
}

/** Installs one best-effort error collector per dashboard Window. */
export function installDesktopFrontendErrorCapture(target: Window = window): void {
  if (installedTargets.has(target)) return;
  installedTargets.add(target);

  target.addEventListener("error", (event: ErrorEvent) => {
    const details = reasonDetails(event.error ?? event.message);
    submit({
      kind: "window-error",
      message: details.message,
      stack: details.stack,
      source: bounded([
        event.filename,
        event.lineno > 0 ? String(event.lineno) : "",
        event.colno > 0 ? String(event.colno) : "",
      ].filter(Boolean).join(":")),
      page: bounded(target.location.hash || "#dashboard"),
    });
  });

  target.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const details = reasonDetails(event.reason);
    submit({
      kind: "unhandled-rejection",
      message: details.message,
      stack: details.stack,
      page: bounded(target.location.hash || "#dashboard"),
    });
  });
}
