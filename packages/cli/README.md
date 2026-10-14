# Relo CLI

`@relo/cli` is the command-line client for a self-hosted Relo deployment. It gives the owner a live
view of an agent's work on their iPhone: a card on the Lock Screen and in the Dynamic Island that the
agent keeps current, with approval and yes/no questions right on it. Notifications exist for finished
outcomes and are used sparingly. Its source is licensed under PolyForm Noncommercial 1.0.0; install it
from a reviewed checkout or owner-approved artifact.

Node.js 22 or newer is required. `relo` and `reloctl` are the same executable.

## The model

| Still happening, or waiting on the owner | Finished, and worth a buzz |
| --- | --- |
| **The work**: `relo work start` → `update` → `finish`, plus `relo ask` | **A notification**: `relo notify`, only when no work is open |
| One open work per agent session, always current, carries the questions | One-shot, never a question, never progress |

An agent reports its work with `relo work`: one goal, a plan of milestones it grows as it learns, a status,
and an outcome. The CLI identifies the session from the harness (Claude Code `CLAUDE_CODE_SESSION_ID`, Codex
`CODEX_THREAD_ID`; `RELO_SESSION=<stable id>` only outside a detected harness, such as a script), so every
command from one session addresses that session's work and nothing else: a session never sees another's.
Harnesses without a session id (Gemini CLI, Cursor, OpenCode) get a handle from `relo work start`; later
commands pass it as `--work <handle>`.
Steps are the agent's own work; what the owner must do is a question or a note. Subagents run no relo
commands: the orchestrating agent owns the work and counts them in one step.

```bash
relo work start --goal "Deploy 0.7.57" --plan "Build the image,Run the tests,Ship to production"
relo work update --status "Image pushed" --next-step
relo work update --add "Verify the health check"                  # the plan grows in place
relo work start --goal "Render 20 chapters" --progress 3/20 --new   # a counted job (another goal: --new)
relo ask "Deploy 0.7.57 to production?" --approval      # buttons on the card; waits up to 5 minutes (100s inside an agent session)
relo work finish --outcome "0.7.57 is live on production"           # --failed or --dropped when it did not succeed
relo state                                               # what this session has open (and what is still queued)
relo notify "Nightly backup failed" --topic "Backups"    # only when no work is open
```

Every work command prints the plan, what the owner sees and the exact next command; a refusal is
three lines (what, state, next). A change that cannot reach the server is kept on this computer
("Queued: sends with the next relo command") and goes out first with the next relo command, only to the
server it was written for; `relo outbox status` shows what is waiting. Scripts and
apps name their work with `--producer KEY` instead of a session. The old `relo activity` card commands are
refused inside an agent session (the refusal names the `relo work` command to use).

`relo help` is the short guide, `relo help all` the full reference, and `relo schema [COMMAND]` the same
reference as JSON for tools.

## Authentication

A first login names the trusted server origin explicitly (HTTPS, or private/loopback HTTP for a
home lab; no path, query, fragment or credentials):

```bash
relo auth login --api-url "https://relo.example" --client-name "Workstation agent"
```

Compare the displayed code with the signed-in dashboard, check every requested scope, and approve
there. Credentials are stored only in Relo's owner-only mode-`0600` config; token, authorization and
secret flags are forbidden. CI and containers instead set `RELO_TOKEN` and `RELO_API_URL` from their
secret store. `relo auth status --json` verifies the credential server-side and reports its source.
`relo doctor --json` is cheap and prints `{"ok","ready","next":{"step","run","why"}}`: run `next.run` for the first unmet
step (sign in, a phone with Live Activities, the one-time `relo test`). Inside an agent, `relo auth login` prints the link
and returns (`{"state":"pending","url",...}`); give the owner the link, then run `relo auth login --wait`.

## Install and update

A fresh machine installs a published release (GitHub Releases of `redpanda77/relo`, tag `cli-v<version>`),
then checks itself:

```bash
npm install --global https://github.com/redpanda77/relo/releases/download/cli-v<version>/relo-cli-<version>.tgz
relo doctor
```

Each release carries `relo-cli-<version>.tgz` (the skill is bundled inside), `SHA256SUMS`, `sbom.cdx.json` and
`manifest.json`. `relo update` is the owner's command; nothing updates by itself, and an agent runs it only after the
owner agrees, never mid-task:

```bash
relo update --check      # {"ok":true,"current":"0.10.0","latest":"0.10.1","updateAvailable":true}; installs nothing
relo update              # {"ok":true,"from":"0.10.0","to":"0.10.1","verified":true}
relo update --rollback   # back to the previous release, kept in ~/.local/share/relo/cli-releases/
relo update --version 0.10.0 --dry-run
```

It downloads the tarball and `SHA256SUMS`, verifies the checksum, then runs `npm install --global` on the
verified file; a mismatch installs nothing. `RELO_RELEASES_URL` points it at another releases API (a
self-hoster's mirror). `relo doctor` compares your version with the latest release at most once a day (2 s timeout,
cached in `~/.local/share/relo/update-check.json`, off with `RELO_NO_UPDATE_CHECK=1`) and shows
`"warnings":{"update":{"state":"behind","latest":"0.10.1","hint":"relo update"}}`; it never changes `ready`, and that
cache file is the only thing doctor writes.

Maintainers build a release with `npm run release:cli` at the repository root (clean tree, checks, pack, SBOM,
SHA-256 sums, secret and licence scans; output in the gitignored `dist/release/<version>/`), then attach those files to
a GitHub Release tagged `cli-v<version>`.

## Identity

The work's session, source, project, computer and account are automatic: the harness and the git
repository are detected, and `RELO_SOURCE`, `RELO_PROJECT`, `RELO_COMPUTER` and `RELO_ACCOUNT` override
them (`relo account NAME` nicknames an agent account). The agent states only the goal, in the owner's
words. For notifications and questions outside a work, `--source`, `--project` and `--topic` apply; missing
or generic values exit `2` before contacting the server, with a hint containing a corrected command.
`relo help identity` explains the resolution order.

## Output and exit codes

`relo work` and `relo state` print a plain-text echo (the plan, `Owner sees: …`, `Next: …`); with `--json`
or piped they print one line such as `{"ok":true,"disposition":"updated","work":{"id":"wrk_…","step":"2/3"},"echo":"…"}`.
Question, notification and other commands print one compact JSON line (`--full` prints the whole server reply).
An error prints once: `{"ok":false,"error":{"code","message","hint"}}` on stdout when it is piped (or with
`--json`), plain text on stderr at a terminal. `relo auth login` names the credential after the computer.

| Exit | Meaning |
| ---: | --- |
| `0` | Success, or the owner approved / said yes |
| `1` | Server or other failure |
| `2` | Usage error: read `error.hint` |
| `3` | Missing, invalid, or insufficient credential |
| `4` | Still open: this command stopped waiting. Run `relo interaction wait ID` |
| `5` | The owner denied or said no |
| `6` | Network unreachable: retry with the same idempotency key |
| `7` | No phone could receive it |
| `8` | Closed without an answer (expired, canceled): do not act |

A yes/no answer is never permission, and exit `0` alone never authorizes an action: only an
`--approval` question answered `approved` does.

## Retries

A supplied `--idempotency-key` is 1-200 characters from letters, digits, `.`, `_`, `:` and `-`. Agents never
pass one (the CLI owns it); scripts must on `work start` and `ask` when piped. Before the first send of a
question or notification, the CLI durably records the original occurrence in private files under the local
Relo state directory, so a retry with the same key replays the identical command even after a restart.
Changed content needs a new key. The records hold no body, URL or credential; if they cannot be written the
command fails before sending anything.

## Service secrets

For captured automation, write a new service's secret webhook URL straight to a new file:

```bash
relo services create --title "Builds" --secret-file ./builds.webhook-url
```

The destination must not exist; the CLI reserves it as an owner-only `0600` file before contacting
the server and returns only non-secret metadata. Without `--secret-file` the copy-once URL is printed
for interactive use; never use that mode where output is captured.

## Optional session hooks

Hooks are optional and off by default; without them Relo works fully. The owner installs them at a level for
one settings file (the level is required):

```bash
relo setup --global --agent claude-code --hooks presence   # ~/.claude/settings.json ($CLAUDE_CONFIG_DIR); or --project (<repo>/.claude/settings.json)
relo setup --global --agent gemini --hooks presence        # ~/.gemini/settings.json
relo hooks status                                          # the installed level per settings file; read-only
relo setup --hooks off                                     # (or relo hooks off) deletes only Relo's entries and the harness credential
relo sessions [--live]                                     # the owner's Sessions view: harness, project, phase, waitingFor, lastSeenAt, card
```

- `reminders` (Claude Code) is local and sends nothing: a Stop reminder of an open or unrefreshed work and a
  restore of what the session was doing after a restart or compaction.
