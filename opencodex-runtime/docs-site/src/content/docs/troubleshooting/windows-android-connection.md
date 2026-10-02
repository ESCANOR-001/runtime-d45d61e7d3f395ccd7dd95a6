---
title: Android cannot load chats on Windows
description: Troubleshoot chat loading and Codex version selection on Windows.
---

If Android stops at **Syncing chats** and reports that the project connection
did not become ready within 15000ms, the phone did not receive its first chat
list within 15 seconds. This does not by itself mean the Wi-Fi connection failed.

## Codex updates and older installation folders

Windows can retain several Codex executable folders after an update. Remodex
uses the Codex app-server started by the running desktop application to identify
the matching version. An older folder alone should not prevent connection.

Open one Codex Desktop version before connecting Android. If more than one
desktop version is running, close the extra desktop application after saving
your work. An explicit `CODEX_CLI_PATH` setting must match the running desktop
version; Remodex reports a mismatch instead of silently overriding that setting.

If an older background server still occupies Remodex's default private Codex
port, Remodex uses another local-only port for the matching version. It does not
terminate the older process. The phone address and saved pairing stay unchanged.

## Slow chat history

New connections and reconnects request ten recent chats first. Remaining and
archived chats load separately. A first-page request does not wait for an
already-running full-history scan, and reconnecting keeps previously cached
older rows until the complete list arrives.

If Codex rejects the first request or fails to answer within ten seconds,
Remodex sends the underlying request error to Android. Check that Codex Desktop
can open your chats, then reconnect. Repeatedly scanning a new QR code does not
repair a stalled Codex history reader.

## Activity appears but messages are blank or disappear

Some Windows Codex versions return an empty recent-message page for a conversation
that still has saved messages. Remodex checks the saved conversation in that case.
For a single saved file, it reads at most the newest 2 MiB first and sends those
messages before loading older history. Scrolling up can then request older messages.
Conversations continued across several files still use the verified history recovery
path so unrelated or abandoned messages are not mixed in.

A later empty Windows refresh keeps messages already loaded while retrying.
An intentional history edit can still remove messages. This fallback is Windows-only;
Linux and macOS continue using their existing recent-message loading path.

## Internal text appears instead of a prompt

Windows Desktop can save an internal page-context record beside the real prompt.
Remodex hides that record and displays the actual user message. Raw response
annotation markers are also removed from displayed answers, while examples inside
code remain intact. This changes the phone's presentation; saved conversations are
not rewritten.
