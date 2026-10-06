# Remodex Connect — desktop/server npm package

## 1.2.23 — Windows chat loading

- Select the Codex runtime belonging to the running Windows Desktop after updates.
- Load recent chats first instead of waiting for the complete chat catalogue.
- Recover recent saved messages when Windows returns an empty history page, then load older history.
- Keep loaded messages during unexpected empty refreshes and hide internal page-context and annotation text.

If a conversation was already open before updating, return to the chat list and
open it again to replace its previously retained history rows with clean messages.

## Version 1.2.21

Carries the Windows/macOS CI fixes verified in all eight server compatibility shards: complete remote-asset test fixtures, bounded startup/shutdown checks, native-promise oversized-response assertions, and isolated real history-worker regression checks. The manual focused runtime workflow is available for transport and worker checks without a full dashboard build.

Legacy Antigravity OAuth client credentials are no longer embedded in the distributed source. That legacy integration requires explicit `GOOGLE_ANTIGRAVITY_CLIENT_ID` and `GOOGLE_ANTIGRAVITY_CLIENT_SECRET` environment settings; missing settings fail before network access. The simplified ChatGPT/Codex connection flow is unchanged.

## Simplified desktop/server flow

Version 1.2.19 introduces the simplified desktop/server flow in the existing `@remodex/rmx` npm package. The Android app is not copied or changed. It includes three-stage onboarding and QR progress. Development and release preparation do not install over the original local service.

The product is the existing npm package (`@remodex/rmx`, command `rmx`) and its browser dashboard. No separate desktop application, native installer, or new npm package is being built or shipped. The retained legacy `desktop/` tooling is outside this product's build and npm payload.

## Product surface

- Android Remote is the landing page: Android Remote controls, Connection methods, and Authorized clients. Only the three nested help/manual-setup disclosures start collapsed. Add phone opens the QR pairing dialog.
- Logs & Debug contains native Codex activity, local reader diagnostics, and desktop runtime logs.
- Usage shows measured native Codex tokens by model and UTC event day. Storage remains available.
- Guide describes existing Codex sign-in and phone pairing. Provider configuration, Claude/Grok adapters, account-pool controls, and model injection are not product options.
- Advanced Settings contains optional background-service setup. Opening it changes nothing; setup requires confirmation and uses OS permission prompts only if required. It is never part of the default pairing path.
- Removed routes redirect to Android Remote. The sidebar retains Check for updates, with latest/preview channel selection, release notes, progress, and Retry. Checks reuse the existing npm registry reader. Built-in installation and automatic updates remain disabled in this release. Update explicitly with `npm install -g @remodex/rmx@latest`, then run `rmx onboard`.

Legacy implementation modules and tests remain where needed by shared dependencies. They are not exposed as Connect product pages. This is not a claim that all pairing defects are fixed.

`rmx onboard` uses the same three-stage flow on Windows, macOS, and Linux: prepare local settings, reuse or start a hidden user-level runtime, and verify pairing readiness. It never installs or repairs a service. Without the optional service, rerun the command after reboot/sign-out or if the process stops. Existing services are not removed. Firewall or enterprise policy restrictions remain possible and are not bypassed.

Fresh Connect profiles use dashboard port 10100, Android gateway port 10105, and private Codex port 10106. Quick and custom-domain Cloudflare tunnels target only `http://127.0.0.1:10105`; they never publish the dashboard or private Codex listener. Onboarding, service setup, recovery, and restart keep the configured dashboard port. If it is occupied, setup reports the conflict without choosing or saving another port. The gateway port does not fall back to a different port. It never stops the other listener or edits Codex settings. Explicit `rmx start --port` and installed-service dashboard ports remain pinned. Gateway startup retries use the same bounded delays on all three operating systems and show a starting state during recovery.

