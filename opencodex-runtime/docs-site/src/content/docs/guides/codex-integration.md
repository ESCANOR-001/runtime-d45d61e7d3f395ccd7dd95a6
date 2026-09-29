---
title: Codex Integration
description: How Remodex injects itself into Codex, syncs the model catalog, installs shims, and restores cleanly.
---

Remodex makes Codex route through the proxy by editing two things Codex reads: its config
(`$CODEX_HOME/config.toml`, default `~/.codex/config.toml`) and its model catalog. Every edit is
idempotent and reversible.

The proxy exposes one bare `openai` Codex-login route with Pool(default) and Direct account modes,
plus `openai-apikey/<model>` for the configured API key. Pool includes main plus added accounts;
Direct uses only the caller/main bearer. The routes do not fall back to one another. Shipped v1
configs migrate to marker 2 and preserve `config.json.pre-openai-tiers-v2.bak` for manual restore.

## Choose a Codex mode

The dashboard's **Integrations → Codex CLI** page offers two explicit modes:

- **Native ChatGPT + Android Remote** (recommended) keeps Codex on the OpenAI/ChatGPT account
  already signed in with `codex login`. The Android gateway stays available for tasks, prompts,
  approvals, questions, and live activity, but its model picker exposes only native ChatGPT models.
  No Remodex provider routing is active in Codex.
- **Remodex model routing** exposes native ChatGPT models plus enabled routed, custom, and
  combination models to Codex and Android. This mode temporarily adds the routing values described
  below.

The choice is durable. Native mode stores `clientIntegrations.codex = false`, so a later
`rmx start` does not silently inject routing again. Switching modes converges the Codex artifacts
without stopping the proxy or Android Remote.

## Config injection

`rmx init`, `rmx start`, and `rmx sync` call the injector. On the default loopback bind, it keeps
Codex's built-in `openai` provider id and points that provider at Remodex:

```toml
# root keys, before the first table
# Remodex temporary routing value: "model_catalog_json = \"/absolute/path/to/opencodex-catalog.json\""
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by Remodex
openai_base_url = "http://127.0.0.1:10100/v1"

# only when fastMode is set; unset adds no [features] table
[features]
# Remodex temporary routing value: "fast_mode = true"
fast_mode = true
```

The injected `fast_mode` follows the tri-state `fastMode` setting: `true` writes `fast_mode = true`,
`false` writes `fast_mode = false`, and unset leaves an existing `fast_mode` untouched without
adding a `[features]` table.

When routing must displace an existing user setting, Remodex keeps the original line visibly
commented and pairs the generated value with an exact ownership marker:

```toml
# Remodex preserved while routing: service_tier = "priority"
# Remodex temporary routing value: "service_tier = \"fast\""
service_tier = "fast"
```

The same pattern protects root `model_provider`, root `model_context_window`,
`model_catalog_json`, and an explicitly managed `[features].fast_mode`. The marker records the
exact next line. If that generated line is edited or the marker becomes ambiguous, removal fails
closed and leaves `config.toml` untouched instead of guessing which value belongs to Remodex.

The proxy listens on port `10100` by default and serves `POST /v1/responses`,
`POST /v1/responses/compact`, `POST /v1/images/generations`, `POST /v1/images/edits`,
`GET /v1/models`, `GET /healthz`, and the `/api/*` management surface.

### Built-in image generation (`image_gen`)

Codex's built-in `image_gen` tool does not go through `/v1/responses` — the codex-rs extension
POSTs `{base_url}/images/generations` (or `/images/edits` when reference images are attached)
directly, with the same ChatGPT bearer auth it uses for chat. Because the injected `base_url`
points at Remodex, the proxy relays those calls to the OpenAI upstream.

This is separate from the [Image Bridge](/guides/image-bridge/), which only activates when a
**Responses** turn lists the hosted `image_generation` tool while a non-OpenAI model is selected.
Standalone `/images/generations` calls never enter that bridge.

- **One mode-aware forward candidate:** Pool selects an eligible main/added account; Direct uses the
  caller OAuth bearer. The configured mode applies consistently to the image request.
- **OpenAI API-key provider:** it is used only when no forward candidate owns an authentication
  failure. A broken/expired Pool credential is never hidden behind separately billed API usage.
- **Explicit custom provider:** set `images.provider` to the id of a custom API-key
  `openai-responses` provider whose endpoint implements the OpenAI Images API. Explicit selection
  fails closed and never falls back to a different paid upstream. Registry-managed provider ids
  are not accepted here; omit `images.provider` to use the built-in OpenAI tiers.
