import type { UpdateJobStatus } from "./dashboard-shared";

/**
 * A worker marks an update as succeeded only after its own stability window. Keep a small
 * client-side guard as well: the first healthy response can still be the last response from a
 * supervisor that is finishing its hand-off. Requiring consecutive observations prevents a
 * full-page reload from landing in the browser's connection-error page.
 */
export const UPDATE_RELOAD_HEALTH_CONFIRMATIONS = 3;

export interface UpdateReloadTracker {
  jobId: string | null;
  targetVersion: string | null;
  healthyChecks: number;
}

export interface UpdateReconnectObservation {
  jobId: string;
  targetVersion: string | null;
  status: UpdateJobStatus;
  /** The version returned by /healthz; null means the probe failed or was not attempted. */
  healthVersion?: string | null;
  /** False when /healthz did not return a valid healthy response. */
  healthOk?: boolean;
}

export interface UpdateReconnectDecision {
  tracker: UpdateReloadTracker;
  reconnecting: boolean;
  reload: boolean;
}

function trackerFor(
  previous: UpdateReloadTracker,
  observation: UpdateReconnectObservation,
): UpdateReloadTracker {
  if (
    previous.jobId === observation.jobId
    && previous.targetVersion === observation.targetVersion
  ) {
    return previous;
  }
  return {
    jobId: observation.jobId,
    targetVersion: observation.targetVersion,
    healthyChecks: 0,
  };
}

/**
 * Fold one update-status/health observation into the reconnect state machine.
 *
 * The dashboard remains in a reconnecting state while the worker is running/restarting, while
 * the endpoint is unavailable, or while health reports the old version. A reload is allowed
 * only after the worker says `succeeded` and the target version has answered repeatedly.
 */
export function observeUpdateReconnect(
  previous: UpdateReloadTracker,
  observation: UpdateReconnectObservation,
): UpdateReconnectDecision {
  const tracker = trackerFor(previous, observation);

  if (observation.status === "failed") {
    return {
      tracker: { ...tracker, healthyChecks: 0 },
      reconnecting: false,
      reload: false,
    };
  }

  if (observation.status !== "succeeded") {
    return {
      tracker: { ...tracker, healthyChecks: 0 },
      reconnecting: true,
      reload: false,
    };
  }

  // Older job records may not have a target version. They can still be displayed, but cannot
  // safely trigger a reload because there is no way to prove which runtime answered.
  if (!observation.targetVersion) {
    return {
      tracker: { ...tracker, healthyChecks: 0 },
      reconnecting: false,
      reload: false,
    };
  }

  const healthy = observation.healthOk === true
    && observation.healthVersion === observation.targetVersion;
  if (!healthy) {
    return {
      tracker: { ...tracker, healthyChecks: 0 },
      reconnecting: true,
      reload: false,
    };
  }

  const healthyChecks = Math.min(
    tracker.healthyChecks + 1,
    UPDATE_RELOAD_HEALTH_CONFIRMATIONS,
  );
  return {
    tracker: { ...tracker, healthyChecks },
    reconnecting: healthyChecks < UPDATE_RELOAD_HEALTH_CONFIRMATIONS,
    reload: healthyChecks >= UPDATE_RELOAD_HEALTH_CONFIRMATIONS,
  };
}
