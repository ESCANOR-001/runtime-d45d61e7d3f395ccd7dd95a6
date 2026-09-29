import { defaultUpdateTag, currentVersion } from "../update/index";
import { isConnectRuntime } from "../connect/mode";
import { readUpdateJob, startUpdateJob, staleActiveUpdateJobReason, UpdateJobError, type UpdateJobState } from "../update/job";
import { checkRemoteUpdate, type RemoteUpdateCheck } from "../update/remote-check";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { publicAutomaticUpdateStatus } from "../update/auto-scheduler";
import { backgroundUpdateStatus, requestBackgroundUpdateCheck } from "../update/background";
import { getActiveTurnCount } from "../server/lifecycle";

const channel = defaultUpdateTag(currentVersion());

export function liveUpdateJob(job: UpdateJobState | null, now = Date.now(), isAlive?: (pid: number) => boolean): UpdateJobState | null {
  if (!job || !staleActiveUpdateJobReason(job, now, isAlive)) return job;
  return { ...job, status: "failed", error: "The update worker stopped before completing." };
}

export function publicUpdateJob(job: UpdateJobState | null) {
  if (!job) return null;
  return {
    id: job.id, status: job.status, targetVersion: job.latestVersion,
    installedVersion: job.installedVersion ?? null, startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    // Installer logs can contain local paths or credentials. They stay on the computer.
    error: job.status === "failed" ? "The desktop update failed. Open the desktop updater for details." : null,
  };
}

type Activity = { known: boolean; running: number };
interface UpdateRouteDeps {
  check: (force: boolean) => Promise<RemoteUpdateCheck>;
  readJob: () => UpdateJobState | null;
  start: (check: RemoteUpdateCheck) => UpdateJobState;
}

/** Called only after the gateway has authenticated the paired phone. */
export function createDesktopUpdateRoutes(deps: UpdateRouteDeps = {
  check: force => checkRemoteUpdate(channel, force),
  readJob: () => liveUpdateJob(readUpdateJob()),
  start: check => startUpdateJob(channel, true, { checkForUpdateFn: () => check }),
}) {
  let starting = false;
  return async (req: Request, activity: () => Activity | Promise<Activity>): Promise<Response> => {
    const currentActivity = async (): Promise<Activity> => {
      const tasks = await activity();
      return { known: tasks.known, running: Math.max(tasks.running, getActiveTurnCount()) };
    };
    const url = new URL(req.url);
    const json = (body: unknown, status = 200) => Response.json(body, {
      status, headers: { "Cache-Control": "no-store" },
    });
    const checkOnly = isConnectRuntime();
    const updateStatus = () => checkOnly ? {
      checkOnly: true,
      automaticUpdates: { supported: false, enabled: false, configured: false, lastResult: null },
      background: { status: "disabled", lastCheckedAt: null, nextCheckAt: null },
    } : { automaticUpdates: publicAutomaticUpdateStatus(), background: backgroundUpdateStatus() };
    try {
      if (req.method === "GET" && url.pathname === "/api/desktop-update/check") {
        if (!checkOnly) requestBackgroundUpdateCheck();
        const check = await deps.check(url.searchParams.get("refresh") === "1");
        return json({
          currentVersion: check.currentVersion, latestVersion: check.latestVersion,
          installer: check.installer, channel: check.channel, updateAvailable: check.updateAvailable,
          canUpdate: !checkOnly && check.canUpdate, reason: checkOnly ? "connect_check_only" : check.reason ?? null, checkedAt: check.checkedAt,
          releaseNotes: check.releaseNotes, activity: await currentActivity(), job: checkOnly ? null : publicUpdateJob(deps.readJob()),
          releaseInfo: check.releaseInfo ?? { urgency: "normal", message: "" },
          ...(check.registryError ? { registryError: check.registryError } : {}),
          ...updateStatus(),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/desktop-update/status") {
        return json({ job: checkOnly ? null : publicUpdateJob(deps.readJob()), activity: await currentActivity(), starting,
          ...updateStatus() });
      }
      if (req.method !== "POST" || url.pathname !== "/api/desktop-update/run") {
        return json({ error: "Unknown desktop update request" }, 404);
      }
      if (checkOnly) return json({ error: "This unpublished Connect copy supports update checks only. Installing the published package would replace it with the old app.", code: "connect_check_only" }, 409);
      if (starting) return json({ error: "An update is already starting." }, 409);
      // This endpoint accepts no commands, paths, channels, or arbitrary package versions.
      const body = await readBoundedResponseBody(new Response(req.body), { maxBytes: 256, totalTimeoutMs: 3_000 });
      if (!body.displaySafe || body.oversized || body.timedOut) return json({ error: "Invalid update confirmation." }, 400);
      let confirmation;
      try { confirmation = JSON.parse(body.text); }
      catch { return json({ error: "Invalid update confirmation." }, 400); }
      if (confirmation?.confirm !== true || Object.keys(confirmation).length !== 1) {
        return json({ error: "Confirm the update from Desktop updates." }, 400);
      }
      if (starting) return json({ error: "An update is already starting." }, 409);
      starting = true;
      try {
        const check = await deps.check(true);
        if (!check.canUpdate) {
          return json({ error: check.installer === "source"
            ? "This computer runs a local development build. Update it on the computer."
            : check.latestVersion ? "No desktop update is available." : "The latest version could not be verified. Try again shortly." }, 409);
        }
        const tasks = await currentActivity();
        if (!tasks.known || tasks.running > 0) {
          return json({ error: tasks.known ? "Finish running tasks before updating." : "Reconnect and wait for task status before updating." }, 409);
        }
        return json({ job: publicUpdateJob(deps.start(check)) });
      } finally { starting = false; }
    } catch (error) {
      if (error instanceof UpdateJobError) {
        return json({ error: error.code === "source_checkout"
          ? "This computer is running a local development build. Update it on the computer."
          : "The update cannot start. Check Desktop updates on your computer.", code: error.code }, error.status);
      }
      return json({ error: "Could not check desktop updates. Try again shortly." }, 503);
    }
  };
}
