# Transports And Sidecars SOT

## Desktop questions and context compaction

Android reads bounded recent Desktop state for selected and known-active tasks,
coalescing reads and retaining only question/compaction metadata. Async questions
come from `agentMessage.questions`, not the tool's immediate acceptance receipt.
Their IDs match Desktop's `request_user_input_async` item/index encoding. Answers
use Desktop's question-reply envelope through the existing owner-safe steer/start
path; every answer is revalidated against fresh Desktop state before delivery.
When Desktop supplies only a bounded saved-history summary, verify the question
and any existing answer against the identity-checked rollout lineage instead.
A missing question in the recent summary alone is not proof that it expired.
Unverifiable saved history fails closed without sending or resolving the answer.
Accepted steering replies and ordinary user replies resolve the same questions.
Android displays a question sheet with options and an optional custom answer,
then compact question/answer bubbles instead of transport JSON.
Successful input delivery publishes request-scoped resolution to both the thread
stream and shell immediately; notification and sidebar share that shell state.
Historical requested rows do not keep resolved questions pending. Flag-only
lifecycle changes must publish even when the session and turn are unchanged,
and other unanswered requests must survive an acknowledgement.

A current, explicitly unfinished `contextCompaction` item keeps the task running
even if the secondary app-server says idle. Completed or historical compaction
does not establish activity. A saved `compacted` record denotes completion, not
the beginning of compaction. Private handoff text is never part of this metadata.

Native `item/started` events do not need an item-level status field: the event
method establishes live compaction. Retain that evidence across quiet polls until
the matching item completes or its owning turn terminates. A secondary reader's
lifecycle or compaction events cannot start or close a Desktop-owned execution.
App-server compaction events remain authoritative for locally owned tasks.
Bounded saved-history fallbacks carry `androidRemoteHistoryOnly`; they cannot
verify live activity or overwrite a known unfinished compaction. Installed
Desktop versions without bounded live-state support may expose only the saved
completion marker, not the compaction start. In that case report unverified
activity rather than infer compaction or a pause from silence. Do not restore
unbounded full-history IPC reads to work around that upstream limitation.

Legacy Desktop routers may reject the read-only bounded-page method with
`no-client-found` rather than `unknown method`. That specific read can use the
bounded compatibility reader; this does not release Desktop ownership or allow
any mutation through the private app-server. Timeouts remain errors.
Verified continuation discovery applies on Linux, macOS, and Windows. A native
page may silently omit a middle continuation even when it reports success;
recover the proven lineage and page locally rather than trusting that cursor.

Zero-filled records in an otherwise verified continuation are retained as an
explicit history gap, not a reason to discard every readable turn. Questions
before the last gap remain unverifiable; only recovered question IDs after it
may pass reply validation, including the existing answered/stale checks.
Other malformed records still fail closed. Concurrent appends are accepted only
when a bounded SHA-256 reread proves the scanned prefix unchanged; replacements,
truncations, and rewritten prefixes invalidate recovery. No rollout is modified.

## Android sidebar updates

Thread context and provider-usage activities are current status metadata, not
paginated conversation blocks. Recent snapshots include the latest row of each
kind independently of its timestamp or prompt limit. Older pages exclude those
rows so they cannot overwrite a newer reading or create a status-only cursor.

Public `thread/status/changed` events update the selected task and sidebar
immediately, including `active` with no waiting flags. Desktop's private
mounted-conversation status is normalized against its bounded turn evidence
separately. Secondary-reader lifecycle events cannot override a Desktop owner.
Session `statusConfidence` distinguishes confirmed execution from unknown
activity; unknown work retains a server-validated Stop action and does not
silently become completed or permit a competing Send. An idle status alone
does not invent an interrupted/completed outcome. Only a matching turn outcome
enables Continue after interruption. Ordinary Continue starts a new turn;
it is not the optional Codex goal pause/resume API.

Manual Stop routes to the Desktop owner before reading status or saved history.
It omits `expectedTurnId`: Desktop's normal user-stop resolves its current turn,
handles turn-id changes, pauses an active goal and cleans up running work. A stale
expected id can acknowledge a no-op and skip goal pausing. Only a nonempty
`interruptedTurnId` confirms interruption; `ok:true` alone is insufficient.
Confirmed owner results publish the matching interrupted lifecycle immediately;
newer observed turns remain protected. A null result, unreachable owner or goal
pause failure is surfaced to Android and triggers a fresh status read. Android
keeps Stop pending until the request settles and never invents a paused state
from a button tap. Stop does not fall back to a secondary writer or kill Desktop.

An uncached shell subscription waits for a real lightweight first-page snapshot;
an invented empty bootstrap must not mark a newly paired phone ready. Explicit
fresh subscriptions also use this ten-row first page, with a ten-second native
request deadline; they never join an in-flight full-history read. Remaining
rows refresh independently of selected transcript and server-configuration reads.
Shell reads are coalesced, failures retry with capped backoff, and the five-second
safety poll also uses that independent shell path. First-page reads skip optional
session-index backfill. A bounded lifecycle cache retains only status metadata
for unselected tasks, so start/completion events immediately update sidebar rows
without loading transcripts. Later stale catalogue reads cannot revive the same
completed turn, and old completion events cannot stop a newer active turn.

Windows runtime selection follows the app-server child of the current user's
verified running Desktop application. Cached installation folders and orphaned
Remodex listeners do not override that version. Explicit environment pins still
require a matching version. A version mismatch on the default private port uses
an alternate loopback port without stopping the unowned listener. Gateway status
reports a disconnected native runtime as an error even if its phone listener is
still open.

## Update activity verification

Manual phone updates, dashboard activity checks, and the background updater await
the same current task-owner check. Update eligibility does not depend on shell
cache freshness, a sidebar subscription, or historical running markers.
`update/task-inventory.ts` reads at most 2,000 task IDs from the newest native
SQLite index in read-only mode, including archived IDs. The private runtime's
in-memory loaded list identifies tasks requiring a native status read. When no
index exists, bounded `thread/list` pages provide a compatibility fallback.
`update/task-activity.ts` includes tracked active tasks and checks at most eight owners concurrently.
Closed tasks use metadata-only owner discovery; open Desktop tasks use the existing
bounded state read. If a Windows owner advertises itself but cannot serve state,
at most four verified rollout paths are checked, with a 1 MiB tail limit per path.
Terminal markers establish idle; fresh progress with a current owner establishes
running. Missing markers, stale progress, or a changing file remain unknown.
No full transcript scan or follower registration is needed.
Missing owners confirmed by a healthy bus may clear an old running indication;
disconnections, incomplete pages, unknown native states, and timeouts remain unknown.
Concurrent callers share a scan, work has a six-second response deadline, and a
turn transition during verification requires a new check. Active proxy requests
also prevent package replacement. The update POST rechecks activity after checking
the release, and automatic installation still requires two idle observations.

## Same-Wi-Fi pairing

Pairing invitations are consumed only after the phone credential is saved successfully. A failed
disk write leaves the invitation available for retry; successful exchanges remain single-use.
Updated phones send a per-attempt random secret proof. For two minutes after acceptance,
the same invitation and proof can recover the same credential if the response was lost.
The recovery cache is memory-only, capped at 128 entries, and invalidated on revocation,
replacement, expiry, or process restart. Older clients retain strict single-use behavior.
An installation ID alone never authorizes recovery. Neither raw proofs nor credentials
are written to diagnostics or the client authorization file.

Pairing stores a digest of the app installation ID, never the raw ID. A successful repeat
exchange atomically replaces all authorizations for that installation; names and addresses
are not identity keys. Authenticated metadata can bind a legacy authorization to its installation.
A dashboard-created repair invitation can also name one existing client to replace, without
revoking it before the scan. Removed clients' tickets, repair invitations, and sockets are
invalidated after persistence succeeds. Revoked or already-replaced repair targets fail closed.

`rmx onboard` explicitly enables `localNetworkEnabled` and starts the Android gateway on IPv4 LAN interfaces. Existing settings without this opt-in keep the loopback-only bind. Main dashboard port 10100 and default private Codex port 10106 remain unchanged; an incompatible existing private listener can cause selection of another loopback port. Only RFC1918 private IPv4 addresses are advertised; loopback, public, link-local, and host-only adapters are excluded from phone-facing readiness. Direct public peers are rejected; cloudflared still connects through loopback. LAN HTTP requires a trusted network and existing phone authentication.

The three-stage onboarding flow starts Remodex without requiring optional service or tray installation. Tunnel startup begins automatically after the Android gateway is ready. The dashboard waits for verified remote access by default, then generates one QR with all available LAN addresses and the verified remote address. An explicit same-Wi-Fi action still offers local-only pairing independently of tunnel readiness. Route changes replace an unpaired QR without remounting the dialog or forgetting a newly connected phone. Stale QR responses are discarded; a QR missing the expected verified remote address is not shown as ready. A local-only QR already scanned from another network requires a new scan. A lightweight 15-second interface check announces changed local addresses; it reads no conversation history and spawns no commands.

Paired Android clients verify remote identity and authentication before saving new routes. They retain one pairing while switching Wi-Fi/cellular routes. A changed Quick Tunnel URL cannot reach a phone that is already away and only knows the old URL; reconnecting on Wi-Fi refreshes it, or an optional named domain provides a stable address.

## Android Remote Cloudflare Tunnel

Android Remote may supervise `cloudflared` as an optional sidecar after its gateway is listening.
Quick Tunnel is the persisted default and produces a temporary `trycloudflare.com` URL; Named Tunnel
uses a user-owned hostname and a connector token kept exclusively in the operating-system credential
store. Supported managed binaries are version-pinned and SHA-256 verified before execution. Named
Tunnel passes its token through the child environment, never command arguments, logs, QR diagnostics,
or management responses.

