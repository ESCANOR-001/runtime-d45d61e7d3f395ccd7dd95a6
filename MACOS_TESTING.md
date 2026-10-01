# macOS regression checks

Run **macOS full regression and npm installation** manually in GitHub Actions.
It tests standard macOS 15 Apple Silicon and Intel runners, with read-only
permissions, pinned actions, no secrets, and no automatic publishing.

## Coverage

- Every runtime test file, including nested suites, in four deterministic shards
  per architecture. Individual failing files do not prevent later files running.
- Typecheck, privacy scan, dashboard build/tests/lint, documentation build, and
  real macOS Keychain create/read/delete on both architectures.
- Node 20, 22, and 24: npm install, build with bundled Bun, package asset validation,
  installation under spaces/Unicode paths, and standalone Bun absent from PATH.
- Installed bash/zsh launchers, architecture-matched bundled Bun and native image
  processing/Keychain modules, two start/dashboard/status/stop cycles on the same
  port, unchanged Codex configuration, and uninstall cleanup.

## Boundaries

These are disposable CI runners, not certification of every macOS version or user
configuration. Interactive Keychain permission prompts, Gatekeeper/quarantine,
sleep/resume, login-session launchd behavior, real networks/tunnels and pairing to
a signed-in Codex desktop still need targeted real-device checks. Existing
platform-specific and credential-dependent test skips are not disabled.

No Android source is exported. No package is published, no background service is
enabled, and no developer profile is modified. The installed-package checks use
their own temporary npm prefix, HOME and Codex profile.
