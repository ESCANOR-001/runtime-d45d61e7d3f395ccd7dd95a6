---
title: CLI Lifecycle
description: Setup, start, stop, service, diagnostics, sync, and update commands.
---

These commands install, run, inspect, repair, and update the local Remodex proxy and its Codex integration.

## Setup

### `rmx onboard [--verbose] [--json] [--no-open]`

`rmx onboard` has three stages: **prepare this computer → start the background service → prepare your pairing code**. Each stage announces what is happening; long-running work prints a waiting message every four seconds. The QR page opens as soon as the dashboard is available and shows preparation progress. A usable QR appears when either same-Wi-Fi access or a verified remote connection is ready. Existing providers, integration choices, and custom domains are preserved. Optional Windows tray setup, updater repair, and Codex integration changes do not block pairing; find them under **Android Remote → Advanced Settings**.

Connect both devices to the same trusted network, then tap **Scan QR code** on your phone. **Free temporary link** prepares in the background. The phone verifies and saves the remote address through its paired connection, so changing networks does not require another scan. A remote setup failure does not stop a ready Wi-Fi connection.

The connection settings open on **Local**, alongside **Free temporary link** and **Custom domain**. Switching local access off or on keeps the running tunnel and its address. Failed network checks also keep a live Quick Tunnel connector so it can reconnect. If the connector exits or is explicitly restarted, its temporary address can change. A phone already away may need to reconnect over Wi-Fi to learn the replacement; an optional custom domain provides a fixed address. Background setup never changes system DNS or opens an administrator command window.

If no private LAN address is available, setup can use a verified remote link. A remote-only QR still requires successful service and computer-identity checks.

Normal output shows three numbered stages and pairing instructions. Keep the QR page open: it distinguishes waiting for a scan, receiving a pairing request, and a new phone actually coming online. Existing online phones do not count as a new connection. Codes still expire after five minutes; use **Create new code** if needed. **Advanced Settings** contains optional connection methods and links to integrations and updates; Windows users also see the optional tray command.

`--verbose` includes detailed command output; `--no-open` leaves the browser closed. `--json` implies `--no-open` and emits one result without progress messages. `completedSteps` now counts the three stages (0–3). Success means a usable pairing connection is ready, not that the phone has connected yet. `connection.localReady` and `connection.remoteReady` report readiness; `tunnel` remains null unless remote access is verified. An unverified tunnel URL alone no longer counts as successful setup. The Windows `tray` field is null because onboarding no longer checks or installs it; `automaticUpdates` is omitted.

Service commands are limited to two minutes, individual management requests to thirty seconds, and connection checks remain bounded. If setup pauses, the QR page stays available for status and retry. Browser-launch failure prints a manual link without discarding a ready connection. The command does not upload failure reports.

```bash
rmx onboard
rmx onboard --verbose
rmx onboard --no-open
rmx onboard --json
```

### `rmx init` · `rmx setup`

Interactive setup wizard (`setup` is an alias of `init`). Prompts for a provider (preset or custom),
API key (literal or `${ENV}`), default model, and proxy port; saves `~/.remodex/config.json`;
asks for explicit permission before integrating with `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`, default answer **No**); and
optionally installs the Codex autostart shim.

## Codex configuration permission

Remodex leaves Codex settings unchanged by default. `rmx onboard`, phone pairing, startup, restart, and updates do not grant permission to edit `config.toml`. Existing installations also need explicit permission; an old integration toggle or generated file does not count as consent.

Phone access uses the existing connection. You can optionally authorize Remodex to manage this Codex configuration, its catalog/cache, and legacy Remodex history:

```bash
rmx sync --allow-config-change
```

This saves ongoing permission in Remodex's own `config.json`, for the exact Codex configuration path. Review the routing changes before running it. To withdraw that permission without changing any existing Codex files:

```bash
rmx sync --revoke-config-access
```

All configuration sync and restoration behavior described below requires that permission. Without it, commands report that Codex files were left untouched. Permission for one Codex home does not authorize another. A previous Remodex routing entry is preserved until the user explicitly authorizes cleanup; revoking permission does not remove it or claim that native routing was restored.

## Proxy lifecycle

### `rmx start [--port <port>]`

