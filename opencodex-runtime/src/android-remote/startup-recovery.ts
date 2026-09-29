import type { AndroidRemoteSettings } from "./store";

interface StartupRecoveryIo {
  settings(): AndroidRemoteSettings;
  status(): { status: string };
  apply(settings: AndroidRemoteSettings): Promise<void>;
  warn(message: string): void;
  intervalMs?: number;
}

/** Retry only a failed optional phone listener. Never recycle the main server. */
export function startAndroidRemoteRecovery(io: StartupRecoveryIo): { stop(): Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | undefined;
  let failureReported = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(tick, io.intervalMs ?? 30_000);
    timer.unref?.();
  };
  const tick = () => {
    if (stopped || flight) return;
    flight = Promise.resolve().then(async () => {
      if (stopped) return;
      const status = io.status().status;
      if (status === "ready") { failureReported = false; return; }
      if (status === "starting") return;
      const settings = io.settings();
      if (!settings.controlEnabled) return;
      await io.apply(settings);
      failureReported = false;
    }).catch(() => {
      if (!failureReported && !stopped) {
        io.warn("[remodex] Phone connection startup failed; retrying in the background. Main server remains running.");
        failureReported = true;
      }
    }).finally(() => {
      flight = undefined;
      schedule();
    });
  };
  tick();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await flight;
    },
  };
}
