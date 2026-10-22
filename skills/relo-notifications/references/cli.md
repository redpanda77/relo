# CLI reference

`relo schema --json` is the exact grammar (every command, flag, enum, limit and exit code; `relo schema work`
prints just the work verbs plus the exit codes, and an unknown name gets a "Did you mean …?" hint); this
page explains behavior. Use the installed `relo`; do not install or upgrade it mid-task.

## Contents

- [The work verbs](#the-work-verbs)
- [Order of application](#order-of-application)
- [Echo, JSON and refusals](#echo-json-and-refusals)
- [Which work a command addresses](#which-work-a-command-addresses)
- [Questions](#questions)
- [Notifications](#notifications)
- [Readiness, devices and services](#readiness-devices-and-services)
- [Other command output](#other-command-output)
- [Retries and idempotency](#retries-and-idempotency)
- [Deprecated and removed](#deprecated-and-removed)

## The work verbs

```bash
relo work start --goal "Ship the 0.17 release" --spoken-name "The 0.17 release" --plan "Bump versions,Run local gates,Tag and publish"
relo work update --status "Gates running" --next-step
relo work update --progress 3/5
relo work update --add "Write release notes"
relo work update --add "Sign the build" --under s3
relo work update --detail "Signing needs the new certificate"
relo work update --plan "Run local gates,Write release notes,Tag and publish"
relo work update --step "Tag and publish"
relo work update --waiting "CI"
relo work update --not-waiting --status "CI green"
relo work pause --status "Waiting for the owner's design review"
relo work resume
relo work deliver --outcome "0.17 is on TestFlight"
relo work deliver --outcome "0.17 is on TestFlight, build 289" --say "The iPhone app is on TestFlight."   # Relo for Mac says it after "Your turn: <name>."
relo work start --round "Add the release notes" --plan "Draft them,Review them"
relo work finish --outcome "0.17 is live"
relo work finish --outcome "Gates failed on the upload test" --failed
relo state
```

| Command | Flags | Notes |
| --- | --- | --- |
| `relo work start` | `--goal TEXT` (required, except with `--round`), `--spoken-name TEXT` (2 to 4 words, how Relo for Mac calls the work aloud), `--round TEXT`, `--plan "A,B,C"`, `--progress n/m`, `--status TEXT`, `--new`, `--dry-run`, `--json` | when this session has an open work it continues it: goal, plan, progress and status are ignored and the echo says why. After a `deliver`, `--round` opens the next round of that goal; without it the start is refused |
| `relo work update` | `--status`, `--goal`, `--spoken-name`, `--next-step` or `--step X`, `--plan "…"`, `--add "…"` (with `--under sN` or `--after sN`), `--detail TEXT`, `--progress n/m`, `--waiting TEXT` or `--not-waiting`, `--dry-run`, `--json` | at least one change; none of the plan changes on a delivered round |
| `relo work deliver` | `--outcome TEXT` (required), `--say TEXT`, `--drop-rest`, `--dry-run`, `--json` | ends this request (refused while top-level steps are open, naming them; `--drop-rest` skips them): the round closes, the owner gets the outcome as one quiet notification and it is their turn; the work stays open for `start --round` |
| `relo work handoff` | `--next TEXT` (required, up to 107 characters), `--dry-run`, `--json` | hands this session's open work to a fresh session on this computer: the card, the plan and the open round stay, the status reads `Handing off: <next>`, nothing is announced. Prints `relo work start --from <handle>` (single use, 24 hours, same computer); this session no longer owns the work. Needs the server (never queued). Refused on a delivered round |
| `relo work start --from HANDLE` | no other flag | in the fresh session: takes over the handed-off work (the old session loses it, this session's own open work is parked). Refused when the handle is unknown, used, expired or from another computer; the pending copy on this computer is then dropped |
| `relo work pause` | `--status TEXT` (required: why), `--json` | takes the card off the Lock Screen; Now › Paused |
| `relo work resume` | `[wrk_…]`, `--json` | default: the most recent paused or parked work of this session |
| `relo work finish` | `--outcome TEXT` (required), `--say TEXT`, `--failed` or `--dropped`, `--work wrk_…`, `--json` | ends the goal; default: the open work; open steps become skipped |
| `relo state` | `--sync`, `--json` | this session's open, paused and parked work; local unless `--sync` |
| scripts only | `--producer KEY`, `--idempotency-key`, `relo work heartbeat --lease 15m` | see [services.md](services.md) |

Plan rules:
- `--plan "A,B,C"` lists **what is left**, in order, matched by label (case-insensitive). Done steps
  stay done; a listed skipped step reopens; an unlisted open or current step is skipped (run
  `--next-step` in the same command to mark the current one done first).
- `--add "D,E"` appends at the end of the round (or after `--after sN`); with no current step the first added becomes current.
- `--next-step`: current → done, the next open step → current. `--step X` (an id like `s4`, or a
  label) jumps: forward marks the steps passed over as done; back to a done step reopens it.
- `--progress n/m` (integers, `m ≥ 1`) attaches to the current step on a planned work and clears
  when the step changes; on a work without a plan it is the whole job's count. On `start` with
  `--plan` it attaches to the first step. Percentages and fractions are refused.
- Nesting: a value with line breaks nests by indentation, two spaces (or a tab) per level, up to
  <!--f:work.planMaxDepth short-->3<!--/f--> levels: `--plan "Build it\n  Parse the rows\n  Write the rows\nVerify it"`. Use it
  only when a step cannot be finished in one go; flat stays the default. `--add "…" --under s3` adds
  last under a step. Only a step without sub-steps is current: `--next-step` goes from leaf to leaf, a
  parent is done when its children are, and a step added under the current one takes over.
- `--detail "…"` (up to <!--f:work.detailMax short-->200<!--/f--> characters) explains the current step; the owner opens it from the plan.
- `--round TEXT` is one line of at most 80 characters.
- `--plan` and `--add` split on commas; a comma inside (), [] or quotes stays in the label, and a value with line breaks is one step per line (an unclosed bracket is refused).
- Rounds: one goal is one work; each request is a round. `deliver` closes it (refused while
  top-level steps are open unless `--drop-rest`); `start --round "…" [--plan "…"]` opens the next (without `--plan` it carries the unfinished steps). An open round is never started again:
  that start continues it and notes that `--round` was ignored.
- A refused `finish` or `deliver` stays on every echo (`Refused earlier: …`) until an accepted one;
  for an over-long outcome the `Next` line holds your own text cut to fit.
- Limits: <!--f:work.planMaxSteps-->30<!--/f--> steps per round (<!--f:work.planMaxNodes short-->120<!--/f--> in all rounds), labels <!--f:work.stepLabelMax short-->80<!--/f-->, goal <!--f:work.goalMax short-->120<!--/f-->, status <!--f:work.statusMax short-->120<!--/f-->, outcome <!--f:work.outcomeMax short-->200<!--/f-->, waiting <!--f:work.waitingMax short-->60<!--/f--> characters.
  Placeholder words ("Step 2", "todo", "done", "in progress"), paths and secrets are refused, and so is
  a step the owner performs ("Owner approves the release"): that is an `ask` or a note.
- `--dry-run` validates locally and prints `Dry run: nothing was sent.` and the computed echo.

## Order of application

Within one `update` the changes apply in a fixed order: 1 `--next-step` · 2 `--plan` · 3 `--add` ·
4 `--step X` · 5 `--detail` · 6 `--progress` · 7 text fields (`--status`, `--goal`, `--waiting`). `--next-step` and
`--step` are exclusive, as are `--waiting` and `--not-waiting`. Because `--next-step` goes first,
"I finished this, and the rest now looks like this" is one command:
`relo work update --next-step --plan "Patch token refresh,Add regression test,Run tests"`.

## Echo, JSON and refusals

Every work command prints the echo as plain text (the worked example is in [cards.md](cards.md)):

```
Work <short id> "<goal>" (<lifecycle>, <disposition>)
  Status: <status>
  Waiting on: <reason> since <HH:MM>
  [x] s1 <label>
  [>] s2 <label>   (<n>/<m>)
  [ ] s3 <label>
  [-] s4 <label>   (skipped)
  Progress: <n> of <m>
Note: …
Owner sees: <what the phone shows>
Question: / Answer: <the latest question on this work>
Parked: <short id> "<goal>" (paused HH:MM) → relo work resume <id>  |  relo work finish --work <id> --outcome "…"
Next: <the exact command>
```

A nested plan indents its steps; closed rounds fold to one line, `[✓] Round 1 "<title>": <outcome>`
(round 1 is titled by the goal), and the open round gets a `Round n "<title>"` header once there are
two. A refused finish or deliver puts `Refused earlier: …` on the first line.

Lifecycle is `open`, `paused` or `finished`; disposition is `started`, `continuing`, `updated`,
`paused`, `resumed`, `delivered`, `round_opened`, `handed_off`, `taken_over`, `done`, `failed` or `dropped`.

`--json` prints one line instead:
`{"ok":true,"disposition":"updated","work":{"id":"wrk_…","lifecycle":"open","version":4,"step":"2/3","progress":{"done":3,"total":5}},"parked":[…],"echo":"…"}`
(versioned in `relo schema` as `workOutput: 1`).

A refusal is exactly three lines on stdout, exit non-zero (usually `2`), nothing sent:

```
Refused: <what went wrong>.
State: <the current state, one line>.
Next: <the exact command>
```

With `--json` (or piped, for scripts) it is `{"ok":false,"error":{"code","message","state","next"}}`.
Branch on the exit code, then run the `Next` command.

<!--generated:exit-codes-->
| Exit | Meaning |
| ---: | --- |
| `0` | Success, or the owner approved / said yes |
| `1` | Server or other failure |
| `2` | Usage error or refused: read the `Next` line |
| `3` | Missing, invalid, or insufficient credential (`relo auth login`) |
| `4` | Still open: this command stopped waiting. Run `relo interaction wait ID` |
| `5` | The owner denied or said no |
| `6` | Network unreachable: retry the same command |
| `7` | No phone could receive it |
| `8` | Closed without an answer (expired, canceled): do not act |
<!--/generated-->

## Which work a command addresses

Never an id you have to remember: the session is read from the harness, never chosen by the agent:
`CLAUDE_CODE_SESSION_ID` (Claude Code) or `CODEX_THREAD_ID` (Codex). `RELO_SESSION=<stable id>` counts
only outside a detected harness (a script, the owner's shell). Session, source, project, computer and
account are automatic.

- `update` and `pause` always act on this session's open work and take no id (a caller with a handle passes `--work <handle>`).
- `finish --work wrk_…` and `resume wrk_…` reach a parked work of this session only.
- No session id (Gemini CLI, Cursor, Copilot, Amp, nested harnesses): `relo work start` prints a handle
  (`Handle: wrk_8f2c1a9e.<token>`); pass `--work <handle>` to every later command for that work.
- Commands that show every session (`relo sessions`, `relo listen`) are for the owner and are refused
  inside an agent session.

## Questions

```bash
relo ask "Deploy 0.7.57 to production?" --approval
relo ask "Run the migration now?" --yes-no --primary-label Run --secondary-label Skip
relo ask "Ship it?" --approval --no-wait          # returns the pending question at once
relo ask "Run the 0042 migration on production?" --approval --detail "Rewrites orders and invoices (about 30s read-only). Backup taken 14:02. Undo: relo db rollback 0042"
relo ask "Which release goes out today?" --option "1.4" --option "1.5 beta" --option Neither --detail "1.5 adds offline mode; its migration takes 2 minutes."
```

- `--option LABEL` (2-4 times, or `ID=LABEL`) asks for one of several answers instead of approve/deny;
  the reply is `{"ok":true,"id":"int_…","state":"chosen","option":"1-4","label":"1.4"}` with exit 0.
  Ids come from the labels unless given. If a phone that would get the question runs an older Relo,
  the ask is refused (`choice_unsupported`, the message names the phone) and nothing is asked.
- QUESTION is one line of at most 120 characters (the Lock Screen shows exactly that). `--detail` holds the
  explanation: markdown, up to 4,000 characters, in the stdin JSON as `detail` too. The owner reads it
  with the question in Relo; the Lock Screen and the notification show only the question.
- The question appears on this session's open work with answer buttons, a countdown and an alert; the
  command waits for the answer. A question waits <!--f:question.defaultSeconds-->5 minutes<!--/f--> by default; `--expires-in` asks for longer
  (for example `2h` or `1d`), up to the server's limit (<!--f:question.serverCapSeconds-->7 days<!--/f--> unless the admin set another; a longer
  ask is refused with `question_wait_too_long`). Past the Lock Screen's 8-hour limit the same question keeps waiting in Relo's Needs you. Unanswered, it expires. The command
  waits for `--timeout` (the CLI asks the server in short slices of at most 90 seconds, never one long request; default the question's lifetime up to <!--f:question.defaultSeconds-->5 minutes<!--/f-->; **<!--f:question.agentWaitSeconds short-->100s<!--/f--> inside an agent
  session**, because an agent's shell tool kills longer commands). If that passes first, it exits 4 with
  `{"error":{"message":"No answer yet; the question is still open.","hint":"relo interaction wait int_… --timeout 100s","details":{"state":"timeout","id":"int_…"}}}`:
  run the hint. Exit 8 (state `expired` or `canceled`) means closed without an answer: do not act.
  No work open? A question never starts one: it goes out as a notification with the answer
  buttons (`"fallback":"notification"`), and answering never finishes a work. An answer that arrives
  after the command stopped waiting shows in a later echo as late: never permission, ask again.
- Tappable answers only: `--approval` (Approve/Deny) or `--yes-no` (Yes/No);
  labels may be renamed (1-24 characters) while the canonical answer stays the same.
- One question at a time per work. With a shorter `--timeout` the question stays answerable until
  it expires: resume with `relo interaction wait ID`; read with `interaction get`; withdraw with
  `interaction cancel`. Updates sent meanwhile succeed and show once it is answered.
- Services that cannot block (scripts only; an agent waits on the answer instead) can pass `--no-wait --callback-url https://… --callback-token-file PATH`:
  Relo POSTs `{type, eventId, interactionId, correlationId, kind, status, action, respondedAt}` with
  `Authorization: Bearer <token>`, retried 10 times over about <!--f:callback.giveUpSeconds-->3 days<!--/f--> (<!--f:callback.retryDelaysSeconds-->30s, 2m, 10m, 1h, 3h, 6h, 12h, 24h, 24h<!--/f-->). Expired or canceled questions
  never call back. `--correlation-id` is echoed in the callback. Every retry of one answer carries the
  same `Relo-Delivery-Id` (handle each once) and `Relo-Signature: t=UNIX,v1=HEX`, the HMAC-SHA256 of
  `UNIX.BODY` keyed by the token: check it and reject an old `t`. Callbacks to private or local
  addresses need the server admin's permission (Dashboard › Server).
- An app that cannot receive callbacks runs `relo listen` (owner and scripts only; a producer key limits it to that producer's answers): one JSON line per answer to the questions
  this login asked (`{id,eventId,state,option?,label?,correlationId?,respondedAt,cursor}`), over one
  outgoing connection. Save the last `cursor`; `--since CURSOR` resumes after a restart without losing
  or repeating an answer (`--since 2026-10-13T09:00:00Z` starts from a time). `--once` prints what is
  waiting and exits. It reconnects on network errors and stops (exit 3) when the login stops working.

## Notifications

```bash
relo notify "0.7.57 is live on production"
relo notify "Nightly backup failed" --summary "Backup failed" --markdown --url "https://ci.example.com/runs/48"
```

- One-shot outcomes only, and only when no work is open. `notify` cannot ask or show progress. While
  this session has an open work it is recorded on that work and sends no buzz (`--full` shows
  `"folded":true` and the `workId`): the finish outcome is the notification. Source, project, computer and account are automatic.
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
- `relo config` prints this computer's settings, each with its effective value and where it comes from (default, config file, environment variable). Read-only.
- `relo devices list` lists phones; `--device ID` targets one.
- `relo services create/list/edit/rotate/revoke`: see [services.md](services.md).
- `relo auth token create/list/rotate/revoke`: CI tokens for pipelines, owner-only; never run them yourself unasked, since each prints a secret (use `--secret-file`).

## Other command output

These commands print one compact JSON line when piped; omitted keys are absent or null:

| Command | Line |
| --- | --- |
| `ask`, `interaction get/wait/cancel` | `{"ok":true,"id":"int_…","state":"approved"}`; `fallback` when no work is open |
| `notify` / `notify withdraw` | `{"ok":true,"id":"ntf_…","devices":1}` / `{"ok":true,"id":"ntf_…","state":"withdrawn"}` |
| `doctor` | `{"ok":true,"ready":true}`, or `{"ok":true,"ready":false,"next":{"step":"login\|phone\|test\|skill","run","why"}}`; failures add `"checks":{"server":{"state","hint"}}` |
| `auth login` | in an agent context or with `--no-wait`: `{"ok":true,"state":"pending","url","code","qr","next":"relo auth login --wait"}`; `--wait` and a blocking login end with the signed-in line |
| `test` | `{"ok":true,"verified":true}` (`"already":true` when the phone passed before) |
| `auth status` | `{"ok":true,"signedIn":true,"server","client","expiresAt"}`; `missingScopes` only when one is missing |
| `services list` | `{"ok":true,"services":[{"id","title","prefix","createdAt"}]}`, secrets never included |
| `setup` | `{"ok":true,"file","action":"created\|appended\|updated\|unchanged\|kept\|moved\|removed","from?","skill":{…},"hint?"}`; owner's choice, see [install.md](install.md) |
| `update` | `--check`: `{"ok":true,"current","latest","updateAvailable"}`; success `{"ok":true,"from","to","verified":true}`. Owner's choice |
| `devices list` | `{"ok":true,"devices":[{"id","name","liveActivities","lastSeenAt"}]}` |
| profiles | `relo auth login --profile NAME`, `relo auth switch NAME`, `RELO_PROFILE=NAME` |

An error prints once: `{"ok":false,"error":{"code","message","hint?","state?","next?"}}` on stdout when
piped or with `--json`, otherwise plain text.

## Retries and idempotency

A supplied `--idempotency-key` is 1-200 characters from letters, digits, `.`, `_`, `:`, `-`. Scripts must pass one on `work start` when piped (optional on `ask`);
agents never pass one (the CLI owns it). Reuse the same key only to retry the identical command (exit `6`); a replay returns the first result without
a second push. Change it when the content changes.

## Deprecated and removed

`relo activity start` and `relo activity update` are gone for everyone, and the remaining card commands are the
owner's; there are no aliases. Translate:
`activity start --title T` → `work start --goal T`; `--steps "A,B"` → `--plan "A,B"`;
`--step-current N` → `--step sN`; `activity end --status T` → `work finish --outcome T`
(`--symbol warning` → `--failed`); `activity status` → `relo state`. `--topic`, `--name`, `--style`,
`--privacy` and the timing flags are gone: Relo finds the work and times every card itself.

## Cleaning up other sessions' cards

Only when the owner asks. `relo admin works` lists every open work; `relo admin finish wrk_… --dropped --outcome "…"`
ends a hanging one. Never otherwise. Details: [troubleshooting](troubleshooting.md).