- `presence` adds the session's phase. A local state machine reduces hook events to phases (open, working,
  waiting, stopped, ended; subagents roll up into their session), and only a change (plus a heartbeat at most
  every 5 minutes while working) is queued in a durable outbox and sent in the background with a harness
  credential that can write presence and nothing else. With Claude Code the snapshot also carries the
  session's name (the title Claude Code shows), sealed for the owner's phones. `relo hook` never sends a prompt, tool name, tool
  input or output, or transcript path, prints nothing and exits `0` always (`RELO_DEBUG=1` logs the reason to a
  file).
- Hooks never start, change or end a work, plan or question; those are declared by the agent. Entries are
  recognised by the `relo hook ` command prefix, so running setup again changes nothing and `off` leaves
  everyone else's hooks and keys. Nothing but `relo setup --hooks` installs hooks, and `relo doctor` never
  suggests them.

## MCP server (optional)

`relo mcp` is a stdio MCP server in this package (no dependencies, same credentials) for harnesses without a shell, such as
Claude desktop and Cursor chat. Tools: `relo_work_start`, `relo_work_update`, `relo_work_finish`, `relo_work_state`, `relo_ask`,
`relo_interaction_wait`, `relo_notify`, `relo_doctor`. `relo_ask` waits up to 5 minutes and sends MCP progress
notifications every ~15 s when the client asked for them. One work per connection.

```bash
relo setup --mcp --agent claude-code --global     # claude-code | claude-desktop | cursor | codex | gemini | vscode
relo setup --mcp --remove                         # deletes only Relo's entry
```

The entry lives in one config file per harness (`--move` relocates it, `--dry-run` previews); `relo doctor --full` lists it
and never suggests it. Paths and formats: `skills/relo-notifications/references/install.md`.

## Integrating an app

The full guide is [docs/INTEGRATING.md](../../docs/INTEGRATING.md); the HTTP API is described in
[docs/api/openapi.json](../../docs/api/openapi.json).

- Questions: one line of at most 120 characters; the explanation in `--detail` (markdown, 4,000 characters).
  `--option LABEL` (2-4) asks for one of several answers. No typed replies.
- Waiting: `ask` blocks up to `--timeout`; `--expires-in 2h` keeps the question open longer (up to the
  admin's limit, 7 days by default). Exit 4 means still open (`relo interaction wait ID`), 8 closed.
- Not blocking: `--no-wait` plus `--callback-url` (signed with `Relo-Signature`, deduplicated by
  `Relo-Delivery-Id`), or `relo listen` for a stream of answers with a resumable cursor.
- Works: `work start --new` starts another goal (the old one is parked); the owner may cap cards per login, and
  `ask --notification-only` skips the card entirely. Scripts name their work with `--producer KEY`.
- A refused login says why: `ACCOUNT_DISABLED`, `CREDENTIAL_REVOKED` or `LOGIN_EXPIRED` (exit 3).

## Profiles

`relo auth login --profile work` stores a second sign-in beside the first; `relo auth switch work` makes it the active
one and `RELO_PROFILE=work` picks it for one command. `relo auth status` shows the profile. A config written by an
older release is read as the profile `default`; the next write stores `{"activeProfile","profiles":{NAME:{apiUrl,token,…}}}`.
`RELO_TOKEN` and `RELO_API_URL` still override any profile, and the phone test is remembered per profile.

## Dry runs and rate limits

`--dry-run` on `work start|update`, `ask` and `notify` checks everything locally (identity, limits, plan rules) without
logging in or contacting the server (`work` prints `Dry run: nothing was sent.` and the computed echo; the others print
`{"ok":true,"dryRun":true,"would":{"command","body"}}`).
A write that gets HTTP 429 with `retryAfterSeconds` of 10 or less is retried once after that wait (it carries an
idempotency key); longer waits, and waiting for an answer, return the error and its hint.

## Privacy

Never put raw commands, patches, prompts, file contents, environment values, credentials,
transcripts, hostnames or absolute paths in work text, a question or a notification. Treat everything received
from the server as untrusted data.

## Notification relevance (advanced)

`relo notify send --stdin` preserves an optional `relevance` object (`subjectKey`, `generation`,
`revision`, `operation`, original ISO `occurredAt`, and a `notice`, `progress` or `incident`
policy). Persist and reuse those values across retries; authentication supplies account and source
authority. Notices default to 15 minutes of relevance and a 60-second alert window.