`src/android-remote/cloudflare-provisioning.ts` owns automatic Named Tunnel setup through Cloudflare's
fixed HTTPS API. Discovery accepts a one-time scoped API token and returns bounded account/zone DTOs.
Provisioning requires a dashboard-session-authorized Connect click, accepts only one subdomain inside
the selected active zone, creates or reuses only an exact Remodex remote configuration, refuses to
overwrite an existing DNS record, and installs a proxied CNAME. Its ingress is exactly the Android
gateway plus a final `http_status:404` catch-all. The API token exists only in browser/request memory;
it is never persisted, logged, returned, placed in QR data, or passed to a process. Failed new
resources are rolled back where Cloudflare makes that possible.

Both modes target only `http://127.0.0.1:10105`. Neither the main Remodex listener nor the private
Codex app-server listener is a tunnel origin. A discovered/configured public URL remains unpublished
until its `/healthz` response identifies `opencodex-android-remote` and its environment descriptor
matches the expected instance. Verified URLs then enter pairing payloads and revisioned
`remodexMobileConnectionUpdated` server-config events; failures degrade to bounded public reason codes.
`cloudflared` startup prechecks are advisory rather than lifecycle authority: some releases (including
2026.5.2) can report `hard_fail=true` and still register healthy edge connections seconds later.
Remodex disables that redundant startup gate because its stricter public identity checks are authoritative, keeps
the child alive if an override still emits the diagnostic, gates all public checks (including manual
dashboard checks) on its first registration, continues checking a known URL, and retries an exited child with capped
backoff. HTTP/2 is the initial desktop transport to avoid a slow automatic QUIC fallback; if it
cannot register within the bounded startup window, the next attempt uses QUIC, and whichever
protocol reaches the edge remains preferred. A LAN preference change rebinds only the gateway listener and retains Codex state, pairing credentials, and cloudflared. A transient restart-time network result cannot leave
either tunnel mode permanently stopped or require a manual retry.

Registration is necessary but not sufficient for public readiness. Checks share one in-flight
request pair per child and bound headers, bodies, and any diagnostic DNS lookup together. A DNS
failure is represented by `checking/activating`, including after prior readiness; it cannot trigger
connector replacement. Ambiguous fetch failures use a bounded OS lookup to confirm DNS failure
without switching resolvers or relaxing TLS/instance identity validation. Background setup never changes system DNS, clears the OS DNS cache, or opens an elevation prompt. Stale child results do not publish after stop or replacement.

A running Quick Tunnel is retained through failed health checks, including a Wi-Fi outage. Its URL may change only after connector exit, explicit restart, or a route-configuration change; checks alone cannot establish that a live connector needs replacement.

Public routes require two HTTP 200 responses and verified identity. A ready opted-in LAN connection independently enables pairing while public verification continues. Loopback addresses never enable phone-facing readiness. The dashboard retains a local QR during remote changes; a remote-only QR is invalidated when public readiness or its address changes.

## Android Remote model catalog and task selection

Remodex is the catalog and routing authority for Android Remote. The gateway merges the current
Codex catalog with enabled Remodex providers, applies Remodex's canonical reasoning-capability
metadata when a stale Codex `model/list` response is incomplete, and sends only presentation-safe
model/capability fields to Android. Provider API keys, OAuth state, environment-variable names and
values, headers, and raw provider configuration never enter the Android protocol.

Reasoning projection follows the same five-state contract as the router. Exact effort controls
render only their validated levels; binary models render Off/On; automatic models render status
without a selector; unsupported and unknown models render no reasoning selector. Canonical state
always outranks a stale Desktop ladder, so a cached `model/list` row cannot bring removed or
fabricated levels back onto Android.

Codex skills and installed plugins are machine-wide runtime capabilities, not properties of the
upstream model provider. The gateway reads each catalogue once and projects the same bounded,
presentation-safe arrays onto every routed provider row. Android also aggregates and deduplicates
those arrays across rows, preferring the selected provider first, so older gateways that attached
the catalogue only to the OpenAI row remain compatible. `$` search and the Plus menu therefore keep
working when a task selects `codex-lb`, Cursor, Anthropic, or another Remodex route.

Per-task provider/model/options live in the durable `taskSelections` ledger in
`src/android-remote/store.ts`. Entries bind Android and native Codex thread IDs and carry a monotonic
revision, source, update ID, and timestamp. Android writes use expected revisions; stale concurrent
writes receive a conflict, while repeated update IDs and Desktop echoes are idempotent. Only the
allowlisted execution options (`reasoningEffort`, legacy `effort`, and `serviceTier`) persist.
Credential-shaped or unknown option fields are discarded before storage.

Provider and model form one identity. Android stores the canonical Remodex selector scoped to
that provider; explicit Desktop provider metadata takes precedence over bare model-name matches.
For a direct Desktop provider, settings, turn starts, collaboration settings, and follower display
snapshots translate to that provider's upstream model ID. Desktop follower actions translate back
to qualified Remodex selectors before reaching the private app-server. Source visibility also
filters stale native catalog entries and does not create an empty ChatGPT provider group.

Android picker changes remain in the phone's composer until Send. The send command captures the
provider, model, reasoning effort, and tier together; the owning connection applies them when the
turn starts. Queued turns retain their own submitted snapshot. Commands without an explicit
selection fall back to the durable ledger. Official and legacy `thread/settings/updated`
notifications flow back into that ledger, but cannot clear an unsent phone draft. A
Desktop-originated update is projected to Android but is not echoed back to Desktop. Deletion
removes the associated selection. The ledger survives gateway/runtime restarts and alias migration.
Every catalog refresh and turn revalidates a stored reasoning choice against the current canonical
row: effort models retain only an advertised level, required effort models select their validated
default/lowest level, legacy non-Off toggle values normalize to On, and automatic, unsupported, or
unknown states remove the saved effort. An absent choice remains provider-owned Auto; no generic
`medium` tier is invented.

Committed provider additions, removals, edits, visibility changes, custom-model changes, and context
cap changes call `notifyModelCatalogChanged()`. That invalidates the gateway's catalog/config cache,
resets provider refresh timing, and schedules an immediate revisioned push to connected phones.

Cold-start empty configs and failed catalog refreshes use a short 1.5-second gateway cache.
Android retries an empty model catalog while connected and foregrounded, with backoff capped at
30 seconds and no fixed attempt limit, so recovery outlives upstream discovery's failure cooldown.
A changed catalog from the provider refresh also invalidates the config cache before publication.

## Android Remote Codex app-server recovery

On Windows, automatic Android runtime selection uses a verified executable from the single
installed Desktop build under `LOCALAPPDATA/OpenAI/Codex/bin`. A saved CLI runtime selection does
not pin Android to an obsolete Desktop build; only an explicit `CODEX_CLI_PATH` environment
override remains authoritative and must match Desktop. Android's selection never rewrites the
saved CLI choice. Ambiguous installations or environment-pin mismatches fail with repair guidance.
The initialization response verifies the actual
connected server version, including an already-listening sidecar; no history mutation is sent
through a mismatched peer. This is a conservative version-parity gate, not a claim that every
pair of different versions is incompatible. Other platforms keep the normal runtime resolver.

Version discovery runs in a bounded, hidden helper process, and the Windows task-server launcher
is asynchronous, so slow executable probes or PowerShell startup do not block the main listener.
Selection is performed when establishing a connection, never to replace a healthy live connection
during active work. A failed optional Android gateway startup is retried every 30 seconds after
the previous attempt settles. Ready/starting gateways are left alone, disabled settings are
respected, and shutdown cancels retries before stopping the gateway. This recovery never restarts
the main Remodex server and does not infer that a remote-network failure is a local-server crash.

Selected-task activity verification uses the append watcher's active turn, matching Stop/steer
routing rather than probing the secondary Windows reader during quiet commands. Fresh items for
that exact open turn repair a stale idle projection; dated terminal records and cleared/changed
watcher turn ids prevent old item echoes from reviving completed work. A fresh live projection
also supersedes a same-turn, undated secondary-reader interruption. File-edit wrappers retain
their edit label when they subsequently poll a running command.

Stale rollout markers used for shell/notification status are verified independently
against the current owner. A watcher replaying that same unfinished `task_started`
record cannot verify itself. Owner reads are cached briefly and request fresh
Desktop state when the cache expires; confirmed long-running work stays active,
while an unavailable/idle owner leaves the existing unverified state rather than
inventing a completion. Stop/steer continues to use exact live watcher boundaries.

`AndroidCodexRuntime` exposes one stable logical client to the Android gateway while owning the
replaceable loopback Codex app-server WebSocket underneath it. When that socket or an owned app-server
process dies, the next operation reconnects or respawns it through a single shared startup flight.
Logical notification subscriptions remain attached and are rebound to the replacement socket, so an
already-authenticated phone does not need a new QR code, access token, or WebSocket session.

Disconnect retries are delivery-aware. Requests that failed before being written may retry once, and
bounded read methods such as config, model, thread, skill, plugin, and filesystem reads may retry
after an uncertain disconnect because they are idempotent. Mutating requests such as `turn/start`,
steer, rollback, settings changes, approvals, and user-input answers are never replayed after an
uncertain delivery; this prevents recovery from duplicating prompts or actions.

## Android Remote mutation identity and acknowledgement

Shared task model selections preserve the provider instance, model selector, reasoning, and service
tier together. A direct Desktop provider constrains Android's advertised choices and request-time
validation before draft creation, metadata updates, queue acceptance, and turn dispatch. Managed
Remodex connections preserve distinct provider namespaces; identical model labels never imply an
interchangeable route. Provider visibility does not rewrite existing selections. Desktop connection
changes invalidate the Android catalog cache, and model discovery is not authentication evidence.
Routed-provider capability metadata owns reasoning and explicit service tiers; live native metadata
remains the native fallback. Explicit null effort/tier updates clear previous settings, while absent
fields in partial Desktop notifications retain the existing choice for the same model.