Managed tunnel downloads support Windows x64, macOS x64/ARM64, and Linux x64/ARM64. Windows ARM64 uses the same checksum-verified x64 helper through Windows 11 emulation; executable validation must pass before installation is completed. If emulation is unavailable, use Local Wi-Fi or supply a compatible `OPENCODEX_CLOUDFLARED_PATH`. No native Windows ARM binary is claimed. See [Cloudflare's release assets](https://github.com/cloudflare/cloudflared/releases/tag/2026.8.3) and [Microsoft's emulation documentation](https://learn.microsoft.com/en-us/windows/arm/apps-on-arm-x86-emulation).

Optional service setup uses a separate hidden worker and persistent status so stopping the original user-level server does not interrupt installation. Failed setup attempts recovery of the normal runtime. Repairing an already supervised process must be done separately with `rmx service repair`, not from a worker inside that service's process group. Cross-platform CI does not replace fresh Windows/macOS installation and real-phone pairing verification.

## Native activity

The authenticated `GET /api/connect/activity` endpoint reads session JSONL files in `CODEX_HOME/sessions` and `CODEX_HOME/archived_sessions`. It does not depend on the proxy's old `usage.jsonl` file. Logs, Debug, and Usage refresh every five seconds while visible and provide manual refresh and explicit loading/error states.

Only OpenAI-native session metadata, turn outcomes, and token counters are returned. Prompts, responses, account IDs, secrets, paths, and raw session files are not returned. Thread identifiers are hashed. No diagnostics are uploaded automatically.

Repeated cumulative counters and copied sessions are deduplicated. Inherited initial totals are excluded; only the available last-call measurement and subsequent deltas count. Cached input is a subset of input, not an additional token charge. Token totals are not ChatGPT subscription limits, account quota, or monetary costs. Turn state is the last observed event, not proof of a live connection.

Scanning is incremental and memory-bounded: at most 200 recent files, 32 MiB read per pass, 4 MiB per file per pass, 400 recent activity rows and 800 usage buckets per file. Oversized or invalid records are skipped. Initial indexing, missing history, inherited totals, retention limits, and unreadable files are reported as partial history rather than presented as complete account totals. A turn spanning midnight can be counted in each UTC day in which it has measured usage.

## Configuration protection

Use `bin/ocx.mjs` or `src/cli/connect.ts`, not the legacy `src/cli/index.ts` entry. Connect mode refuses config-management permission even if an old profile contains consent. It disables config injection/restoration, catalog writes, shell/environment hooks, provider mutation endpoints, and automatic package updates. It does not repair or remove settings written by older apps.

Existing `config.toml`, `config.yml`, model catalogs, and provider settings are left unchanged. The phone's Codex app-server selects OpenAI through process arguments, not a file edit. Codex itself still owns authentication and normal session persistence. Storage deletion remains an explicit user-controlled action; read-only configuration does not mean the storage cleanup feature is disabled.

Windows compatibility checks cover short and full paths resolving to the same home, including ownership metadata after a directory migration. Legacy explicit-consent checks resolve the existing parent directory and still reject other configurations or unreadable paths; Connect mode always denies configuration writes. The optional Windows tray uses the shared hidden, handle-isolated launcher so it cannot retain the server's listening socket after shutdown.

Own settings and pairing records default to `~/.remodex-connect`. Native sessions remain in the existing Codex home. On Windows, Connect reuses an existing Remodex scheduler task only when its launcher belongs to this profile; it creates remodex-connect only when neither supported task exists. Duplicate, unknown, or foreign-profile tasks block installation. Existing phone authorizations are not migrated from the old profile; pair the phone again. Fresh Windows service installation remains a separate end-to-end verification task.

## Isolated local preview

Run the backend from this directory with a separate profile and free port:

```sh
OPENCODEX_HOME="$HOME/.remodex-connect-preview" CODEX_HOME="$HOME/.codex" bun src/cli/connect.ts start --port 10110
```

Then, from `gui`:

```sh
NODE_OPTIONS=--max-old-space-size=512 OPENCODEX_PROXY_TARGET=http://127.0.0.1:10110 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174 --strictPort
```

Open `http://127.0.0.1:5174/#logs`. Pairing/settings are independent from the original runtime; no existing phone authorization is copied. Android gateway/task-server ports remain 10105 and 10106, including in previews. Do not enable phone control in two runtimes simultaneously: only one can own these ports. Phone control stays disabled until explicitly enabled. No service installation is needed for this preview. For user-equivalent testing, install the npm tarball and use its bundled dashboard on port 10100, not the Vite preview.

## Validation

Run checks sequentially with a bounded Node heap. `bun scripts/test.ts` provides disposable runtime-test homes. Focused tests cover cumulative usage, inherited totals, duplicate sessions, provider changes, partial files, date boundaries, authentication, and unchanged client files across startup/shutdown. GUI tests cover refreshed records, stale errors, period filtering, and read-only diagnostics.

Windows CI uses `bun scripts/test-file-shard.ts --shard=1/4` (indices 1–4) to run each selected file in a fresh, hidden Bun process through the same isolated-home wrapper. This limits accumulated Worker/isolate state and memory. Files are partitioned deterministically without overlap; a failed or crashed file still fails the job. Linux runs the Worker-heavy storage-policy files separately from its general shards.

Windows installation and real-phone pairing remain separate end-to-end checks; passing local tests does not validate a Play Store release or trial conversion.

### Local verification (September 23, 2026)

- GUI suite: 788 passed; focused native-activity and desktop-log tests also passed after adding desktop-log polling. GUI lint, i18n lint, and production build pass.
- Focused runtime checks: 170 passed, one Windows-only test skipped. Runtime and desktop TypeScript checks pass. Documentation build passes (226 pages).
- Browser verification: native activity includes today's sessions, Usage and Debug refresh, and Desktop logs reads the isolated backend's log. The existing runtime on port 10100 remains the same running process. The real Codex config checksum remains unchanged.
- The monolithic legacy runtime suite was stopped at roughly 2.3 GiB RSS to avoid another memory-full crash. It is not a passing full-suite result. Two Android gateway tests failed during that run; the legacy Command Code metadata test also requires a Git worktree that this independent copy does not have. Stale launcher/parity assertions caused by the intentional Connect entry changes were updated and pass in the focused rerun.
- The existing privacy scan cannot enumerate files because this copy has no Git repository. No Git repository was created merely to bypass that prerequisite. Activity payload and redacted runtime-log privacy checks are covered by focused tests instead.