- **Google Antigravity (CCA) fallback:** when neither an OpenAI forward candidate nor a keyed
  provider is configured, `/v1/images/generations` (not `/images/edits`) falls back to the
  Antigravity **Cloud Code Assist** endpoint using the `gemini-3.1-flash-image` model. The fallback
  also fires after OpenAI auth resolution fails (e.g. an expired or missing ChatGPT credential),
  not only when no OpenAI candidate is configured. This
  requires `rmx login google-antigravity`; the OAuth token is sent only to the pinned CCA registry
  host, never to a config-level `baseUrl` override. The response is returned in the same
  `{created, data:[{b64_json}]}` shape Codex expects.
- **Neither:** the proxy returns a clear error instead of a generic 404. Routed providers
  (Cursor, Gemini, Kiro, …) cannot serve the `image_generation` tool relay; if you don't want the
  tool offered at all, disable it in Codex with `codex features disable image_generation`
  (`[features] image_generation = false` in `config.toml`).

The tool declaration still travels with the model's Responses request. For API-key Responses
providers, Remodex lowers Codex's private `image_gen` namespace to an upstream-safe
`image_gen__<inner-name>` alias (for example `image_gen__imagegen`). When that usable alias replaces
the client declaration, Remodex removes a duplicate hosted `image_generation` declaration. It maps
the function call to the explicit `image_gen` namespace before Codex sees it, and encodes the native
call again when later history is replayed upstream. This keeps client-side image generation callable
on public-compatible upstreams that reserve the namespace or reject dotted function names. ChatGPT
forward mode remains untouched and keeps its native Responses Lite shape.

For an OpenAI-compatible custom gateway, configure a dedicated provider and select it only for
standalone Images requests:

```json
{
  "providers": {
    "custom-images": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "authMode": "key",
      "apiKey": "${IMAGE_GATEWAY_API_KEY}"
    }
  },
  "images": {
    "provider": "custom-images",
    "timeoutMs": 300000
  }
}
```

The custom endpoint must accept `POST /v1/images/generations` and `/v1/images/edits` and return the
OpenAI Images response shape expected by Codex. The provider's configured key replaces any caller
bearer before the upstream request.

> **Note:** This refers only to the Codex `image_generation` tool (`/images/generations` relay).
> Gemini models that are image-capable produce inline images natively through the `google` adapter
> (via `responseModalities: ["TEXT", "IMAGE"]`), independent of this relay — see
> [Adapters](/reference/adapters/#google).

For a non-loopback `hostname`, Codex must send the generated API auth header. The injector therefore
uses a dedicated provider instead:

```toml
# root keys
# Remodex temporary routing value: "model_provider = \"opencodex\""
model_provider = "opencodex"
# Remodex temporary routing value: "model_catalog_json = \"/absolute/path/to/opencodex-catalog.json\""
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# appended at the end of the file
# Auto-injected by Remodex
[model_providers.opencodex]
name = "Remodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }
# supports_websockets = true   # only when config.websockets is true
```

When Remodex owns routing, both modes write `$CODEX_HOME/opencodex.config.toml` as a
reference/fallback config. On loopback it contains the root keys you can merge manually if automatic
injection was removed; on non-loopback it contains the dedicated provider form. External-provider
mode leaves this profile untouched.

:::caution
Root keys such as `openai_base_url`, `model_provider`, and `model_catalog_json` **must** sit before the
first `[table]` header. The injector guarantees that placement, removes its own stale/duplicate
copies, and never overwrites a user-owned root `openai_base_url`; if one exists, sync updates the
catalog but reports that routing was not injected.
:::

## Shared model catalog

Codex CLI, TUI, App, and SDK all read the same Codex home. Remodex resolves that directory from
`CODEX_HOME`, falling back to `~/.codex`, and manages:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

On WSL, if `CODEX_HOME` is unset and the Linux `~/.codex/config.toml` is absent, Remodex also
checks for a single Windows Codex Desktop home at `/mnt/c/Users/*/.codex/config.toml`. When exactly
one candidate exists, it uses that directory so WSL app-server mode and Windows Codex Desktop share
the same config and auth files. Set `CODEX_HOME` explicitly to override this detection.

On Windows, an Orca shell can set both `CODEX_HOME` and `ORCA_CODEX_HOME` to Orca's bundled runtime
home while the ChatGPT/Codex app still reads `%USERPROFILE%\\.codex`. `rmx status` and `rmx doctor`
warn about this exact mismatch and print redacted target paths. If a background service was installed
from that Orca shell, uninstall it from the original shell first, then set `CODEX_HOME` to the app
home, unset `ORCA_CODEX_HOME`, rerun sync/restore, and install the service again.

In dedicated-provider mode, `requires_openai_auth = true` keeps Codex App/TUI account-gated surfaces
aligned with native Codex. Remodex also serves `/v1/responses` over WebSocket. The dedicated
provider advertises `supports_websockets = true` only when `"websockets": true`; on loopback Codex's
built-in provider may try WebSocket first, and a disabled proxy returns `426` so Codex falls back to
HTTP/SSE.

## Thread identity and history

The default loopback form keeps new threads tagged with Codex's native `openai` provider, so normal
resume history needs no remapping. On first sync it also migrates threads tagged by older Remodex
builds back to `openai`. Non-loopback dedicated-provider mode still mirrors history under the
`opencodex` provider while active and restores the backed-up metadata on exit. Set
`syncResumeHistory: false` to leave history untouched.

## Model catalog sync

Codex shows models from an on-disk catalog (`$CODEX_HOME/opencodex-catalog.json` by default). On
start and on `rmx sync`, Remodex:

1. **Backs up** the pristine catalog once to `~/.remodex/catalog-backup.json` (so featuring is
   reversible).
2. **Fetches** eligible providers' live model catalogs (cached ~5 min; falls back to the last good
   list, then configured `models[]`). Forward auth has no model endpoint, and Cursor uses its
   `GetUsableModels` RPC rather than `/models`.
