# Native Claude Desktop helper

The private stdin/stdout JSON interface separates OS accessibility from the shared
JavaScript chat adapter. It has no network listener or phone credentials. The
existing Remodex gateway remains responsible for device authorization and command
deduplication; changing agent does not require pairing again.

Build with `npm run build:native` from `claude-desktop-bridge`. Rust is a build-time
dependency. End users need the compiled helper for their platform. Linux currently
also needs GLib/GIO, an accessible graphical session, `xdotool`, `wl-copy`, and
`wl-paste`. Claude must run with its X11 accessibility support enabled.

The JS bridge uses `native/target/release/remodex-desktop-helper` by default (with
`.exe` on Windows). Packagers can set `REMODEX_DESKTOP_HELPER` to an absolute path
to the bundled platform binary. Helpers are never downloaded or compiled during
a phone request. `REMODEX_CLAUDE_DRIVER=python` explicitly selects the old Linux
driver for rollback; a failed action never automatically falls back or replays.

## Protocol version 1

One JSON request per process, one `{ok,result}` or `{ok:false,error}` response.
`info` is available without a graphical session. `scan` returns an application
identity, ordered normalized nodes, and document title/URI attributes. `action`,
`focus`, `scroll`, and `hover` require the exact application, node ID, name and role
from a preceding scan. The driver revalidates those before native interaction.
`activate`, `clipboardRead` and `clipboardWrite` are local primitives. Clipboard
payloads stay in memory and travel through stdin, never command-line arguments.

Requests/responses are bounded; the caller imposes a deadline and hides background
windows. The adapter preserves an existing clipboard and restores it only if the
desktop user has not replaced its contents while the action was running.

## Platform status

| Platform | Implementation | Validation |
| --- | --- | --- |
| Linux | GIO/AT-SPI native scan, verified actions, focus, scroll, hover, clipboard | Live Claude + realme; unit tests |
| Windows | Portable protocol builds; native UI Automation driver still required | Build/protocol/shared-logic CI only |
| macOS | Portable protocol builds; native Accessibility driver still required | Build/protocol/shared-logic CI only |

Windows and macOS return `available:false` from `info` and reject native operations.
A successful CI build is not support for controlling a signed-in Claude session.
Their future drivers must implement the same normalized-tree/target contract and
pass live parity checks before being enabled. Windows child processes must remain
hidden, including startup, restart and diagnostics. Codex's transport is unchanged.

Native API references: [GIO D-Bus](https://gtk-rs.org/gtk-rs-core/stable/latest/docs/gio/struct.DBusConnection.html),
[Windows UI Automation](https://learn.microsoft.com/windows/win32/winauto/entry-uiauto-win32),
[macOS Accessibility](https://developer.apple.com/documentation/applicationservices/axuielement).
