# Windows regression checks

Run **Windows full regression and npm installation** manually from GitHub Actions
on the server-only branch. The workflow never publishes a package or installs
anything on a developer's PC. It uses standard hosted Windows runners, read-only
permissions, pinned actions, and no repository secrets.

## Coverage

- Windows Server 2022 and 2025: every runtime test file, including nested suites,
  divided deterministically into four shards per OS. A failing file does not
  prevent later files in that shard from running.
- Both Windows environments: runtime typecheck, privacy scan, dashboard build,
  dashboard tests and lint, documentation build, and a real credential-store
  create/read/delete round trip.
- Node 20, 22, and 24 on both Windows environments: build with the npm-bundled
  Bun dependency, pack the exact checkout, verify packaged assets, and install
  into a disposable global prefix containing spaces and a non-ASCII character.
- Installed-package checks with standalone Bun removed from PATH: Node launcher,
  command-prompt and PowerShell shims, native image processing and keyring imports,
  two server start/dashboard/status/stop cycles on the same port, unchanged Codex
  configuration, and npm uninstall cleanup.

## Boundaries

Hosted Windows Server runners are not Windows 10/11 desktop certification. They
cannot prove interactive UAC behavior, Windows Defender/third-party antivirus
compatibility, sleep/resume, a real user's network/firewall/tunnel conditions, or
Android-to-desktop pairing with a signed-in Codex account. Those still need
hands-on testing. Credential-dependent tests retain their existing skip gates;
no account credentials are injected into public CI. Android source stays private.

The smoke uses disposable CI profiles and does not enable background services,
modify a user's real Codex configuration, or publish to npm. PowerShell's execution
policy override is process-local for the smoke, not a machine setting.
