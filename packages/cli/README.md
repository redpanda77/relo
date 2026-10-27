# Relo CLI

`@relo/cli` is the command-line client for a self-hosted Relo deployment. It gives the owner a live
view of an agent's work on their iPhone: a card on the Lock Screen and in the Dynamic Island that the
agent keeps current, with approval and yes/no questions right on it. Notifications exist for finished
outcomes and are used sparingly. Its source is licensed under PolyForm Noncommercial 1.0.0; install it
from a reviewed checkout or owner-approved artifact.

Node.js 22 or newer is required.

## The model

| Still happening, or waiting on the owner | Finished, and worth a buzz |
| --- | --- |
| **The work**: `relo work start` → `update` → `deliver` (a request done) → `finish` (the goal done), plus `relo ask` | **A notification**: `relo notify`, only when no work is open |
| One open work per agent session, always current, carries the questions | One-shot, never a question, never progress |

An agent reports its work with `relo work`: one goal, a plan of milestones it grows as it learns, a status,
and an outcome. Each request is a round: `deliver` ends it, `start --round "<next request>"` opens the next one on
the same card, and `finish` ends the goal. The CLI identifies the session from the harness (Claude Code `CLAUDE_CODE_SESSION_ID`, Codex
`CODEX_THREAD_ID`, OpenCode `OPENCODE_SESSION_ID`, Antigravity `ANTIGRAVITY_CONVERSATION_ID`; `RELO_SESSION=<stable id>` only outside a detected harness, such as a script), so every
command from one session addresses that session's work and nothing else: a session never sees another's.
Harnesses without a session id (Gemini CLI, Cursor, Copilot, Amp) get a handle from `relo work start`; later
commands pass it as `--work <handle>`.
Steps are the agent's own work; what the owner must do is a question or a note. Subagents run no relo
commands: the orchestrating agent owns the work and counts them in one step.

```bash
relo work start --goal "Deploy 0.7.57" --plan "Build the image,Run the tests,Ship to production"
relo work update --status "Image pushed" --next-step
relo work update --add "Verify the health check"                  # the plan grows in place
relo work start --goal "Render 20 chapters" --progress 3/20 --new   # a counted job (another goal: --new)
relo ask "Deploy 0.7.57 to production?" --approval      # buttons on the card; waits up to 5 minutes (100s inside an agent session; the CLI waits in slices of at most 90s)
relo work deliver --outcome "0.7.57 is live on production"          # this request is done; the next one: relo work start --round "…"
relo work finish --outcome "0.7.57 is live on production"           # the goal is done (--failed or --dropped when it did not succeed)
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

A fresh machine installs the CLI its Relo server hands out (the image packs it; Node.js 22 comes with it when
missing), then checks itself:

```bash
curl -fsSL https://relo.example.com/install.sh | sh                 # the CLI; then relo auth login
curl -fsSL https://relo.example.com/install.sh | sh -s -- rci_…     # a code from Add a computer: signed in and set up
relo doctor
```

It lands in `~/.local/share/relo/cli/<version>` with a launcher in `~/.local/bin/relo` naming Node and the CLI by
path. A published release (GitHub Releases of `redpanda77/relo`, tag `cli-v<version>`) installs with npm instead:
`npm install --global https://github.com/redpanda77/relo/releases/download/cli-v<version>/relo-cli-<version>.tgz`.

Each release carries `relo-cli-<version>.tgz` (the skill is bundled inside), `SHA256SUMS`, `sbom.cdx.json` and
`manifest.json`. `relo update` is the owner's command. A CLI installed with the install script updates itself in the background
after the command that noticed a new version (`RELO_NO_UPDATE_CHECK=1` turns that off); an npm install does not, so
an agent runs `relo update` only after the owner agrees, never mid-task:

```bash
relo update --check      # {"ok":true,"current":"0.17.48","latest":"0.17.49","updateAvailable":true}; installs nothing
relo update              # {"ok":true,"from":"0.17.48","to":"0.17.49","verified":true}
relo update --rollback   # back to the previous release, kept in ~/.local/share/relo/cli-releases/
relo update --version 0.17.48 --dry-run
```

