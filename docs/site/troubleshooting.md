---
title: Troubleshooting
summary: Find out why a card, a question or a notification did not reach your phone, and the command that fixes it.
---

Most problems are one of a few: the computer is not signed in, the phone is not set up, a card left
the Lock Screen by design, or the server was briefly out of reach. Start with `relo doctor`, then
find your symptom below.

## Start with relo doctor

```sh
relo doctor
```

It is cheap: it pings no phone and sends nothing. It prints one line of JSON:

```json
{"ok":true,"ready":false,"next":{"step":"phone","run":"…","why":"…"}}
```

- `ready: true` means this computer can show work on your phone. Nothing else to do.
- `ready: false` comes with `next`: the first unmet step, the exact command to run, and why. Run
  it, then run `relo doctor` again. The steps come in order: `login` (signed in, server
  reachable), `phone` (a phone with Live Activities on), `test` (the one-time phone check).
- `skill` as the next step is only a warning (`ready` stays true): the agent skill is missing or
  older than the CLI. `relo setup --refresh` brings it up to date.
- `warnings.update` with state `behind` means a newer CLI exists. Updating is your choice:
  `relo update`.

- `privacy` is one line about your server: whether end-to-end encryption is required and how long ended
  content is kept (`ended content deleted after 10 hours`, or `kept` when no window is set).
- `warnings.unusedCredentials` lists logins, hook credentials and services unused for
  {{fact credentials.unusedDays}}: revoke what you no longer use.

`relo doctor --full` shows every check, and failing checks carry a hint.

## Not signed in

**Symptom.** Commands exit `3`, or `relo doctor` stops at `login`.

