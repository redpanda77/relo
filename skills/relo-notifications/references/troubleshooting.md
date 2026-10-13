# Troubleshooting

Always keep credentials and sensitive payloads out of diagnostics.

## Authentication or scope failure

Run `auth status --json`. If the credential is absent, invalid, or lacks a required scope, stop and
ask the user to complete browser-approved onboarding. Never accept, reveal, generate, transfer, or
SSH-copy a token as a workaround.

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

Exit `4` means no answer within 5 minutes; treat it as no. The question expired and its card ended;
`relo activity start` opens a new card if the work continues. Never ask again just to extend the
wait. `question_pending` means the card already shows a question: wait for it, or
`relo interaction cancel ID` first. `private_activity_question` means the card is private and cannot
show questions.

## Activity sequence conflict

Run `activity get ID --json`, compare the current sequence and state with the intended update, and
send a new mutation only if it remains valid. Do not blindly overwrite newer progress. End an
activity exactly once; a terminal state is not retried as a new activity.

## Live Activity missing or stale on the phone

Run `relo activity diagnose --wait --timeout 30s --json` (add a card ID or `--name` for another card). The diagnosis
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

Inside Claude Code or Codex every command lands on the session's card, so this only happens outside
a session when the topic changed between commands. Reuse the exact `--topic`, or pass `--name` for an
explicit card. `relo activity list --json` shows what is open; end strays with `relo activity end ID`.

## APNs and delivery meaning

A mutation success with `delivery.durableCommands > 0` proves durable server enqueue only. It does
not prove APNs accepted, iOS displayed, or the user saw the content. Report these states separately.
When APNs is disabled, history and durable commands may still be testable, but physical push and
Live Activity behavior remain unverified.
