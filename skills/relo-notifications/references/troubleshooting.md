# Troubleshooting

Always keep credentials and sensitive payloads out of diagnostics.

## Authentication or scope failure

Run `auth status --json`. If the credential is absent, invalid, or lacks a required scope, stop and
ask the user to complete browser-approved onboarding. Never accept, reveal, generate, transfer, or
SSH-copy a token as a workaround. Run `permissions doctor --json` for permission prerequisites;
hook absence is an accurately reported limitation, not proof of failure in notification delivery.

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

## Pending or timed-out interaction

A local timeout does not delete a still-valid server interaction. Preserve its ID and resume with
`interaction wait ID --timeout DURATION --json`. Until an approval returns all permission gates,
the protected action remains denied. Never create duplicate approval prompts merely to extend a
local wait.

## Activity sequence conflict

Run `activity get ID --json`, compare the current sequence and state with the intended update, and
send a new mutation only if it remains valid. Do not blindly overwrite newer progress. End an
activity exactly once; a terminal state is not retried as a new activity.

## Live Activity missing or stale on the phone

Run `relo activity diagnose [ID_OR_NAME|--name NAME] --wait --timeout 30s --json`. The diagnosis
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

## Codex completes with an ordinary notification

Automatic lifecycle integration must not fall back to `notify send`. Resolve the installed notifier
helper from `npm root --global` and run its `doctor` action against the exact `config.toml`, adapter,
CLI, and installation identity paths. Also run the lifecycle hook doctor. Both must target the same
reviewed package pair; the notifier command must contain `--lifecycle-only`. A missing lifecycle is
a safe no-op, while a status/read error is a visible failure. `--notification-fallback` is an explicit
explicit opt-in and must not appear in the managed command.

Codex may cache or require trust review for changed hooks. After a successful on-disk reconciliation,
review the hook warning and start a new Codex task before treating an old task's behavior as release
evidence. A Live Activity remote start includes the alert Apple requires for push-to-start; that one
alert is not an ordinary Relo notification. Updates and terminal reconciliation remain lifecycle
operations.

## APNs and delivery meaning

A mutation success with `delivery.durableCommands > 0` proves durable server enqueue only. It does
not prove APNs accepted, iOS displayed, or the user saw the content. Report these states separately.
When APNs is disabled, history and durable commands may still be testable, but physical push and
Live Activity behavior remain unverified.
