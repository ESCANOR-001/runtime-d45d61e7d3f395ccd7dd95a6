import type { AdmissionLease } from "../lib/admission";

export interface ProxyStopRestoreResult {
  success: boolean;
  message: string;
}

export interface ProxyStopGrokResult {
  ok: boolean;
  message: string;
}

export interface ProxyStopPreparationIo {
  acquireDrain: () => AdmissionLease | null;
  assertServiceOwnership: () => void;
  restoreNativeCodex: () => Promise<ProxyStopRestoreResult>;
  restoreGrok: () => ProxyStopGrokResult;
  serviceInstalled: () => boolean;
  /** True when the request is running inside the process supervised by that service. */
  isServiceProcess?: () => boolean;
  /** Record an intentional stop before the supervised process exits. */
  requestServiceStop?: () => void;
  /** Undo the intentional-stop signal when teardown is refused. */
  clearServiceStopRequest?: () => void;
  stopService: () => boolean;
  beginShutdown: () => void;
}

export type ProxyStopPreparation =
  | { ok: true; message: string }
  | { ok: false; status: 409; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Prepare one intentional proxy shutdown without ever publishing a dead local
 * route. The temporary drain fences new turns while Remodex-owned client state
 * is restored. It is released on every refusal so the live proxy remains usable;
 * only the success path promotes the process to the irreversible shutdown drain.
 */
export async function prepareProxyStop(
  io: ProxyStopPreparationIo,
): Promise<ProxyStopPreparation> {
  const drain = io.acquireDrain();
  if (!drain) {
    return {
      ok: false,
      status: 409,
      message: "Another proxy lifecycle action is already in progress. Retry shortly.",
    };
  }

  let stopRequestArmed = false;
  let shutdownCommitted = false;
  const refuse = (message: string): ProxyStopPreparation => {
    if (stopRequestArmed && !shutdownCommitted) {
      try { io.clearServiceStopRequest?.(); } catch (error) {
        return {
          ok: false,
          status: 409,
          message: `${message} The Windows service stop marker could not be cleared: ${errorMessage(error)}`,
        };
      }
    }
    return { ok: false, status: 409, message };
  };

  try {
    io.assertServiceOwnership();

    // Set the intentional-stop signal before touching shared client settings. A
    // Windows supervisor may restart a child the moment it exits; the early signal
    // makes that restart leave immediately instead of stealing port 10100.
    const serviceInstalled = io.serviceInstalled();
    const serviceProcess = io.isServiceProcess?.() ?? false;
    if (serviceInstalled && serviceProcess) {
      if (!io.requestServiceStop) {
        return refuse("Proxy is still running because the supervised service could not be told to stay stopped.");
      }
      io.requestServiceStop();
      stopRequestArmed = true;
    }

    const codex = await io.restoreNativeCodex();
    if (!codex.success) {
      return refuse(`Proxy is still running because native Codex could not be restored safely: ${codex.message}`);
    }

    const grok = io.restoreGrok();
    if (!grok.ok) {
      return refuse(`Proxy is still running because Grok configuration could not be restored safely: ${grok.message}`);
    }

    // A supervised proxy must close itself first. Calling `schtasks /end` from inside
    // that same process force-terminates Bun before its listener can close, leaving a
    // dead PID that still occupies the port on Windows. The external CLI stops the
    // registered manager after this process exits; standalone proxies still stop it here.
    if (serviceInstalled && !serviceProcess && !io.stopService()) {
      return refuse("Proxy is still running because its background service could not be stopped.");
    }

    io.beginShutdown();
    shutdownCommitted = true;
    return {
      ok: true,
      message: "Proxy stopping; Remodex-owned client configuration was restored.",
    };
  } catch (error) {
    return refuse(`Proxy is still running because clean shutdown was refused: ${errorMessage(error)}`);
  } finally {
    drain.release();
  }
}