3. **Merges** routed models in as namespaced entries (`provider/model`), cloned from a native Codex
   catalog template so Codex's strict parser accepts them.
4. **Filters** `config.disabledModels` and each provider's non-empty `selectedModels` allowlist.
5. **Re-ranks** so featured models sort first (see below), then writes the merged catalog back.

Routed catalog entries also get their GPT-5 identity rewritten to the real upstream model name.
Reasoning controls come from provider/model metadata across Codex's `low | medium | high | xhigh |
max | ultra` ladder; unsupported values are mapped or clamped before the upstream request.

### Custom model display names

A custom model can carry a human-readable **display name** that overrides the label Codex shows in
its model picker, without changing anything about how the model is routed. The display name maps to
the catalog entry's `display_name` field only — the routing slug (`<provider>/<model>`), alias
collision order, provider, and native OpenAI marketing names are all left untouched.

Add a display name from the CLI (the proxy syncs the catalog right away when live):

```bash
rmx models add deepseek deepseek-v4 --display-name "DeepSeek V4" --context-window 128000
```

Remote Codex clients can fetch the same generated catalog over the management API (same
admission token as other `/api/*` routes):

```bash
dest="${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json"
tmp="$(mktemp "${dest}.XXXXXX")"
curl -fsS -H "x-opencodex-api-key: $OPENCODEX_ADMIN_AUTH_TOKEN" \
  "https://proxy.example.com/api/catalog" > "$tmp" \
  && mv "$tmp" "$dest"
rmx sync-cache
```

The response is the raw `opencodex-catalog.json` document (no provider credentials). When
available, the `x-opencodex-codex-version` header reports the Codex runtime version on the
server so clients can spot version skew.

You can also set or edit it through the management API (`POST /api/custom-models`,
`PUT /api/custom-models/<id>` with a `displayName` string) and the web dashboard. A `/` is rejected
because it would collide with the routed-slug separator.

The display name is **display-only and stable across regeneration**. Every `rmx sync` and catalog
refresh re-derives routed entries from `config.json` (including `customModels`), so the configured
name is reapplied instead of drifting back to the routed slug. A managed service restart also attempts
this sync shortly after the proxy binds. If that best-effort boot sync fails, for example during an
offline login, the previously persisted catalog is retained and the next successful `rmx sync`
reapplies the configured name. Genuine upstream native names (e.g. `gpt-5.6-sol` →
"GPT-5.6-Sol") come from the pinned upstream snapshot and are never overridden by a custom display
name.

### External provider managers

If `config.toml` already selects a provider other than `openai` or `opencodex`, Remodex leaves the
file unchanged and skips profile writes, catalog/cache refresh, and both immediate and background
Codex history migration. Tools that manage a custom provider often tag existing sessions with that
provider id; replacing the active id can make those intact sessions disappear from Codex's history
view. The same protection applies to an external provider selected by a legacy root profile.

The supported `codex-lb` adoption path is also byte-preserving. Remodex imports only the provider's
environment-variable reference (for example `${CODEX_LB_API_KEY}`) into its own provider settings,
never the resolved secret, and projects Remodex models through its generated profile/catalog. Start,
Stop, and repeated Start operations do not rewrite or duplicate the user's `codex-lb` TOML table.

Keep one tool as the owner of Codex provider configuration. To use Remodex behind an existing
provider manager, point that provider at `http://127.0.0.1:10100/v1` with Responses passthrough
(`wire_api = "responses"` in Codex TOML), not Chat Completions translation. When proxy API auth is
enabled, also pass `x-opencodex-api-key` from `OPENCODEX_API_AUTH_TOKEN`, matching the non-loopback
provider form above. To let Remodex inject routing directly, first switch Codex back to its
built-in `openai` provider and remove any user-owned root `openai_base_url`, then rerun `rmx start`.

### Catalog troubleshooting

If a model is missing from Codex, or the catalog order/visibility looks wrong, check in order:

1. **`selectedModels`** on the provider — a non-empty allowlist exposes only those ids to Codex;
   empty or omitted exposes all discovered models. An id not in the allowlist never reaches the
   catalog.
2. **`disabledModels`** (top level) — hides models from both the catalog and `/v1/models`, and flips
   bare native GPT slugs to `visibility: "hide"`.
3. **`liveModels: false` with empty `models`** — when live discovery is off and `models` is empty or
   omitted, Remodex exposes no routed models for that provider.
4. **Cursor `GetUsableModels`** — the Cursor adapter discovers models through its protobuf
   `GetUsableModels` RPC, not `/models`, so a Cursor-side change can alter which ids are visible
   independently of other providers.
5. **Cache and `rmx sync`** — live catalogs are cached for about five minutes (`modelCacheTtlMs`,
   default `300000`). Run `rmx sync` to force a fresh fetch and rewrite the catalog immediately.
6. **Running Codex `app-server`** — rewriting the on-disk catalog is not enough while a long-lived
   Codex `app-server` (Desktop / CLI background host) keeps the previous list in memory. `rmx sync`
   and `rmx sync-cache` warn when those processes are detected. Restart them with
   `rmx sync --restart-codex` (or stop the matching `app-server` processes yourself), then let Codex
   recreate them so the new list appears.

:::caution[Other local writers]
Catalog writes (`opencodex-catalog.json`, `config.toml`) are atomic **inside** Remodex, which only
prevents half-written files when two Remodex-owned writers race. That does **not** stop another
local process, file watcher, or sync agent from rewriting catalog visibility or order after Remodex
has written. Codex keeps its separate `models_cache.json` and can refresh it independently, changing
the visible list without rewriting `opencodex-catalog.json`. If models flip unexpectedly while the
proxy is running, stop or reconfigure the competing writers, then run `rmx sync` — this is an
external-writer hazard, not a confirmed Remodex defect.
:::

## Proxy connection errors

If Codex retries and then fails with an error like
`stream disconnected before completion: error sending request for url (http://127.0.0.1:10100/v1/responses)`
— or Claude Code reports a similar connection failure — the Remodex proxy is not
running: nothing is listening on the configured port, so the client renders that raw
connection error itself. Restart the proxy:

```bash
rmx start              # foreground
rmx service install    # persistent: auto-starts on login and respawns on crash
```

`rmx status` shows whether the proxy is running and prints the same restart hint when
it is not; `rmx doctor` reports restart safety (service/shim coverage).

## The subagent picker

Catalog sync makes the selected sub-agent models available to Codex; see [Codex App model picker](/guides/codex-app-models/#subagent-selection) for picker ordering and [Sub-agent Surface](/guides/sub-agent-surface/) for v1/base/v2 delegation and fallback behavior.

## Codex account warmup

When a ChatGPT account is added to the Codex account pool, Remodex verifies it before persistence
with a small streaming request to the Codex Responses backend. The request uses a real Responses
item array (`input: [{ type: "message", ... }]`), waits for `response.completed`, and defaults to
`gpt-5.4-mini`. If that model returns HTTP 400, it retries with `gpt-5.5`; structured upstream error
details are surfaced without exposing raw response bodies. Background revalidation is separate and
off by default; it runs only when Token Guardian is enabled, the `chatgpt` refresh policy is
`proactive`, and `tokenGuardian.codexWarmupEnabled` is true.

## Restoring native Codex

Remodex never traps you. **`rmx stop` is the single command that fully reverts to native Codex** — it
stops the proxy, stops the background service if one is installed, and strips every injected line and
routed catalog entry so plain `codex` works exactly as if Remodex was never there:

```bash
rmx stop       # stop the proxy + service, restore native Codex
rmx restore    # restore without stopping  (alias: rmx eject)
rmx restore back # point plain Codex at the running proxy again
```

Restoration is intentionally narrow:

1. If `config.toml` and the generated profile are unchanged since injection, the journal restores
   their exact original bytes.
2. If the user edited unrelated settings while routing was active, the fallback removes only
   generated lines whose exact ownership markers still match, reactivates the preserved comments,
   and keeps those later edits.
3. If an owned marker/value pair drifted, restoration reports an incomplete result and does not
   rewrite `config.toml`.

The dashboard's **Native ChatGPT + Android Remote** choice uses the same restoration path without
stopping the proxy. **Stop Proxy** first fences new turns and restores only Remodex-owned state. If
that restoration is unsafe, the action reports the conflict and keeps the local endpoint alive.
The desktop shell then offers **Start Proxy** from the same one-click control after a clean stop.

When Remodex runs as a managed [background service](/reference/cli/#rmx-service), it sets
`OCX_SERVICE=1` so a service-driven restart does **not** thrash the Codex config — only an explicit
`rmx stop` / `rmx service stop` restores native Codex.