Writer ownership is a transport detail, not a restriction on Android controls. Ordinary sends to
idle tasks use the already-mounted connection; running tasks queue normal sends or accept explicit
steering. An explicit active-writer rejection permits bounded owner rediscovery and redelivery of
the same client-message id. Stale local mirrors are released, stale renderer ids are refreshed,
and `thread/loaded/list` can prove a retained private writer without another `thread/resume`.
Recovery never deletes writer locks, replaces an authoritative Desktop owner with an unverified
private writer, or retries an ambiguous turn-start timeout. Unavailable routes keep ordinary sends
in the durable queue with capped retry backoff. Recovery queue delivery records an uncertain marker
before dispatch; after a disconnect or restart it reconciles exact message-id evidence rather than
replaying. Prompt edits are excluded from this retry because rollback may already have happened.

Android sends, atomic prompt edits, and queued-message steer conversions use one stable command id
and client message id from the phone through Remodex and Codex Desktop IPC. Remodex serializes
these mutations per logical thread and records bounded delivery metadata in the owner-only
`android-remote-mutations.json` state file. The ledger stores ids, one-way payload fingerprints,
owner route, status, and result sequence only; it never stores prompt text, attachments, image data,
credentials, or provider configuration.

An accepted command is idempotent across gateway and service restarts. A pending or uncertain
command is reconciled against authoritative Codex history and a fresh Desktop follower snapshot.
An exact durable client-message id proves ordinary send/steer delivery. A legacy atomic edit may
also be accepted when the original target turn disappeared and the replacement visible-text hash
is present. If neither source proves delivery, Remodex does not replay the mutation through a
different writer. The phone keeps its optimistic row while state refreshes instead of converting an
unknown acknowledgement into a duplicate prompt.

The Android transport applies the same rule at its outer boundary. A post-write WebSocket close,
HTTP connection failure, or mutation acknowledgement timeout is classified as uncertain rather than
as a definitive rejection. The selected-task socket is invalidated so a later command cannot reuse
an ambiguous owner route, and the reconnect obtains a fresh authoritative snapshot. Android does
not restore the same prompt into the composer or roll back an optimistic queued steer while that
reconciliation is pending. Explicit server rejections remain definitive and may restore the draft.

The Android transcript cache is presentation-only. It may accelerate cold start, but it does not
restore command ownership, prompt-edit intent, dispatch responsibility, queued execution, or a
running state. A terminal missing-target edit clears only the matching edit intent before restoring
the text as an ordinary draft.

[Decision Log]
- 목적과 의도: Keep LAN, Quick Tunnel, and Named Tunnel Android sessions usable when model synchronization or an external process terminates Remodex's private Codex app-server.
- 기존 구현 및 제약 조건: The runtime cleared its internal socket after close, but the gateway retained the original client and notification subscription indefinitely. Re-pairing could not repair that stale in-process reference.
- 검토한 주요 대안: Restart the whole packaged Remodex service; close every phone WebSocket and force re-pairing; make every gateway call acquire a new raw socket; expose a stable recovering logical client.
- 선택한 방식: Keep one logical client per runtime lifecycle, replace only its private raw socket through a concurrency-safe connection flight, and preserve subscribers across replacements.
- 다른 대안 대신 이 방식을 선택한 이유: Phone credentials and public transport were healthy, so restarting them expanded the failure surface. A stable client fixes every gateway caller at one lifecycle boundary and avoids duplicate listener registration.
- 장점, 단점 및 영향: Existing phones recover without user action and concurrent config/shell reads create only one app-server process. A mutating request whose delivery became uncertain still fails visibly instead of being replayed, requiring the user to retry after state refresh.

## Android prompt paging and Work details

The selected transcript opens completed history with ten user prompts and
prioritizes one newest turn while running. Android fills the remaining recent
prompt window independently of live updates. Question replies remain with their originating prompt; ordinary steering
messages count as prompts. Tool counts do not determine the
outer history boundary. A recovered turn without a retained user prompt counts
as one history entry, so incomplete saved transcripts remain bounded. Live
bootstrap includes the whole active turn, including its steering messages; queued
follow-ups remain visible independently of the history window. Older history uses ten-prompt pages and is prefetched
when the reader approaches the oldest two loaded prompts; only one history
request is in flight. Native stable row keys preserve the reader's current
position; request-time scroll anchors must never be restored after a response.

Completed Work bodies are represented by revisioned disclosures in snapshots
and older pages. Expansion reads up to 100 work entries (512 KiB target) through
`orchestration.getTurnWork`; further entries use a turn/revision-bound cursor.
Live work continues through ordinary events. Hydrated Work survives a matching
compact snapshot. Question activity removals use keyed tombstones instead of
replacing the transcript, and bounded owner reads retain fetched prefixes and
missing in-flight messages. Explicit history rewrites remain authoritative.

## Android Remote thread reconciliation and live convergence

A Codex thread ID is the logical Android task identity. A rollout JSONL path is only one physical
history source: resume, revert, archive, migration, and history repair may leave several active or
archived rollout rows with the same thread ID. Android must therefore canonicalize `thread/list`
before aliasing or projection. It emits one row per ID, prefers a non-archived row, orders and labels
the row by Codex `recencyAt` (`recency_at` on the request), and retains every known rollout path for
history recovery. Migration-mutated `updatedAt` is not conversation recency.

On Windows, even successful bounded native history pages are checked against verified rollout
discovery. Multiple verified sources or a newest source different from native metadata select
session recovery with local paging, retaining native items in the merge and dropping native cursors.
Nonempty single-source Windows tasks and other platforms retain native paging. An empty Windows
native page instead recovers saved messages. A verified single-source file without a history parent
uses a 2 MiB recent tail before a coalesced background full read; older-page requests join that read.
The initial local cursor anchors the first recovered block. Unexpected empty refreshes preserve
already projected messages; explicit history edits can still clear them. Metadata header reads use
explicit positional bounds because Bun sliced reads can overrun on Windows. Discovery uses the same
Codex home as the recovery reader when a custom reader provides source resolution.

Across platforms, private developer/system response records (including image resize notices) do
not break the pairing of a public user response with its following client-id event. Public messages
and turn boundaries still flush that pending pair. Persisted `local_image`/`local_audio` content
types normalize to the public `localImage`/`localAudio` types during history recovery. Attachment
echo reconciliation keeps the durable client id and never merges two different explicit client ids.
The shared public-text boundary also hides Windows `external_codex_apps_open_page` context
records before recovery or live projection can treat them as user prompts. Response annotation
directives are removed outside code examples so native phone rendering receives readable text.

Live session replay and saved history use `desktop-thread-item.ts` for the same structured item
conversion. `item_started`/`item_completed` events publish public tools immediately, including
additional tools inside code-mode wrappers. A single inferred wrapper row is replaced by the first
canonical tool, with its position retained; later polls of an existing command do not add tools.
Structured assistant/reasoning echoes retain their ids and private compaction answers stay hidden.
Initial replay advances only through a complete newline, retaining partial UTF-8/JSON records for
the next append. File truncation/replacement resets the projector and requests a bounded history
refresh. A superseded turn's delayed completion cannot clear the current turn. All of these paths
stay in-process: no shell polling, extra server processes, or shorter history polling intervals.

`thread/read` is not the sole history authority. If it is truncated, stops at an interrupted
continuation boundary, or reports a listed thread as missing, Android recovery scans only matching
rollouts inside Codex `sessions` and `archived_sessions`, merges their turns chronologically, and
uses durable structured `item_started` / `item_completed` events to recover messages, activities,
file changes, plans, images, compaction, and terminal state. A later completion overrides an older
interruption for the same turn. One unreadable or concurrently moved rollout does not discard the
other recoverable history.

When `session_meta.history_base` exists, recovery uses a single proven parent chain instead of
the legacy chronological merge. Only a unique leaf or an explicit native leaf path selects a
branch; timestamps cannot choose between siblings. Each parent is read through the child's
`end_byte_offset` only, and ordered replay applies rollbacks across inherited turns. Explicit
physical-parent lookup can reach ancestors outside the 16-file discovery window or under a
different logical thread id, while retaining canonical path containment and metadata checks.
Missing/ambiguous parents, cycles, invalid cutoffs, oversized records, and concurrent rewrites
keep the native snapshot with a visible incomplete-history warning, including
while a task is running. No saved history is rewritten.
Bounded metadata caches and a single composed-history cache avoid repeated whole-file replay
while source identity, size, and modification time are unchanged.

The selected-task watcher follows the canonical rollout path when Codex continues a thread into a
new file. Live shell, task, and config subscription groups refresh independently; a failure in one
group cannot suppress the others, and bounded retries converge connected phones without requiring a
new QR code or application restart. Recent saved assistant/tool work keeps an open
`task_started` marker fresh. If that evidence grows old, an inactive or unavailable owner
probe presents a session connection error, not an invented interruption or Resume action;
the internal running marker/turn id is retained for command ownership safety. Confirmed private
owners are probed through the private runtime, not the Desktop follower. Staleness is measured
from the activity marker or later saved work, never from an unrelated thread metadata refresh.
A same-turn native interrupted snapshot without an end time can be superseded by newer saved
work after its lifecycle timestamp. Dated terminal states, completed replies, and later turns
still win; uncertain activity does not override native terminal state.

An Android alias is removed as a ghost only when `thread/read` conclusively says the native thread is
absent and no cached metadata, matching rollout, or recovered turn remains. This is intentionally
stricter than removing a row after a transient read, reconnect, archive move, or service restart.

