# CLI reference

`relo schema --json` is the exact grammar (every command, flag, enum, limit and exit code; it is long:
`relo schema activity update`, or `activity.update`, prints just those commands plus the exit codes,
and an unknown name gets a "Did you mean …?" hint); this page explains behavior. Use the installed `relo` (or `reloctl`); do not install or upgrade it mid-task.

## Contents

- [Output and exit codes](#output-and-exit-codes)
- [Which card a command addresses](#which-card-a-command-addresses)
- [Origin: computer and account](#origin-computer-and-account)
- [Cards](#cards)
- [Questions](#questions)
- [Notifications](#notifications)
- [Readiness, devices and services](#readiness-devices-and-services)
- [Retries and idempotency](#retries-and-idempotency)

## Output and exit codes

Success is one compact JSON line holding what you act on; omitted keys are absent or null:

| Command | Line |
| --- | --- |
| `activity start/update/end/get` | `{"ok":true,"id":"act_…","state":"active","sequence":3,"step":"2/5","progress":0.4,"disposition":"reused"}` (`reused`/`held` only when true) |
| `activity status`, `activity get` with no card | the line above with `"found":true`, or `{"ok":true,"found":false}` |
| `activity list` | `{"ok":true,"cards":[{"id","state","title","status","step","progress","updatedAt"}…]}`, newest 10 (`--limit N`) |
| `ask`, `interaction get/wait/cancel` | `{"ok":true,"id":"int_…","state":"approved"}`; `ask` adds `card`, and `fallback` when the owner answers in the app |
| `notify` / `notify withdraw` | `{"ok":true,"id":"ntf_…","devices":1}` / `{"ok":true,"id":"ntf_…","state":"withdrawn"}` |
| `doctor` | `{"ok":true,"ready":true}`, or `{"ok":true,"ready":false,"next":{"step":"login\|phone\|test\|skill","run","why"}}`; failures add `"checks":{"server":{"state","hint"}}` |
| `auth login` | in an agent context or with `--no-wait`: `{"ok":true,"state":"pending","url","code","next":"relo auth login --wait"}`; `--wait` and a blocking login end with the signed-in line |
| `test` | `{"ok":true,"verified":true}` (`"already":true` when the phone passed before); no/timeout explain the checks |
| `auth status` | `{"ok":true,"signedIn":true,"server","client","expiresAt"}`; `missingScopes` only when one is missing |
| `services list` | `{"ok":true,"services":[{"id","title","prefix","createdAt"}]}`, secrets never included; `--full` for everything |
| `setup` | `{"ok":true,"file","action":"created\|appended\|updated\|unchanged\|kept\|moved\|removed","from?","skill":{…},"hint?"}`; owner's choice, see [install.md](install.md) |
| `sessions` | `{"ok":true,"sessions":[{harness,computer,account,project,presence,lastEventAt,card}]}`; empty unless the owner installed the optional session hooks (`relo setup … --hooks`). Without hooks Relo works fully: cards go stale and end on their own. |
| `--dry-run` | `activity start\|update\|end`, `ask`, `notify`: validate locally, print `{"ok":true,"dryRun":true,"would":{command,body}}`, send nothing |
| profiles | `relo auth login --profile NAME`, `relo auth switch NAME`, `RELO_PROFILE=NAME`; `auth status` shows `profile` |
| `skill install\|remove\|status` | `{"ok":true,"agent","dir","version","action":"installed\|updated\|unchanged\|removed\|absent","archived?"}`; status: `{"ok":true,"cli","copies":[{"dir","version","current"}]}`; see [install.md](install.md) |
| `update` | `--check`: `{"ok":true,"current","latest","updateAvailable"}`; success `{"ok":true,"from","to","verified":true}`; already latest: `updateAvailable:false`; `--rollback` adds `"rollback":true`. Owner's choice, see [install.md](install.md) |
| `devices list` | `{"ok":true,"devices":[{"id","name","liveActivities","lastSeenAt"}]}` |

`--full` prints the whole server reply as `{"ok":true,"command":"…","data":{…}}`; `services create`
(which returns the webhook URL), `account` and `activity diagnose` print their own full shapes. Use `sequence` for `--if-sequence`.

When display text is longer than its limit (title 80, status 60, detail 240, progress label 32,
notify title 80 and summary 240) it is shortened at a word boundary with `…`, and the line carries
`"note":"status shortened to 60 characters"`. Questions, topics, button labels, URLs and IDs are never
shortened; they fail with exit `2` instead.

An error prints once: `{"ok":false,"error":{"code","message","hint?","details?"}}` on stdout when it is
piped or with `--json`, otherwise plain text on stderr. Branch on the exit code, then read `error.hint`.

| Exit | Meaning |
| ---: | --- |
| `0` | Success, or the owner approved / said yes |
| `1` | Server or other failure |
| `2` | Usage error: read `error.hint` (a corrected command, or "Did you mean …?" for a typo) |
| `3` | Missing, invalid, or insufficient credential (`relo auth login`) |
| `4` | Still open: this command stopped waiting. Run `relo interaction wait ID` |
| `5` | The owner denied or said no |
| `6` | Network unreachable: retry the same command with the same idempotency key |
| `7` | No phone could receive it |
| `8` | Closed without an answer (expired, canceled): do not act |

## Which card a command addresses

Leave out the card and the command uses this work's card:
- inside an agent session: the session's card, whatever the topic wording. Session ids are read from
  `CLAUDE_CODE_SESSION_ID` (Claude Code), `CODEX_THREAD_ID` (Codex) or the generic `RELO_SESSION`, which any
  harness or script can export as a stable id. OpenCode, Gemini CLI and Cursor are recognized as sources
  (`OpenCode`, `Gemini CLI`, `Cursor`) but expose no session id, so set `RELO_SESSION` or reuse `--topic`.
  For any other harness set `RELO_SOURCE="<harness>"` and `RELO_SESSION=<stable id>`;
- elsewhere: the card for source › project › topic, so pass the same `--topic` every time.

Pass a card ID (`act_…`) or `--name NAME` to address a specific card instead. `relo activity status`
(or `get` with no card) shows this work's running card, if any.

## Origin: computer and account

Cards say which computer and agent account they came from. Both are automatic and optional:
- **Computer**: `--computer`, else `RELO_COMPUTER`, else the Mac's name (`scutil --get ComputerName`),
  else the hostname without its domain.
- **Account**: `--account`, else `RELO_ACCOUNT` (any harness), else the nickname set with `relo account NAME`
  (stored per Claude Code `CLAUDE_CONFIG_DIR`/`~/.claude`, Codex `CODEX_HOME`/`~/.codex`, or the harness
  name for any other), else the
  folder name of a custom config directory (`~/.claude-work` is "work"), else omitted. Relo never reads
  anything inside those folders. `relo account` shows the current one; `relo account --clear` removes it.
- `relo auth login` names the credential after the computer unless `--client-name` is given; a login
  with an existing name replaces that login, so keep names unique per machine.

## Cards

```bash
relo activity start --title "Deploying 0.7.57" --status "Building image" --topic "Release 0.7.57" \
  --steps "Build,Test,Deploy"
relo activity update --status "Running tests" --next-step --detail "214 of 380"
relo activity update --step-current Deploy
relo activity update --progress 3/5      # a counted job; labelled "3 of 5" (add --progress-label to rename)
relo activity end --status "Live on production"
relo activity end --status "Failed: 3 tests" --symbol warning
```

- `activity start` reuses this work's running card (updating it) instead of creating another; the
  outside an agent session the line carries a `note` saying so. `--new` starts a card of this run's
  own beside it (for a second process on the same topic).
- The owner can cap how many cards one login keeps running (Dashboard › Connections). At the cap a
  start is refused with `card_limit_reached`; `relo ask` then puts the question in Relo's Needs you
  instead of on a card (the line says so in `note`). `--notification-only` does that on purpose.
- Steps: `--steps "A,B,C"` (up to 8, 40 characters each; repeated `--step` works too). The first is
  current unless `--step-current` says otherwise. `--step-current` takes a number from 1 or a step
  name, `--next-step` advances one (it reads the card first; no steps or already last is an error).
  On `update` the card's own steps are reused, so send only the change.
- `--progress` takes `0.4`, `40%` or `3/5`. A bare number above 1 (`40`) is rejected as ambiguous.
  A card with steps draws its progress from them: `--progress` there is ignored and the line says
  `"note":"progress follows this card's steps; use --next-step or --step-current"`. `--steps` together
  with `--progress` in one start is a usage error.
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
relo ask "Run the 0042 migration on production?" --approval --detail "Rewrites orders and invoices (about 30s read-only). Backup taken 14:02. Undo: relo db rollback 0042"
relo ask "Which release goes out today?" --option "1.4" --option "1.5 beta" --option Neither --detail "1.5 adds offline mode; its migration takes 2 minutes."
```

- `--option LABEL` (2-4 times, or `ID=LABEL`) asks for one of several answers instead of approve/deny;
  the reply is `{"ok":true,"id":"int_…","state":"chosen","option":"1-4","label":"1.4"}` with exit 0.
  Ids come from the labels unless given. If a phone that would get the question runs an older Relo,
  the ask is refused (`choice_unsupported`, the message names the phone) and nothing is asked.
- QUESTION is one line of at most 120 characters (the card shows exactly that). `--detail` holds the
  explanation: markdown, up to 4,000 characters, in the stdin JSON as `detail` too. The owner reads it
  with the question in Relo; the card and the notification show only the question.
- The question appears on this work's card with answer buttons, a countdown and an alert; the
  command waits for the answer. A question waits 5 minutes by default; `--expires-in` asks for longer
  (for example `2h` or `1d`), up to the server's limit (7 days unless the admin set another; a longer
  ask is refused with `question_wait_too_long`). A card lives at most 8 hours, so past that the card
  ends and the same question keeps waiting in Relo's Needs you. Unanswered, it expires. The command
  waits for `--timeout` (default the question's lifetime up to 5 minutes; **100s inside an agent
  session**, because an agent's shell tool kills longer commands). If that passes first, it exits 4 with
  `{"error":{"message":"No answer yet; the question is still open.","hint":"relo interaction wait int_… --timeout 100s","details":{"state":"timeout","id":"int_…"}}}`:
  run the hint. Exit 8 (state `expired` or `canceled`) means closed without an answer: do not act.
  No card running? `ask` starts one for the question and ends it after the answer (inside an agent
  session it stays as the session's card).
- Tappable answers only: `--approval` (Approve/Deny) or `--yes-no` (Yes/No);
  labels may be renamed (1-24 characters) while the canonical answer stays the same.
- One question at a time per card. With a shorter `--timeout` the question stays answerable until
  it expires: resume with `relo interaction wait ID`; read with `interaction get`; withdraw with
  `interaction cancel`. Updates sent meanwhile succeed and show once it is answered.
- Services that cannot block can pass `--no-wait --callback-url https://… --callback-token-file PATH`:
  Relo POSTs `{type, eventId, interactionId, correlationId, kind, status, action, respondedAt}` with
  `Authorization: Bearer <token>`, retried after 30s, 2m, 10m and 1h. Expired or canceled questions
  never call back. `--correlation-id` is echoed in the callback. Every retry of one answer carries the
  same `Relo-Delivery-Id` (handle each once) and `Relo-Signature: t=UNIX,v1=HEX`, the HMAC-SHA256 of
  `UNIX.BODY` keyed by the token: check it and reject an old `t`. Callbacks to private or local
  addresses need the server admin's permission (Dashboard › Server).
- An app that cannot receive callbacks runs `relo listen`: one JSON line per answer to the questions
  this login asked (`{id,eventId,state,option?,label?,correlationId?,respondedAt,cursor}`), over one
  outgoing connection. Save the last `cursor`; `--since CURSOR` resumes after a restart without losing
  or repeating an answer (`--since 2026-10-13T09:00:00Z` starts from a time). `--once` prints what is
  waiting and exits. It reconnects on network errors and stops (exit 3) when the login stops working.

## Notifications

```bash
relo notify "0.7.57 is live on production" --title "Deployed" --topic "Release 0.7.57"
relo notify "Nightly backup failed" --topic "Backups" --summary "Backup failed" --markdown --url "https://ci.example.com/runs/48"
```

- One-shot outcomes only. `notify` cannot ask or show progress. Inside an agent session `--topic`
  is optional while the session's card is running: source, project, topic, computer and account come
  from it.
- `--url` accepts `https://` pages, an app's own scheme (`your-app://incidents/42`) or
  `shortcuts://run-shortcut?name=…`; the owner opens it from the message. `--image` is a public
  `https://` image shown with the message and as the sender's avatar. `--summary` is the banner for
  a long body. `relo notify withdraw ID` removes a delivered notification.

## Readiness, devices and services

- `relo doctor` is cheap (no phone pings; its only write is the 24h update-check cache). It checks the config, server and credential, then
  names the first unmet step in `next` (sign in, a phone with Live Activities, the one-time `relo test`);
  a missing or outdated skill, or a newer CLI release (`"warnings":{"update":{"state":"behind","latest","hint":"relo update"}}`), is a warning only. The instruction-file block is never a step.
  `relo auth login` in an agent context prints the link and returns; finish with `relo auth login --wait`;
  `relo auth status` shows who is signed in (`"source":"RELO_TOKEN"` when it came from the
  environment). `--full` prints every check and the scopes.
- `relo devices list` lists phones; `--device ID` targets one.
- `relo services create/list`: see [services.md](services.md).

## Retries and idempotency

A supplied `--idempotency-key` is 1-200 characters from letters, digits, `.`, `_`, `:`, `-`. Reuse the
same key only to retry the identical command (exit `6`); a replay returns the first result without
a second push. Change it when the content changes.
