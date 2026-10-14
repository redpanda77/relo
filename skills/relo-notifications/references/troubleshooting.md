# Troubleshooting

Always keep credentials and sensitive payloads out of diagnostics.

## Authentication or scope failure

Run `relo auth status`. If the credential is absent, invalid, or lacks a required scope, stop and
ask the user to complete browser-approved onboarding. Never accept, reveal, generate, transfer, or
SSH-copy a token as a workaround.

The error code says why a working login stopped: `account_disabled` (the server admin turned the
account off; retrying will not help), `credential_revoked` (the owner revoked this login; sign in again
only if they want it back), `login_expired` (run `relo auth login`).

## `card_limit_reached`

This login already keeps as many cards running as the owner allows. End a card you no longer need
(`relo activity list`, `relo activity end ID`) or ask the owner to raise the limit in Dashboard ›
Connections. `relo ask` still works: the question waits in Relo's Needs you instead of on a card.

## Network failure

Exit `6` means the request was not durably accepted because the server was unreachable. Retry later
with the same idempotency key only when the intended operation and content are unchanged. Do not
create a replacement event first.

If the phone has internet but cannot reach the private server, APNs may display an alert while app
history and responses remain queued. Never treat that display or a local answer as server-confirmed.
The app syncs accepted history after reconnecting.

## No durable command

Exit `7` means no durable device command was enqueued. Inspect safe device readiness with
`devices list --json`, which enumerates every page and fails on expired or malformed cursors. Verify
explicit target ownership and status, and retry only after correcting
the prerequisite. Do not claim delivery and do not allow a protected action.

## Unanswered question

Exit `4` with state `timeout` ("No answer yet; the question is still open"): the wait ended before the
question did (about 100s in an agent session). Run the hint, `relo interaction wait ID --timeout 100s`,
as often as needed until the question closes. Exit `8` with state `expired` or `canceled` ("closed
… Do not act"): treat it as no. The card ended; `relo activity start` opens a new one if the work
continues. Never ask again just to extend the wait. `question_pending` means the
card already shows a question: wait, or `relo interaction cancel ID` first. `private_activity_question`
means the card is private and cannot show questions.

## Unknown command or option

A typo fails with exit `2` and a hint such as `Did you mean --status?` or `Did you mean activity update?`.
Without a close match the hint lists the command's flags; `relo help all` shows everything.

## Doctor says `ready:false`

`relo doctor` is cheap (no phone pings; it writes only a 24h cache of the latest CLI release) and prints `{"ok","ready","next":{"step","run","why"}}`.
Run `next.run` for the first unmet step, in this order, and ask the owner at most once per step:
`login` (signed in and server reachable), `phone` (a phone with Live Activities on: `relo devices list`),
`test` (`relo test`, once). A healthy but unready setup exits `0`; real failures keep their exit codes.
`next.step` `skill` is a warning only (`ready` stays `true`): the skill is missing or not at the CLI's version,
the owner reinstalls it, see [install.md](install.md). A `warnings.update` of `behind` means a newer CLI release exists: tell the owner once; `relo update` runs only with their go-ahead. Agents do not run installers mid-task. Whether an
instruction-file block exists is the owner's choice and never a step (`relo doctor --full` mentions it).

## Sign-in through an agent shell

An agent's tool shows output only when the command ends, so `relo auth login` there does not block: it prints
`{"state":"pending","url":…,"code":…,"next":"relo auth login --wait"}`. Give the owner the `url` (the code is
the fallback), then run `relo auth login --wait`; it waits at most 100s. Exit `4` with state `pending` means the
owner has not approved yet: run `--wait` again. "The sign-in link expired" means start over with
`relo auth login --no-wait`. Tokens are never printed.

## The phone test failed (`relo test`)

`relo test` shows a short card and asks "Can you see this card on your iPhone?". Exit `5` (no), exit `4` (state
`timeout`: no answer; run `relo test` again, it resumes the same question) or exit `7` (no phone could show it)
mean: on the iPhone, iOS Settings > Relo > Live Activities is on and the Relo app is signed in to this server;
then `relo devices list` shows the phone with `liveActivities:true`, then `relo test --again`. A phone that
passed is remembered and never asked again unless it is removed.

## Progress did not change on a steps card

`"note":"progress follows this card's steps; …"` means `--progress` was ignored because the card draws
progress from its steps. Move it with `--next-step` or `--step-current`.

## "This card already ended."

An update or end after the card ended (answered-then-expired question, stale timeout, or ended
earlier) fails with that message. Start a new one: `relo activity start --title … --status …`.

## Activity sequence conflict

Run `relo activity get ID`, compare the current sequence and state with the intended update, and
send a new mutation only if it remains valid. Do not blindly overwrite newer progress. End an
activity exactly once; a terminal state is not retried as a new activity.

## Live Activity missing or stale on the phone

Run `relo activity diagnose --wait --timeout 30s` (add a card ID or `--name` for another card). The diagnosis
stops at the last proven boundary:

- `problemStage: "server"` means the canonical activity exists but direct delivery was disabled,
  misconfigured, or no command job was created.
- `problemStage: "apns"` means the job exists but is queued, retrying, rejected, token-invalid, or
  fenced behind an ambiguous provider outcome.
- `problemStage: "phone"` means APNs accepted the command but ActivityKit creation or the exact
  command receipt is still unconfirmed, or phone authorization/registration is missing.

Follow the returned safe `code` and `nextAction`. Do not resend while APNs is ambiguous. Do not
claim display from provider acceptance. For starts, a current-generation update-token registration
is creation proof; for updates and ends, only the receipt tied to that exact event and device proves
application. Diagnostics report token presence but never token values.

## Two cards for one piece of work

Only outside Claude Code/Codex, when the topic changed between commands: reuse the exact `--topic`
or pass `--name`. `relo activity list` shows what is open; end strays with `relo activity end ID`.

## APNs and delivery meaning

A mutation success with `delivery.durableCommands > 0` proves durable server enqueue only. It does
not prove APNs accepted, iOS displayed, or the user saw the content. Report these states separately.
When APNs is disabled, history and durable commands may still be testable, but physical push and
Live Activity behavior remain unverified.

## A note says a phone is waiting for approval

End-to-end encryption notes name the phone and what to do, e.g. "iPhone Air (Simulator) is waiting
for approval: run `relo keys approve iphone-air`, approve it on your iPhone 17 Pro …". Your command
still worked for the trusted phones. Relay the note to the owner once; never run `relo keys approve`
(or add `--yes`) yourself: accepting a phone is the owner's decision. A "security code changed" note
that says nothing is needed is informational.