Start the proxy server (preferred port `10100`). If that port is occupied, Remodex selects and
records another available port. It writes PID/runtime-port state and refuses to start a second live
instance. On start it syncs each provider's models into Codex's catalog. On shutdown it restores
native Codex — unless it was launched as a managed service (`OCX_SERVICE=1`).

```bash
rmx start
rmx start --port 8080
```

### `rmx stop`

Stop the running proxy (by PID), remove the PID file, and restore native Codex. If a managed
background service is installed, `rmx stop` also stops it first so it cannot respawn the proxy.
The same action is available from the web dashboard's **Stop** button (`POST /api/stop`).

### `rmx restart`

When a proxy is running, ask that exact attested PID and port to restart in place, wait for its
normal drain, and verify a different runtime PID on the same port. Managed routing and service
supervision stay installed throughout; an uncertain request is observed rather than replayed as a
separate stop/start. If no proxy is running, the command falls back to the normal `ensure` start.
If a live listener cannot be attested to a runtime PID (including a pre-update proxy), restart fails
closed without an `ensure` or stop/start fallback. After confirming ownership, use `rmx stop` then
`rmx start` for a standalone proxy. For a service-managed proxy, use `rmx stop` followed by
`rmx service start` so supervision is restored.

### `rmx ensure`

Idempotently ensure a background proxy is running, then sync its live model catalog. If
`codexAutoStart` is `false`, it prints that autostart is disabled and does nothing.

### `rmx restore [back]` · `rmx eject [back]`

Restore native Codex **without** stopping the proxy — strips the injected config lines and routed
catalog entries so plain `codex` works natively again. `eject` is an alias of `restore`.

Pass `back` to either spelling to re-point plain `codex` at an already-running proxy without changing
the proxy lifecycle:

```bash
rmx restore back
rmx eject back
```

### `rmx recover-history --legacy-openai`

Explicit recovery for older development builds that remapped Codex App history before reversible
backup support existed. Close Codex first if its history database is locked.

### `rmx uninstall` · `rmx remove`

Stop the service and proxy, remove the service and Codex shim, restore native Codex, then remove
Remodex local config only if all restore steps succeeded. `remove` is an alias of `uninstall`.
Config cleanup requires ownership metadata created by a fresh install; legacy or shared directories
are left in place.

## Status and health

### `rmx status [--json]`

Print a read-only diagnostic summary: proxy PID, `/healthz` reachability, dashboard URL, config path,
default provider, Codex autostart setting, service state, shim state, and the redacted effective Codex
home. Only the explicit, high-confidence Windows Orca runtime-home signature adds an actionable App-home
mismatch warning; it never changes `CODEX_HOME` automatically.

Human output also includes an **OAuth health** block after the OAuth logins summary: `OAuth health:
ok` when every known account is healthy, or `OAuth health: warning` with one redacted line per
non-healthy account (provider, masked account id, status such as reauthentication required, rate or
quota limited, or refresh conflict) plus an optional `Action:` hint. Account ids are redacted; tokens
and emails are never printed. The `--json` contract does not currently include this health block.

```bash
rmx status
rmx status --json
```

