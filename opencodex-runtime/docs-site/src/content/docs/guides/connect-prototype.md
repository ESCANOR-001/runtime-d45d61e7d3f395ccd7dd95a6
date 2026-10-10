---
title: Connect prototype
description: Native Codex activity and read-only configuration in the unpublished Connect fork.
---

This page describes the **unpublished, private Connect fork**, not the existing npm release. Other universal-provider documentation in this source copy describes the legacy product and does not enable those features in Connect.

Connect remains the `@remodex/rmx` npm package with the `rmx` command and a browser dashboard. There is no separate desktop application or native installer in this product's build or npm payload.

## Dashboard sections

Connect offers Android Remote, Logs & Debug, Usage, Storage, Guide, and Advanced Settings. Sign in using Codex itself. There are no Claude, Grok, custom-provider, account-pool, or model-injection controls. The private fork does not run the published package's automatic updater.

The sidebar retains **Check for updates**. Its dialog checks the published Remodex npm package on the latest or preview channel, shows version details and available release notes, and offers Retry after a failed check. These are read-only checks. Installation remains disabled in the unpublished Connect copy, with an explanation: installing the existing published package would replace it with the old app, not upgrade this private fork.

Android Remote retains its connection controls and authorized clients. Connection methods stays visible; only the difference explanation, Cloudflare token instructions, and advanced manual setup start collapsed. Add phone opens the pairing dialog with progress feedback.

Android task controls follow the owning Codex runtime: running tasks show Stop,
and interrupted tasks offer Continue. Continue starts another turn in the same
conversation. If the task's state cannot be verified, the composer shows that
it is checking the status and retains Stop; the server sends Stop directly to the owning Desktop runtime without waiting
for a status read. Desktop resolves the current turn and pauses its active goal.
The phone shows interruption only after confirmation; an unavailable owner or
an unconfirmed Stop produces an error instead of pretending the task stopped.
Unknown status does not mean the task has completed.

Update checks distinguish network failures, timeouts, unavailable release channels, and npm rate limits. A failed check does not mean automatic installation needs to be enabled. Retry starts a fresh check after failure rather than reusing a cached error; simultaneous checks still share one request. If a channel has no published release, select another channel. If npm rate-limits checks, wait a few minutes before retrying. The paired-phone update endpoints enforce the same check-only restriction and cannot start installation or activate the legacy automatic updater.

## Onboarding without service installation

On Windows, macOS, and Linux, `rmx onboard` prepares local settings, reuses a verified running instance or starts a hidden background process for the current user, then verifies a usable connection before reporting QR pairing ready. It does not install, repair, or require an operating-system service. Progress messages continue while waiting. Existing Codex settings remain untouched.

Fresh Connect profiles use dashboard port 10100, Android gateway port 10105, and private Codex port 10106. Onboarding, service setup, recovery, and restart keep their configured ports. If a port is occupied or its existing peer is incompatible, setup reports the conflict rather than silently switching ports. Other listeners are left running. Gateway startup uses the same bounded retries on Windows, macOS, and Linux, showing a starting state while retrying.

Advanced manual tunnel setup displays the actual Android gateway address returned by the server. Use that address, not the management dashboard port or the old app's gateway port.