[Decision Log]
- 목적과 의도: Keep Android sidebar identity, recency, Running/Completed state, and full transcript aligned with Codex Desktop across continuation rollouts and reconnects.
- 기존 구현 및 제약 조건: The gateway treated each list row/path as a separate task, trusted one `thread/read`, silently dropped refresh failures, and could retain stale running markers or remove recoverable tasks.
- 검토한 주요 대안: Trust only the newest list row; migrate rollout files into one file; poll the whole history continuously; reconcile logical IDs and recover only at the Android projection boundary.
- 선택한 방식: Canonicalize by thread ID, preserve bounded physical sources, merge durable rollout events, switch watchers at continuation boundaries, and retry failed subscription groups.
- 다른 대안 대신 이 방식을 선택한 이유: Codex owns its rollout lifecycle and Android must not rewrite it. Boundary reconciliation preserves Desktop behavior while giving the phone one stable logical task.
- 장점, 단점 및 영향: Duplicate/ghost rows, false Running state, wrong timestamps, and truncated completed tasks converge automatically. Recovery performs bounded local reads and keeps exact-path containment, cache, and record-size limits.

## Provider diagnostic outbound safety

Provider connection tests and live model discovery share the GET-only provider outbound wrapper.
Direct HTTP(S) resolves once and pins the validated address; HTTPS preserves the original Host/SNI
and always verifies certificates. Proxy-configured requests stay on Bun fetch so HTTP(S)_PROXY,
ALL_PROXY, and NO_PROXY semantics remain authoritative. The wrapper classifies successful local DNS answers, but
only a typed DNS-resolution failure degrades to proxy resolution; every literal, metadata, and
resolved-address policy error still rejects. Proxy mode logs once that the proxy-selected peer
cannot be pinned. Private destinations additionally require allowPrivateNetwork plus NO_PROXY.

Both paths reject redirects and expose only credential-stripped final-address guidance. This phase
does not cover ordinary requests, streaming, retries, or per-hop redirect review on those paths.
Caller-owned `provider.fetch` executors are also deferred: they receive literal/config checks and
redirect blocking, but cannot inherit DNS classification or peer pinning without a verified-peer
executor contract. Main-request migration must not treat that branch as fixed-transport equivalent.

## Responses HTTP/SSE

`/v1/responses` is the main Codex-facing endpoint. The server parses Responses input, routes to a
provider, lets the selected adapter speak the upstream protocol, then bridges adapter events back to
Responses-compatible streaming output.

The option-aware `openai` provider uses `openai-responses` with `authMode: "forward"`. Pool mode
resolves main plus added accounts through affinity/quota/cooldown ownership; Direct forwards only
the allowed Codex/OpenAI auth/session headers from the current request and short-circuits pool
state. `openai-apikey` uses its configured key and canonical API base URL. Missing credentials fail
within their route; neither route falls through to the other. See
[`08_openai-provider-tiers.md`](08_openai-provider-tiers.md).

`POST /v1/responses/compact` handles remote compaction v1 before the generic `/v1/responses` branch
and before the `/v1/*` guard. Unknown `/v1/*` paths return JSON 404 errors instead of falling through
to GUI static serving.

### Passthrough SSE stream shapes (#314)

Native passthrough SSE has TWO shapes, selected per request in
`src/server/responses/core.ts`:

- **Default outside Windows: tee + background inspection.** `upstreamResponse.body.tee()` sends
  branch[0] through a terminal-aware client relay while branch[1] is
  drained eagerly by `consumeForInspection`/`consumeForResponseLogMetadata`
  for terminal-outcome recording, quota, the passthrough continuation cache,
  and request logs. This remains the default shape on bundled Bun 1.3.14.
- **Terminal-aware eager bounded relay** (`src/server/relay-eager.ts`). Windows
  uses this single-reader shape for rewrite traffic and for no-rewrite traffic
  selected by `selectEagerPath` in `src/lib/bun-stream-caps.ts`; the latter keeps
  `legacy-tee` and known-bad-runtime `auto` on tee as documented. When selected,
  `response.completed` closes the client stream even if upstream keeps HTTP/SSE
  alive. Darwin uses it for no-client-rewrite traffic only (neither image-gen
  aliases nor item-id repair) and is explicit-only: `auto` stays tee even after
  a future threshold bump. One eager reader + byte-bounded
  client queue + post-cancel bounded discard-drain replaces the tee and goes
  directly to the response without a JS rewrite wrapper, preserving the full
  inspection side-effect set (shared `createSseInspector` factory in `relay.ts`)
  including the #44 late-terminal semantics.

The two-shape contract is mirror-commented in `src/server/index.ts`; the real
`core.ts` gate is source-invariant-tested by `tests/passthrough-abort.test.ts`,
and the platform matrix lives in `tests/bun-stream-caps.test.ts`. Keep all three
in lockstep with any passthrough-policy change.

Translated response request-log tracking and the heartbeat relay also reuse
`createSseInspector`. This keeps every client-facing SSE observation path on
the same byte-bounded, discard-and-resynchronize frame policy and ensures the
request-log, first-output, and terminal observers share one payload parse.

## Standalone Search and exact account selectors

`POST /v1/alpha/search` retains the selected model in its request body. When that value is an
account-qualified native selector, the server resolves the public namespace, uses only the mapped
stored Codex credential, and sends the bare native model upstream. That exact path is fail-closed:
it does not consult Pool active state or affinity when selecting, and its outcomes cannot rotate
the active Pool account. An account-wide credential failure still quarantines that credential and
clears stale ordinary Pool affinities so they cannot reappear after reauthentication. Quota and
transient outcomes from an exact request leave Pool affinities untouched. Ordinary search requests
keep the normal Direct/Pool sidecar behavior.

Standalone Images and Live requests currently carry neither the account-qualified model selector
nor a trustworthy thread correlation from the Codex client. They therefore retain normal provider
routing. Do not infer an exact account from caller-supplied account headers, process-global last
selection, connection identity, or other ambient state; concurrent threads could cross-route
credentials. Extending exact routing to those endpoints requires an opaque client correlation that
can be bound server-side to a previously validated selector.

## Standalone Images

Codex's local `image_gen.imagegen` tool makes a second Images request after the model calls it:
`POST /v1/images/generations` for generation or `POST /v1/images/edits` for reference-image edits.
These are standalone Images API routes, not the hosted Responses `image_generation` tool.

`src/server/images.ts` uses the existing ChatGPT/OpenAI fallback unless `images.provider` explicitly
selects a custom API-key `openai-responses` provider. Explicit selection fails closed when the
provider is missing, disabled, registry-managed, incompatible, or lacks a usable key; it never
falls through to another paid upstream. The relay accepts bounded JSON generation and edit requests,
then forwards the decoded JSON without rewriting Codex's edit schema. Each paid Images POST receives
one upstream attempt; client cancellation aborts the upstream and pool-only failures update the
existing account-health state. Unknown Images subpaths still reach the JSON `/v1/*` 404 guard.

When the OpenAI credential path is unavailable or its authentication fails, `generations` (not
`edits`) may fall back to Google Antigravity if that provider is logged in. The fallback is
credential-driven: it exists so an image request reaches a real upstream answer rather than dying on a
local credential error, and it does not apply when the caller selected an explicit keyed custom
provider, because a configured pool owns its own authentication failure rather than hiding it behind
separately billed generation.

On non-loopback binds, data-plane authentication and origin policy cover both Images routes. An
explicit keyed Images provider accepts the proxy admission secret as either an OpenAI-style bearer
or `x-opencodex-api-key` because the provider key replaces caller authorization before fetch. The
ChatGPT forward path still requires the dedicated header so its upstream bearer remains distinct.

The API-key `openai-responses` path also adapts Codex's private standalone image tool to the public
Responses tool surface. A complete `image_gen` namespace is lowered to safe
`image_gen__<inner-name>` function aliases even when no hosted image tool is present, because public
Responses runtimes may reserve the namespace itself and reject dotted function names. Native and
legacy dotted calls replayed in `body.input` are encoded to the same aliases. When any client
image-gen declaration is replaced by a usable `image_gen__<inner-name>` alias, the adapter also drops
hosted `image_generation` and deduplicates aliases in stable container order. Empty or malformed
namespaces do not remove the hosted fallback. Discovery and normalization span both top-level
`body.tools` and Codex Desktop Responses Lite `input[].type = "additional_tools"` containers.

For a model explicitly listed in `modelPreferHostedTools`, a non-forward Responses provider may opt
to remove colliding client `image_gen` declarations before this normalization and rewrite their
selectors to hosted `image_generation`, so a provider-reserved hosted tool takes precedence without
loosening a caller's tool-choice restriction. The opt-in is intentionally model-scoped: the default
alias path remains safest for ordinary public Responses endpoints.

For OpenAI API virtual `-pro` models, preference lookup checks the selected public ID first and
uses the resolved base wire-model ID as a fallback. `modelAdapters` resolves the public ID first and
the base ID second; the second pass selects the final adapter, and configuration validation mirrors
both steps.

Client-facing API-key responses perform the inverse mapping: JSON output and SSE function-call
items restore `{ namespace: "image_gen", name: "<inner-name>" }` so Codex can dispatch the local
extension. When item-id repair is also enabled, both transforms compose in one SSE parse/stringify
pass (`src/server/sse-payload-rewrite.ts`) rather than chaining separate JS pull wrappers.
Inspection and continuation-cache branches keep the raw upstream alias, allowing stored
replays to return upstream without leaking a client-only namespace shape. Malformed, empty, and
unrelated namespaces remain untouched. ChatGPT forward mode preserves the private namespace and
hosted tool because that backend understands their native semantics.

Per-model `modelReasoningSummaryDelivery` is a narrow compatibility layer for
`openai-responses` gateways whose summary capability is real but whose accepted delivery enum
differs from Codex. Presence advertises reasoning summaries in the routed catalog and rewrites only
an already-present `stream_options.reasoning_summary_delivery` at the adapter boundary. It never
injects summary generation into a request, and config validation rejects a delivery map that
conflicts with `modelSupportsReasoningSummaries: false` for the same model.

