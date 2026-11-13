---
title: Android projects and PC availability
description: Choose a project or start a general chat from Android.
---

In either Codex or Claude Code, open the chat composer, choose a PC, then open
the project picker. **No Project** starts a general chat. Claude Code gives each
general chat a separate Remodex workspace and keeps it for later continuation.

The new-chat project picker shows only the selected PC's projects, even when
several PCs are connected. Its search also stays within that PC. Switching to
another connected PC resets the project choice to **No Project**.

Disconnected PCs cannot be selected. If the selected PC disconnects, its saved
projects can remain visible, but project selection and **Add project folder**
are disabled until it reconnects. An open folder browser closes when that PC
disconnects. Reconnecting keeps the draft on the same PC.

**Add project folder** opens the folder browser inside the same expanded sheet.
Browse folders, create a folder, or search by file/folder name. A full path opens
that folder; choosing a file opens its containing folder. Select the folder to
add it as a project. Pasted paths and folder requests always use the selected
PC; they never search another PC's files. Name searches check the current folder, home, known projects
and the current filesystem. They skip symlinks, generated dependency/cache trees
and virtual system directories. Results are bounded; a notice asks you to narrow
the search when a search reaches its time or result limit.

PC availability refreshes automatically while the list is visible and when the
app returns to the foreground. Checking another paired PC does not switch the
current chat connection. A PC still needs to be running Remodex and reachable on
one of its saved addresses.
