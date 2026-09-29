# Agent rules for installing and running Remodex

This file is for an agent **installing, starting, or operating** Remodex on a
user's machine. It is not about contributing to this repository — that is
[`AGENTS.md`](./AGENTS.md), and nothing here concerns you if you are only
reading or changing this codebase.

There is one rule, and it exists because `rmx start` can print a question that
an agent is capable of answering and must not.

For everything else about driving Remodex from a scripted terminal —
installation, `rmx init`, headless flags, exit codes — see the
[Agent Quickstart](https://opencodex.me/getting-started/for-agents/). This file
is only the consent boundary, kept in the installed package so it is readable
offline and without leaving the terminal.

## User-consent actions

Some actions write to the **user's own accounts and identity**, not to this
repository or to their machine's configuration. They sit outside anything an
install or operations task authorizes, and an agent must never perform or
auto-answer them — even when the surrounding task is approved, even when the
credential is sitting right there.

The current actions are **starring the repository on GitHub** and **provisioning a Named
Cloudflare Tunnel/DNS record in the user's Cloudflare account**.

### Do not

- Do **not** run `gh api -X PUT /user/starred/...`, `gh repo star`, or the
  equivalent REST call on the user's behalf.
- Do **not** call `POST /api/github/star` on the management API. It refuses
  agent-driven callers with `403 agent_consent_required`; treat that response as
  the final answer, not as an obstacle to route around.
- Do **not** answer the interactive prompt printed by `rmx start` /
  `rmx service install`. When an agent is detected the prompt is deliberately
  suppressed and its one-time marker left unwritten, so the user still gets the
  real question on their own next run.
- Do **not** submit the user's Cloudflare API token to
  `POST /api/android-remote/cloudflare/provision`, call the equivalent Cloudflare
  mutation APIs, or simulate the dashboard's **Connect domain** click. The
  provisioning route refuses raw-admin-token callers with
  `403 dashboard_session_required`; do not mint or imitate a browser session to
  route around that refusal.

### Do

- **Relay it once.** When a start prints the deferral, ask the user in the reply
  that follows *that* start, as a required Yes/No choice they have to answer —
  `Star lidge-jun/opencodex? Yes / No` — near the top of the reply. Not a soft
  aside such as "want to give it a star?", and not tacked onto the end of a long
  message.
- **Ask once, not forever.** An unanswered question settles nothing — silence is
  deferred, never a Yes and never a recorded No. Do not repeat the question in
  later replies or later sessions: the CLI re-arms the deferral at most once per
  Remodex version (never more than once a week), and a later version re-asks
  on its own. Do not decide it yourself in either direction.
- **Let an answer settle it.** Star only on an explicit yes. An explicit no ends
  the matter permanently — do not argue it, re-frame it, or raise it again
  later.
- **Leave Cloudflare provisioning to the user.** You may start Remodex, open or
  explain the Android Remote dashboard, and diagnose a returned safe error. The
  user must paste the one-time token and choose **Connect domain** in the
  dashboard themselves; that click is the consent action.

## Why this is a file and not a prompt

The prompt an agent sees is deliberately thin. Printing the full rule on every
start would bury real startup output under a wall of text that only an agent
reads, so the CLI prints one dim line and this file carries the contract.

## Where the enforcement lives

Reading this file is not what makes the boundary hold — the code refuses
agent-driven callers regardless:

- [`src/cli/agent-driven.ts`](./src/cli/agent-driven.ts) — agent detection.
- [`src/cli/star-prompt.ts`](./src/cli/star-prompt.ts) — prompt suppression and
  the one-time marker.
- [`src/server/management/sidebar-routes.ts`](./src/server/management/sidebar-routes.ts)
  — the `403 agent_consent_required` refusal.
- [`src/server/management/android-remote-routes.ts`](./src/server/management/android-remote-routes.ts)
  — the dashboard-session-only Cloudflare provisioning route.

Regression coverage: `tests/startup-prompt.test.ts`,
`tests/agent-driven.test.ts`, `tests/sidebar-routes.test.ts`, and
`tests/android-remote-management.test.ts`.

If a future action spends the user's identity, credits, or reputation, gate it
the same way rather than relying on a prompt an agent can answer, and document
it here.
