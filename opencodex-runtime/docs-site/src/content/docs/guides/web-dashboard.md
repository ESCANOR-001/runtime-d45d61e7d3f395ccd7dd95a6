---
title: Web Dashboard
description: The Remodex GUI for proxy health, providers, models, delegation guidance, auth pools, usage, and logs.
---

Remodex ships a local web dashboard (a Vite/React app under `gui/`) served from the proxy. It is the
shortest path to managing providers, Codex/ChatGPT accounts, catalog models, sidecars, sub-agent
settings, and request traffic.

## Opening it

```bash
rmx gui
```

This opens `http://localhost:<port>` in your browser, auto-starting the proxy first if needed. In
development you can run the GUI dev server separately against a running proxy:

```bash
rmx start
bun run dev:gui
```

## Sign-in

On the default loopback bind (`localhost` / `127.0.0.1`) the dashboard never asks for a token:
the proxy mints short-lived GUI sessions into the served page and renews them silently when
they expire or the proxy restarts. Only a dashboard bound to a non-loopback hostname requires
the admin token (`OPENCODEX_ADMIN_AUTH_TOKEN`, or the auto-generated
`~/.remodex/admin-api-token` file).

When a remote dashboard needs that credential, it presents a standard password form so a browser
password manager can offer to save and autofill it. The dashboard itself still keeps the token only
in memory and does not write it to `localStorage` or `sessionStorage`; whether it is saved is entirely
the browser or password manager's decision.

## What you can do

| Area | What it does |
| --- | --- |
| **Dashboard summary** | Multi-agent mode, online state, version, uptime, provider count, 30-day token total, active providers, and available native/routed models. |
| **Sub-agent delegation** | Choose a native or routed model and optional reasoning effort shared by Remodex delegation guidance and the separate native-default opt-in. This is not a proxy-side per-spawn router; see below. |
| **Sidecars** | Choose the web-search model and effort plus the vision-description model. Changes apply on the next request. |
| **Maintenance** | Resync the Codex model catalog, inspect project-local config bypass warnings, and check or install the `@remodex/rmx` npm package. |
| **Startup safety** | Show whether injected Codex routing survives a restart, with separate service and launcher-shim health plus exact repair commands. |
| **Windows tray** | Install a per-user login tray for one-click proxy start, stop, restart, dashboard access, and status. The tray is a controller, not a proxy restart service. |
| **Codex autostart** | Allow an already-installed Codex launcher shim to run `rmx ensure`. This toggle does not install a shim or background service. |
| **Providers** | Add, edit, set the default (enabled providers only), enable/disable, and remove providers; manage OAuth account pools and API-key pools where supported. Removing the current default switches to the first remaining enabled provider when one exists; otherwise deletion is refused and the current default is kept. Provider Settings can disable live model discovery for endpoints with missing, slow, or oversized `/models` catalogs. For Claude (Anthropic) OAuth pools, each logged-in account shows its own 5-hour and weekly rate-limit bars (usage is per credential); a failed probe keeps the last-known bars and marks them unavailable until the next successful refresh. |
| **Add provider** | Search registry-backed presets for account login, API-key services, local servers, or a custom endpoint. |
| **Codex Auth** | Add ChatGPT/Codex pool accounts, select the next-session account, refresh 5h / weekly / 30d quotas, enable or disable quota auto-switch, set its 1–100% threshold, and configure transient-failure failover. |
| **Subagents** | Feature up to five bare native or namespaced routed models in the `spawn_agent` override list. |
| **Models** | Toggle native GPT and routed models, set provider allowlists and context caps, choose v1/base/v2, and configure the v2 thread limit. Configured providers stay visible as zero-model groups when discovery is off or returns no rows. |
| **Logs** | Auto-refresh recent requests with tokens, requested effort and (when available) effective outbound effort, resolved model, provider, status, request id, duration, and error details. The detail view includes the exact reasoning wire field when the adapter emits one. Filter by opaque conversation/session id (when the client sends one) to total tokens and estimated list-price cost for the currently loaded Logs ring. |
| **Desktop logs** | In the npm/localhost dashboard, read bounded, redacted tails of the runtime service and crash logs, along with the installed npm version and capture time. No native desktop application is required. Refresh reads new entries; missing or unreadable logs are marked individually. Download report saves the preview as a .txt file; Copy report copies the same text. Contact support opens an email draft to support@remodex.net. Review and attach the downloaded file yourself before sending; reports are not uploaded automatically. |
| **Usage / Debug** | Inspect token-usage coverage and trends, or enable opt-in provider transport and usage-extraction diagnostics. |
| **Storage** | Read-only CODEX_HOME disk breakdown (sessions, archives, DBs, attachments). Optional archived cleanup: preview the oldest N%, then quarantine to `CODEX_HOME/.trash` (default) or permanently delete behind an explicit checkbox. **Auto-cleanup policy** is opt-in and **default OFF** (`storageCleanupPolicy.enabled`); configure threshold/target/schedule/mode on the Storage page, or trigger **Run now**. Quarantined entries can be restored from the Storage page (JSONL + threads). Active sessions stay read-only. Cleanup and restore are refused while Codex holds the newest/active `state_*.sqlite` locked. |
| **Start / Stop Proxy** | In the desktop app, one health-derived control starts an offline proxy or gracefully stops a running proxy. During a transition it shows **Starting…** or **Stopping…** and cannot be clicked twice. The persistent desktop shell remains available after stop. In a normal browser, only Stop is available because a web page cannot launch a local process. |
| **Android Remote** | Start the Android gateway, choose a temporary Quick Tunnel or stable Named Tunnel, pair a phone with a five-minute one-use QR code, inspect online clients, and revoke a phone immediately. A paired Remodex app can read Codex tasks, send prompts and attachments, receive live updates, interrupt work, and answer approvals or questions. |