Abbreviated example shape:

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.remodex/config.json",
    "pid": "/Users/example/.remodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexHome": {
    "effectiveCodexHome": "C:\\Users\\[USER]\\.codex",
    "appCodexHome": "C:\\Users\\[USER]\\.codex",
    "mismatch": false,
    "warning": null,
    "action": null
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.remodex/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

The real object also includes `listen` (port, hostname, runtime/config source), config load
diagnostics, and bundled Codex plugin diagnostics. The JSON schema is additive-only: future versions
may add fields, but existing fields should stay stable. It intentionally excludes API keys, OAuth
tokens, authorization headers, request content, emails, and account identities.

### `rmx health [--json]`

Identity-check the live proxy. Human output reports PID/port; `--json` emits `{ok, pid, port}`. The
command exits 0 only when healthy and 1 otherwise, making it suitable for service probes.

### `rmx ready [--json] [--wait [--timeout <seconds>]]`

Check post-sync readiness through the unauthenticated `GET /readyz` endpoint. It returns `200` when
ready, or `503` with `Retry-After: 1` for `pending` and terminal `failed`. Its sanitized HTTP identity
is `{service, version, uptime, pid, port, status}`. Old proxies without `/readyz` fail closed as
`unreachable`; `/healthz` is separate liveness, not readiness. The command performs one probe by
default; `--wait` polls until ready or timeout, but exits immediately when it observes the terminal `failed` state. The
default timeout is 45 seconds; `--timeout <seconds>` requires `--wait` and accepts positive integer seconds from 1–300.
CLI JSON emits `{ready, status, pid, port}`, where `status` is `ready`, `pending`, `failed`, or
`unreachable`. Exit codes are 0 for ready; 1 for not-ready, pending, failed, timeout, or
unreachable; and 64 for invalid arguments.

### `rmx doctor`

Run read-only environment and connectivity diagnostics: state paths and filesystem type, WSL dual
installs, proxy environment/config, ChatGPT reachability, Codex plugin and project-config warnings,
and pending history migration. The Codex app-home targeting section also detects the narrow Windows
Orca runtime-home mismatch and explains service migration when applicable. Paths shown by this
diagnostic redact the OS username. Doctor prints repair hints but does not apply them.

The **OAuth reliability** section reports whether credential storage is writable, whether refresh
single-flight/lock files can be created under `OPENCODEX_HOME`, non-healthy OAuth or Codex pool
accounts (redacted ids) with a recovery `Action:`, and a static OK that the Codex forward path does
not fabricate official-client metadata. Doctor never mutates credentials or applies repairs.

## Catalog sync

### `rmx sync [--restart-codex]`

Fetch the live model list from every configured provider and re-inject the merged catalog into Codex.
Run it after adding a provider or to refresh available models.

If long-lived Codex `app-server` processes are still running, `rmx sync` warns that they may keep
serving the previous in-memory model list even though `opencodex-catalog.json` / `models_cache.json`
were updated. Pass `--restart-codex` to send `SIGTERM` only to matching `codex … app-server` and
`codex-code-mode-host` processes owned by the current user (active turns may be interrupted). Broad
`pkill -f codex` matching is intentionally avoided.

### `rmx sync-cache [--restart-codex]`

Invalidate Codex's local model picker cache so it is rebuilt from the active Remodex catalog. The
same stale-`app-server` warning and optional `--restart-codex` behavior as `rmx sync` apply.

## Background service

### `rmx service [install|repair|start|stop|status|uninstall|remove]`

Run Remodex as a login-managed background service (macOS **launchd**, Linux **systemd user unit**,
Windows **Task Scheduler**) that auto-starts on login and auto-restarts on crash. Service runs set
`OCX_SERVICE=1` so a restart does not churn the Codex config.

Provider keys may remain `${ENV_VAR}` references. During `install`, `repair`, and `start`, Remodex
copies only the referenced provider/proxy values into the owner-only
`$OPENCODEX_HOME/service-provider-env.json` snapshot. The service definition contains only that
file's path; it never embeds the values. A missing reference fails before the service is launched,
and `service uninstall` removes the snapshot. Remodex discovers referenced variables from the OS
user environment when a GUI/service process did not inherit the launching shell; if a value is
still missing, export it and run `rmx service repair` so the running service receives it.

| Subcommand | Action |
| --- | --- |
| none | Create/update and start the service. |
| `install` | Create and start the service. Registers it, which on Windows needs elevation. |
| `repair` | Refresh an installed service in place and restart it, without re-registering it. |
| `start` | Start an installed service. |
| `stop` | Stop the service and restore native Codex. |
| `status` | Report service and proxy diagnostics plus log paths. |
| `uninstall` | Remove the service and restore native Codex. |
| `remove` | Alias of `uninstall`. |

```bash
rmx service
rmx service install
rmx service repair
rmx service status
rmx service uninstall
```

`install`, `start`, and `repair` confirm that a proxy actually answers on the port
baked into the installed service before reporting success — on all three platforms.
They wait up to 20 seconds and then print the serving port:

```
✅ Remodex service installed and serving on port 10100.
```

If nothing answers, they warn and **exit non-zero**:

```
⚠️  Service installed, but no proxy answered on port 10100 within 20s.
   The manager registered the job; that is not the same as serving.
   Log:       ~/.remodex/service.log
   Meanwhile: rmx start   (serves in the foreground)
```

A non-zero exit here means *registered but not serving* — not *not installed*. The
service manager accepted the job; the proxy behind it never bound the port. Read the
log named in the message, and use `rmx start` to serve in the foreground meanwhile.

`rmx service status` reports the same three states rather than raw manager output:

```
✅ installed and loaded (launchd; logs: …)
   Serving on port 10100.
```

```
⚠️  installed and loaded (launchd; logs: …)
   Registered, but no proxy is answering on port 10100.
   launchd is running an OLDER plist than the one on disk.
   Fix:    launchctl bootout gui/$(id -u)/com.opencodex.proxy && rmx service repair
   Log:    ~/.remodex/service.log
   Repair: rmx service repair
   Meanwhile: rmx start           (serves in the foreground)
```

It no longer prints the raw `launchctl list` / `systemctl status` line, which
reported a registered job identically whether it was serving, bound to nothing, or
running a previous definition. The `Diagnostics:` line still carries the log path and
any stale-baked-path finding.

On Windows the scheduler backend keeps its own richer status output, which already
reported Task Scheduler registration separately from proxy reachability.

On macOS this also covers a subtler failure: `launchctl load` reports failure on
stderr while exiting 0, so a load that did not take used to leave launchd running a
**previous** version of the service definition while the command printed a checkmark.
`install` now fails loudly in that case and names the `launchctl bootout` command that
clears the stale job.

On Windows, `rmx service status` reports Task Scheduler registration separately from
identity-verified Remodex proxy reachability. It does not print the localized `schtasks` table,
so the summary remains readable across Windows code pages.

On Windows, creating or deleting the Task Scheduler entry requires elevation. `rmx onboard`,
`rmx service install`, and service removal automatically show one Windows UAC approval prompt when
the normal shell is not already elevated. The dashboard's Startup Safety action uses the same
approval path with its own timeout and recovery checks. Automatic elevation is restricted to
Remodex's exact `opencodex-proxy` create/delete commands; unrelated permission errors do not trigger
it. If UAC is blocked by machine policy, run the command from an elevated PowerShell window.

### `rmx codex-shim <install|status|uninstall|remove>`

Wrap a script-based `codex` launcher on PATH with a lightweight autostart script. Real `codex.exe`
targets are left untouched to avoid breaking exact executable invocations.

Launcher installation alone does not prove that Codex requests will use Remodex. After a healthy
install, the command checks the current Codex routing and reports a warning instead of a green result
when routing is external, user-owned, or unverifiable. It also warns when outbound proxy variables
exist only in the current process while `config.proxy` is unset or unresolved, because Codex
launchers and background services may not inherit that environment. These checks are read-only and
never print proxy values; resolve the reported handoff and run `rmx doctor` before relying on
autostart.

If a completed external Codex update overwrites an installed shim, the next ordinary `rmx` command
backs up the stable new launcher and restores the shim before dispatch. A launcher that is still
changing is left untouched and retried later. Repair failures warn without failing the requested
command; manual fallback: `rmx codex-shim install`. Set `codexShimAutoRestore` to `false`, or set
`OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` for a process-level opt-out.

| Subcommand | Action |
| --- | --- |
| `install` | Install the shim (or repair if stale). |
| `uninstall` | Remove the shim and restore the original Codex binary. |
| `remove` | Alias of `uninstall`. |
| `status` | Report shim state (installed, stale, or missing). |

```bash
rmx codex-shim install
rmx codex-shim status
rmx codex-shim uninstall
```

:::tip[Service vs Shim]
Use `rmx service` for an always-on background proxy (recommended). Use `rmx codex-shim` for
lightweight, on-demand startup without a daemon — the proxy starts only when `codex` is launched.
:::

### `rmx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

Install and control the Windows status tray icon. It starts at Windows login and provides one-click
proxy controls. `start` and `stop` control the icon only; use its menu to control the proxy.
`--no-start` applies to `install` and installs the tray without launching it immediately.
The first row probes the uncached loopback `/healthz` endpoint every second and on every click, so
**Ready** means the current Remodex listener answered with the expected identity. Restart-safety
diagnostics remain in the authenticated dashboard and do not incorrectly downgrade a live tray.

## Dashboard

### `rmx gui`

Open the [web dashboard](/guides/web-dashboard/) at `http://localhost:<port>`, auto-starting the proxy
if it is not running.

## Updating

### `rmx update [--tag latest|preview]`

Self-update Remodex from npm. Stable installs use `@latest`; preview installs stay on `@preview`
unless you pass `--tag latest|preview`. It detects a source checkout and tells you to
`git pull && bun install` instead, and is a no-op if you are already on the newest version for that
tag. Before stopping anything, npm installations run a bounded Unix cache ownership and access
check. Nested symlinks are checked with `lstat` but not followed; Windows explicitly skips this
Unix-only check. A failure aborts while the tray and proxy are still running. A running proxy is
then stopped before files are replaced; an installed service is rebuilt and started automatically,
while a foreground installation prints `rmx start` as the next step. Dashboard update records
redact profile/cache paths and UID/GID values before they are persisted.

```bash
rmx update
rmx update --tag preview
```

New versions become available when the [Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)
publishes them to npm.

### `rmx system update auto <on|off|status>`

Global npm and Bun installations enable the unattended updater by default the first time Remodex
bootstraps normally. Updater repair is separate from pairing; use `rmx system update auto on` to repair missing job files.
An existing choice to turn automatic updates off is preserved.

Service-mode startup also repairs an already-enabled updater after an upgrade, including legacy
scheduler state, missing files, and outdated launcher paths on Windows and Linux. It does not enable
updates for the first time from a service or override a saved opt-out. If the operating-system
scheduler cannot be queried safely, automatic repair stops; run `rmx system update auto on` to see
the setup error and repair the registration explicitly.

The running server checks its selected npm channel shortly after startup and about every **30 minutes**
(with a small random offset). Opening or reconnecting Android or the dashboard refreshes checks older
than **5 minutes**. A failed check retries after about **2 minutes**. These checks fetch small version
records over HTTPS; they do not launch npm or read conversation history.

A registry lookup retries a connection failure, timeout, or HTTP server error once before reporting
failure. Invalid package metadata and HTTP client errors (including rate limits) are not retried
immediately. The dashboard distinguishes network, timeout, HTTP, and invalid-response failures
without exposing private URLs or raw error output. A failed lookup never authorizes installation.

The operating system also keeps a daily backup check at **03:00 local time**:

| Platform | Scheduler |
| --- | --- |
| Windows | Hidden Task Scheduler task (`Remodex-AutoUpdate`) |
| macOS | Per-user `launchd` agent |
| Linux | Per-user `systemd` timer |

Installation waits for confirmed idle tasks. Unknown or stale task status postpones installation;
it does not mean the computer is idle. The worker checks again immediately before stopping the server.
If the phone is disconnected and a fresh task status is unavailable, reconnect it to refresh the status,
or use the explicit update command on the computer when work has finished. Linux requires an available
systemd user manager; macOS requires the user's launchd session. Setup failures leave phone pairing
usable and show a repair instruction instead of claiming updates are ready.

The update screen shows the installed and latest versions, important release notices, and updater
setup or worker failures. Release maintainers can attach `remodex-update.json` to the matching GitHub
release tag (`v1.2.3`, for example) to mark a fix as important:

```json
{
  "version": "1.2.3",
  "urgency": "urgent",
  "affectedVersions": ["1.2.2"],
  "message": "Fixes a connection problem. Update when your current task finishes."
}
```

Use `"*"` in `affectedVersions` only when every older version is affected. Missing or invalid notices
do not block normal updates. This notice cannot change the npm target or bypass the idle check.

The updater runs as a short-lived worker. It resolves one concrete registry version, requires valid
integrity metadata before replacement, reuses the existing service/tray restart path, checks that
the proxy is healthy afterward, and records the previous version plus any rollback attempt under
`~/.remodex/auto-update.json`. Scheduler and worker diagnostics are written to
`~/.remodex/auto-update.log`; package-manager output is not copied into that log.
After a failed replacement triggers rollback, automatic installation pauses for that specific version.
A newer release can install normally; an explicit manual update can retry the rejected version.

```bash
rmx system update auto status
rmx system update auto off
rmx system update auto on --channel latest
```

`off` removes the platform scheduler and persists the opt-out. A later normal `rmx`, `rmx start`, or
`rmx service` invocation leaves it disabled until `auto on` is run. Source checkouts do not register
an unattended updater; update those with Git instead. If the scheduler cannot be registered, Remodex
continues starting normally and reports the condition in the update screen and in `auto status`.
