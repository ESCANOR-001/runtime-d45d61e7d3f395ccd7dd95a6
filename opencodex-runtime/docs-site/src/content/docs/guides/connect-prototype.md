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
an unconfirmed Stop produces an error instead of pretending the task stopped. If Desktop reports that the turn already ended, Remodex checks its latest turn and restores Send or Continue when the result matches. Confirmed stops stay settled across history refreshes, even if the PC restarted before the final saved event.
Unknown status does not mean the task has completed.

Queued messages survive a restart. If the connection drops while Codex accepts a
queued message, Connect checks the saved conversation for that exact message
before removing it from the queue. It does not automatically resend an uncertain
message. Editing and steering that queue entry remain unavailable until delivery
is confirmed. Cancelling removes the pending entry; it cannot undo a message
Codex already accepted. A storage error leaves the previously saved queue,
phone authorizations, and settings intact.

When Remodex owns a chat created from Android, Codex Desktop can submit ordinary
messages through its follower queue. Remodex saves the queue before acknowledging
it and sends the next message when the current turn finishes. A stopped turn
pauses waiting messages. Unconfirmed deliveries stay visible for review and are
not automatically replayed. Text, ready image attachments, and local file
references are supported; desktop-only rich context and queued prompt edits are
rejected explicitly instead of being silently omitted.

Update checks distinguish network failures, timeouts, unavailable release channels, and npm rate limits. A failed check does not mean automatic installation needs to be enabled. Retry starts a fresh check after failure rather than reusing a cached error; simultaneous checks still share one request. If a channel has no published release, select another channel. If npm rate-limits checks, wait a few minutes before retrying. The paired-phone update endpoints enforce the same check-only restriction and cannot start installation or activate the legacy automatic updater.

## Onboarding without service installation

On Windows, macOS, and Linux, `rmx onboard` prepares local settings, reuses a verified running instance or starts a hidden background process for the current user, then verifies a usable connection before reporting QR pairing ready. It does not install, repair, or require an operating-system service. Progress messages continue while waiting. Existing Codex settings remain untouched.

Fresh Connect profiles use dashboard port 10100, Android gateway port 10105, and private Codex port 10106. Onboarding, service setup, recovery, and restart keep their configured ports. If a port is occupied or its existing peer is incompatible, setup reports the conflict rather than silently switching ports. Other listeners are left running. Gateway startup uses the same bounded retries on Windows, macOS, and Linux, showing a starting state while retrying.

Advanced manual tunnel setup displays the actual Android gateway address returned by the server. Use that address, not the management dashboard port or the old app's gateway port.