Android conversations hide automatically supplied project instructions, including the
`AGENTS.md instructions for…` blocks sent by Codex Desktop on Windows. These rules
still guide Codex; they simply do not appear as messages you sent. Normal questions
about AGENTS.md and file-edit activities remain visible.

### Model catalog

The generated model catalog uses Codex's current downloaded model definitions when available.
New native models keep their reasoning and speed options across server restarts; a newer
downloaded list also removes retired native models. Your model visibility choices still apply.
Model catalog updates do not delete or move saved conversations.

### Package updates

The sidebar and tray **Check package updates** actions open the same npm updater at
`#dashboard/update`. It checks the selected `latest` or `preview` channel, shows the installed and
latest versions, and updates only the `@remodex/rmx` package. It does not download or launch a native
desktop installer.

[GitHub Releases](https://github.com/ESCANOR-001/remodex-android/releases) is the changelog source.
The release workflow publishes npm first and then creates the matching `v<version>` GitHub release;
the dashboard links directly to that version's notes. After an updater-driven install succeeds, the
dashboard records and displays the local installation date and time. A fresh or manual npm install
has no trustworthy local event timestamp, so that line remains hidden until Remodex records one.

Package updates preserve Remodex configuration and credentials. When **Restart after update** is
enabled, the updater refreshes an installed background service or restarts the proxy so the new code
becomes active.

Background history maintenance skips completed migrations. For Codex's newer ordered
conversation files, it reads only the opening metadata and leaves the file unchanged.
Older files are checked from the end in small chunks, with a 16 MiB scan limit per lookup.
If the needed metadata is outside that limit, Remodex leaves the conversation file
unchanged instead of guessing or loading the whole file into memory.

### Desktop updates from Android (next release)

The Android sidebar has a download button for **Desktop updates**. A small **1**
badge means a newer desktop package is available. Opening Android checks quietly;
recent results are reused for five minutes. Opening the update sheet requests a fresh
check. Version checks do not run commands or scan conversation history.

The sheet shows the connected computer's running version, the published version,
and release notes from the matching GitHub Release. Press **Update desktop server**
to install through the same updater used by the dashboard. Finish running tasks
first and keep the computer on. The server restarts, so Android briefly disconnects
and tries to reconnect. Allow a few minutes; slow downloads may take longer.
When using a temporary Quick Tunnel, its address can change during restart. The
sheet explains that a new QR scan may be needed if the saved routes no longer work.

Local source checkouts are labelled **Local development build** and cannot be
replaced from the phone. Older desktop versions without phone update support need
one update on the computer using `rmx update`. Failed checks are shown as unavailable,
not as confirmation that the installed version is current.

Update availability uses current task-owner checks, independently of the sidebar.
An old running label or an unopened sidebar does not by itself block installation.
The server rechecks before starting the update; running tasks or an unavailable
task owner keep installation blocked until idle status can be confirmed. Turning
automatic installation off does not disable a manual update.

The phone update endpoints require the existing paired-phone credentials. They
only update Remodex through its fixed release channel; phones cannot supply an
installation command, package name, or path. Installer logs remain on the computer.

### Linking to a section

There is a single layout, so there is no layout switch to configure. Dashboard sections are
addressable instead: `#dashboard` opens Overview, and `#dashboard/providers` and
`#dashboard/models` open the other two. Reload, bookmark, and Back all keep the section you were
on. **Logs** works the same way with `#logs` and `#logs/debug`. An older `#providers/workspace`
bookmark now lands on `#providers`.

In the unpublished **Remodex Connect desktop/server prototype**, the remote page contains only
**Android Remote** controls, **Connection methods**, and **Authorized clients**, in that order.
Connection methods stays visible. Only **What's the difference?**, **Create the Cloudflare token
once**, and **Advanced manual setup** start collapsed; expand them when needed.
**Add phone** still opens QR pairing with progress feedback.
The QR button beside the PC name opens normal pairing. Each phone also has a QR button
to reconnect that authorization. Opening or refreshing this QR does not revoke the phone;
the previous authorization is replaced atomically only when pairing succeeds. Its old
tokens and connections are then invalidated. Repeated pairing from the same app installation
keeps one authorized client, even after a server restart. Device names and IP addresses
are not used to merge phones. For older entries without an installation identity, or after
reinstalling the Android app, use the existing phone's QR button to replace that entry explicitly.
The prototype removes the redundant scan card and the account, update, and tray shortcuts from
this page. Package updates remain accessible from the sidebar. This layout change does not
change saved connection settings or the Android app.

The Android Remote page is available at `#android-remote`. Turn on **Control this PC** to start the
phone gateway on port `10105`. The page reports `Starting`, `Ready`, or a safe start error instead of
claiming that a stopped gateway is available. **Keep this PC awake** is currently a saved preference;
operating-system sleep prevention is not implemented yet.

The Remodex model picker combines Codex's live native model list with the same enabled native,
routed, custom, and combination models shown by Remodex's **Models** page. Provider groups and
Codex-facing routed selectors are preserved. Catalog changes are pushed to a connected phone after
the gateway's short cache refresh, so adding a provider or model does not require reinstalling the
app or clearing its pairing data.

Hiding a source on the **Models** page also removes its Android picker group, including stale
Codex catalog entries. With a direct Codex Desktop provider such as Codex-LB, Android preserves
the provider with each selection and translates its model ID for Desktop. Identically named
models from different providers are kept separate. Existing tasks retain their saved route.

When Desktop connects directly to one provider, Android offers only that provider's visible
models for shared tasks. This also applies to a direct official-account connection. Android
checks the connection before creating a task, saving a changed selection, or queuing a message;
an incompatible existing task receives a clear selection error instead of silently changing
providers. When Desktop routes through Remodex, all user-enabled provider groups remain available.
Changing the configured Desktop connection invalidates Android's cached model list. An already
running Desktop process may still need to reload its configuration; a list refresh alone does not
prove Desktop has adopted a changed connection. Model discovery also does not verify account access.

Android model, reasoning, and response-speed choices stay local to the composer until **Send**.
The new turn applies the final choices together on the PC. Incoming Desktop changes do not
replace an unsent Android choice. A queued message keeps the choices captured when it was sent
and applies them when its turn starts; steering an active turn keeps that turn's current model.

Models that advertise response-speed controls show **Standard** plus the exact additional speeds
declared for that model inside the model picker instead of adding another composer chip. This can
include **Fast** and a provider-specific **Ultrafast** tier; an explicit empty tier list shows no
speed control and does not inherit choices from another model. The choice is stored per task and
uses each provider's own wire value (`priority` for Codex Fast and `ultrafast` unchanged). For native
Codex tasks, Android also follows model, reasoning effort, and speed changes made in Codex Desktop,
while Standard clears the service-tier override.

For the ChatGPT account, Android and the dashboard use Codex's current downloaded model list,
including each model's reasoning levels and speeds. Newly available models appear without a
Remodex release, and models absent from that current list are not re-added from an older private
Codex list. Hidden models stay hidden. A compact copy of this model metadata survives Remodex's
generated-cache replacement and server restarts; it contains no conversation or account credentials.
When no downloaded list has been observed, pinned metadata remains the fallback. An explicit empty
tier list removes the speed control.
Sending uses the same current reasoning levels, so a newly available model's Max or Ultra choice
is not silently lowered to an older model's limit.

Reasoning and speed are validated against the same selected provider/model used for sending.
Explicit routed-provider speed metadata wins over older Codex catalog entries, including an empty
supported-speed list. Selecting automatic reasoning in Desktop clears an earlier Android effort;
switching models without choosing a new effort does not reuse the previous model's effort.
Fast maps to `priority` for the private Codex connection and `fast` for Desktop's picker. Standard
and automatic reasoning are sent as explicit resets when updating task settings, so an old Fast
or reasoning choice cannot survive merely because a field was omitted. These choices remain saved
across reconnects and server restarts.

Opening a task loads a recent page with its public reasoning and file-change summaries already
included. Completed transient tool activities are filtered on the PC before transmission. Running
turns continue to stream their activities. On Android 1.0.66 and later, swipe toward older messages
to load another page; opening a short task does not automatically download its older history.

### Pair an Android phone

1. Start Remodex and open **Android Remote** in the dashboard.
2. Turn on **Control this PC** and wait for the gateway and public tunnel to be ready.
3. Select **Add phone**. Until the public connection is verified, this dialog shows a waiting message,
   not a QR. The QR appears automatically when checks pass, works once, and expires after five minutes.
4. On the Android device, open Remodex, choose **Pair with QR code**, and scan the code. The QR
   includes the verified Cloudflare route; a localhost address alone does not enable pairing.
5. Open an existing Codex task or create one from Android. Messages, streaming responses, tool
   activity, safe reasoning summaries, plan updates, interruptions, approvals, and user questions
   travel through Remodex in real time.

### Connect Android from outside the local network

On Windows, the tunnel runs in the background without opening a terminal window, including when
Remodex restarts it after a connection failure.

Android Remote offers two Cloudflare Tunnel modes:

- **Quick Tunnel** is the default. Remodex downloads a pinned `cloudflared` release for supported
  Windows, macOS, and Linux systems, starts a temporary `trycloudflare.com` address automatically,
  and verifies that the address reaches this exact Remodex instance before advertising it. No
  Cloudflare account or domain is required. Quick Tunnels are intended for development and testing;
  their address changes when the tunnel process is replaced or Remodex restarts.
- **Use my domain** provides a stable Named Tunnel and proxied DNS record for regular use with a domain
  already added to Cloudflare. Remodex stores only the resulting connector token in the operating-
  system credential store. The one-time Cloudflare API token is never persisted or returned.

Both choices use an encrypted Cloudflare Tunnel and still require an authorized Remodex phone.
Quick Tunnel is the fastest default, while a custom domain trades a little more setup for a stable
address. The dashboard keeps this comparison in a compact expandable panel.

Remodex waits for `cloudflared` to report a registered connection before making public website
checks, including checks requested by **Check address**. Registration alone does not mark a route
**Live**: `/healthz` and `/.well-known/t3/environment` must both return HTTP **200 OK**,
and their contents must identify the expected service and this computer. The pairing API refuses
to create a QR before these checks pass, even if an older dashboard requests one. When the dashboard
receives a failed or pending connection status, it hides an existing QR. Recovery or a changed public
address creates a fresh code in an open pairing dialog. This desktop-side check does not guarantee
that the phone's own network can reach the link.
Cloudflare can assign an address before DNS can find it. If this computer cannot resolve it,
Remodex shows **Address lookup pending**, not **Live** or a blocked-port warning. Ambiguous Windows
connection errors get a bounded operating-system address lookup to distinguish a DNS failure;
Remodex does not change DNS servers. DNS-only failures keep the same tunnel running, even after
it was previously verified. **Check address** checks the same address and shares any in-progress
check rather than creating duplicate requests. **Restart tunnel** is the separate recovery action
that may create a new Quick Tunnel address. Remodex also keeps checking automatically, so pressing
**Check address** is optional. Remodex skips Cloudflare's redundant startup precheck because the
connector can report a false failure and then register successfully moments later. Remodex verifies
the actual public gateway instead, starts checking once the connector registers, and automatically
retries it with capped backoff if the process exits. It starts with HTTP/2 for predictable desktop
startup and falls back to QUIC automatically when TCP cannot establish an edge connection.
These safeguards do not guarantee instant DNS availability or repair a network's DNS service.

To connect a domain purchased from any registrar:

1. Buy a domain from any registrar, or use one you already own.
2. In the [Cloudflare dashboard](https://dash.cloudflare.com/), add the root domain (for example,
   `example.com`), choose a plan, and review the imported DNS records.
3. Cloudflare assigns two nameservers. Sign in to the company where you bought the domain and replace
   its current nameservers with those exact assigned values. Do not reuse nameservers shown for a
   different Cloudflare account or zone.
4. Wait until Cloudflare reports the domain as **Active**. Nameserver propagation is external to
   Remodex and may take time.
5. Create a scoped Cloudflare API token with **Account → Cloudflare Tunnel → Edit**,
   **Zone → DNS → Edit**, and **Zone → Zone → Read** for the account and domain you intend to
   connect. The Android Remote page includes this exact expandable walkthrough.
6. In Remodex **Android Remote**, select **Use my domain**, paste that one-time token, and choose
   **Connect Cloudflare**. Select the account and domain, keep or replace the generated random
   subdomain (for example, `rmx-072ab490ff`), and choose **Connect domain**. A non-obvious subdomain
   reduces casual discovery, but it is not an access control; phone authorization remains required.
   That click explicitly authorizes Remodex to create
   or safely reuse its tunnel, configure the fixed gateway ingress, and create a proxied CNAME.
7. If the domain is pending, Remodex shows the Cloudflare-assigned nameservers. Set those at the
   registrar and reconnect after the zone becomes Active.
8. Do not put Cloudflare Access in front of this hostname unless the Android app is separately
   configured with matching Access credentials; otherwise its normal bearer-authenticated requests
   cannot reach the gateway.

The API token remains only in the current browser/request memory and is cleared after setup. It is
never written to Remodex settings, the keyring, logs, QR data, or a child process. You may revoke it
in Cloudflare after setup. If you already created a tunnel yourself, **Advanced manual setup** still
accepts its public hostname and connector token. Wait for **Verified** before generating a QR code.
**Connect another domain** leaves the current route active until its replacement is configured.
**Remove domain** clears the local connector credential and hostname and returns Remodex to Quick
Tunnel; it deliberately does not claim to delete the Cloudflare-side tunnel or DNS record.

Only the Android gateway at `http://127.0.0.1:10105` is a tunnel origin. The Remodex management
dashboard defaults to port `10100`, and the private Codex connection uses `10106`, including in Connect mode.
Quick and automatically configured custom-domain tunnels use only gateway port `10105`; starting
a tunnel for another gateway port is rejected. Manual Cloudflare routes must use the same origin.
The dashboard and private Codex app-server listeners are not published. A URL appears in pairing data and
live phone route updates only after `/healthz` and `/.well-known/t3/environment` prove that it reaches
the expected local gateway instance.

Remodex sends ordinary live changes as small, ordered updates. The selected task initially loads a
bounded recent window, and Android can request older pages without replacing the current screen.
Assistant text, plans, commands, MCP progress, and file changes keep their provider order; raw
reasoning text and raw command/file output are not converted into Markdown. While a turn is live,
Remodex combines an uninterrupted run of terminal commands into one stable Command Execution row.
A message, file change, or different tool ends that run. Only the newest running activity receives
motion feedback. Command Execution is temporary progress UI and is omitted after the turn completes;
the lasting Work summary keeps the other useful activity types. A reconnect replays retained ordered
updates when possible and falls back to a fresh bounded snapshot if a gap cannot be proved safe.

Active reasoning without a public summary is labeled **Reasoning**. When that reasoning finishes,
the empty entry disappears instead of displaying a summary-unavailable message. Public summaries
remain visible; private or encrypted reasoning is never used to fill a missing summary.

To keep a single very large tool result from freezing a phone, each projected tool-text field is
limited to 64 KiB and each structured tool object is limited to 128 KiB, 256 entries, and 64 items
per array. Remodex labels truncated data instead of silently presenting it as complete.

The Android composer accepts images and, when connected to Remodex, ordinary files selected from
the phone. A prompt may contain up to eight attachments, each attachment may be up to 10 MB, and the
combined decoded size may be up to 40 MB. Remodex stores them in a protected per-phone staging
folder on the computer. Images are passed to Codex as native local images; other files are referenced
by their protected computer-local path.

Attachment messages keep one chat bubble when Codex saves both the original message and a second
copy containing its message ID. Internal image notices do not split those copies into separate
bubbles. This applies to live updates and restored history on Windows, Linux, and macOS; sending
the same prompt again intentionally still creates a separate message.

Live tool updates use the same saved Desktop events as restored history, including individual
commands inside a grouped tool call. Remodex retains unfinished updates during reconnects and
recovers if Codex replaces a history file, helping keep the tool list and **Working** state aligned.
Checking an already-running command updates that command instead of adding another command row.
An edit followed by a command check is shown as **File Change** from the first update. Fresh work
from the watched Desktop task restores **Working** if a Windows history read reported an interruption
without a stop time. Quiet periods during long commands use the same saved start/stop state as the
Stop button; a real completion or interruption still clears the running state.

After a desktop restart, Android automatically retries an initially empty model list while the app
is open. Recovery continues through provider discovery cooldowns without reopening the chat.

On Windows, macOS, and Linux, task status also checks newer saved history files for the same task. Codex can continue
a task in a new file while its task list still points to the old one. This prevents an old stopped
reply from leaving a stale **Paused** badge after newer work has started or finished. A genuinely
interrupted latest reply still appears as **Paused**; that does not mean the phone is disconnected.

Recent saved reasoning and dynamic-tool activity also count as progress. If activity becomes old
and the desktop's live-status handler cannot be reached, **Status unavailable** means the current
state could not be verified—not that the task was paused or stopped. Remodex does not invent a
completion or keep an abandoned task permanently marked as running.

If Windows Codex rejects a task with `invalid paginated history lineage` because its source belongs
to another task, Remodex reads that task's verified local history files instead. Messages and saved
work still load in pages without restarting the connection or changing Codex's files. If no readable
saved history exists, Remodex reports a task-history error instead of an empty conversation. This
lineage compatibility fallback is Windows-only.

On all three desktop operating systems, native history loads one complete turn per page. If the
initial history page exceeds the reader's safe response limit, Remodex fails that read immediately and recovers
the task from verified local history with local paging, rather than waiting for a timeout or
requesting the same oversized response repeatedly. This does not stop the task or modify its files.

Windows also checks for verified continuation files when Codex returns a successful history page.
If the task spans several files, or its saved file has moved, Remodex combines the saved messages
before sending the first page. This prevents a successful but incomplete response from showing
only the first message. Older messages remain available by scrolling.

When a saved continuation links to an earlier file, recovery reads that file only up to
the saved stopping point. Later messages from an abandoned continuation are excluded.
Large saved records up to 16 MiB are supported; an invalid boundary or a record above
that limit keeps the available Codex history and shows an incomplete-history warning.
Recovery reads saved files without changing them.

The composer also receives the machine's presentation-safe Codex extension catalogue. Type `$` to
search installed, enabled plugins and enabled skills; plugin matches include their name, display name,
description, and marketplace. The Plus menu shows the same installed catalogue below its upload,
plan, and access actions. This catalogue is machine-wide rather than model-provider-specific, so
selecting an Remodex-routed model does not hide the extensions installed in Codex. Selecting an
entry adds its ordinary plugin or skill reference to the prompt; MCP references remain normal prompt
text.

Revoking a phone from the dashboard invalidates its saved credential and closes its active live
connection immediately. Pairing does not expose the private Codex app-server: that listener stays on
`127.0.0.1:10106`, while only the smaller Android gateway is reachable from the local network.

:::note
Remodex and Codex Desktop share saved task history. When an Android prompt starts a task and Codex
Desktop is already running on Windows, macOS, or Linux, Remodex asks Desktop to open that exact task and
supplies its live state through Desktop's local connection. The sent Android prompt, safe reasoning
summaries, text, tools, file changes, completion, and later Desktop controls therefore belong to the
same native Codex turn. Remodex sends one complete state first and then small numbered changes.
If that exact task is already open in Desktop, the Android send is handed to Desktop's existing
task connection instead of opening a second writer. An idle task accepts the next message; a running
task queues it, or accepts it as steering when you choose that action. Opening the task on either
device does not give that device exclusive control of these actions.
If a connection changes while sending, Remodex discovers the current connection and retries only
after Codex explicitly rejects the first attempt. During a longer reconnect, the message stays in
the saved queue and retries automatically. A lost confirmation is checked against saved history
before another send, so recovery does not duplicate the message.
If Desktop is closed, Remodex does not unexpectedly launch it; Android continues normally and the
live connection is offered when Desktop later becomes available.
:::

Cost values in **Logs** and **Usage** are API list-price equivalents calculated from reported tokens.
They are not billing receipts or evidence of an actual charge; subscription usage or provider credits
may apply instead.

## Model visibility

The **Models** switches show final Codex visibility: a routed model is on only when its provider allowlist includes it (or no allowlist is set) and it is not disabled. Turning a model on reconciles both filters atomically; **All on** clears the provider allowlist so newly discovered models are also on.

## Delegation picker vs spawn routing

The Dashboard's **Sub-agent delegation** picker stores `injectionModel` and, optionally,
`injectionEffort`. **Remodex multi-agent guidance** independently controls the delegation
instructions that use those values. On eligible v2 turns, that guidance tells the parent
agent which exact model and reasoning effort to pass to `spawn_agent`; clearing the model also clears
the stored effort.

The default-off **Use as native Codex subagent defaults** switch applies the same selection to Codex's
native `[agents]` defaults on the next sync/restart when Remodex manages the active Codex routing.
External user-managed provider configs remain untouched. Those defaults affect newly created Codex tasks
and do not themselves cause delegation. Existing user-owned `[agents]` defaults are preserved rather
than overwritten, so they may continue to override the requested defaults.

:::caution
Neither control is a proxy-side cross-model spawn router. Remodex guidance asks Codex to pass
overrides to `spawn_agent`; native `[agents]` defaults apply only when Codex creates a new task after
they have been synchronized. See
[Sub-agent Surface](/guides/sub-agent-surface/) for the canonical v1/base/v2 behavior.
:::

The spawn override guarantee applies to the **built-in** v2 guidance text. A custom
`injectionPrompt` replaces that text entirely and must include `{{model}}` and `{{effort}}`
placeholders (and optionally `{{roster}}`) or those values will not appear in the injected
guidance.

The picker offers enabled native and routed models plus the global Codex effort ladder. The API
validates the selected effort globally; Codex still validates a spawn effort against the target
catalog entry.

## Codex Auth and account pools

The **Codex Auth** page manages the native ChatGPT/Codex route:

Pool mode selects across the main and added Codex accounts; Direct uses only the caller/main login.
In-flight requests keep their captured credentials, and a 401/403 reauthentication or 429 cooldown
may clear affinity and rotate to another eligible Pool account. This is separate from `openai-apikey`
and other providers.

- Manually choosing an account applies immediately: an already-bound thread moves to it on its next
  request, and only requests already in flight keep the account they captured. A manual choice is also
  pinned: the card shows a **PINNED** badge, and a higher selection order cannot preempt that account
  until it is drained, you select another account, or you change any account's selection order.
- Each account card carries a **Selection order** control (First, Earlier, Normal, Later, Last).
  Higher order is used first, and the pool drops to a lower order only once every account above it is
  drained or unavailable. A changed order applies from the next unbound request and never moves a
  thread that is already bound. The Codex Desktop (main) account is ordered like any other, so it can
  be set to **Last** and kept as the reserve. An order set from `rmx account priority` outside those
  five presets stays visible and selectable on the card.
- Thread affinity prevents per-request flapping. With quota auto-switch enabled, a long-running
  thread is periodically re-evaluated and may rebind after its relevant usage reaches the threshold
  and a strictly lower-usage eligible account exists.
- New sessions can choose the lowest-usage eligible account. Paid plans score the hottest known 5h,
  weekly, or 30d window; Go/Free plans use the 30d window only.
- When WHAM supplies `limit_window_seconds`, Codex Auth classifies a primary window of at least 28
  days as 30d instead of assuming every primary window is weekly. Responses without a duration keep
  the legacy weekly interpretation.
- **Refresh quotas** re-reads account usage immediately so routing and the account cards use the same
  values.
- Pool request logs use opaque labels such as `p3fa91c`, never account emails.
- **Target a specific Codex account from the model picker** is an explicit opt-in. When enabled,
  ordinary supported GPT picker rows are replaced by one entry per public account selector.
  Choosing one locks that conversation to the mapped account: it does not rotate, fall back, or
  change the active Pool account. The built-in Codex App login has its own selector; generated maps
  normally use `main`, with a collision-safe suffix such as `main-2` when needed. Added accounts
  receive stable, privacy-safe labels, and existing custom selector labels are preserved.
  Existing conversations and saved model selections continue routing. Turning the setting off
  hides generated picker entries without deleting accounts, selectors, or exact routes. Plain GPT
  model ids continue to use the configured Pool or Direct behavior.
- Account add, remove, and picker-setting changes are saved before the model catalog is refreshed.
  If that bounded refresh cannot finish, the dashboard shows an amber success-with-recovery notice;
  run `rmx sync` to retry. The account or setting change itself remains saved.

The Providers overview separately summarizes Pool-mode usage as a display-only weighted capacity
estimate, alongside the effective account's raw quota and the next capacity recovery. See
[Providers overview pool capacity](/guides/providers/#providers-overview-pool-capacity) for the
visible fields, incomplete-coverage meaning, and routing boundary.

## Starring is yours to decide, not an agent's

The sidebar's star button — and the one-time question `rmx start` asks in an interactive
terminal — goes through **your own `gh` login**. Remodex holds no GitHub token, and the
only thing it learns is your yes or no.

Because that writes to your GitHub account, agent-driven callers are refused rather than
allowed to answer for you:

- `rmx start` and `rmx service install` **skip the prompt entirely** when an agent or CI
  harness is driving them (`CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_TRACE_ID`, `CI`, and
  similar). The one-time marker stays unwritten, so the real prompt still shows up on your
  next hand-typed run. The agent is told to ask you instead — and to ask as a plain Yes/No
  choice you have to answer, not as a soft aside it can slip past you. If you never get
  around to answering, the agent is told to re-ask rather than treat your silence as a no.
- `POST /api/github/star` answers `403` with `code: "agent_consent_required"` when the proxy
  runs under an agent session and the request has no dashboard browser session. Possessing
  the admin token is not consent: an agent on your machine can read that file.
- The dashboard button keeps working normally. A real click carries same-origin session
  evidence, so it is recognized as you even when an agent started the proxy.
- Saying no ends it. Nothing is persisted and nothing is added to any model prompt to nudge
  you later.

## Android history and Windows version checks

After pairing, the sidebar waits for actual project and chat data before the
connection becomes ready. It then receives task status updates automatically,
including for chats you have not opened on the phone. A slow transcript read
does not block sidebar updates. Temporary sidebar-read failures retry without
requiring you to close the app or pull to refresh.

New and forked tasks appear under their saved project even when Codex has not yet saved a
per-task project assignment. Remodex matches the task's exact folder to a unique saved project,
including Windows drive-letter casing and slash differences. Explicit project assignments and
projectless chats keep their chosen location; ambiguous shared folders are not guessed.

Android Remote checks that its Codex history reader matches the installed Windows Codex Desktop
version. Automatic selection uses Desktop's executable when one verified Desktop build is
available, even when a previously saved CLI path points to an older version. This affects only
Android's connection; your saved CLI choice is not rewritten. An explicit `CODEX_CLI_PATH`
environment override must still match Desktop. The connected server is also checked, so an older background server
cannot silently keep using a different history format. Multiple installed Desktop versions require
repairing the installation before Android connects.

A failed phone-connection startup retries in the background every 30 seconds after the previous
attempt finishes. Slow version checks and Windows helper startup do not block the main server.
These retries leave ready connections alone, stop when remote control is disabled, and never
restart the main Remodex server or restart a healthy task connection just because Desktop updated.

If Android cannot check whether a task is still running, it shows **Task status is unavailable**.
The sidebar shows **Status unavailable** rather than replacing an unverified active task with a
relative timestamp. Confirmed **Completed** labels appear for the first minute, then change to
**1m ago**, **2m ago**, and so on, measured from completion rather than the original prompt.
Reconnect to refresh the status. This message does not mean that the task failed or finished.
The connection retains its internal ownership information to avoid starting duplicate work.
An inactive or unavailable status check by itself is not a saved stop event, so it must not
produce a **Paused** badge or a Resume action. Recent saved assistant messages and tool work
keep an open reply active even when its original start message is older than the status-check
window. Real stop and completion events still take precedence over that recent work.

The Android notification uses the same checked task status. Old unfinished history
records alone cannot keep the notification on **Working**. Its title shows the
connection/work status, with the current project and activity underneath. Idle
connections show **Active**; the same single task line is not repeated in an
expanded notification. The compact status chip uses Android's supported live
notification feature where available; its appearance depends on the phone's Android
version and notification settings.

For conversations continued across several saved files, Android follows the recorded parent
links and their saved stopping points. If a link is missing or there are two possible branches
without a confirmed current file, Android shows the Codex-provided history with an incomplete
history warning. It does not combine uncertain branches or change your saved conversations.

## How the dashboard talks to the proxy

The GUI is a thin client over the proxy's JSON management API. Useful endpoints include:

| Endpoint | Purpose |
| --- | --- |
| `GET` / `PUT /api/settings` | Read settings or update Codex autostart, stream/memory settings, and account-targeting picker visibility. |
| `GET /api/android-remote` | Read Android Remote settings, gateway readiness, reachable addresses, secret-free tunnel configuration/status, the current desktop, and privacy-safe authorized-client metadata. |
| `PUT /api/android-remote/settings` | Save strict boolean `controlEnabled` and/or `keepAwake` preferences. |
| `POST /api/android-remote/cloudflare/discover` | Verify a one-time scoped Cloudflare API token and return bounded account/domain metadata. The token is not retained or returned. |
| `POST /api/android-remote/cloudflare/provision` | From a real dashboard GUI session only, create or safely reuse the selected tunnel, ingress, and DNS record; store only the connector token; and start verification. A raw admin token cannot authorize this Cloudflare mutation. |
| `PUT /api/android-remote/tunnel` | Select Quick Tunnel, or save a Named Tunnel hostname and optional replacement connector token. The token is never returned. |
| `POST /api/android-remote/tunnel/retry` | Restart and re-verify the selected tunnel mode. |
| `DELETE /api/android-remote/tunnel/token` | Remove the Named Tunnel connector token from the operating-system credential store. |
| `DELETE /api/android-remote/tunnel/domain` | Clear the local Named Tunnel hostname and connector credential, then return Android Remote to Quick Tunnel without deleting Cloudflare-side resources. |
| `POST /api/android-remote/pairing` | Create one five-minute, single-use Android pairing invitation while the gateway is ready. |
| `DELETE /api/android-remote/clients/<id>` | Revoke one saved Android client. Stored credentials are not returned by the API. |
| `GET /api/startup-health` | Read secret-free routing, service, shim, and restart-safety diagnostics. |
| `POST /api/startup-action` | Install the background service or Codex launcher shim through fixed, allowlisted actions. |
| `GET` / `POST /api/windows-tray` | Read or change the Windows tray installation and visible-process state. POST accepts `install`, `start`, `stop`, or `uninstall`. |
| `POST /api/sync` | Rebuild the shared model catalog. After dashboard confirmation, temporarily take over global Codex routing and hard-restart Codex/ChatGPT Desktop so the picker reloads immediately. |
| `GET /api/update/check` · `POST /api/update/run` · `GET /api/update/status` | Check, install, and monitor `@remodex/rmx` npm package updates. The check returns bounded release notes for the resolved version and the locally recorded install time when it belongs to the running version. The dashboard shows those notes only after that version is installed. Worker PIDs are persisted so a crashed job recovers automatically; legacy no-PID jobs recover after ten minutes. |
| `GET` / `PUT /api/sidecar-settings` | Read or set search/vision sidecar model settings. |
| `GET` / `PUT /api/injection-model` | Read or set the shared sub-agent model/effort selection and the independent guidance/native-default switches. |
| `GET` / `PUT /api/v2` | Read or set the surface mode, Codex feature flag, and v2 thread limit. |
| `GET /api/providers` · `POST /api/providers` · `PATCH /api/providers?name=...` · `DELETE /api/providers?name=...` | List, add/replace, enable/disable, set the default, or remove providers. `PATCH` uses standalone `{ "setDefault": true }` on an enabled provider; `POST` may include `setDefault` when creating/replacing (also enabled-only). Deleting the current default reassigns to the first remaining enabled provider when one exists; otherwise the API returns `409` with `code: "last_provider"` and keeps the current default. |
| `GET /api/models` · `PUT /api/disabled-models` | List native/routed model rows and update the shared disabled-model set. |
| `GET /api/selected-models` · `PUT /api/model-visibility` | Read provider allowlists and atomically change the final visibility of one model or provider group. |
| `GET /api/key-providers` · `GET /api/oauth/providers` | Read the API-key and OAuth provider catalogs. |
| `POST /api/oauth/login` · `GET /api/oauth/status` | Start a provider OAuth flow and poll for completion. |
| `GET /api/codex-auth/accounts?refresh=1` | List main and pool accounts, force quota refresh, and report main-account `hasCredential` / terminal `needsReauth` state. |
| `PUT /api/codex-auth/active` · `PUT /api/codex-auth/auto-switch` · `PUT /api/codex-auth/failover` | Select the account for the next request and configure pool routing. |
| `GET /api/codex-auth/active` · `PUT /api/codex-auth/accounts/priority` | Read the effective account (including `pinned` and which account is `pinnedAccountId`) and set one account's selection order. |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | Add a pool account through browser login. |
| `GET /api/logs?tail=50&limit=20&offset=0&provider=...&status=5xx` | Read recent request metadata with optional tail, provider, and exact/class status filters. With `limit`/`offset`, paging walks backward from the newest row (`offset=0` returns the latest page). Response shape: `{ timeZone, total, logs }` where `total` is the filtered row count before pagination. |
| `GET` / `PUT /api/subagent-models` | Read or set the five featured `spawn_agent` override models. |
| `POST /api/stop` | Fence new work, restore only Remodex-owned client configuration, stop the service, and exit. A restoration or lifecycle conflict returns 409 and keeps the proxy alive. |

:::tip
Adding **Ollama Cloud** or another catalog provider from the dashboard copies its text-versus-vision
classification into the saved provider config, so the [vision sidecar](/guides/sidecars/)
is gated correctly without manual classification.
:::


### Android file-content previews

Generated-image tools remain visible while running and after completion. The Android **View Images**
disclosure starts collapsed: opening it requests 256-pixel previews, and tapping an image opens the
original in the full-screen viewer. Image bytes and private generation prompts are not included in
the transcript. Saved image paths are authorized against the selected task before issuing a preview URL.
A pending image-generation call has a bounded ten-minute quiet-work window; explicit task completion
or interruption still takes precedence, and unverifiable older work is not reported as confirmed running.

With the matching Android app update, tapping a filename in a message opens its current
text contents in a bottom sheet. This is separate from the existing file-change diff view.
The authenticated `filesystem.readTextFile` WebSocket method requires task-read access
and resolves the path within the selected task's canonical project folder. It rejects
outside-project paths, symlink escapes, non-regular files, binary data and invalid UTF-8.
Reads are limited to 256 KB, with a visible truncation notice for larger files.
The operation does not modify project files or Codex configuration.

### Pair your Android phone on the same Wi-Fi

Run `rmx onboard` on your computer, then scan the QR code with Remodex on your phone. Setup shows three stages with periodic waiting messages. The dashboard opens while pairing prepares, then displays a usable QR as soon as Wi-Fi or verified remote access is ready. Keep the page open to see when a new phone comes online; receiving a pairing request alone is not shown as connected. Failed or expired QR requests have retry controls. Use a trusted private network and keep your computer awake.

In the Connect prototype, remote-control and keep-awake preferences remain visible above **Connection methods**. The connection choices remain visible, while the comparison, Cloudflare token guide, and advanced manual setup start collapsed. Authorized clients follow the connection section. Your selected connection method is saved on the computer and restored after a dashboard reload or server restart. Existing custom-domain setups select **Custom domain**; new setups select **Local**. Selecting a method does not toggle local access. The Local switch changes local access without stopping the remote tunnel.

**Free temporary link** prepares separately in the background. Your paired phone checks and saves the remote link while connected. No second scan is needed to switch networks. Remote setup failure does not stop a ready Wi-Fi connection.

A temporary remote link can change after a connector restart. Turning Local off or on does not restart that connector. If your phone is away and cannot reach an old link, return to the same Wi-Fi to refresh its saved address. **Custom domain** is optional and provides a fixed address.
