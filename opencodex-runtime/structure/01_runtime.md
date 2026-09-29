# Runtime SOT

## Entrypoints

| Path | Responsibility |
| --- | --- |
| `bin/ocx.mjs` | Published npm `bin` entry (Node shim). Resolves the bundled or explicit Bun binary before project dotenv can load, stamps its runtime provenance plus a proof-bound Anthropic parent-env snapshot, lazy-runs `bun/install.js` if only the placeholder stub is present, then execs `src/cli/index.ts` under Bun. Lets `npm install -g` work without a separately-installed Bun. |
| `src/lib/bun-runtime.ts` | Bundled-Bun resolution: `isRealBunBinary()` (size gate vs the ~450-byte placeholder stub), `bundledBunPath()`, and `durableBunPath()` (path baked into service/shim artifacts). Durable selection accepts only the source/path pair already stamped for the running executable; it never re-reads a project-dotenv `OPENCODEX_BUN_PATH`. |
| `src/cli/index.ts` | `rmx` CLI (with `remodex`, `opencodex`, and `ocx` compatibility aliases). Lifecycle: init, start, stop, restart, status, sync, restore/eject, gui, service, update. Configuration: provider, account, models, combo/route, access, integrations, v2. Diagnostics: doctor, debug, observe, health. Windows adds tray. The full command surface is `src/cli/help.ts`; this table names the groups, not every verb. After help/version early exits, ordinary commands run the bounded best-effort Codex-shim auto-restore policy before dispatch. Keeps the `#!/usr/bin/env bun` shebang for from-source dev (`bun run src/cli/index.ts`). |
| `src/cli/onboard.ts` | Idempotent first-user orchestrator: safe config bootstrap, desired Codex state, Android Remote defaults, service/tray convergence, Codex sync, verified-tunnel wait, concise terminal/JSON reporting, and the pairing deep link. Existing external providers and custom-domain tunnels are preserved. |
| `src/server/index.ts` | Bun server entrypoint: `startServer`, `/v1/responses` HTTP + WebSocket routing (compact handled before generic Responses), exact `POST /v1/images/generations` and `POST /v1/images/edits` routing, `/v1/models`, the Anthropic-shaped `/v1/messages` and OpenAI-shaped `/v1/chat/completions` compatibility surfaces, the Live/Realtime surface, the hosted-search relay, artifact serving, `/healthz`, the `/api/*` auth gate, the `/v1/*` JSON 404 guard, GUI fallback, and facade re-exports for split server modules. |
| `src/server/images.ts` | Standalone Images data plane: default OpenAI or explicit custom-provider selection, Codex account affinity, bounded opaque request relay, single-attempt upstream fetch, pool health recording, and safe response/cancellation relay. |
| `src/config.ts` | `~/.remodex/config.json` by default, defaults, PID path, env-value resolution, `websocketsEnabled()`. |
| `src/router.ts` | Provider/model selection before adapter dispatch. |
| `src/types.ts` | Shared config, parsed request, adapter, and event types. |
| `src/reasoning-effort.ts` | Codex reasoning-level definitions (`low`/`medium`/`high`/`xhigh`), per-model effort mapping, and catalog effort sanitization. |
| `src/codex/shim.ts` | Codex autostart shim: replaces the `codex` binary with a wrapper that auto-starts the proxy on demand. It skips startup for management subcommands even when value-taking global flags precede the subcommand, and transactionally restores complete, stable external launcher replacements without a watcher or PATH rediscovery. |
| `src/codex/desktop-client-processes.ts` | Explicit restart support for the official Codex/ChatGPT GUI. Enumeration is current-user scoped and install-path constrained, helper processes are rejected, and PID plus command identity is revalidated immediately before any signal. Tray restarts remain graceful-only; the dashboard's warned, confirmed model takeover uses a separate force-close-and-relaunch entrypoint. |
| `src/service.ts` | OS service manager (macOS launchd, Linux systemd, Windows schtasks): always-on proxy with crash restart. |
| `src/update/auto-scheduler.ts` | Default-on unattended package updater for global npm/Bun installs: native daily scheduler artifacts, exact-version/integrity gating, overlap lock, post-restart health confirmation, rollback bookkeeping, and the `rmx system update auto` controls. |
| `src/update/job.ts` | npm package update engine for the dashboard and schedulers: registry/version checks, exact-version install, integrity preflight, service/tray handoff, restart health verification, owner-only job state, version-specific GitHub changelog links, and locally recorded install time. |
| `desktop/src-tauri/src/main.rs` | Cross-platform Remodex tray/window shell. It shows and periodically refreshes health/readiness state, dispatches health-derived Start/Stop plus apply and restart actions to the bundled CLI, and opens the dashboard's npm update route. It has no native-installer updater. The remote dashboard lifecycle bridge is limited to the exact loopback origin verified when its window opens. |