**Cause.** No credential on this computer, or it stopped working. The error code says which:
`login_expired` (sign in again), `credential_revoked` (you revoked this login), `account_disabled`
(the server's admin turned the account off; retrying will not help).

**Fix.**

```sh
relo auth status
relo auth login
```

Inside an agent, `relo auth login` does not block: it prints a link to open in your browser. After
you approve, the agent runs `relo auth login --wait`. Several servers or accounts: see
[profiles](/docs/guides/profiles). In CI the credential comes from `RELO_TOKEN`; see
[environment](/docs/reference/environment).

A refusal that says the server is older than the CLI means nothing was sent: update your server
([updating](/docs/guides/update)).

## No phone, or the test fails

**Symptom.** `relo doctor` stops at `phone` or `test`; `relo test` exits `5`, `4` or `7`.

**Cause.** The Relo app is not signed in to this server, or Live Activities are off for Relo.

**Fix.** On the iPhone, sign in to the Relo app with the same server and account, and turn on iOS
Settings › Relo › Live Activities. Then:

```sh
relo devices list   # the phone should show liveActivities: true
relo test --again
```

`relo test` asks "Can you see this card?" on the phone. Exit `4` means no answer yet: run it again
and it resumes the same question. A phone that passed is remembered.

## A card is not showing

**Symptom.** A work is open, but nothing is on the Lock Screen.

**Cause.** Usually by design. Check the `Owner sees:` line the last `relo work` command printed:

- no write for {{fact card.retireSeconds}}: the card left the Lock Screen (dimmed after {{fact card.freshSeconds}}); any update brings it back;
- paused or parked: the card is in Now › Paused, not on the Lock Screen;
- finished: the final card stays {{fact card.doneSeconds}} (failed: {{fact card.failedSeconds}}), then leaves;
- more than three cards: only the three most relevant show.

See [cards](/docs/concepts/cards) for every rule.

**Fix.** If the line says the card should be on the Lock Screen and it is not, ask the server why,
from your own terminal (it is refused inside an agent session):

```sh
relo activity diagnose
```

It stops at the last proven step: `server` (no delivery was created), `apns` (queued, retrying or
rejected by Apple) or `phone` (Apple accepted it; the phone has not confirmed), with a code and the
next action.

## A question does not reach the phone

**Symptom.** `relo ask` exits `7`, `4` or `8`, or the phone never shows the question.

**Cause and fix.**

- Exit `7`: no phone accepted the push. Check `relo devices list`, then `relo test --again`.
- Exit `4`: the question is on the phone and still open; the command stopped waiting. Resume with
  `relo interaction wait int_…`.
- Exit `8`: it expired or was withdrawn. Treat it as no and ask again if it still matters.
- `question_pending`: the work already shows a question. Wait for it, or `relo interaction cancel` it first.
- A choice question needs a phone on a recent Relo app; update the app.

Whatever happened, only an approval answered `approved` is permission. See
[questions](/docs/concepts/questions).

## "Queued: sends with the next relo command"

**Symptom.** A `relo work` command prints that line.

**Cause.** The server was unreachable. The change is kept on this computer in a durable outbox.

**Fix.** Nothing to retry. Queued changes go out first, oldest first, with your next relo command.
To check or send them now:

```sh
relo state          # the open work and how many changes are queued
relo outbox status
relo outbox flush
```

Questions are never queued: without the server `relo ask` fails with exit `6`. Try again once the
server is reachable.

## A refused command

**Symptom.** A command prints three lines and exits `2`:

```
Refused: this session has no open work
State: …
Next: relo work start --goal "…"
```

**Cause.** The command could not apply as written: no open work, a placeholder or a path in the
text, a step that is your job rather than the agent's, a finished work being resumed.

**Fix.** Run the `Next` line, filling in the `…`. Do not repeat the refused command unchanged. A
typo gets a "Did you mean" hint; `relo help all` lists every command. If the refusal says the work
changed twice while the command ran, run the same command again.

## Encryption unavailable

**Symptom.** "End-to-end encryption is on for this server but the phone's keys are unavailable.
Nothing was sent." (code `E2EE_UNAVAILABLE`), or a refusal with `end_to_end_required`.

**Cause.** This computer has no trusted phone with a current key to seal for. Often the phone has
not opened Relo for a long time, so its prekey is stale, or the only phone was removed.

**Fix.** Open Relo on the iPhone, then retry. Check:

```sh
relo keys status
```

A prekey shown as `stale` or `missing` means the phone needs to be opened. Relo never falls back to
readable text. See [keys and devices](/docs/guides/keys).

## A new phone is waiting for approval

**Symptom.** A note such as "iPhone Air is waiting for approval". Commands still work for your
trusted phones.

**Cause.** A phone that signs in after your first one stays pending until you approve it, so a server
cannot add a phone of its own.

**Fix.** On a phone you already use, open Relo › Settings › Devices and approve it. Or, at your
terminal:

```sh
relo keys status
relo keys approve iphone-air
```

An agent relays this note to you and never approves a phone itself. A "security code changed" note
that asks for nothing is informational. See [encryption](/docs/concepts/encryption).

## Hooks are not reporting

**Symptom.** The Sessions view is empty, or a session shows idle while it works.

**Cause.** The depth is `notify` or `track` (no hooks), or the hooks were installed by an older CLI.

**Fix.**

```sh
relo setup --show                # the depth and hook set per harness
relo setup --level guide         # send the session's phase
relo setup --refresh             # rewrite entries an older CLI installed
relo outbox status               # snapshots waiting to be sent
```

Restart the harness afterwards. Run `relo sessions` from your own terminal; inside an agent it is
refused. `RELO_DEBUG=1` makes hooks log their errors to Relo's state folder. Hooks are optional:
cards work fully without them. See [hooks](/docs/guides/hooks).

## The MCP server's tools do not appear

**Symptom.** Claude desktop, Cursor, Codex or another MCP client shows no `relo_work_start` tool.

**Cause.** The entry was not added, the app was not restarted, or node or the CLI moved since setup.

**Fix.**

```sh
relo setup --mcp --agent claude-desktop
relo setup --refresh   # after node or the CLI moved
```

Quit and reopen the app. Apps launched from the Dock do not inherit your shell's `PATH`, which is why
setup writes absolute paths. See [MCP](/docs/guides/mcp).

## Still stuck

Every exit code is in [exit codes](/docs/reference/exit-codes). Two works for one goal usually mean
`start --new` was used by mistake: finish the stray one with `--dropped`. A work from a session that
is gone: `relo admin works`, then `relo admin finish wrk_… --dropped --outcome "…"`.