The managed Cloudflare helper supports Windows x64, macOS Intel/Apple Silicon, and Linux x64/ARM64. On Windows ARM64 it uses the checksum-verified x64 helper via [Windows 11 emulation](https://learn.microsoft.com/en-us/windows/arm/apps-on-arm-x86-emulation), not a native ARM binary. Setup validates the executable before completing installation. If emulation is unavailable, use Local Wi-Fi or provide a compatible executable through `OPENCODEX_CLOUDFLARED_PATH`.

This user-level process is not a service: it has no guaranteed restart after a crash, sign-out, or computer reboot. Run `rmx onboard` again when needed. Onboarding does not uninstall or disable an existing service. Network policy or a firewall can still block connectivity; setup never bypasses those protections or claims that an unusable QR code is ready.

Advanced Settings contains only the optional background-service setup, not provider or Codex configuration. Opening the page reads status. Enabling or repairing a stopped service requires an explicit confirmation; Windows may then show an OS administrator prompt, while macOS and Linux use per-user service managers. Setup runs in a separate hidden worker so it can complete when the current server stops. Status survives the server handoff; duplicate actions are blocked while setup or elevation reconciliation remains pending. On failure, the worker attempts to restart the ordinary user-level server without claiming service installation succeeded.

Do not repair a currently supervised server from inside its own service process: its service manager could terminate the repair worker along with the server. For that case, inspect `rmx service status` and run `rmx service repair` separately on the computer. Unsupported service managers or a service owned by another profile are not changed. No administrator password is collected by the dashboard.

## Adding another computer

On the phone, choose **Add connection** and scan the QR from the additional computer. Opening this scanner does not reuse an earlier QR link or show errors from the previously selected connection. Errors from a new scan still appear on the pairing screen.

Saved computers remain available when adding another connection, including when confirmation of the new connection fails. A shared Wi-Fi address alone does not identify a computer: Windows, Linux, and macOS installations can reuse the same address. Remodex keeps their pairings separate and updates an existing saved computer only when its identity or issued phone credential matches.

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
live activity, including steering messages, then fills in the remaining recent
prompts in the background. Queued follow-ups stay visible while you steer the
current response. Recovered responses whose original prompt is missing still
load in bounded pages. Incomplete-history warnings remain visible during work.
Scrolling toward older history prefetches the next ten prompts near the oldest
two loaded prompts. Already loaded messages are reused when scrolling back.
Network delays keep the existing conversation visible with a loading indicator.

Expand Work to fetch its historical entries in bounded pages. Long Work sections
include a **Load more work** action. Steering messages and answered questions
from a finished turn are included in Work. The original prompt and final answer
remain outside the fold, and unanswered questions stay visible. Resolving a question updates
its activity without replacing the loaded chat. Once delivery succeeds, the
thread list and Android notification clear **User input needed** immediately,
unless another question remains unanswered. Failed delivery keeps the question
pending so you can retry.

### Recovering a chat after an interruption

Chats created on Android use Codex's native thread creation and keep their pairing
with the same desktop chat. Temporary history-loading failures preserve the
connection's controls. Desktop can read model settings, edit the last finished
prompt, and remove waiting follow-ups from these chats.

When you press Stop, Remodex checks that the native turn has actually ended before
reporting it stopped. If the computer cannot confirm the result, refresh the chat
and retry Stop. A delayed submission is checked against its original message ID;
it is not automatically sent again. Stopping an active goal also pauses that goal.
Waiting follow-ups are retained and paused after Stop, so they cannot immediately
restart the task. Remove or explicitly resend a waiting prompt when ready.

## Agent setup and settings

Open **Agents** in the dashboard sidebar, then choose **Claude Code** or **Codex**.
Each tab has a beginner-friendly setup guide and the settings relevant to that agent.
Tab links can be bookmarked, and browser Back/Forward restores the selected tab.

**Claude Code** contains its enable, Desktop sync, and automatic-connection controls.
The one-time Desktop setup warning appears here when Desktop has auto-connect turned
off. Open **Advanced settings** only if Claude Code needs a custom executable path.

**Codex** explains sign-in, pairing, and starting a chat. Its account is managed by
the Codex desktop app; model, reasoning, and access choices remain in the Android
composer. Opening the tab does not change Codex configuration.

Both agents use the same paired PC. Pairing and shared network/keep-awake settings
remain in **Android Remote**, with a link from each agent tab. Pairing a PC does not
replace each agent's own account sign-in.

## Managed Claude Code (preview)

### One-time setup for Desktop and Android chats

The **Agents → Claude Code** tab includes a **Control chats from Desktop and Android**
checklist. Complete it on each PC where you want to use local Claude Code sessions:

1. Sign in to Claude Code and Claude Desktop with the same Claude account and a
   subscription that supports Remote Control. Pair Remodex Android with that PC;
   an existing Codex pairing can be reused.
2. In **Agents → Claude Code**, turn on **Enable Claude Code**, **Sync with Claude
   Desktop (preview)**, and **Automatically connect new Claude Code chats**.
3. In Claude Desktop, open **Settings → Claude Code** and enable **Connect new
   sessions to Remote Control**. Desktop's saved choice takes precedence over
   Remodex's automatic-connection preference.
4. Return to Remodex and select **Refresh status**. Resolve any setup warning;
   an unverified setting does not confirm that individual chats are connected.

For a chat started on Android, select Claude Code, the paired PC and a project
folder, then send a message. Its shared session appears in Desktop's **Code** tab.
For a chat started in Desktop, create a local Code session on that PC. Once
Remote Control connects, open the same chat under Claude Code on Android.
Connected sessions synchronize prompts, replies, tools, approvals and Stop.

This default applies to new sessions. An older unshared chat may still need its
Remote Control switch enabled, or `/remote-control` run once in Desktop, before
reopening it on Android. Keep the PC awake and online and Remodex running. Keep
Desktop running for sessions it started. Account and organization restrictions
can prevent connection, and the preview's concurrent-worker limits still apply.
See [Claude's Desktop connection settings](https://code.claude.com/docs/en/desktop#control-which-sessions-appear-on-your-other-devices).

### Start using Claude Code

Open **Agents → Claude Code** in the dashboard for setup instructions and settings. This runs the official
Claude Code CLI through the Anthropic Agent SDK on your PC. It does not modify
Claude Desktop or install a Desktop plugin. Codex keeps its existing connection.

1. Install Claude Code on the PC and run `claude auth login` with your Claude
   subscription. If Remodex cannot find the executable, enter its full path in
   **Agents → Claude Code → Advanced settings**.
2. Enable Claude Code in **Agents → Claude Code** and refresh its status.
3. Pair the phone with this PC once. The same PC authorization is used by both
   agents; a second QR scan is not required.
4. In Android, tap **Remodex · Codex** and select **Claude Code**. Add a project
   folder on the PC and start a task. The existing chat UI displays prompts,
   streaming replies, tool activity, permission requests, model selection and
   the effort levels reported by the installed CLI.

Claude tool rows include read file names and command metadata in the shared
timeline. Permission controls remain available without duplicating the linked
tool row. **Accept edits** uses Claude Code's edit-acceptance mode; other tools
may still require approval. **Full access** bypasses tool permission prompts.
Successful Claude Write/Edit results retain the SDK's actual per-call unified patch
and added/deleted line counts. Android's changed-file sheet can display these
patches after reconnect. Large patches are bounded and marked as shortened;
missing historical patches are not reconstructed from current files. Declined,
stopped, and staged writes are not reported as completed file changes. Structured
tool results render as readable text, with tool references and returned media
identified without displaying encoded file bytes. Completed Claude command, search,
and read activities remain individually available under Work; tap Details to read
the command and output. Other providers retain their existing presentation.

Claude questions use the same answer sheet, including single-choice, multiple-choice
and typed answers. Submitted choices remain in the conversation after reconnecting.

Remodex owns sessions created through this integration and resumes their exact
Claude Code session IDs. Existing local Claude Code sessions also appear under
their project folders. With Desktop sync enabled, opening an existing chat attaches
a client to its recorded Remote Control session. Enable `/remote-control` in that
chat in Claude Desktop first. Android unlocks sending only after the original worker
acknowledges the connection. Prompts, tools, approvals and Stop use that same worker;
Remodex never launches a second writer or copies the chat. Offline or unshared chats
remain readable and show the connection instruction in Status. The
list refreshes while a phone is connected. Very large transcripts are rejected
with an explicit message (the native transcript limit is 16 MiB). Imported history
is no longer cut off at 2,000 entries: Android loads older messages in ten-prompt
pages, including the beginning of the saved conversation. Closing or switching the Android screen does not stop a running
PC task. Up to four managed tasks can run concurrently. Use Stop before changing
settings during a turn. New Claude tasks default to asking for approval; full
access is an explicit composer choice. Renaming a Remodex-owned chat keeps its
Desktop connection open. Model, effort and ordinary access changes apply to the same
idle worker without reconnecting; rejected settings remain unapplied. The first
explicit **Full access** change may reopen only that idle Claude worker because the
CLI requires launch consent. Its native and Desktop sharing identities are retained. CLI control
messages do not appear as user prompts or leave the chat marked as running. These local chat
titles do not rename the Desktop sidebar entry. Context compaction and subscription
usage warnings appear in the activity timeline. Session history and permission state stay
on the PC. After a PC restart, a pending tool permission must be requested again.

In a connected managed or existing Desktop session, the composer's **Add** menu reads that session's
loaded skills, plugins and MCP connection status. Skill selection sends Claude's
leading slash command, including skills that require explicit user invocation.
Selecting another skill replaces the previous skill chip for that prompt.
MCP rows offer **Reconnect** and **Enable/Disable** while the chat is idle. These
controls address only servers already configured in that session. **Reload skills**
and **Reload plugins** refresh the PC's existing configuration; they do not install
packages or perform sign-in. If Claude holds a plugin reload to preserve the
conversation cache, start a new chat to use the changed plugins. Install and
configure new integrations on the PC. The catalog becomes available after the session starts and is scoped
to that session, not copied between projects. Unconnected Desktop history has no
live capability catalog. **Allow for this session** appears only when Claude
provides a reusable permission rule; **Approve once** remains available otherwise.

While Claude is working, sending another prompt **queues** it until the current
task finishes. Hold the Send button to choose **Steer current task** and redirect
Claude using its native priority input. Steer keeps the same session and conversation;
Claude may interrupt its response or move a running tool into the background.
Some foreground tools must finish before Claude can process a steering message.
Use Queue when the original task should finish before the next prompt is sent.
Queued messages have an actions menu to edit, move, cancel, or **Steer instead**.
The queue holds up to 32 follow-ups on the paired PC, including any staged attachments.

Stop and task errors pause queued work. **Steer instead** sends a paused item
explicitly; sending a new prompt also lets the remaining queue continue after it
finishes. Queues survive a Remodex restart but do not replay automatically. If a
connection is lost before a steering message is acknowledged, Remodex keeps it
visible with an unconfirmed-delivery notice. Check the conversation before
removing and resending that item. These controls work for Remodex-managed Claude
sessions and existing Desktop sessions with an active Remote Control connection.

When Claude reports thinking progress or an API retry, the activity list shows
that status rather than only a Working timer. Thinking counts are approximate;
private reasoning is never displayed. Retry notices show the next retry delay
and clear when Claude responds, stops, or fails. These notices depend on the
events provided by the connected Claude version; silence alone does not prove
that a task has stalled. Higher effort settings can take longer before a visible
reply or tool call appears.

Claude's model picker shows the account's resolved runtime default by name, for
example **Opus 5.5 (default)**. The composer shows only **Opus 5.5**. Selecting this
row keeps Claude's `default` selection rather than pinning a specific model;
the name refreshes from the connected PC's Claude model catalog. If an older
Claude version does not report the resolved model, Remodex says **Default model**
instead of guessing. Explicit model selections remain unchanged.

Claude's reasoning picker defaults to **Auto**, which leaves the effort choice
to Claude's model and saved settings instead of forcing High. Existing explicit
choices stay unchanged. For ordinary coding tasks on Claude 5.5, **Medium** is
the native default; Extra high can spend several minutes thinking before writing
files or showing a reply. Choose Auto to clear an effort override, or Medium for
an explicit faster setting. Changing effort keeps the same conversation; it does
not resend a prompt or restart the worker. See
[Claude's effort guidance](https://code.claude.com/docs/en/model-config#adjust-effort-level).

The preview does not implement regular Claude Chat history or Desktop session
handoff. Those
actions return an explicit unsupported-action error instead of falling through
to the Codex backend. Subscription availability and limits are governed by Claude.

Claude MCP tools can ask for information through the Android question sheet.
Text, numeric, yes/no, single-choice and multiple-choice fields keep their types
when sent back to the MCP server. Invalid answers stay on the form for correction;
**Stop** cancels the pending request. The same flow applies to connected existing
Desktop sessions. Browser sign-in steps and unsupported forms show a PC-action
notice instead of silently declining. Remodex does not automatically open an
authentication link or approve it. Typing a draft answer stays on the phone and
does not rewrite the chat history or move the chat in Recents.
Unsupported CLI dialogs in Remodex-owned sessions are cancelled with an explicit
notice rather than left waiting indefinitely. Desktop-owned dialogs remain in
Claude Desktop.

### Claude file restore and isolated worktrees

Android remembers the selected agent and unsent chat drafts when the app closes.
Tap a file link in a reply to preview the file on the connected PC. The chat's
**Files** and **Changes** menu items open its working folder and changes view.
Folder aliases on macOS and Windows resolve to the same project; file listing
and new-file change previews stay inside that project's real folder.
Completed work keeps its recorded duration when another prompt is sent.

For Remodex-owned chats, **Stop** also stops background tools reported by that
chat's worker. Queued follow-ups stay paused; choose **Steer instead** after the
stop completes to send one explicitly. Branch history omits internal background
task notifications, while keeping the actual prompts and replies.

For a chat started by Remodex, **Add → Branch chat** copies the conversation into a
separate Claude session. Send a message there to continue with the copied context
and connect the branch to Desktop through the normal sharing setting. The source
chat stays intact. Both conversations use the same project folder, so file changes
are shared; this does not create a Git branch or copy files. Previous approvals,
queued prompts and file restore checkpoints are not copied. The new chat starts
with approval prompts enabled. Finish running tasks, background tools, pending
questions and queued messages before branching. Desktop-owned conversation
branching and editing earlier prompts in place are not supported by this control.

For a Remodex-created Claude chat, **Add → Restore tracked files** lists available
file checkpoints. Select a prompt to preview affected files, then confirm the
restore. It covers Claude's Write, Edit and NotebookEdit changes, not Bash changes,
and keeps the conversation. Other edits to affected files may be overwritten.
The preview expires after one minute; changes made after preview require another
review. Running tasks, pending approvals and queued messages block restore. Native
Desktop-owned chats keep their own restore workflow in Desktop.

**Add → New isolated worktree chat** creates a separate Git branch and checkout
from committed HEAD. Uncommitted changes stay in the original folder. The new chat
starts with approval prompts enabled. This requires an existing Git repository
with a commit. Worktrees are retained on the PC; remove them with Git after saving
any needed work. No automatic cleanup discards files or branches.

### Optional Claude Desktop sync

Enable **Sync with Claude Desktop (preview)** in **Agents → Claude Code**
before starting a task. Open the task in Claude Desktop's **Code** tab using the
same Claude account. Remodex remains the local session owner; Desktop connects
through Claude Remote Control. There is no Desktop patch or plugin and no extra
Android pairing. Existing Desktop-owned sessions can be joined through their active Remote Control link.
This client route currently reads the normal Claude Code CLI credential file on the PC;
installations whose credentials exist only in an OS keychain must use Claude Code login
with a supported credential store. Credentials stay on the PC and are never sent to
Android. Expired or denied credentials require reauthentication; Remodex never replaces
a rejected Desktop link or claims its worker. Closing Remodex detaches its client and
does not stop the Desktop task. Rename, archive and delete existing chats in Desktop.

Prompts, replies, tool activity, approvals and Stop share one worker. Android's
thread status panel shows whether the task is shared with Desktop. Remote Control
requires an eligible Claude subscription, network connectivity and a running PC.
Sharing a session sends its conversation through Claude's Remote Control service.
If sharing fails, its status is disconnected; ordinary Remodex access can continue.

The preview keeps at most four workers. When a new or reopened managed chat needs
a slot, Remodex parks the least recently used idle worker automatically. Its
history and both session identities are retained; no archival is required. A
parked chat temporarily shows disconnected in Desktop. Reopen it in Android or
send a prompt there to reattach the original shared session. Running tasks and
pending approvals are never selected for parking. If all four workers are
running, finish or stop one before starting another. A Remodex restart reconnects previously
shared tasks that were not deliberately paused or archived, using their original
identities without replaying an accepted prompt or approval. An interrupted tool is not automatically rerun.
Changes to sharing or the CLI path require running Claude tasks to finish first.

Remodex automatically retries unexpectedly disconnected Claude sync connections;
you do not need to reopen the chat. Retries begin after five seconds and slow down
to at most one attempt every two minutes per chat while the connection is unavailable.
They retain the Android, native Claude and Remote Control session IDs and chat history.
A live managed worker finishes its turn and background tools before recovery can
replace it. Existing Desktop chats reconnect only to their original Desktop worker
when it is available. Recovery never starts a second owner or resends prompts,
queued messages, tool calls or approvals. Queued work remains paused after a lost
worker until you review it.

An unexpectedly disconnected managed chat keeps priority for its worker slot
during recovery, so older background chats cannot take that slot while it retries.
Opening or starting another chat yourself can still use the available capacity.
Automatic retries do not unpark chats, override Stop/disconnect, or evict another
worker when all four slots are occupied. Sign-in, device verification, policy
refusals, missing links and changed session identities require the action shown
in the chat status. Recovery does not bypass those checks or silently create a
replacement conversation.

If an older Desktop link returns HTTP 403, open the Android chat's **Status →
Reconnect Desktop**. **Retry** reconnects the original identity. If Claude keeps
rejecting it, **New link** explicitly copies its saved history using the Claude
SDK into a new native session and Desktop entry, initially named with a `(reconnected)` suffix. The Android chat, project and
saved messages remain in place. The old Desktop entry stays separate; file undo
history is not copied. Recovery is blocked while a task or approval is active.
If creating the link fails after the copy, retry uses that copy instead of making
another one. No prompt or tool is automatically replayed. The dashboard's
connected count includes only successfully shared workers.

This integration pins Agent SDK 0.3.296 and guards its experimental Remote Control
method at runtime. If that method is unavailable, or the original shared identity
cannot be reattached, it reports an error rather than modifying Desktop or silently
creating a replacement conversation. Linux has live device coverage; Windows and
macOS still require platform validation before general release.

### Automatically connect new Claude Code sessions

In Android, select Claude Code, open Settings → Claude Desktop sync, and turn on
**Automatically connect new Claude Code chats**. The dashboard exposes the same
setting in **Agents → Claude Code**. This uses the existing paired PC authorization;
a phone must have task-operation access to change it. Opening the panel only reads
settings and never enables sharing.

The setting saves Claude’s documented `remoteControlAtStartup` preference in its
user settings and enables Remodex’s Claude sharing. It applies to new local Desktop
and CLI sessions. Turning it off leaves current sessions and Remodex sharing
running. No Desktop application code, plugins, or Codex configuration are changed.

A saved preference does not confirm that every session is connected. Claude
Desktop’s explicitly saved **Connect new sessions to Remote Control** setting
takes precedence, and organization or project restrictions can prevent connection.
Remodex reads Desktop’s saved preference without changing it. When Desktop has
explicitly turned automatic connection off, Android’s Claude Desktop sync panel
and the dashboard show **One-time Desktop setup needed**, even if the Remodex
switch is on. On the PC, open Claude Desktop → Settings → Claude Code, enable
**Connect new sessions to Remote Control**, then select **Refresh status** in
Remodex. The warning clears when the saved Desktop choice is detected as on.
Missing, unreadable, or unrecognized Desktop settings are reported as unverified;
they are never treated as confirmation that automatic connection is ready.
Remodex does not override `disableRemoteControl` or edit Desktop’s private settings.
Existing unshared sessions may still need Remote Control enabled once in Desktop.
See [Claude’s automatic connection documentation](https://code.claude.com/docs/en/remote-control#enable-remote-control-for-all-sessions).


### Claude sign-in and device verification

Automatic connection, a live session connection, and Claude Desktop's device
verification are separate states. **Agents → Claude Code** in the dashboard and
Android shows the confirmed session connection count. The PC account status means
Claude Code is signed in; it does not certify a separate Desktop client's trust.

After signing in or out of Claude Code on the PC, select Claude Code in the
phone's thread list and swipe down. This refresh checks the PC's current sign-in
and available models before updating the list, including on Windows, Linux, and
macOS. You do not need to open Agents or pair the PC again. Background status
updates still use a short cache instead of repeatedly starting account checks.

When Claude reports a device-trust or sign-in error, Remodex displays **Claude
verification required** or **Claude sign-in required**, with recovery instructions.
Complete Claude's verification prompt on the PC, or run `claude auth login` when
instructed. Reopen the affected chat and retry its connection. **Check again** in
Agents refreshes the reported status; it does not sign you in, approve a device,
restart tasks, or replay prompts. Your Remodex PC pairing remains saved.
Verification recovery retries the original chat rather than offering a new link.

A generic access-denied or network error is not proof that device verification is
required. Android shows **Live sync connected** when the session connection works,
and shows a verification warning only when Claude reports a verification problem.
This is a session connection status, not an assertion about Desktop's separate
trusted-device approval. Remodex cannot see prompts displayed only inside Claude
Desktop. If Desktop asks you to verify a device, complete that prompt there.
If the request repeats immediately after successful verification, check the account
and report the exact prompt to Claude support. Creating a replacement chat is not
a verification fix. See [Claude's Trusted Devices documentation](https://code.claude.com/docs/en/remote-control#trusted-devices).

Claude Desktop's separate setup-reminder blocks are omitted from Android's user
message bubbles. The actual prompt is preserved, including literal tags typed in
that prompt. Opening an older imported chat refreshes its saved message text from
the original transcript without changing Claude Desktop's files or resending it.
The Claude chat status panel shows Claude's current context estimate (tokens and
remaining percentage), plus reported 5-hour, weekly and per-model subscription
limits with reset times in the phone's local timezone. Context is measured against
Claude's current compaction window, not cumulative tokens spent across turns.
These read-only checks send no prompt and do not modify the Desktop session.
Context comes from the connected worker; account limits come from the signed-in
Claude Code CLI on the paired PC, because Desktop Remote Control may not expose
the usage control. The optional SDK usage API is experimental. Remodex validates
its response, caches account reads for one minute, skips transcript scans, and
refreshes only while the Claude chat is visible. Missing, failed or expired
readings are not shown as zero or as a connection failure; the panel directs users
to Claude's Usage settings when subscription figures are unavailable.


### Claude activity details and images

Claude Code activity rows show a shortened command or tool invocation. Tap the row
for its full command or input details; returned text output stays hidden. File
changes retain their separate diff viewer. Available Claude 4+ API thinking
summaries and SDK tool summaries appear as compact status text. Encrypted
thinking and raw reasoning from older or unidentified models are not displayed;
when Claude omits a summary, Remodex shows only the available progress status.
New Remodex-managed workers request public thinking summaries without changing
the selected effort level or modifying Claude Desktop.

Tool-returned PNG, JPEG, WebP, and GIF images are stored on the PC, with only
bounded references sent in the chat stream. Tap **View Images** to fetch small
previews, then tap a preview for the full image. Each preview is authorized for
its original chat. Remote image URLs and arbitrary paths in tool output are not
fetched. Existing tool results that contained no image data cannot gain a preview
retroactively. Codex's activity presentation is unchanged.
If an image fails to download, **Retry** refreshes its authorization and makes one
new full-image request. It does not fetch the old and refreshed images in parallel.