[Decision Log]
- 목적과 의도: Preserve Codex Desktop reasoning summaries while adapting only the delivery enum rejected by a specific Responses-compatible upstream.
- 기존 구현 및 제약 조건: The existing boolean capability either passed Codex's enum unchanged or disabled summaries entirely; stale running clients can keep sending the old enum after a catalog refresh.
- 검토한 주요 대안: Disable summaries; rewrite the enum globally; inject a delivery field when absent; configure a provider-wide value.
- 선택한 방식: Use a validated per-model allowlisted map, imply summary capability for that model, and rewrite only a caller-provided delivery field at the Responses adapter boundary.
- 다른 대안 대신 이 방식을 선택한 이유: Upstream enum support differs by model and provider, while global rewriting or injection would change unrelated requests and disabling summaries removes Desktop UX.
- 장점, 단점 및 영향: Configured models retain the native summary UI and stale clients self-heal; each incompatible model needs an explicit map entry and contradictory opt-out configuration now fails closed.

## Claude Desktop config-library resolution

The Desktop profile writer and the management status probe share
`resolveDesktop3pConfigLibraryPath`. The resolver reproduces Desktop's own rule rather than a guess:
an explicit `CLAUDE_USER_DATA_DIR` (or the Remodex override) wins; on Windows
`%LOCALAPPDATA%\Claude-3p` wins; otherwise the Electron user-data path gains a `-3p` suffix if it
does not already have one. `configLibrary` is appended to that root.

`Claude-3p` is Desktop's real directory name, assembled at runtime from `"Claude" + "-3p"`, which is
why searching the app bundle for the literal string finds nothing. It is not a legacy path to migrate
away from. Resolution stays a pure function of (env, platform, home) so the Windows branch is
testable on any host: stubbing `process.platform` does not propagate to `os.platform()` under Bun.

