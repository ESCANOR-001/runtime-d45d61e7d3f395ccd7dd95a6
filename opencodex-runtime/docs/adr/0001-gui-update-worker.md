# ADR 0001: GUI self-update runs through a worker job

## Status

Accepted

## Context

The dashboard needs buttons for `rmx sync` and Remodex self-update. `rmx sync` is safe to run in
the proxy process because it refreshes Codex config/catalog state. `rmx update` is different: npm
installs may replace the package files currently serving the GUI, and the existing CLI update path
can print to inherited stdio and exit the process.

## Decision

GUI self-update is not executed directly in the request handler. The dashboard calls management
API endpoints that create an update job in `OPENCODEX_HOME/update-job.json`. The proxy starts a
detached hidden CLI worker, and the worker performs the install command and optional restart. The
worker is deliberately outside the proxy service's process group: Linux service launches use a
transient `systemd-run --user` unit, macOS service launches use a one-shot `launchctl submit` job,
and Windows keeps the PowerShell `Start-Process` boundary. A service stop therefore cannot kill the
worker that is responsible for bringing the replacement proxy back.

For npm installs, the worker captures the listen target and service state, stops the running proxy,
then runs the Node launcher path (`node bin/ocx.mjs __exact-update <version>`) so the existing npm
integrity/cache checks are reused without a second stop/restart lifecycle. The outer worker then
uses the freshly installed launcher to repair the service, start the proxy on the captured port,
and verify `/healthz`. For Bun global installs, it follows the same outer stop/restart flow with
the existing Bun global update command. Source checkouts remain manual-only and show `git pull &&
bun install && bun run build:gui`.

After an update requests a restart, the worker now waits for an identity-checked `/healthz` to
return and remain healthy for a short stability window before marking the job successful. This
keeps `update-job.json` honest on Windows cases where npm leaves the bundled Bun runtime in a bad
state and the restarted proxy dies a few seconds later.

If package replacement fails after the stop boundary, or a later worker step throws, the worker
attempts the same captured-port service/direct recovery before persisting the original failure. The
update remains failed so the dashboard can show the real error while the proxy is brought back when
possible.

The worker requires update-correlated restart evidence (a new PID versus the pre-update capture,
and/or the job's target version), not merely a healthy listener. A surviving pre-update process
would otherwise look like success. Direct (non-service) installs use the same captured-port
restart path, while service installs repair the existing manager without re-registering it. This
keeps the dashboard from reporting success when the replacement proxy never actually returns.

The dashboard does not reload as soon as the new version first answers `/healthz`. It waits for a
`succeeded` job and three consecutive healthy responses for the target version, so a supervisor
handoff cannot turn a transient restart into a browser `ERR_CONNECTION_REFUSED` page.

## Consequences

- The GUI request handler stays responsive and does not overwrite its own running module graph.
- Update status survives a proxy restart because it is stored in the Remodex config directory.
- Restart handling can branch between service-managed installs and direct detached proxy starts.
- A completed install can still finish with `status: "failed"` when the replacement proxy never
  becomes healthy or flaps during the stability window; the job log then points the user at
  `rmx start` and the Bun `--allow-scripts` reinstall path.
- The dashboard must poll both the job endpoint and `/healthz` while reconnecting.
