# Linux regression checks

Run **Linux full regression and npm installation** manually in GitHub Actions.
The workflow uses standard Ubuntu 22.04 and 24.04 x64 runners, read-only
permissions, pinned actions, no secrets, and no automatic publishing.

## Coverage

- Every runtime test file, including nested suites, split into four deterministic
  shards on each Ubuntu version. Failed files do not prevent later files running.
- Typecheck, privacy scan, dashboard build/tests/lint, and documentation build.
- Real Secret Service create/read/delete using a temporary private HOME, D-Bus
  session, runtime directory and unlocked GNOME keyring. No developer keyring or
  account credentials are used.
- Node 20, 22, and 24: npm install, build with bundled Bun, package validation,
  installation under spaces/Unicode paths and no standalone Bun in PATH.
- Bash/sh command launchers, architecture-matched Bun and native image/keyring
  modules, two start/dashboard/status/stop cycles on the same port, unchanged
  Codex configuration, and npm uninstall cleanup.

The POSIX package smoke is shared with macOS; platform guards and shell selection
remain explicit. Windows/macOS workflows are not triggered by a Linux dispatch.

## Boundaries

This is Ubuntu x64/glibc coverage, not certification of every Linux distribution,
ARM machine, musl/Alpine installation, container, desktop session or hardened
SELinux/AppArmor policy. Actual systemd login persistence, sleep/resume, firewall
and tunnel conditions, and real phone pairing need targeted environment checks.
Existing platform-specific and credential-dependent test skips remain visible.
Android stays private. No npm publishing or changes to a developer profile occur.
