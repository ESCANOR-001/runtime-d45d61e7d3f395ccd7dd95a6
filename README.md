# Server compatibility checks

Server-only source snapshot for the Remodex NPM package, with its browser dashboard and tests. This repository is public: its randomized name is not an access-control mechanism.

The Android application, native desktop installer project, credentials, machine profiles, and previous Git history are not included. The existing private repository remains the development source of truth. Nothing here publishes to NPM or deploys a server automatically.

## Scope

- `opencodex-runtime/src` and `bin`: NPM server and CLI.
- `opencodex-runtime/gui`: browser dashboard, not a separate desktop application.
- `opencodex-runtime/tests`: server regression tests. Native desktop-installer-only assertions are omitted with that project.
- Runtime documentation and nested `.github` files are retained for existing documentation and workflow regression tests. Only the root `.github/workflows` directory runs Actions in this repository.
- Original licensing remains in `opencodex-runtime/LICENSE`.
- Embedded third-party Google OAuth client credentials are not distributed here. The legacy Antigravity integration requires explicit `GOOGLE_ANTIGRAVITY_CLIENT_ID` and `GOOGLE_ANTIGRAVITY_CLIENT_SECRET` environment settings; missing settings fail before network access. This does not affect the ChatGPT/Codex connection flow. CI uses synthetic values only in mocked OAuth tests.

## Windows and macOS CI

The root workflow uses standard `windows-2025` and `macos-15` runners, with four shards per OS. It runs on pushes, pull requests, or manual dispatch. It does not run Linux jobs or use repository secrets, publishing permissions, or private-repository checkout tokens.

The manually dispatched **Focused runtime regression checks** workflow runs the oversized-response and history-worker cases on both operating systems without rebuilding the dashboard.

Oversized WebSocket tests await the request using native promises before asserting its error: Bun 1.3.14's asynchronous rejection matcher can stall large incoming frames on Windows. They still verify the size-limit error, no replay, and successful reconnection. Real history-worker checks run in a hidden, disposable child process with the test's isolated environment; this avoids Bun's Windows test-timer assertion when a Worker invokes a synchronous subprocess. The same real workers, repeated jobs, shutdown counts, timeout outcomes, database writes, and hard-error assertions remain covered.

## Local checks

Requires Bun 1.3.14 and Node.js 20.9 or newer.

```sh
cd opencodex-runtime
bun install --frozen-lockfile
bun run typecheck
bun run build:gui
bun scripts/test.ts tests
bun run privacy:scan
```

## Updating this snapshot

Review each server-only export and scan for secrets before committing. Never mirror the private repository, push its history, or copy local configuration, environment files, signing keys, phone data, build outputs, or logs. Keeping a repository name obscure does not protect uploaded information.
