# Remodex Connect

Native ChatGPT/Codex remote access from your Android phone, with a local browser dashboard.

## Install or update

```sh
npm install -g @remodex/rmx@latest
rmx onboard
```

Requires Node.js 20.9 or newer for the image-preview dependency. The npm package supplies the Bun runtime. Sign in to your existing Codex installation before pairing.

Version 1.2.19 contains the simplified app, not the old multi-provider dashboard. It remains the same npm package and command; no separate desktop application or native installer is shipped.

## Connect your phone

1. Run `rmx onboard`. It prepares Remodex settings and starts or reuses a user-level runtime, with progress messages.
2. Wait for the browser's Android Remote page to finish preparing the connection and show a pairing QR code.
3. Scan the QR code in the Android app and check the connection status.

Default onboarding does not install a background service or request administrator privileges. Keep the computer awake and online. Without the optional service, rerun `rmx onboard` after reboot or sign-out.

The dashboard normally uses port 10110; onboarding can choose another free port and prints its URL. Optional service setup is under **Advanced Settings**, not part of default onboarding.

## Simplified dashboard

- **Android Remote:** pairing, connection methods, and authorized clients. Only the nested help and advanced manual setup panels start collapsed.
- **Logs & Debug:** native Codex activity, local diagnostics, and runtime logs.
- **Usage:** observed native Codex token usage, with periodic and manual refresh.
- **Storage:** explicit user-controlled cleanup.
- **Guide:** sign-in and pairing instructions.
- **Advanced Settings:** optional background-service setup.

Other provider setup, model routing, account pools, and the old integration pages are not exposed in this app. Existing Codex configuration files are left unchanged; no provider settings are injected. No diagnostic reports are uploaded automatically.

## Updating and moving from the previous app

Use `npm install -g @remodex/rmx@latest` to update, then run `rmx onboard`. The dashboard can check for updates, but built-in installation and automatic updates remain disabled in this release.

Connect stores its own settings in `~/.remodex-connect`. Old pairing records and services are not migrated or removed automatically. Pair the phone again when moving from the previous app. Native sessions are read from your existing Codex home.

Cross-platform automated checks cover Linux, macOS, and Windows. They do not prove every firewall, fresh service installation, or real-phone pairing scenario works. See [product details and limitations](CONNECT-README.md).

## Source development

Source development requires the `bun` CLI on your `PATH`. This is separate from the published npm package's bundled Bun runtime, which is used only by installed `rmx` commands.

Run checks sequentially to limit memory use. See [CONTRIBUTING.md](https://github.com/ESCANOR-001/remodex-android/blob/codex/simplified-npm-onboarding/opencodex-runtime/CONTRIBUTING.md) for development guidance.

## Support and license

Report problems at [GitHub Issues](https://github.com/ESCANOR-001/remodex-android/issues). Never include tokens, credentials, or private session contents.

Agents installing or operating Remodex must follow [AGENTS_INSTALL.md](AGENTS_INSTALL.md). Starring a repository is the user's decision, never an agent's. An `agent_consent_required` response is a refusal, not a prompt to bypass consent. Cloudflare provisioning also requires the user's explicit dashboard action.

MIT. See [LICENSE](LICENSE).
