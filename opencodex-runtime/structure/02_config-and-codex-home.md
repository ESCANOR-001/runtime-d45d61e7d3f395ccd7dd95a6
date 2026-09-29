# Config And Codex Home SOT

## Codex home

`src/codex/paths.ts` resolves Codex state from `CODEX_HOME` when set and valid, otherwise from
`~/.codex`. An unset `CODEX_HOME` falls back to `~/.codex`, including WSL discovery. An explicitly
set path that is unreadable or not a directory is an error, not a fallback: silently using a
different home than the operator named would write provider state where nobody is looking for it.
The managed files are:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models.json
$CODEX_HOME/opencodex-journal.json
$CODEX_HOME/models_cache.json
$CODEX_HOME/.opencodex-native-main-profiles/
```

Never assume macOS-only paths. Windows, service installs, and app-launched Codex can all depend on
the resolved `CODEX_HOME`.

On Windows, write-coordination paths use the effective Windows account's registered
Local AppData folder, read from that account's registry hive without expanding process
environment variables. Different `HOME`, `USERPROFILE`, or `LOCALAPPDATA` overrides must
not give two processes different locks for the same Codex home. Successful SID and
registered-folder lookups are reused for the lifetime of each process and refreshed
on restart. Failed lookups are never cached. This avoids launching PowerShell for
every coordination operation. Lookups run with hidden windows; directory ownership
and reparse-point checks still run on each access.

Config mutation also verifies that an existing config home is a directory before
applying directory permissions. An invalid file-shaped home is refused with its bytes
and permissions intact, including on Windows where directory grants differ from file grants.

Native-main profile ownership is bound to the real `CODEX_HOME`, not to an Remodex instance.
Its encrypted vault, transaction journal, recovery marker, and referenced quarantine files live in
the owner-only `.opencodex-native-main-profiles` directory. The unchanged
`.opencodex-native-profile.lock.sqlite` beside that directory serializes every process sharing the
home. Only plaintext login staging is instance-local under
`$OPENCODEX_HOME/native-main-profile-staging`; a stage from one instance is invalid in another.
These paths and the OS keyring are owner-only: the operating-system account that owns them is the
trust boundary and already has direct access to active native credentials. Remodex detects and
fails closed on file identities that change during an operation, but it does not claim isolation
from a malicious process already running as that same trusted OS account.

Startup and the periodic stage cleaner do not acquire the profile transaction lock when both the
stage registry and this instance's staging tree are proven absent. This keeps an unused profile
subsystem from fencing native traffic or creating lock contention. Presence, an unsafe entry type,
or any observation error still takes the locked sweep and fails closed; the fast path is based only
on proven absence, never on an unreadable path.

[Decision Log]
- 목적과 의도: Keep zero-profile and zero-stage installations out of the native-profile transaction path without weakening staged-credential cleanup.
- 기존 구현 및 제약 조건: Every live server swept stages at startup and every minute, and a failed sweep closed the global native-main gate even when no stage artifact existed.
- 검토한 주요 대안: Disable native-main ownership entirely when the vault is empty, add a stale-lock deletion command, or skip only the stage sweep when both artifact paths are absent.
- 선택한 방식: Preserve owner and claim protection, but bypass `sweepStages()` only after proving the registry and staging tree are both absent.
- 다른 대안 대신 이 방식을 선택한 이유: Physical credential ownership remains cross-process safe, while an inert optional subsystem can no longer create the reported lock/recovery catch-22.
- 장점, 단점 및 영향: Fresh installs avoid the SQLite profile lock; any present or uncertain stage state retains the existing locked fail-closed cleanup and recovery behavior.

Remodex never overrides an explicit `CODEX_HOME`. On Windows, `rmx doctor` and `rmx status`
nevertheless diagnose the high-confidence Orca dual-home case: both `CODEX_HOME` and
`ORCA_CODEX_HOME` select Orca's `orca/codex-runtime-home/home`, while the ChatGPT/Codex app uses the
default `%USERPROFILE%\\.codex`. Sync and restore output always prints the exact target Codex home;
display and JSON paths redact the OS username. The diagnostic tells users to invoke Remodex with
the app home explicitly rather than silently claiming that an unrelated app was configured. If a
service was installed under the Orca home, it must first be uninstalled from that original Orca
environment and then reinstalled under the app home; changing only the current shell cannot migrate
the recorded service ownership.

[Decision Log]
- 목적과 의도: Make multi-home injection truthful without taking ownership of user environment variables.
- 기존 구현 및 제약 조건: CODEX_HOME is an intentional override, but Orca exports it for its own bundled runtime and the Windows app reads a different home.
- 검토한 주요 대안: Rewrite CODEX_HOME automatically, warn for every custom home, or detect only the Orca-owned signature and report the target path.
- 선택한 방식: Preserve the override, add a narrow Windows/Orca diagnostic, and qualify sync/restore success output with the effective home.
- 다른 대안 대신 이 방식을 선택한 이유: It fixes the silent failure while avoiding destructive or noisy behavior for intentional custom homes.
- 장점, 단점 및 영향: Orca users get an actionable warning; other multi-home products remain unchanged until they have an equally reliable signature.

`atomicWriteFile` uses a temp file named `{path}.ocx.{pid}.{seq}.tmp` (process ID + incrementing
sequence number) to avoid collisions when concurrent writers (e.g. `rmx stop` and the proxy's own
shutdown handler) both restore Codex config simultaneously. The temp is renamed atomically into place.

Response-state loading performs a bounded recovery pass for interrupted snapshot writes. It only
matches regular files named `responses-state.json.ocx.<pid>.<sequence>.tmp`, waits at least 15
minutes, and skips the current or any live PID. Eligible files are truncated before unlinking so a
matching stale path is unlinked without following it. Path-based truncation is intentionally avoided:
a same-user replacement could otherwise turn cleanup into a write through a symlink. Unrelated
temporary files, symlinks, directories, and young/active writes are never touched; directory entries
are consumed incrementally and at most 512 stale files are attempted per process start.

[Decision Log]
- 목적과 의도: Bound disk and conversation-state retention after abrupt process termination.
- 기존 구현 및 제약 조건: Ordinary write failures clean up immediately, but a killed process cannot run that path and Windows may temporarily lock files.
- 검토한 주요 대안: Delete every `.tmp`, rely on manual cleanup, or recover only exact response-state remnants with age and PID guards.
- 선택한 방식: Run a capped, best-effort, unlink-only sweep on lazy response-state startup.
- 다른 대안 대신 이 방식을 선택한 이유: It repairs known remnants without broad authority over unrelated temp files or active writers.
- 장점, 단점 및 영향: Old dead-PID files are reclaimed automatically; locked or conservatively classified files remain for a later retry.

## Config surface

`src/types.ts` is the shape and `src/config.ts` is the loader; neither is reproduced here. What
matters for maintainers is which groups exist and who resolves them:

| Group | Keys | Resolution rule |
| --- | --- | --- |
| Listener | `port`, `hostname` | The listener owns the port; `runtime-port.json` reports where it actually landed. |
| Routing | `defaultProvider`, `providers`, per-provider `selectedModels` | Explicit `provider/model` wins over `defaultProvider`. |
| Catalog | `disabledModels`, `customModels`, `modelSourceVisibility`, `modelCacheTtlMs`, `providerContextCaps`, `contextCapValue`, `codexAccountNamespaces`, `codexAccountPickerEnabled` | Catalog state is derived; config only records intent. `modelSourceVisibility` hides a provider's rows from client selectors without removing credentials or blocking exact source-qualified routes. The picker flag is an explicit visibility override, while selector mappings remain the durable exact-routing contract. |
| Retained state | `appOwnedMemoryBudgetMb` | Process-wide eviction target for app-owned logs, caches, blobs, and continuation payloads. Default 256 MiB, valid 64..4096; pinned state may temporarily exceed the target, but every pin-capable store has a finite local cap and their documented aggregate stays below `APP_OWNED_WORST_CASE_PINNED_BYTES` (512 MiB). Neither value caps RSS or native runtime memory. |
| Transport | stream mode, timeouts, proxy settings, `websockets` | `streamMode` persists in config.json; Windows services need a persisted input, and macOS uses it for explicit eager-relay opt-in. |
| Credentials | `apiKeys` | Data-plane only; never admitted to `/api/*`. |
| Lifecycle | `codexAutoStart`, shim/start behavior, resume-history sync, storage cleanup | Startup safety reads these; see [`05_gui-and-management-api.md`](05_gui-and-management-api.md). |

Env values are resolved through `src/config.ts`, so a config value naming an env var never persists
the secret itself. Durable services snapshot only referenced provider/proxy variables into the
owner-only `$OPENCODEX_HOME/service-provider-env.json`; launchd, systemd, Task Scheduler, and WinSW
artifacts carry only that file's path. The service child loads it before runtime config is parsed,
preserves an explicitly manager-supplied value, and fails service preparation when a required
reference exists in neither the shell nor the prior snapshot.

## Config injection

When the base config uses native `openai`, `src/codex/inject.ts` writes one of two forms. The choice
is not cosmetic: it decides whether Codex keeps its native provider id, which decides whether
existing thread history still resolves. External-provider coexistence uses the separate profile
described below and does not enter either base-config transform.

**Loopback (default).** A single marker-owned root override, no provider table:

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
openai_base_url = "http://127.0.0.1:10100/v1"
```

Codex keeps the native `openai` provider id, so new threads stay under that identity instead of
being re-tagged. History that an earlier legacy injection re-tagged as `opencodex` is migrated back
to `openai` once, as restore machinery — a no-op when there is nothing to migrate. A user-owned root
`openai_base_url` is preserved instead of overwritten, and that case also blocks managed sub-agent
defaults rather than fighting the user for ownership.

**API auth header (non-loopback).** The built-in `openai` provider cannot carry the
`x-opencodex-api-key` env header, so this form re-tags the root provider and appends the table:

```toml
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

[model_providers.opencodex]
name = "Remodex Proxy"
base_url = "http://<host>:<port>/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }
```

Root TOML keys must be written before the first `[table]`. Re-injection strips the stale form of
both shapes — Remodex blocks, injected root base-url overrides, and stale unmarked routing
residue — before rewriting, so switching between forms leaves no duplicate active keys. User-owned
root context-window, provider, service-tier, fast-mode, and managed catalog values that must be
inactive during routing stay visible behind `# Remodex preserved while routing:` comments.
Generated replacements are paired with `# Remodex temporary routing value:` markers containing the
exact next line. Fallback restore removes a replacement only while that pair still matches, then
reactivates the preserved line; ambiguous drift fails closed without rewriting `config.toml`.

Native Codex sub-agent defaults are a separate, explicit opt-in. When
`syncCodexSubagentDefaults` is true and `injectionModel` is set, injection writes marker-owned
`agents.default_subagent_model` and, when configured,
`agents.default_subagent_reasoning_effort`. Unmarked values are user-owned and must never be
overwritten. Disabling the option and fallback restore remove only marker-owned values; journal
restore must preserve later user edits while stripping those managed values.

If the root config selects a provider other than `openai` or `opencodex`, sync leaves
`config.toml` byte-for-byte unchanged and performs no history migration. External provider managers
own that routing configuration, and replacing their provider id can hide otherwise intact Codex
sessions. Remodex still refreshes its routed catalog, atomically publishes the same complete catalog
as `$CODEX_HOME/models.json`, and writes `$CODEX_HOME/opencodex.config.toml`. The loopback profile
overlays the base config with:

```toml
model_provider = "openai"
openai_base_url = "http://127.0.0.1:10100/v1"
model_catalog_json = "/absolute/path/to/models.json"
```

The private app-server used by Remodex external clients projects this generated profile's allowlisted
values through app-server's `--config key=value` options; current Codex builds reject `--profile` for
the `app-server` subcommand. An ordinary Codex launch can still use `codex --profile opencodex`, while
the untouched base provider remains the default for ordinary launches. A non-loopback/API-auth
profile uses the `opencodex` provider table and an environment-variable header reference instead.
Profile creation happens without a config journal because there are no base-config bytes to restore.

`codex-lb` is the one narrow adoption exception (`src/codex/provider-adoption.ts`). Remodex adopts
it only when the active TOML table declares the Responses wire, a valid environment-variable name,
and a public non-self-referential HTTP(S) upstream. The provider is added to protected Remodex
config with `responsesPath: "/responses"` and the literal `${ENV_NAME}` reference; the resolved
credential is never read during adoption. An incompatible existing `codex-lb` entry, malformed
table, unsupported wire, or loopback/private/self route fails closed without changing Codex.
Unknown external providers retain the preservation behavior above.

After successful adoption, the original root `model_provider = "codex-lb"`, its
`[model_providers.codex-lb]` table, line endings, Windows tables, and unrelated settings remain
byte-identical and active for ordinary Codex launches. No comments, temporary values, journal, or
history retagging are required. Provider catalog collection runs after adoption, allowing the
visible `data[]` rows from codex-lb and existing Cursor/OpenCode providers to enter `models.json` on
the first sync. The upstream Codex-shaped `models[]` envelope is not treated as generic provider
availability; the OpenAI-compatible `data[]` list is authoritative here, so hidden rows such as
auto-review are not advertised as callable routed models.

`supports_websockets = true` is appended to the provider table only when `websocketsEnabled(config)`
returns true.

## Codex-home diagnostics

Some Codex-home conditions are reported rather than repaired, because repairing them would overwrite
a deliberate user choice:

- Bundled-plugin marketplace state on Windows (`src/codex/plugins-doctor.ts`), surfaced by
  `rmx status`.
- Project-level Codex config that bypasses managed routing
  (`src/codex/project-config-warnings.ts`), surfaced by `rmx doctor` as a warning rather than an
  override.

## Profile and fast tier

Remodex writes `$CODEX_HOME/opencodex.config.toml` as an explicit profile target. For an external
base provider this profile is the sole routing overlay and is automatically selected only by the
private Remodex app-server. Codex config uses `service_tier = "fast"` and
`[features].fast_mode = true`;
catalog/request tier metadata may use `priority`. Do not collapse these spellings into one value.

## Provider output defaults

`OcxProviderConfig.defaultMaxOutputTokens` and `modelMaxOutputTokens` are OpenAI Chat wire defaults,
not context-window metadata. They are applied only when a Responses request omits
`max_output_tokens`; an explicit request value wins, then a model-specific configured value, then
the provider default, then the adapter omits `max_tokens`.

Both fields must stay positive finite integers at disk-config and management validation boundaries.
Registry entries may seed them through `providerConfigSeed`, key-login derivation, OAuth reconcile,
and `routeModel`, but user config overrides registry defaults per field/key.

## Restore

History restore and migration check the first session metadata record for Codex-owned
paginated/ordinal ordering before scanning the rest of a rollout. These files remain
byte-identical; provider changes stay in SQLite. The header probe reads in 64 KiB chunks
with a 16 MiB ceiling, and inconclusive headers retain the latest-metadata validation.
This prevents stop-first package updates from reading whole multi-GB conversations
only to discover that their rollouts cannot be edited.

Legacy rollout metadata is read backwards in 64 KiB chunks, stopping at the latest
applicable record. Each lookup has a 16 MiB total scan ceiling; when the latest
record cannot be proved within that window the rollout is left untouched, never
patched using a stale header. Complete UTF-8 lines are assembled before parsing.
Managed migration also proves pending work under the history lock before opening
any rollout or write-opening the state database. Retained codex-lb rollback entries
alone do not cause completed conversations to be read again.

`rmx stop`, `rmx restore` / `rmx eject`, `rmx service stop`, and `rmx service uninstall` must strip
Remodex config and routed catalog entries without damaging native Codex state.

The exact journal snapshot is the preferred restore when generated artifacts are unchanged. When
the user edited unrelated `config.toml` content while routing was active, marker-based fallback
restores only Remodex-owned settings and preserves those later edits. The durable
`clientIntegrations.codex = false` mode uses the same restore without stopping the proxy, so Android
Remote remains available while its model surface is restricted to native ChatGPT models.

Full `rmx uninstall` config cleanup is ownership-manifest based. A fresh config directory receives a
root-bound owner marker and an uninstall manifest before its first atomic config write. Uninstall
validates both bounded metadata files, rejects path traversal and a symlink/junction config root,
and removes only normalized manifest entries. Manifest-owned directory links are unlinked without
traversing their targets. Unknown files remain in place and make the command report a partial
uninstall with their exact paths.

Legacy nonempty config directories are deliberately not retroactively claimed. If either ownership
file is missing, malformed, or bound to another root, uninstall refuses config deletion and reports
the residual directory for manual review; there is no recursive-delete fallback.
