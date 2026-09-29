---
title: Installation
description: Install the Remodex proxy, its prerequisites, and verify it runs.
---

Remodex installs `rmx` as the primary command. The legacy `remodex`, `opencodex`, and `ocx` aliases remain
available for compatibility; all four launch the same small local HTTP server (built on Bun). Model requests go to the provider selected by routing; optional
vision and web-search sidecars can also use your ChatGPT login when a routed model needs them.

## Prerequisites

| Requirement | Why |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 20.9** | Required by the image-preview dependency. `rmx` runs on the Bun runtime, but the runtime is bundled automatically on `npm install` — you do **not** need to install Bun yourself. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App, or SDK) | The client Remodex connects to. Changes to `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) require explicit permission. |
| A provider account or API key | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, an OpenAI-compatible endpoint, or your ChatGPT login. |

## Install

```bash
npm install -g @remodex/rmx
```

That npm package is the complete Remodex product. Windows does not require or install a separate
Remodex desktop application or native installer.

:::note[npm blocked the bun postinstall?]
Recent npm versions may block bun's postinstall script (`npm warn
install-scripts ... blocked because they are not covered by allowScripts`),
which leaves the bundled Bun runtime unprepared. Reinstall allowing bun's
script — and always include the package name (npm's abbreviated suggestion
omits it, which would reinstall the current directory instead):

```bash
npm install -g --allow-scripts=bun @remodex/rmx

# if the original install used sudo, keep using sudo:
sudo npm install -g --allow-scripts=bun @remodex/rmx
```
:::

Verify the canonical Remodex command is on your `PATH`:

```bash
rmx --version
```

The npm install only installs the CLI; it never edits Codex from an npm lifecycle hook. Complete
the normal setup with one command:

```bash
rmx onboard
```

`rmx onboard` has three stages: **prepare this computer → start the background service → prepare your pairing code**. Each stage announces what is happening; long-running work prints a waiting message every four seconds. The QR page opens as soon as the dashboard is available and shows preparation progress. A usable QR appears when either same-Wi-Fi access or a verified remote connection is ready. Existing providers, integration choices, and custom domains are preserved. Optional Windows tray setup, updater repair, and Codex integration changes do not block pairing; find them under **Android Remote → Advanced Settings**.

Connect both devices to the same trusted network, then tap **Scan QR code** on your phone. **Free temporary link** prepares in the background. The phone verifies and saves the remote address through its paired connection, so changing networks does not require another scan. A remote setup failure does not stop a ready Wi-Fi connection.

The connection settings open on **Local**, alongside **Free temporary link** and **Custom domain**. Switching local access off or on keeps the running tunnel and its address. Failed network checks also keep a live Quick Tunnel connector so it can reconnect. If the connector exits or is explicitly restarted, its temporary address can change. A phone already away may need to reconnect over Wi-Fi to learn the replacement; an optional custom domain provides a fixed address. Background setup never changes system DNS or opens an administrator command window.

On Windows, approve the single permission request if setup needs to install its background task. You can start in ordinary PowerShell. Use the same computer account that runs Codex.

Use `rmx onboard --verbose` for detailed checks, `--no-open` to leave the browser closed, or `--json` for automation.

The dashboard's **Sync models** action is an explicit opt-in exception. It first warns that the
Codex/ChatGPT desktop client will be force-closed and unsaved input can be lost. After confirmation, Remodex temporarily replaces
the active global provider/profile/base URL and model catalog, restarts Codex/ChatGPT Desktop, and
keeps the original settings available for normal `rmx stop` or `rmx restore` recovery.

After installation, running `rmx` with no arguments is the one-command startup:
it installs or refreshes the supervised background service and starts the proxy.
Use `rmx --help` when you want help without starting anything.

For global npm/Bun installs, unattended package updates are enabled by default after the first normal
bootstrap. Updater repair does not block phone pairing; use `rmx system update auto on` if needed. The server checks at startup and about
every 30 minutes; reopening Android refreshes checks older than five minutes. A daily operating-system
job remains as a backup. Installation waits until task status confirms it is safe to restart.
Remodex verifies a
concrete package version and its registry integrity before installing, then health-checks and records
rollback information after the service restarts. Inspect or change this behavior with:

```bash
rmx system update auto status
rmx system update auto off
rmx system update auto on --channel latest
```

The state and diagnostic log stay under `~/.remodex` (`auto-update.json` and `auto-update.log`).
Source checkouts are never auto-updated.

`remodex`, `opencodex`, `ocx`, and `rmx` remain equivalent compatibility aliases. When a provider uses an
environment reference such as `${CODEX_LB_API_KEY}`, Remodex checks the current process first and
then the OS user environment (systemd/launchd/Windows user settings and safe shell environment
files). The secret is loaded only in memory; it is never copied into `config.json` or Codex's
`config.toml`.

### Release channels

The stable `latest` channel already includes GPT-5.6 Sol/Terra/Luna catalog support for ChatGPT,
OpenAI API-key, OpenRouter, and experimental Cursor routes. Upstream access is still account-gated;
the catalog entries do not grant access by themselves. Use the preview channel only to test
unreleased Remodex builds:

```bash
npm install -g @remodex/rmx@preview
rmx update --tag preview
```

## Run from source

To hack on Remodex itself:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # starts the proxy API in dev mode (src/cli/index.ts start)
bun run dev:gui     # starts the dashboard dev server (another terminal)
```

`bun run dev` remains an alias for `bun run dev:proxy`. The proxy API exposes `/healthz`,
`/v1/responses`, and `/api/*`; `GET /` serves the packaged dashboard only after `bun run build:gui`
has produced `gui/dist`. While hacking on the dashboard, run the frontend separately with
`bun run dev:gui`.

## What gets created

Remodex state lives under `$OPENCODEX_HOME` (default `~/.remodex`). Codex integration files live
under `$CODEX_HOME` (default `~/.codex`).

The Codex files and catalog backups below are created or changed only after [explicit configuration permission](/reference/cli/lifecycle/#codex-configuration-permission). Phone pairing does not require that permission.

| Path | Purpose |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | Your providers, default provider, port, and options. |
| `$OPENCODEX_HOME/ocx.pid` | PID of the running proxy (single-instance guard). |
| `$OPENCODEX_HOME/runtime-port.json` | The live PID, hostname, and port, including an automatically selected fallback port. |
| `$OPENCODEX_HOME/auth.json` | Stored OAuth credentials (when you `rmx login`). |
| `$OPENCODEX_HOME/catalog-backup*.json` | Codex model catalog backups made before Remodex edits it. |
| `$CODEX_HOME/config.toml` | On loopback, Remodex adds a marker-owned root `openai_base_url`; non-loopback binds use `model_provider = "opencodex"` plus `[model_providers.opencodex]` so Codex can send the API-auth header. |
| `$CODEX_HOME/opencodex.config.toml` | Fallback/reference profile written alongside the main Codex config. |
| `$CODEX_HOME/opencodex-catalog.json` | Synced native and routed model catalog used by Codex. |

:::note
Remodex never deletes your Codex config. With configuration permission, `rmx stop`, `rmx restore`,
or `rmx eject` can remove unchanged Remodex-managed entries and restore saved native settings. Without permission, existing files stay untouched, including entries left by older releases.
:::

## Next

Continue to the [Quickstart](/getting-started/quickstart/) to configure your first provider,
or read [How It Works](/getting-started/how-it-works/) for the architecture.