[Decision Log]
- 목적과 의도: 생성된 Claude Desktop 프로필이 설치된 Desktop이 실제로 읽는 디렉터리에 떨어지고, 대시보드 상태가 그 쓰기 대상과 일치하게 한다.
- 기존 구현 및 제약 조건: 두 호출자가 경로 계산을 각자 복제했고, Desktop이 실제로 참조하는 `CLAUDE_USER_DATA_DIR`와 Windows `LOCALAPPDATA` 분기가 빠져 있었다(#539). 사용자가 프로필 루트를 직접 지정하는 경우도 있다.
- 검토한 주요 대안: `-3p` 접미사를 구버전 잔재로 보고 제거; 두 디렉터리를 모두 스캔; 레거시 파일을 자동 이전; 크로스플랫폼 해석기를 한 곳에 둔다.
- 선택한 방식: Desktop 번들의 해석 규칙을 그대로 이식한 override 인지 해석기를 한 곳에 두고, 쓰기 경로와 상태 조회가 같은 함수를 쓴다.
- 다른 대안 대신 이 방식을 선택한 이유: `-3p`는 Desktop의 정상 동작이므로 제거는 회귀였다. 해석기를 한 곳에 두면 두 호출자의 드리프트가 불가능해지고, 파괴적 이전 없이 상태와 쓰기 대상이 일치한다.
- 장점, 단점 및 영향: 지원 플랫폼 전부에서 apply 결과가 Desktop에 보인다. 비표준 레이아웃 사용자는 문서화된 override를 써야 하고, 해석기는 Desktop 번들의 규칙 변경을 따라가야 한다.

## Cursor Native Exec

Cursor's experimental live transport can receive server-driven local read/write/delete/ls/grep,
shell, and fetch exec frames. These frames are denied by default because they bypass Codex's normal
approval and sandbox path. `nativeLocalExec: "on"` is the explicit config-owner opt-in for trusted
local experiments; `off` and the backwards-compatible `codex-sandbox` spelling both fail closed.
MCP, screen recording, and computer-use stay on their separate explicit executor/MCP config paths.

[Decision Log]
- 목적과 의도: prevent caller-controlled Responses text from authorizing Cursor native local shell, filesystem, or fetch execution.
- 기존 구현 및 제약 조건: the adapter preserved top-level `instructions`, system messages, and developer messages, then treated a `sandbox_mode ... danger-full-access` prose marker as an exec allow signal in `codex-sandbox` mode.
- 검토한 주요 대안: keep marker-based authorization, require a future trustworthy attestation channel, or restrict authorization to server-local config.
- 선택한 방식: keep marker detection only as diagnostic/context and make `nativeLocalExec: "on"` the only non-legacy mode that enables built-in local exec; unset, `off`, and `codex-sandbox` all deny.
- 다른 대안 대신 이 방식을 선택한 이유: Remodex has no trustworthy per-request sandbox attestation in request text or headers, so any prompt-carried marker is spoofable by data-plane callers.
- 장점, 단점 및 영향: this closes prompt-to-native-exec escalation while preserving an explicit operator escape hatch; existing configs that relied on `codex-sandbox` must switch to `nativeLocalExec: "on"` for trusted local experiments.

## WebSocket

The WebSocket endpoint exists at `/v1/responses`, but discovery is opt-in:

```json
{
  "websockets": false
}
```

`websocketsEnabled(config)` is true only for an explicit `true`. When false, Remodex removes
`supports_websockets` from injected provider tables and routed catalog entries, keeping Codex on
HTTP/SSE. When true, Codex may use Responses WebSocket frames handled by `src/server/ws-bridge.ts`.
If Codex still attempts a WebSocket upgrade while the feature is disabled, `/v1/responses` rejects
the upgrade with 426 so Codex falls back to HTTP cleanly.

The endpoint handles `response.create`, ignores `response.processed`, supports warmup
`generate: false`, and feeds the same request pipeline as HTTP/SSE.

Registry-declared per-model compatibility hints (`modelResponsesUpstreamStreaming`) may ask the
upstream Responses endpoint for bounded JSON on ANY client transport — WebSocket or ordinary
HTTP/SSE. The bridge reframes that JSON into the same Responses event sequence
(`src/server/responses-json-events.ts`): WS turns send the frames as WebSocket messages, while
HTTP clients that requested streaming receive a synthesized terminal SSE body (created →
output_item.done → terminal → `[DONE]`). No production registry entry currently opts in:
DeepSeek V4 Flash used this path while its public-beta Responses stream was suspected of not
closing on the terminal event, but the official guide documents a
`response.completed`/`response.incomplete`/`response.failed` terminal with no `data: [DONE]`
sentinel, and live probes (2026-08-07) confirm the stream closes on the terminal. The relay's
terminal-output boundary (`src/server/relay.ts`) cuts the stream at that event and synthesizes
`[DONE]` itself, so DeepSeek streams live again; the registry knob remains as a one-line
rollback for upstreams that regress, kept suite-reachable by a synthetic-registry fixture in
`tests/deepseek-inbound-wire.test.ts`.

`ws-bridge.ts` preserves upstream `failed` and `incomplete` status values in the final WebSocket
frame rather than always emitting `response.completed`. If the response status is `failed`, a
`response.failed` frame is sent; otherwise `response.completed` carries through the original status.

## Heartbeat and stall deadline

The HTTP/SSE bridge emits `response.heartbeat` events during upstream silence to re-arm Codex's idle
timer (Codex's default `stream_idle_timeout` is 300 s and ANY SSE event re-arms it). Those
bridge-enqueued keepalive frames do NOT count as activity for the bridge's own watchdog: a bounded
stall deadline (default 300 s, configurable via `stallTimeoutSec`, checked on the 2 s heartbeat tick)
closes the stream with `response.incomplete` / `upstream_stall_timeout` and cancels the upstream
request if no real adapter events arrive. Adapter-yielded `{ type: "heartbeat" }` events DO reset
the watchdog.

The web-search loop requests `stream: true` for every routed-model iteration, but buffers the events
needed to decide whether to intercept a synthetic search call. Text explicitly phased as
`commentary` is safe to forward live because it cannot terminate the turn; this keeps Kiro's
progress visible. A Kiro stream EOF after user-facing text or reasoning gets one bounded completion
retry, because neither the upstream text event nor `END_TURN` / `STOP_SEQUENCE` reliably distinguishes
progress from a final answer. Those two clean-stop reasons prove only that the inference ended; on a
tool-enabled turn, only the private completion tool authorizes `final_answer`. Any other explicit
reason already terminated the inference upstream and is reported as a terminal state rather
than converted into another model request: output-token limits become continuable incomplete output,
context-window exhaustion becomes a non-retryable `context_length_exceeded` error, filtering becomes
filtered incomplete output, and a `TOOL_USE` without an actual tool call is a contradiction. Since
the stop reason arrives only at the end of the stream, `required`-mode assistant text is held inside
the adapter until a real tool call starts or the stream ends, then released as `commentary` unless a
private completion call supplied the final answer. Each held event yields a `heartbeat` in its place
so the stall watchdog stays armed. Synthetic search calls, real tool calls,
and terminal events remain buffered until the iteration validates. Only the first iteration's final
response headers/status and any 429 key rotations are handled eagerly. A failure before downstream
SSE starts returns non-2xx JSON; once headers have started the final response, a generation failure
is emitted as `response.failed` SSE.

Kiro transient HTTP 429 recovery is coordinated process-wide after the first throttle: healthy
traffic remains parallel, but throttled followers wait behind one abort-aware probe and share a
deadline that is re-checked after every sleep. Event-stream `ThrottlingException` records the same
deadline for the next client replay. Retries are bounded to three attempts; hard quota responses and
ordinary 5xx errors are not replayed. Completion fallback rebuilds only replayable text, preserves
the original user/tool-result turn for reasoning-only attempts, supplies neutral non-empty carriers
for empty tool output, and validates role alternation plus tool-use/result pairing before transport.

Provider-level `retryOn429` (devlog 260802_429_same_target_retry) is the generic, opt-in
same-target 429 retry for API-key providers (`authMode: "key"`), primarily single-key pools
that cannot use multi-key failover. In the pre-stream recovery loop, a 429 waits (`Retry-After`
or the fixed interval, capped at `maxIntervalMs`) and replays the identical request on the same
key before any failover, up to `attempts` extra times per request (the budget lives outside the
recovery loop, so a 413/401 replay cannot re-arm it). The same wait-and-replay applies to every
other key-auth surface that bypasses that loop: the Responses passthrough wire (e.g. the
built-in DeepSeek preset), the image/video bridge and web-search sidecar loops (before their
`on429` key rotation), and Anthropic terminal-guard continuations (before key/account
failover). The policy covers HTTP-capable adapters only: custom `runTurn` transports in the
image loop run through an event queue and never receive an HTTP status, so they are outside
the HTTP retry scope and cannot replay a 429. Codex never retries 429 client-side (openai/codex#30471), so this is the only
defense for those providers; the final 429 still carries `Retry-After` for clients that honor
it. Concurrent requests each honor their own policy — there is no process-wide shared cooldown
(unlike the Kiro pattern), so a rate-limit storm multiplies upstream volume by at most
`attempts + poolKeys` per request (same-key replays, then failover keys; the pool size is the
operator-configured `apiKeyPool` length, fixed for the duration of the request). Every surface
releases (and awaits the cancellation of) the unread 429 body before the backoff, records the
`rate-limit-429` recovery kind on replay sends, and the bridge loops clear the old
response-header deadline before the wait and start a fresh one afterward — client cancellation
is re-checked after the wait, so 499 always wins over a stale-deadline edge, and backoffs never
consume the connect budget or surface as a 504. The wait is abort-aware:
once the server observes the client disconnect (Bun propagates it asynchronously, observed
1–10 s), the sleep is interrupted, the unread 429 body is released, and the request is
cancelled with 499 before any replay; because the propagation is async, a replay may precede
the cancel if the interval elapses first (bounded by the same `attempts` budget).

[Decision Log]
- 목적과 의도: Prevent Kiro progress from becoming a false final answer, reject invalid empty completion retries, and stop concurrent transient 429s from consuming independent retry budgets.
- 기존 구현 및 제약 조건: Kiro text has no trustworthy phase; stop metadata arrives only at stream end; the private completion tool is adapter-owned; normal parallel tool traffic must remain parallel; client cancellation must interrupt all waits.
- 검토한 주요 대안: Trust native `END_TURN`; infer completion from wording; serialize every Kiro request; leave throttling entirely to the client; manufacture empty assistant turns to preserve alternation.
- 선택한 방식: Require the private completion tool on tool-enabled turns, rebuild only valid replayable wire turns, validate the final conversation, and activate a shared cooldown plus single probe only after a transient throttle.
- 다른 대안 대신 이 방식을 선택한 이유: Native stop metadata has mislabeled progress, wording is language-dependent, global serialization harms healthy concurrency, client-only retries amplify bursts, and empty structural turns are rejected upstream.
- 장점, 단점 및 영향: Completion phase is deterministic and throttled concurrency recovers without a request storm; some clean Kiro stops pay one bounded validation call and an exactly repeated completion answer may be shown twice to preserve `final_answer` semantics.

Historical `web_search_call` output items from previous Responses turns are not converted into
assistant text. They are UI/search-cell evidence, not a replayable search result payload; turning
them into strings risks routed models echoing an internal marker or implying a current search ran
when the sidecar is unavailable. The active sidecar path is the only place that emits new
`web_search_call_begin` / `web_search_call_end` events.

Four independent clocks bound this path. `stallTimeoutSec` is the base bridge event-stall budget.
`connectTimeoutMs` (default 200 s) covers only DNS/TCP/TLS and the wait for final response headers,
not response-body generation. Config-file-only
`webSearchSidecar.routedModelStallTimeoutMs` (default 200 s, integer 1..2147483647) bounds continuous
raw response-byte inactivity for a routed-model iteration and resets on every non-empty byte.
`webSearchSidecar.timeoutMs` (default 60 s) separately bounds one hosted search request (lowered
from 200 s so an unavailable/limit-exhausted search backend degrades within ~1 min instead of
hanging the whole turn, #398). The
effective web-search bridge watchdog is
`max(base stall, connect timeout, routed-model stall, sidecar timeout) + 30 s` (230 s at defaults,
dominated by the routed-model stall clock),
with seam heartbeats between bounded units. None of these clocks is a total generation deadline.

## Reasoning and tool-result compatibility

Native OpenAI passthrough sanitizes routed reasoning history so `reasoning` input items do not send
non-empty `content` arrays to upstream models that reject them. Chat Completions bridging repairs
orphan `toolResult` messages by inserting a synthetic assistant `tool_call` before tool messages.
It also repairs the opposite direction (260718): an assistant `tool_calls` round left dangling —
by an intervening user/developer barrier or an interrupted turn — is closed by deferring barrier
messages until the round completes, reattaching real results to their original call occurrence,
and synthesizing explicit "no tool result was recorded" answers only when no real result exists
(Kimi/Moonshot 400 `ocx-mrqaiw05-269`; unit `devlog/_fin/260718_dangling_toolcall_hardening`).

The shared `openai-responses` boundary repairs replayed `call_id` values longer than the Responses
API's 64-character limit for every provider/model that uses that wire, including ChatGPT forward,
API-key gateways, per-model Responses overrides, and the Azure wrapper. Sidechat/fork replay can
namespace routed-provider ids beyond that limit, so each oversized id and all matching call/output
items receive the same deterministic 64-character SHA-256 alias; existing short ids occupy the
alias namespace and force deterministic salting on collision. Exactly 64 characters remains
untouched, and the source id has no separate proxy-level length ceiling beyond ordinary request-body
admission.

A continuation that retains `previous_response_id` may contain only an output for a call stored
upstream under the original id. Those output-only references remain byte-identical. Calls declared
inside the current input are self-contained and may be aliased together with every matching output,
even when the request also retains upstream state. Complete API-key histories and proxy-expanded
replays are self-contained, so every oversized pair is repaired.

These compatibility guards are covered by focused tests and should stay close to the adapters that
need them.

## Cursor parameterized models

Cursor Router's parameterized `default` model is represented in Codex by four catalog rows:
`cursor/auto` preserves Cursor's team/account default, while `cursor/auto-cost`,
`cursor/auto-balance`, and `cursor/auto-intelligence` make each optimization level explicit.
All four route to the `default` Cursor wire model. Explicit variants additionally populate
`AgentRunRequest.requested_model.parameters` with the `optimization` parameter; this is the same
parameterized-model channel used by current Cursor clients. Router rows are static capabilities and
must survive a live `GetUsableModels` response that omits `default`.

`cursor/grok-4.5-fast` is also a stable Codex-facing row, but current Cursor clients do not request
it as a flat model slug. Remodex sends `grok-4.5` through `requested_model` with separate `effort`
and `fast=true` parameters, leaving legacy `model_details` unset for that parameterized external
selection. Live discovery still recognizes Cursor's flattened `cursor-grok-4.5-{effort}-fast`
variants, plus the older `grok-4.5-fast-{effort}` ordering, as availability evidence only.

## Cursor active-context usage

Cursor's `conversationCheckpointUpdate.tokenDetails.usedTokens` is treated as the authoritative
absolute active-context size for a Cursor conversation. Some client-tool suspension turns must end
before Cursor emits a new checkpoint; those turns carry forward the last observed total for the same
Cursor conversation instead of reporting only the tiny current-turn output delta. The carry-forward
cache is process-local, numeric-only, bounded, and keyed by Cursor conversation id. Compaction
boundaries clear the carry so pre-compaction totals are not reused after Codex replaces history.
Historical compaction markers restored by `previous_response_id` expansion are acknowledged as a
replayed prefix and do not clear a fresh post-compaction checkpoint again on every later turn.
Compaction summarizer turns may still report their own checkpoint for that response, but their
pre-compaction checkpoint is not persisted for later carry-forward.

```text
[Decision Log]
- 목적과 의도: Keep Codex's visible "context left" indicator aligned with Cursor's active-context usage on client-tool turns that finalize before a checkpoint arrives.
- 기존 구현 및 제약 조건: Checkpoint turns reported totalTokens correctly, but no-checkpoint client-tool finalize fell back to output-only usage and could overwrite a meaningful prior total with values like 109 tokens.
- 검토한 주요 대안: Add a longer wait for late checkpoints; infer prior+output totals; store full prompt/history state; carry forward only the last numeric checkpoint per Cursor conversation.
- 선택한 방식: Carry forward the last numeric absolute checkpoint per Cursor conversation with bounded LRU/TTL storage, update it only from live checkpoint frames, and clear/suppress it once when a newly appended compaction boundary starts an epoch; previous_response replay provenance acknowledges historical markers without serializing private metadata upstream.
- 다른 대안 대신 이 방식을 선택한 이유: It fixes the UI regression without delaying tool turns, fabricating token growth, storing prompt/tool content, or repeatedly clearing valid post-compaction usage when historical markers replay; one-time compaction resets still prevent stale over-report when history is replaced.
- 장점, 단점 및 영향: Active-context reporting stays monotonic within an uncompacted Cursor conversation; no-checkpoint turns remain estimated; a process restart loses the numeric cache, and when neither a checkpoint nor a carry-forward is available the turn reports a request-local estimate derived from the same pruned payload sent to Cursor (#373 — reporting output-only usage made Codex read the context as nearly empty). Estimates are never persisted or promoted into checkpoint carry-forward; only live checkpoint frames update the cache.
```

## Google tool-call thought-signature replay

Gemini may attach an opaque `thoughtSignature` to a `functionCall` and requires that exact value on
the matching model turn when its tool result is submitted. Antigravity and Vertex share the existing
bounded TTL/LRU replay store, keyed by compiled function-call name plus canonical arguments. Vertex
prefixes its cache model key with the transport, project, and location identity, so a signature
minted by Vertex cannot be sent to Antigravity even when both routes expose the same public model id.
Vertex prefers Codex's opaque `prompt_cache_key` for session identity and falls back to the existing
first-user-message derivation for clients that omit it; only the fixed hash is retained.
Both streaming and non-streaming responses feed the store; request compilation happens before replay
so matching uses the provider-visible tool name.

[Decision Log]
- 목적과 의도: Preserve Vertex Gemini tool-call continuation without exposing opaque signatures to Codex or another Google backend.
- 기존 구현 및 제약 조건: Responses history does not carry a safe Gemini signature field; Antigravity already used a bounded in-process replay cache, while Vertex bypassed it and received HTTP 400 after the first tool call.
- 검토한 주요 대안: Serialize the signature into Responses item ids or reasoning content; create an unbounded Vertex map; reuse the bounded cache with or without a transport namespace.
- 선택한 방식: Reuse the bounded cache for Vertex, observe both response shapes, apply after wire-name compilation, and scope Vertex by transport/project/location plus the opaque client session key when available.
- 다른 대안 대신 이 방식을 선택한 이유: Responses ids are not Gemini signatures and previously caused Base64/TYPE_BYTES failures; a second cache duplicates limits; an unscoped cache could send provider-private state across destinations.
- 장점, 단점 및 영향: Tool loops continue with exact opaque state and bounded memory while cross-transport reuse fails closed. Replay remains process-local, matching the existing Antigravity contract.

## OpenRouter provider routing

The canonical OpenRouter `openai-chat` transport may carry optional provider-routing preferences
from `OcxProviderConfig.openRouterRouting`, with exact model-id replacements in
`modelOpenRouterRouting`. The adapter maps camel-case config to OpenRouter's request wire
(`order`, `only`, `allow_fallbacks`) after the Codex-facing routed slug has been decoded to the
native model id.

Preferences are accepted only for `https://openrouter.ai/api/v1` (an optional trailing slash is
equivalent) and the `openai-chat` adapter. Alternate ports, credentials, query strings, fragments,
lookalike hosts, and custom proxy paths fail validation. A model override replaces rather than
merges the provider-wide default, keeping precedence deterministic. With no preference configured,
the request body is byte-for-byte unchanged in this area and OpenRouter retains its default routing.

## Kimi Coding Plan prompt-cache affinity

The canonical `kimi` OAuth and `kimi-code` API-key presets opt into forwarding the internal
request's `prompt_cache_key` to Kimi's Chat Completions body. Kimi Code Plan documents a stable
session/task key as required to improve cache hit rates. The chat adapter never invents a key of
its own: it forwards what the request already carries — Codex's session key on
`/v1/responses`, or the session-scoped key the Claude `/v1/messages` inbound derives
(metadata.user_id hash, else the system+tools cohort hash) — and a request with no key stays
keyless. An explicit provider-level `promptCacheKey: false` continues to opt out, and the flag is
persisted through `providerConfigSeed`/`enrichProviderFromRegistry` for new configs; key-pool 429
rotation keeps it — along with every other registry backfill — because the retry inherits the
request's routed provider and swaps only the API key (`rotateProviderTransportOn429` in
src/providers/key-failover.ts). If an opted-in upstream rejects the field, Remodex does not strip it and retry or mutate the
saved configuration. Other OpenAI-compatible providers remain deny-by-default because strict
backends may reject the OpenAI-specific field.

## xAI Grok hardening (official Grok Build contract parity)

Grounded in the open-sourced official client (xai-org/grok-build); unit + evidence:
`devlog/_fin/260716_grok_build_hardening/`.

- **Reasoning folding:** the Responses parser folds `reasoning` items into the FOLLOWING
  assistant turn (`pendingReasoning` in `src/responses/parser.ts`) so the Grok chat wire carries
  ONE assistant message with `reasoning_content` — exact-prefix cache stability. Unsigned
  siblings newline-join; `ocxr1`-signed siblings stay separate parts (Anthropic replay keeps
  each signature on its own text); boundaries (user/tool-result/agent) clear pending state;
  call items fold pending reasoning into the same turn.
- **Grok CLI credential ownership:** `source:"local-cli"` xAI credentials re-read
  `~/.grok/auth.json` (read-only) before any refresh and adopt a newer usable generation with
  zero IdP calls (`shouldAdoptGrokGeneration`, later-expiresAt authority); an IdP refresh
  detaches the credential to `source:"oauth"`.
- **Two-lock refresh transaction:** per-provider+account intent lock held across the IdP
  exchange plus a short global store-write lock + async mutation funnel around every
  `auth.json` load-merge-persist (`src/oauth/store.ts`); generation-guarded persist
  (`expectedGeneration` → superseded adoption), conditional `needsReauth`, bounded jittered
  retry for transient token-endpoint failures.
- **Reactive 401 replay:** the serving recovery loop force-refreshes once (singleflight,
  generation-checked) and replays OAuth-backed xAI requests exactly once with a re-resolved
  transport; API-key/BYOK paths excluded (`src/server/responses.ts`).
- **Header parity:** per-attempt `x-grok-req-id` (fresh UUID inside the transport fetch
  wrapper), stable session/conv affinity headers, always-set User-Agent, and a single
  compatibility profile const for the Grok client version (`src/providers/xai-transport.ts`);
  `fetchWithHeaderTimeout` takes an executor so provider fetch wrappers stay inside the
  timeout race.

## Kiro reasoning round-trip (`redactedContent`)

Kiro never returns plaintext reasoning for its **GPT-5.6 family** (`gpt-5.6-sol`, `-terra`,
`-luna`): `reasoningContentEvent` carries a KMS-encrypted `redactedContent` blob, never `text`.
Their `additionalModelRequestFieldsSchema` (`ListAvailableModels`) accepts only `reasoning.effort`
with `additionalProperties: false` — there is no display/summary opt-in, so this is the only
reasoning these models can return. Kiro's own CLI replays the blob on the matching
`assistantResponseMessage.reasoningContent` to preserve model reasoning across turns; dropping it
makes every turn restart without the previous turn's reasoning. Verified on kiro-cli 2.14.1 and
2.16.0, all three models.

The Claude 4.6+/5 entries advertise a different, richer contract (`thinking.type` adaptive/disabled,
`thinking.display` summarized/omitted, `output_config.effort`, `max_tokens`) and are not covered by
that measurement; older Claude, deepseek, minimax, glm, and qwen entries advertise no additional
fields at all. The handling below keys off the wire field, not the model id, so any model that
sends `redactedContent` round-trips.

- The blob rides the existing `ocxr1:` envelope as `krc` (`src/responses/reasoning-envelope.ts`) on
  an envelope-only reasoning item — `summary: []`, no text deltas — so it stays invisible in the
  Codex app while round-tripping, exactly like the hidden-thinking path.
- **Pairing is backwards.** Kiro emits `reasoningContentEvent` at the END of an assistant turn,
  after content AND tool calls. A `krc`-only item therefore belongs to the turn that already
  closed, so the parser attaches it to the PRECEDING assistant message rather than folding it into
  the following turn like ordinary reasoning (`src/responses/parser.ts`). With no assistant turn to
  own it, the blob is dropped rather than mis-paired.
- The blob lives on `OcxAssistantMessage.kiroRedactedReasoning`, not on a thinking content part, so
  no other adapter replays provider-private state if the conversation switches providers.

Kiro reports context pressure in its own `contextUsageEvent`, which is the authoritative source. On
every capture taken (2.14.1 and 2.16.0) `metadataEvent` carried only `stopReason` — which is why
reading the percentage from `metadataEvent` alone never saw a value — but the parser still accepts a
finite `contextUsagePercentage` (and a `tokenUsage` block) there as a fallback, so a value parsed
from `metadataEvent` is legitimate rather than impossible. Both feed the same field, and any
positive value overwrites an earlier one.

Spend arrives in `meteringEvent` as **credits, not tokens**. No captured response carried
`tokenUsage` on any event, which is why Kiro usage stays estimated; `meteringEvent` is currently
ignored because a credit is not a token count.

## Parallel tool calls (default-on for chat providers)

The openai-chat adapter buffers ALL streamed `tool_calls` deltas (keyed by `index`, falling back to
`id`, then last-seen) and flushes them as atomic start/delta/end sequences at the terminal signal.
This is required by the bridge's sequential tool-call contract and makes interleaved parallel
deltas, id-only-first-chunk continuations, and whole-chunk multi-call frames all safe.

Parallel tool calls are DEFAULT-ON for openai-chat providers: the adapter follows Codex's
request-level `parallel_tool_calls` bit (default true) and routed catalog entries advertise
`supports_parallel_tool_calls`. `OcxProviderConfig.parallelToolCalls: false` is the per-provider
opt-out (registry-seeded, router-backfilled; an explicit user value always wins). Non-chat
adapters advertise the catalog bit only on explicit `true`; cursor keeps its own special-casing.
Providers with flaky parallel streaming can be opted out individually. Evidence and provider
ledger: `devlog/_fin/260709_parallel_tool_calls/`.

## Reasoning display parity (hideThinkingSummary)

`hideThinkingSummary` (request reasoning summary absent/"none" — the routed catalog default) is
honored by BOTH reasoning paths: anthropic `thinking_delta` AND raw `reasoning_raw_delta`
(openai-chat `reasoning_content`, kiro tags). Hidden reasoning emits an envelope-only reasoning
item (`summary: []`, txt-only `ocxr1:` `encrypted_content`, no text deltas) — invisible in the
Codex app, so tool cells group like native models — while the text still round-trips for
`preserveReasoningContentModels` replay. Visible mode (summary "auto") keeps the raw
`content[reasoning_text]` shape. Diagnosis and codex-rs grouping evidence:
`devlog/_fin/260709_native_response_pattern/`.

## Chat-to-Responses message phase inference

Chat Completions streams do not carry the Responses `message.phase` field. The bridge keeps an
unphased live message provisional while its deltas arrive, then assigns `commentary` when a later
tool, search, reasoning, or assistant boundary proves that more work follows, and assigns
`final_answer` only when a clean terminal `done` closes the current message. Explicit adapter
phases always win. Streaming `output_item.added` remains unphased until that future boundary is
known; `output_item.done` and the terminal response snapshot carry the authoritative inferred phase
with the same item id. The batch/non-streaming bridge follows the same rule.

```text
[Decision Log]
- 목적과 의도: Prevent Codex App from rendering one bridged Chat Completions answer as both live commentary and a second persisted final answer.
- 기존 구현 및 제약 조건: openai-chat emits text deltas without phase, the bridge streamed them immediately, and whether text is pre-tool commentary or the terminal answer is unknowable until a later boundary arrives.
- 검토한 주요 대안: Mark every delta final_answer; mark every delta commentary; buffer the entire answer before emitting; infer phase only when the message is finalized.
- 선택한 방식: Keep the live added item provisional and infer commentary or final_answer at the authoritative close boundary, preserving explicit phases and item identity in done/completed output.
- 다른 대안 대신 이 방식을 선택한 이유: Eager defaults misclassify either tool preambles or final answers, while full buffering removes live streaming; close-time inference provides correct persisted semantics without adding latency.
- 장점, 단점 및 영향: Codex App receives a definitive phase for persisted bridged messages and avoids the duplicate-final rendering path; the provisional output_item.added event intentionally has no phase because its classification is not yet knowable.
```

## Upstream reset retry

`src/lib/upstream-retry.ts` guards upstream fetches against stale pooled keep-alive sockets
(Cloudflare closes idle connections; Bun's fetch reuses the dead socket and rejects with
`ECONNRESET` before any response bytes). `fetchWithResetRetry` retries only
connection-reset-shaped rejections (up to 3 total attempts, jittered backoff, warn-logged);
timeouts, aborts, `ECONNREFUSED`, HTTP error statuses, and mid-stream SSE failures are never
retried. Guarded paths: the ChatGPT passthrough and generic adapter fetch in
`src/server/responses.ts`, the vision/web-search sidecars, and the web-search loop's direct-fetch
fallback. Adapters with their own `fetchResponse` (kiro, cursor, google) keep their own retry
policies; kiro imports the shared abort/sleep helpers from this module.

One registry-owned exception exists for fixed provider destinations whose edge is proven to
intermittently return a non-JSON error page under an otherwise deterministic status.
`fetchWithTransientNonJsonRetry` runs only before response bytes are relayed, validates the response
body under a strict bound, preserves valid JSON errors, cancels replaced bodies, and opens the retry
on a fresh connection. OpenCode Zen opts into this recovery for non-JSON HTTP 405 responses from its
documented Chat Completions route; an ordinary JSON 405 remains terminal, and same-named custom
destinations do not inherit the capability.

## Same-provider combo quota fallback

For a failover combo with multiple models on the same Codex-login OpenAI provider, a pre-stream
429/402 carrying only `x-codex-*-reset-at` may advance to the later model on the same account. The
failed physical combo target still enters its normal target cooldown. An explicit `Retry-After`
remains an account-wide instruction and blocks the later target; a quota response with neither an
explicit retry delay nor a usable reset timestamp keeps the conservative default account cooldown.
This exception is request-scoped and is not applied to direct requests, round-robin combos, or a
combo whose remaining eligible targets use other providers.

```text
[Decision Log]
- 목적과 의도: Let an ordered combo recover when one model-specific Codex quota window is exhausted but another model on the same account remains usable.
- 기존 구현 및 제약 조건: Account health is shared across models, and recording a reset-derived 429 before combo advancement rejected the later model locally.
- 검토한 주요 대안: Make every quota cooldown model-scoped; ignore all combo 429 cooldowns; or defer only reset-derived cooldown recording for an eligible later same-provider failover target.
- 선택한 방식: Use the narrow request-scoped deferral while retaining target cooldown and all explicit Retry-After/default account cooldown behavior.
- 다른 대안 대신 이 방식을 선택한 이유: Reset timestamps identify quota windows rather than a literal account-wide retry instruction, but widening the exception would risk hot retries and provider abuse.
- 장점, 단점 및 영향: Same-account model fallback works without weakening explicit upstream backoff; the account health map intentionally does not remember that one deferred reset-derived failure, while the combo target map does.
```

## Transport inventory

The sections above cover the transports with load-bearing invariants. The rest of the transport
surface is listed here so a maintainer can find the owner without grepping:

| Transport | Owner | Invariant worth knowing |
| --- | --- | --- |
| Azure OpenAI Responses | `src/adapters/azure.ts` | Deployment-shaped URLs on top of the Responses contract. |
| Google / Vertex / Antigravity | `src/adapters/google.ts`, `src/adapters/google-http.ts`, `src/adapters/google-wire-compiler.ts`, `src/adapters/google-tool-schema.ts`, `src/adapters/google-truncation.ts`, `src/adapters/google-errors.ts`, `src/adapters/google-antigravity-wire.ts`, `src/adapters/google-antigravity-replay.ts` | Vertex and Antigravity install a Google-family `fetchResponse` and so own their retry policy, while AI Studio Gemini leaves it undefined and uses the default server fetch path. The Google-family wrapper reuses the shared abort/deadline helpers (`src/lib/upstream-retry.ts`), wire-body repair, and upstream error normalization. |
| Mimo Free | `src/adapters/mimo-free.ts` | Client identity and JWT handling are transport-local; the per-install client id lives in the Remodex state root. |
| Anthropic image ingress | `src/adapters/anthropic-image-guard.ts`, `src/adapters/anthropic-image-normalize.ts` | Oversized or unsupported images are normalized or rejected before reaching upstream. |
| Adapter execution support | `src/adapters/run-turn-queue.ts`, `src/adapters/tool-catalog-nudge.ts`, `src/adapters/identity.ts`, `src/adapters/image.ts`, `src/adapters/upstream-http-error.ts` | Shared machinery: turn ordering, tool-catalog nudging, client fingerprinting, image conversion, upstream error normalization. |
| Cursor (beyond the sections above) | `src/adapters/cursor/live-transport.ts`, `src/adapters/cursor/transport-retry.ts`, `src/adapters/cursor/mcp-manager.ts`, `src/adapters/cursor/thread-continuity.ts` | Thread continuity is the point: a retry must not start a new Cursor thread. |
| Claude Messages | `src/server/claude-messages.ts` | Routed translation, a native Anthropic passthrough branch, and `count_tokens`. |
| Chat Completions inbound | `src/server/chat-completions.ts`, `src/chat/` | Inbound translation onto the same routing pipeline. |
| Hosted search relay | `src/server/search.ts` | Direct relay; distinct from the web-search sidecar loop below. |
| Image/video generation loop | `src/images/loop.ts`, `src/images/plan.ts`, `src/images/fulfill.ts`, `src/images/xai-client.ts`, `src/images/xai-video-client.ts`, `src/images/artifacts.ts` | A provider-returned image URL is downloaded into a local artifact once, then served locally; warnings stay URL-free because provider CDN URLs may embed credentials. |
| GitHub Copilot | `src/providers/xai-transport.ts` (`resolveProviderTransport`), `src/providers/github-copilot-transport.ts` | `resolveProviderTransport` selects the Copilot transport when the routed provider name is `github-copilot`; the Copilot module then resolves its headers and base URL, and the registry seeds the provider row and model fallback. |
| API-key pools | `src/providers/key-failover.ts` | A 429 rotates the active key and records a cooldown; `provider.apiKey` keeps mirroring the active entry so routing stays single-key. |
| Alibaba regions | `src/providers/alibaba-region-backup.ts`, `src/providers/alibaba-region-migration.ts`, `src/providers/alibaba-region-startup.ts` | Region migration backs up before rewriting and is idempotent across restarts. |
| Discovery and quota | `src/providers/model-discovery.ts`, `src/providers/quota.ts` | Discovery rejects a response over 4 MiB or past 2,000 raw rows before caching it. |

## Sidecars

Web search and vision sidecars run only when the main request needs that capability and a usable
sidecar authority exists. Both have two possible backends, but they select differently:

| Sidecar | Backend selection | Default model | Activation |
| --- | --- | --- | --- |
| `web-search/` | Explicit configuration only: unset always resolves to the OpenAI forward path. Anthropic is never auto-selected from credential availability — doing so once sent OpenAI model ids to the Anthropic API. | `gpt-5.6-luna` (OpenAI), `claude-sonnet-5` (Anthropic) | Hosted `web_search` requested by a non-passthrough routed model. |
| `vision/` | Explicit configuration wins for both backends. Only an unset backend auto-selects: Anthropic when a usable Anthropic OAuth provider exists, otherwise the OpenAI forward authority. An explicitly selected backend whose authority is unavailable produces no plan rather than falling back. | `claude-sonnet-5` (Anthropic), `gpt-5.4-mini` (OpenAI) | Input contains images for a model listed in `noVisionModels`. |

The asymmetry is in the unset case only: vision may describe an image with whichever model can see
it, while a hosted search tool is tied to a provider-specific tool contract, so search never infers
Anthropic from credentials alone.

On the OpenAI path there is one deterministic `openai` sidecar candidate and its current account mode
owns credential selection; API-key OpenAI is not a ChatGPT forward sidecar candidate.

Sidecar failures must degrade to text markers or skipped capability, not abort the main request.