The `src/` root stays thin: process entry (`src/cli.ts`, `src/index.ts`), shared config/types,
router, bridge, service manager, reasoning-effort definitions, and the stall-timeout budget live
there. Feature code is grouped by responsibility:

| Group | Directories |
| --- | --- |
| Data plane | `src/adapters/`, `src/responses/`, `src/chat/`, `src/claude/`, `src/grok/`, `src/images/`, `src/vision/`, `src/web-search/` |
| Codex integration | `src/codex/`, `src/combos/`, `src/providers/`, `src/oauth/` |
| Surfaces | `src/server/`, `src/cli/`, `src/tray/`, `src/github/` |
| Support | `src/lib/`, `src/storage/`, `src/usage/`, `src/update/`, `src/generated/` |

`src/generated/` is build output committed for the runtime; it is not edited by hand.

`src/server/` is split by responsibility: `index.ts` owns the listener and route ordering;
`responses.ts` owns Responses handling and compaction; `images.ts` owns the standalone Images relay;
`management-api.ts` owns `/api/*`;
`lifecycle.ts`, `request-log.ts`, `relay.ts` (incl. the shared `createSseInspector` SSE inspection
factory), `relay-eager.ts` (#314 gated eager bounded passthrough relay), `memory-watchdog.ts`
(warn-only RSS sampler), `management/system-routes.ts` (`/api/system/*`), and `auth-cors.ts` own
server infrastructure (`src/lib/bun-stream-caps.ts` owns the Bun stream-capability gate); and
static GUI, WebSocket bridge, port/liveness, decompression, and adapter-resolution helpers live in
their own files.

## Lifecycle

`rmx start` refuses a duplicate PID, starts the proxy, writes `~/.remodex/ocx.pid`, syncs Codex
config/catalog, then serves until shutdown. Normal shutdown restores native Codex. Service mode sets
`OCX_SERVICE=1`, so managed restarts do not repeatedly restore/reinject; explicit service stop and
uninstall still restore.

`rmx onboard` composes those existing boundaries instead of maintaining a second setup path. It
persists Android Remote before service start, reapplies the enabled state through the live management
API for already-running services, captures service/tray command noise, synchronizes Codex through the
canonical injector, and withholds the pairing deep link until the public tunnel verifies the exact
Android gateway identity. Reruns repair stale service assets and preserve named tunnels and external
Codex providers.

Dashboard **Sync models** is the explicit exception to onboarding's coexistence policy. After a
destructive-action confirmation it temporarily preserves and disables root provider/profile/base-URL
and catalog selectors, applies Remodex routing, then force-closes and relaunches one verified
Codex/ChatGPT Desktop client so its in-memory model picker is rebuilt. An unconfirmed API sync and
all CLI/onboarding syncs keep the external-provider preservation behavior.

For global package installs, normal bootstrap also provisions a default-on daily updater. The
updater is a separate short-lived worker (`__auto-update`) so the long-running service never
updates its own loaded files. Windows uses a hidden Task Scheduler task; macOS uses a per-user
`launchd` agent; Linux uses a per-user `systemd` timer. `~/.remodex/auto-update.json` records the
enabled/channel state, exact target, health result, and rollback attempt; `auto-update.log` contains
only bounded, locally-composed diagnostics. `rmx system update auto off` removes the scheduler and
persists an explicit opt-out. Source checkouts and unsupported platforms do not register one.

An installed Codex shim is checked on ordinary CLI startup with a regular-file/1 MiB state bound plus
bounded metadata and prefix reads. A complete replacement must produce identical fingerprints and
prefixes across a 100 ms observation interval; changing launchers are silently deferred, while mixed
sibling sets warn and defer as a unit. Guarded repair holds a self-identifying atomic-mkdir
interprocess lock across its final revalidation, rename, shim write, and state commit. Its owner record
uses the unique token as the filename, so stale-owner deletion cannot name a successor's record. An
aged lock is reclaimed only when its owner PID is no longer alive and the same token, lock-directory
identity, and owner fingerprint are still present immediately before deletion. Repair preflights every
tracked sibling before mutation and rolls back earlier siblings in reverse order on a later race.
Failures warn without changing the requested command's exit behavior. The probe uses read-only config
diagnostics only for a confirmed candidate and never reads adjacent auth state.

The bridge enforces a heartbeat stall deadline. It defaults to 300 seconds sampled on a 2 s tick
(`src/stall-timeout.ts`) and is configurable, so treat the number as a default rather than an
invariant; sidecars keep their own clocks. On expiry the stream is closed and the upstream request
cancelled. If the adapter generator ends without an explicit done/error event, the response is marked
`incomplete` rather than `completed` so Codex can distinguish a clean finish from a truncated stream.
On `error` / incomplete / stall / EOF — and when assembled non-freeform tool arguments fail to parse —
an open tool call is cancelled as `status: "incomplete"` without `function_call_arguments.done`, so
the client never sees a completed call ahead of `response.failed` / `response.incomplete`.

The server exposes `POST /api/stop`, which fences new turns, restores only Remodex-owned Codex and
Grok state, stops any installed service (to prevent respawn), and exits the process. A restoration,
ownership, or lifecycle conflict returns 409 and keeps the proxy alive. A browser dashboard calls
this endpoint directly. The persistent desktop shell uses its serialized CLI lifecycle bridge so
the same control can start the proxy again after a clean stop.

[Decision Log]
- 목적과 의도: Prevent repository dotenv data from becoming a durable executable or an OAuth-bearing Claude destination.
- 기존 구현 및 제약 조건: Bun auto-loads project dotenv before Remodex TypeScript evaluates, while provider interpolation still depends on that behavior and cannot be disabled globally.
- 검토한 주요 대안: Reject only relative Bun paths; disable Bun dotenv; trust a plain environment marker; capture provenance in the Node launcher and bind it to an argv proof.
- 선택한 방식: The Node launcher selects Bun and snapshots Anthropic credential/destination slots before Bun starts. Durable runtime selection uses only the stamped current executable, while Claude accepts the snapshot only when its random argv proof matches.
- 다른 대안 대신 이 방식을 선택한 이유: Absolute dotenv expansion bypasses a relative-path check, global dotenv removal breaks supported configuration, and an environment-only marker can itself come from dotenv.
- 장점, 단점 및 영향: Normal npm launches preserve genuine shell overrides. Direct Bun or legacy launches have no provenance signal and fail closed for all three ambient Anthropic slots — credentials included, because subscription mode leaves `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` unset by design (#253) and a `settings.env` merge can still replace the destination after launch, so a preserved key would travel with it. The cost is that `bun src/cli/index.ts` loses ambient Anthropic values; the escape hatch is running through the published `rmx` bin, where genuine shell exports are preserved by proof. Durable artifacts use the running or bundled Bun.

## Providers and adapters

| Path | Responsibility |
| --- | --- |
| `src/providers/registry.ts` | Canonical provider presets for CLI, dashboard, OAuth, key providers, and metadata. |
| `src/providers/derive.ts` | Enrichment from provider presets into user config. |
| `src/oauth/` | OAuth providers, token storage, refresh, and auth-token resolution. |
| `src/adapters/openai-responses.ts` | Native OpenAI/ChatGPT Responses passthrough. |
| `src/adapters/openai-chat.ts` | OpenAI-compatible Chat Completions bridge. |
| `src/adapters/anthropic.ts` | Anthropic Messages bridge. |
| `src/adapters/google.ts` | Gemini bridge. |
| `src/adapters/azure.ts` | Azure OpenAI bridge. |
| `src/adapters/cursor.ts`, `src/adapters/cursor/` | Cursor protobuf transport: discovery, request builder, event decoding, MCP, thread continuity, native-exec policy. |
| `src/adapters/kiro.ts` and its `src/adapters/kiro-*.ts` helpers | Kiro event/tool/thinking/truncation/retry handling. |
| `src/adapters/mimo-free.ts` | Mimo Free transport (client identity + JWT). |
| `src/adapters/image.ts`, `src/adapters/anthropic-image-guard.ts`, `src/adapters/anthropic-image-normalize.ts` | Image conversion for adapter ingress and Anthropic-specific normalization/limits. |
| `src/adapters/run-turn-queue.ts`, `src/adapters/tool-catalog-nudge.ts`, `src/adapters/identity.ts`, `src/adapters/upstream-http-error.ts` | Shared adapter execution support: turn queueing, tool-catalog nudging, client identity, upstream error normalization. |

Adapter output must stay in internal `AdapterEvent` form until `bridge.ts` converts it back to
Responses SSE or WebSocket frames.

Live model discovery is bounded and registry-driven through `src/providers/model-discovery.ts`.
Custom providers keep the conventional `${baseUrl}/models` request; canonical presets may select a
trusted URL/path/query and declarative eligibility filter without persisting that policy into user
config. A response is rejected before caching when it exceeds 4 MiB, contains more than 2,000 raw
rows, has a malformed OpenAI list envelope, or includes an invalid model id. Tests use fixtures and
must never depend on live provider endpoints. Newly promoted fixed key presets opt into
`preserveCustomDestination`, so an older same-named custom provider keeps its configured adapter,
destination, and key boundary instead of being silently canonicalized onto the new host. Fixed
OAuth presets resolve discovery against the same canonical registry transport as normal routing
before any adapter-specific transport override, so a stale configured `baseUrl` cannot receive an
OAuth bearer token.