Its source is the signed-in server when it hands out a CLI (`/cli/version`, `/cli/relo-cli.tgz`), else GitHub
releases. It verifies the digest (the server's, or `SHA256SUMS`), then installs: behind the install script's
launcher it unpacks the new version beside the old one and points the launcher at it, otherwise it runs
`npm install --global` on the verified file; a mismatch installs nothing. `RELO_RELEASES_URL` points it at another
releases API (a self-hoster's mirror). `relo doctor` compares your version with the latest release at most once a day (2 s timeout,
cached in `~/.local/share/relo/update-check.json`, off with `RELO_NO_UPDATE_CHECK=1`) and shows
`"warnings":{"update":{"state":"behind","latest":"0.17.49","hint":"relo update"}}`; it never changes `ready`, and that
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
| `7` | Nothing could show it: no phone and no Mac |
| `8` | Closed without an answer (expired, canceled): do not act |

A yes/no answer is never permission, and exit `0` alone never authorizes an action: only an
`--approval` question answered `approved` does.

## Retries

A supplied `--idempotency-key` is 1-200 characters from letters, digits, `.`, `_`, `:` and `-`. Agents never
pass one (the CLI owns it); scripts must on `work start` when piped (on `ask` it is optional). Before the first send of a
question or notification, the CLI durably records the original occurrence in private files under the local
Relo state directory, so a retry with the same key replays the identical command even after a restart.
Changed content needs a new key. The records hold no body, URL or credential; if they cannot be written the
command fails before sending anything.

## Service secrets

A service sends to `<origin>/hooks` with its secret in `Authorization: Bearer hook_…` (never in the URL).
For captured automation, write a new service's secret straight to a new file:

```bash
relo services create --title "Builds" --secret-file ./builds.secret
```

The destination must not exist; the CLI reserves it as an owner-only `0600` file before contacting
the server and returns only non-secret metadata (the endpoint included). Without `--secret-file` the
copy-once secret is printed for interactive use; never use that mode where output is captured.

## Supported harnesses

What `relo setup` writes for each harness it finds (`--agent NAME` picks one; `--dry-run` shows the plan
first). The table is checked against the harness descriptors by `test/catalog.test.mjs`.

<!-- harness-matrix:start -->
| Harness | `--agent` | Instructions block | Skill | Hooks (`--level guide`) | MCP (`--mcp`) |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | yes | yes | yes | yes |
| Codex | `codex` | yes | yes | yes | yes |
| OpenCode | `opencode` | yes | yes | yes | — |
| Antigravity | `antigravity` | — | — | yes | yes |
| Gemini CLI | `gemini` | yes | yes | yes | yes |
| Cursor | `cursor` | — | yes | — | yes |
| GitHub Copilot | `copilot` | yes | yes | — | — |
| Amp | `amp` | yes | yes | — | — |
| Claude | `claude-desktop` | — | — | — | yes |
| Agents | `agents` | — | yes | — | — |
<!-- harness-matrix:end -->

`Agents` is the shared `~/.agents/skills` folder other harnesses read. `relo setup --project` writes the block
into this repository's `AGENTS.md` (and a `CLAUDE.md` that imports it) instead of each harness's global file.

## Setup depths and session hooks

`relo setup --level notify|track|guide|optimize` chooses how deep Relo plugs into the agents, once per computer.
The depth is not stored anywhere: it is what is installed (the block's modules, named in its start marker, and the
hook set), so setup without `--level` keeps it and never downgrades. At a terminal, a bare `relo setup` asks once.

| Depth | Block modules | Skill | Hooks | The owner gets |
| --- | --- | --- | --- | --- |
| `notify` | notify | no | none | questions and notifications, no cards |
| `track` (first install) | reporting, planning | yes | none | live cards with plans |
| `guide` | + continuity | yes | presence | + continuity across requests, compaction and `/clear`; the Sessions view |
| `optimize` | + efficiency | yes | presence | + lean context and right-sized subagents |

```bash
relo setup --level guide                 # block, skill and hooks: ~/.claude/settings.json ($CLAUDE_CONFIG_DIR), ~/.gemini/settings.json,
                                         # ~/.config/opencode/relo-hooks.json + plugins/relo.js (OpenCode has no command hooks)
relo setup --level guide --approvals on  # also answer permission prompts from the phone (the approvals hook set)
relo setup --level guide --project       # this repository: the block in AGENTS.md or CLAUDE.md, hooks in .claude/settings.local.json (personal, uncommitted)
relo setup --level track                 # the way back: deletes only Relo's hook entries, and revokes the harness credential
relo setup --show [--level optimize]     # read-only: what is installed per harness (or what that depth would install), and the block
relo setup --modules reporting,efficiency --level guide   # override the block's modules; hooks and the skill follow --level
relo sessions [--live]                   # the owner's Sessions view: harness, project, phase, waitingFor, lastSeenAt, card
```

Hooks are optional: notify and track install none, and without them Relo works fully. The hook sets are `off`,
`presence` and `approvals` (presence plus `PermissionRequest`; `--approvals on` at guide or optimize).

- `presence` is local context for the agent (a restore of what the session was doing after a restart or
  compaction, a reminder of an open or unrefreshed work) plus the session's phase. A local state machine reduces
  hook events to phases (open, working, waiting, stopped, ended; subagents roll up into their session), and only
  a change (plus a heartbeat at most every 5 minutes while working) is queued in a durable outbox and sent in the
  background with a harness credential that can write presence and nothing else. With Claude Code the snapshot
  also carries the session's name (the title Claude Code shows), sealed for the owner's phones. `relo hook` never
  sends a prompt, tool name, tool input or output, or transcript path, prints nothing and exits `0` always
  (`RELO_DEBUG=1` logs the reason to a file).
- Hooks never start, change or end a work, plan or question; those are declared by the agent. Entries are
  recognised by the `relo hook ` command prefix, so running setup again changes nothing and going back to track
  leaves everyone else's hooks and keys. Nothing but `relo setup` installs hooks, and `relo doctor` never
  suggests them. An older install's reminders-only set reads as custom, and `relo setup --refresh` upgrades it to presence.

## MCP server (optional)

`relo mcp` is a stdio MCP server in this package (no dependencies, same credentials) for harnesses without a shell, such as
Claude desktop and Cursor chat. Tools: `relo_work_start`, `relo_work_update`, `relo_work_deliver`, `relo_work_handoff`, `relo_work_finish`, `relo_work_state`, `relo_ask`,
`relo_interaction_wait`, `relo_notify`, `relo_doctor`. `relo_ask` waits up to 5 minutes and sends MCP progress
notifications every ~15 s when the client asked for them. One work per connection.

```bash
relo setup --mcp                          # every harness here with an MCP config (user-level: works in every project)
relo setup --mcp --agent claude-desktop   # only that one
```

`relo uninstall --apply` removes it; `relo doctor --full` lists it and never suggests it. Paths and formats:
`skills/relo-notifications/references/install.md`.

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
