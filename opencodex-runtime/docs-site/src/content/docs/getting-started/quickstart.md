---
title: Quickstart
description: Configure Codex, the background service, and Android Remote with one command.
---

For a normal ChatGPT/Codex account or an already configured external provider, run:

```bash
rmx onboard
```

`rmx onboard` has three stages: **prepare this computer → start the background service → prepare your pairing code**. Each stage announces what is happening; long-running work prints a waiting message every four seconds. The QR page opens as soon as the dashboard is available and shows preparation progress. A usable QR appears when either same-Wi-Fi access or a verified remote connection is ready. Existing providers, integration choices, and custom domains are preserved. Optional Windows tray setup, updater repair, and Codex integration changes do not block pairing; find them under **Android Remote → Advanced Settings**.

Phone pairing leaves your Codex `config.toml`, model catalog, and existing chat history unchanged. Android reads the existing provider settings. Starting, restarting, or updating Remodex does not grant permission to rewrite them. See [optional Codex configuration access](/reference/cli/lifecycle/#codex-configuration-permission) before enabling Desktop routing changes.

Connect both devices to the same trusted network, then tap **Scan QR code** on your phone. **Free temporary link** prepares in the background. The phone verifies and saves the remote address through its paired connection, so changing networks does not require another scan. A remote setup failure does not stop a ready Wi-Fi connection.

The connection settings open on **Local**, alongside **Free temporary link** and **Custom domain**. Switching local access off or on keeps the running tunnel and its address. Failed network checks also keep a live Quick Tunnel connector so it can reconnect. If the connector exits or is explicitly restarted, its temporary address can change. A phone already away may need to reconnect over Wi-Fi to learn the replacement; an optional custom domain provides a fixed address. Background setup never changes system DNS or opens an administrator command window.

The sections below are the manual path for adding another model provider or running Remodex in the
foreground.

## Add a provider (optional)

```bash
rmx init
```

`rmx init` walks you through:

1. **Pick a provider** — choose one of the 76 built-in registry presets or `custom` to type a base
   URL and adapter.
2. **API key** — paste a key, or reference an environment variable like `${ANTHROPIC_API_KEY}`.
3. **Default model** — for key, local, and custom providers, accept the preset or enter a model id.
4. **Proxy port** — defaults to `10100`.
5. **Allow changes to Codex?** — the default is **No**. Only an explicit **Yes** grants ongoing permission. On a normal loopback setup, approved integration adds a root `openai_base_url` to
   `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) so Codex's built-in `openai` provider
   targets the proxy. Remote/LAN binds use a dedicated provider entry with an API-auth header instead.
6. **Install the autostart shim?** — when enabled, launching `codex` runs `rmx ensure` first.

The result is saved to `$OPENCODEX_HOME/config.json` (default `~/.remodex/config.json`).

:::note[GPT-5.6 rollout entries]
The current stable release seeds GPT-5.6 Sol/Terra/Luna for ChatGPT passthrough, OpenAI API-key,
OpenRouter, and
the experimental Cursor adapter. They work only when that upstream account has access. The OpenAI
API-key and OpenRouter presets advertise a 372,000-token usable context window; Cursor keeps its own
adapter metadata.
:::

## Start manually (optional)

```bash
rmx                  # install/refresh the background service and start the proxy
rmx start            # foreground mode, defaults to port 10100
rmx start --port 8080
```

The no-argument `rmx` command is shorthand for `rmx service`: it installs or refreshes the
platform service and starts the proxy under supervision. Use `rmx start` when you specifically
want a foreground process.

On startup, Remodex:

- writes its PID to `~/.remodex/ocx.pid` (and refuses to start twice),
- discovers available models; it updates Codex's model catalog only when configuration access was explicitly granted,
- listens on `http://localhost:<port>/v1`.

If the requested port is busy, `rmx start` selects a free port, records it in `runtime-port.json`,
and, only with configuration permission, updates Codex to use the live listener.

Check it:

```bash
rmx status
rmx gui       # open the dashboard on the live port
```

## Use Codex

With approved Desktop integration, Codex talks to Remodex transparently. Otherwise it continues using your existing connection:

```bash
codex "Refactor this function for readability"
```

To target a specific routed model, use the `provider/model` form Codex's model picker shows:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

## Choose sub-agent models (optional)

A fresh config features five native models in Codex's sub-agent picker: `gpt-5.5`,
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and `gpt-5.4-mini`. Open `rmx gui` to replace or
reorder up to five native or routed models. The dashboard can also set one preferred sub-agent model
and reasoning effort. See [Sub-agent Surface](/guides/sub-agent-surface/) to choose v1/base/v2 and
understand when guidance, native defaults, and fallback apply.

## Logging in instead of pasting a key

Some providers support real account login (OAuth, auto-refreshed):

```bash
rmx login xai          # or: anthropic, kimi, kiro, google-antigravity, cursor
rmx logout xai
```

OpenAI itself needs **no key** — the default provider forwards your existing `codex login`
credentials straight through (see [Providers](/guides/providers/)).

## Stopping & restoring

```bash
rmx stop          # stop the proxy and restore native Codex
rmx restore       # restore native Codex without stopping (alias: rmx eject)
rmx restore back  # route Codex through the still-running proxy again
```

## Next

- [How It Works](/getting-started/how-it-works/) — what happens to each request.
- [Providers](/guides/providers/) — every way to authenticate.
- [Configuration](/reference/configuration/) — the full `config.json` reference.
