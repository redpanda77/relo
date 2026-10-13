# CLI reference

`relo schema --json` is the exact grammar (every command, flag, enum, limit and exit code); this page
explains behavior. Use the installed `relo` (or `reloctl`); do not install or upgrade it mid-task.

## Contents

- [Output and exit codes](#output-and-exit-codes)
- [Which card a command addresses](#which-card-a-command-addresses)
- [Cards](#cards)
- [Questions](#questions)
- [Notifications](#notifications)
- [Readiness, devices and services](#readiness-devices-and-services)
- [Retries and idempotency](#retries-and-idempotency)

## Output and exit codes

Every command prints one JSON object on stdout: `{"ok":true,"command":"…","data":{…}}`, or
`{"ok":false,"error":{"code","message","hint?","details?"}}` (errors print as JSON whenever stdout is
piped, or with `--json`). Diagnostics go to stderr. Branch on the exit code, then read `data`.

| Exit | Meaning |
| ---: | --- |
| `0` | Success, or the owner approved / said yes |
| `1` | Server or other failure |
| `2` | Usage error: read `error.hint`, it is a corrected command |
| `3` | Missing, invalid, or insufficient credential (`relo auth login`) |
| `4` | No answer within 5 minutes, canceled, or expired: the card has ended |
| `5` | The owner denied or said no |
| `6` | Network unreachable: retry the same command with the same idempotency key |
| `7` | No phone could receive it |

## Which card a command addresses

Leave out the card and the command uses this work's card:
- inside Claude Code (`CLAUDE_CODE_SESSION_ID`) or Codex (`CODEX_THREAD_ID`): the session's card,
  whatever the topic wording;
- elsewhere: the card for source › project › topic, so pass the same `--topic` every time.

Pass a card ID (`act_…`) or `--name NAME` to address a specific card instead. `relo activity status`
shows this work's running card, if any.

## Cards

```bash
relo activity start --title "Deploying 0.7.57" --status "Building image" --topic "Release 0.7.57" \
  --step Build --step Test --step Deploy --step-current 1
relo activity update --status "Running tests" --step-current 2 --detail "214 of 380"
relo activity update --progress 0.6 --progress-label "Tests"
relo activity end --status "Live on production"
relo activity end --status "Failed: 3 tests" --symbol warning
```

- `activity start` reuses this work's running card (updating it) instead of creating another.
- `update` sends only what changed; `--clear-detail` / `--clear-progress` remove a line.
- `end` without `--status` reads "Complete" with a success icon and completes all steps and
  progress; with `--symbol warning` it keeps where the work stopped. `--dismiss-after 5m` keeps the
  finished card visible.
- `--stale-after` (default 20m) marks the card out of date without updates; it ends 10 minutes later.
- `activity diagnose --wait --timeout 30s` explains a missing or stale card (see troubleshooting).
- Live Activity work requires `devices:read` so delivery can be inspected; the default login has it.

## Questions

```bash
relo ask "Deploy 0.7.57 to production?" --approval --topic "Release 0.7.57"
relo ask "Run the migration now?" --yes-no --primary-label Run --secondary-label Skip
relo ask "Ship it?" --approval --no-wait          # returns the pending question at once
```

- The question appears on this work's card with answer buttons, a countdown and an alert; the
  command waits for the answer. A question waits at most 5 minutes (`--expires-in`, default and
  maximum 5m; `--timeout` up to 5m). Unanswered, it expires and the card ends; the command exits 4.
  No card running? `ask` starts one for the question and ends it after the answer (inside an agent
  session it stays as the session's card).
- Up to 240 characters. Tappable answers only: `--approval` (Approve/Deny) or `--yes-no` (Yes/No);
  labels may be renamed (1-24 characters) while the canonical answer stays the same.
- One question at a time per card. With a shorter `--timeout` the question stays answerable until
  it expires: resume with `relo interaction wait ID`; read with `interaction get`; withdraw with
  `interaction cancel`. Updates sent meanwhile succeed and show once it is answered.
- Services that cannot block can pass `--no-wait --callback-url https://… --callback-token-file PATH`:
  Relo POSTs `{type, eventId, interactionId, correlationId, kind, status, action, respondedAt}` with
  `Authorization: Bearer <token>`, retried after 30s, 2m, 10m and 1h. Expired or canceled questions
  never call back. `--correlation-id` is echoed in the callback.

## Notifications

```bash
relo notify "0.7.57 is live on production" --title "Deployed" --topic "Release 0.7.57"
relo notify "Nightly backup failed" --topic "Backups" --summary "Backup failed" --markdown --url "https://ci.example.com/runs/48"
```

- One-shot outcomes only. `notify` cannot ask or show progress.
- `--url` accepts `https://` pages, an app's own scheme (`your-app://incidents/42`) or
  `shortcuts://run-shortcut?name=…`; the owner opens it from the message. `--image` is a public
  `https://` image shown with the message and as the sender's avatar. `--summary` is the banner for
  a long body. `relo notify withdraw ID` removes a delivered notification.

## Readiness, devices and services

- `relo doctor --json` checks the config, server, credential and phones; `relo auth status --json`
  reports the credential and whether it came from the config file or `RELO_TOKEN`.
- `relo devices list --json` lists phones; `--device ID` targets one.
- `relo services create/list`: see [services.md](services.md).

## Retries and idempotency

A supplied `--idempotency-key` is 1-200 characters from letters, digits, `.`, `_`, `:`, `-`. Reuse the
same key only to retry the identical command (exit `6`); a replay returns the first result without
a second push. Change it when the content changes.