The managed Cloudflare helper supports Windows x64, macOS Intel/Apple Silicon, and Linux x64/ARM64. On Windows ARM64 it uses the checksum-verified x64 helper via [Windows 11 emulation](https://learn.microsoft.com/en-us/windows/arm/apps-on-arm-x86-emulation), not a native ARM binary. Setup validates the executable before completing installation. If emulation is unavailable, use Local Wi-Fi or provide a compatible executable through `OPENCODEX_CLOUDFLARED_PATH`.

This user-level process is not a service: it has no guaranteed restart after a crash, sign-out, or computer reboot. Run `rmx onboard` again when needed. Onboarding does not uninstall or disable an existing service. Network policy or a firewall can still block connectivity; setup never bypasses those protections or claims that an unusable QR code is ready.

Advanced Settings contains only the optional background-service setup, not provider or Codex configuration. Opening the page reads status. Enabling or repairing a stopped service requires an explicit confirmation; Windows may then show an OS administrator prompt, while macOS and Linux use per-user service managers. Setup runs in a separate hidden worker so it can complete when the current server stops. Status survives the server handoff; duplicate actions are blocked while setup or elevation reconciliation remains pending. On failure, the worker attempts to restart the ordinary user-level server without claiming service installation succeeded.

Do not repair a currently supervised server from inside its own service process: its service manager could terminate the repair worker along with the server. For that case, inspect `rmx service status` and run `rmx service repair` separately on the computer. Unsupported service managers or a service owned by another profile are not changed. No administrator password is collected by the dashboard.

## Windows tray icon

Run `rmx tray install` to add the Remodex icon beside the Windows clock and start it automatically when you sign in. The tray is separate from the background service: enabling the service alone does not install the icon. Windows may place it under the hidden-icons arrow.

The Connect tray opens the dashboard, shows the server status, and starts, stops, or restarts Remodex on its configured port. It does not offer Codex configuration or desktop-restart controls. Its saved launcher keeps Connect mode after signing in again. Use `rmx tray status` to check it, `rmx tray start` to reopen it, or `rmx tray uninstall` to remove only the tray.

## Android account limits

The Android thread-status dialog reads remaining ChatGPT limits from the connected
Codex runtime's account API. These account-wide limits are separate from the
thread's context-window usage and the dashboard's token totals. The window labels
follow the durations returned by Codex; a primary window is not assumed to be
five hours. Unsupported accounts or missing windows remain unavailable, rather
than showing a fabricated zero. Refreshes are coalesced and cached briefly.
Only the normalized window labels, percentages and reset times reach the phone;
raw account metadata is not forwarded.
Current limits and context status accompany every recent chat snapshot, even when
only the newest prompt loads. Loading older messages does not replace those values
with historical readings.

## Current activity and usage

Logs, Debug, and Usage read native Codex session events and refresh every five seconds while visible. They do not rely on historical requests that happened to pass through the old proxy. Manual refresh, loading indicators, and stale-data errors distinguish an empty history from a failed request.

Usage deduplicates cumulative counters and copied sessions, excludes inherited initial totals, and groups measured increments by UTC event day and model. Cached input is already included in input. This is **not account billing or the remaining ChatGPT quota**. Turn status reflects the last observed event, not a live connection check.

Large histories are indexed incrementally with bounded memory. At most 200 recent session files are considered, with capped per-file history. Warnings identify incomplete indexing, retained-history limits, inherited counters, and skipped or unreadable records. Empty or partial results must not be treated as complete subscription usage.

Debug shows local reader health, not raw request capture. Session prompts, responses, secrets, and file paths are not returned by the activity endpoint. No failure report is uploaded automatically. Desktop logs retain their existing redacted report workflow.

## Existing configuration stays unchanged

The Connect entry point refuses provider/configuration mutation even when older settings contain write consent. Startup, shutdown, and pairing do not inject or restore provider entries, rewrite `config.toml` or `config.yml`, install shell hooks, or replace model catalogs. Existing legacy settings are left in place, not silently repaired. Phone access selects OpenAI with temporary process arguments. Codex itself continues to own its sign-in and session persistence.

Connect settings and pairing records default to `~/.remodex-connect`; native activity is read from the existing Codex home. An isolated preview must use its own runtime profile and unoccupied ports, not the old service's settings. Storage cleanup is still an explicit user action and can delete the selected history.

This fork still needs fresh Windows installation and real-phone pairing checks before publication. It does not establish that a pairing or trial-conversion issue is resolved.

On Windows, service setup checks both the current and legacy task names. It repairs and reuses an existing task whose launcher belongs to the current profile, and creates a new task only when neither exists. Duplicate tasks, an unreadable task list, or another profile's launcher require attention before setup proceeds. The Advanced Settings page retains the last known status during a refresh and keeps a failed status request visible while retrying.

### Android chat history

Completed chats initially show the latest ten prompts with their replies and
collapsed Work sections. A running chat prioritizes its current response and
live activity, then fills in the remaining recent prompts in the background.
Scrolling toward older history prefetches the next ten prompts near the oldest
two loaded prompts. Already loaded messages are reused when scrolling back.
Network delays keep the existing conversation visible with a loading indicator.

Expand Work to fetch its historical entries in bounded pages. Long Work sections
include a **Load more work** action. Question bookkeeping stays in Work; question
and answer messages remain part of the conversation. Resolving a question updates
its activity without replacing the loaded chat. Once delivery succeeds, the
thread list and Android notification clear **User input needed** immediately,
unless another question remains unanswered. Failed delivery keeps the question
pending so you can retry.
