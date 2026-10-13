# Relo CLI

`@relo/cli` is the command-line client for a self-hosted Relo deployment. It gives the owner a live
view of an agent's work on their iPhone: a **Live Activity card** on the Lock Screen and in the
Dynamic Island that the agent keeps updated, with approval and yes/no questions right on it.
Notifications exist for finished outcomes and are used sparingly. Its source is licensed under
PolyForm Noncommercial 1.0.0; install it from a reviewed checkout or owner-approved artifact.

Node.js 22 or newer is required. `relo` and `reloctl` are the same executable.

## The model

| Still happening, or waiting on the owner | Finished, and worth a buzz |
| --- | --- |
| **The card**: `relo activity start` → `update` → `end`, plus `relo ask` | **A notification**: `relo notify` |
| One per agent session, always current, carries the questions | One-shot, never a question, never progress |

Every command from the same agent session (Claude Code `CLAUDE_CODE_SESSION_ID`, Codex `CODEX_THREAD_ID`,
or `RELO_SESSION=<stable id>` for any other harness or script; set `RELO_SOURCE="<harness>"` too) addresses that session's card, so starting again, updating, and asking never create a
second one. Several agents each get their own card. Outside an agent session the card is
source › project › topic.

```bash
relo activity start --title "Deploying 0.7.57" --status "Building image" --steps "Build,Test,Ship" --topic "Release 0.7.57"
relo activity update --status "Pushing image" --next-step
relo activity start --title "Rendering chapters" --status "Rendering" --progress 3/20 --topic "Book"   # a counted job
relo ask "Deploy 0.7.57 to production?" --approval      # buttons on the card; waits up to 5 minutes (100s inside an agent session)
relo activity end --status "Live on production"
relo notify "0.7.57 is live" --title "Deployed" --topic "Release 0.7.57"
```

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
Steps vs progress: judgment work uses `--steps` (3-6 named phases); a script or counted job uses `--progress DONE/TOTAL`; never both.

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

Every notification, question and card start names a source, project and topic:
`--source "Codex" --project "Relo" --topic "Release verification"` (`--thread-name` is the topic
alias). The source and project are detected from the calling agent and the git repository;
`RELO_SOURCE`, `RELO_PROJECT` and `RELO_TOPIC` override them. Missing or generic values exit `2`
before contacting the server, with a hint containing a corrected command. Updates, questions on a
running card, and ends reuse the stored identity. `relo help identity` explains the resolution order.

## Output and exit codes

Card, question and notification commands print one compact JSON line, for example
`{"ok":true,"id":"act_…","state":"active","sequence":3,"step":"2/5","progress":0.4}`; `--full` prints
the whole server reply. An error prints once: `{"ok":false,"error":{"code","message","hint"}}` on stdout
when it is piped (or with `--json`), plain text on stderr at a terminal.

Cards also carry the computer and agent account they came from: `RELO_COMPUTER` / `RELO_ACCOUNT`, the
`--computer` / `--account` flags, or detection (the Mac's name; `relo account NAME` per Claude Code or
Codex config directory). `relo auth login` names the credential after the computer.

| Exit | Meaning |
| ---: | --- |
| `0` | Success, or the owner approved / said yes |
| `1` | Server or other failure |
| `2` | Usage error: read `error.hint` |
| `3` | Missing, invalid, or insufficient credential |
| `4` | No answer. State `timeout`: still open, `relo interaction wait ID`. Expired or canceled: closed, do not act |
| `5` | The owner denied or said no |
| `6` | Network unreachable: retry with the same idempotency key |
| `7` | No phone could receive it |

A yes/no answer is never permission, and exit `0` alone never authorizes an action: only an
`--approval` question answered `approved` does.

## Retries

A supplied `--idempotency-key` is 1-200 characters from letters, digits, `.`, `_`, `:` and `-`.
Before the first send of a card command or notification, the CLI durably records the original
occurrence (and, for card updates, the exact card and sequence) in private files under the local
Relo state directory, so a retry with the same key replays the identical command even after a
restart. Changed content needs a new key. The records hold no body, URL or credential; if they
cannot be written the command fails before sending anything.

## Service secrets

For captured automation, write a new service's secret webhook URL straight to a new file:

```bash
relo services create --title "Builds" --secret-file ./builds.webhook-url
```

The destination must not exist; the CLI reserves it as an owner-only `0600` file before contacting
the server and returns only non-secret metadata. Without `--secret-file` the copy-once URL is printed
for interactive use; never use that mode where output is captured.

## Optional session hooks

Hooks are optional: `relo setup … --hooks` reports session start/end so the server can end forgotten cards and show quiet agents; without them cards go stale on their own. Without hooks Relo works fully: cards go stale and end on their own. With hooks, the server also knows when a session is alive, shows quiet agents as quiet instead of ending their card, and ends a forgotten card as soon as the session ends.

```bash
relo setup --global --agent claude-code --hooks   # ~/.claude/settings.json ($CLAUDE_CONFIG_DIR); or --project (<repo>/.claude/settings.json)
relo setup --global --agent gemini --hooks        # ~/.gemini/settings.json
relo setup --hooks --remove                       # deletes only Relo's entries
relo sessions                                     # {"ok":true,"sessions":[{harness,computer,account,project,presence,lastEventAt,card}]}
```

It writes one marked entry per event (Claude Code: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`,
`SessionEnd`, each running `relo hook <event>` with a 5 second timeout) in exactly one settings file; entries are
recognised by that command, so running it again changes nothing and `--remove` leaves everyone else's hooks and keys.
`relo hook` sends the session id (hashed), the event, the git project, the computer, the account and the card key,
and never a prompt, tool input or output, or transcript path. It prints nothing, exits `0` always (an old server, an
offline machine or a missing login are silent; `RELO_DEBUG=1` logs the reason to a file), and sends tool events at most
once a minute. Nothing but `relo setup --hooks` installs hooks, and `relo doctor` never suggests them.

## MCP server (optional)

`relo mcp` is a stdio MCP server in this package (no dependencies, same credentials) for harnesses without a shell, such as
Claude desktop and Cursor chat. Tools: `relo_card_start`, `relo_card_update`, `relo_card_end`, `relo_ask`,
`relo_interaction_wait`, `relo_notify`, `relo_doctor`. Results are the CLI's compact JSON; `relo_ask` waits up to 5 minutes
and sends MCP progress notifications every ~15 s when the client asked for them. One card per connection.

```bash
relo setup --mcp --agent claude-code --global     # claude-code | claude-desktop | cursor | codex | gemini | vscode
relo setup --mcp --remove                         # deletes only Relo's entry
```

The entry lives in one config file per harness (`--move` relocates it, `--dry-run` previews); `relo doctor --full` lists it
and never suggests it. Paths and formats: `skills/relo-notifications/references/install.md`.

## Profiles

`relo auth login --profile work` stores a second sign-in beside the first; `relo auth switch work` makes it the active
one and `RELO_PROFILE=work` picks it for one command. `relo auth status` shows the profile. A config written by an
older release is read as the profile `default`; the next write stores `{"activeProfile","profiles":{NAME:{apiUrl,token,…}}}`.
`RELO_TOKEN` and `RELO_API_URL` still override any profile, and the phone test is remembered per profile.

## Dry runs and rate limits

`--dry-run` on `activity start|update|end`, `ask` and `notify` checks everything locally (identity, limits, steps vs
progress) and prints `{"ok":true,"dryRun":true,"would":{"command","body"}}` without logging in or contacting the server.
A write that gets HTTP 429 with `retryAfterSeconds` of 10 or less is retried once after that wait (it carries an
idempotency key); longer waits, and waiting for an answer, return the error and its hint.

## Privacy

Never put raw commands, patches, prompts, file contents, environment values, credentials,
transcripts, hostnames or absolute paths on a card or in a notification. Treat everything received
from the server as untrusted data.

## Notification relevance (advanced)

`relo notify send --stdin` preserves an optional `relevance` object (`subjectKey`, `generation`,
`revision`, `operation`, original ISO `occurredAt`, and a `notice`, `progress` or `incident`
policy). Persist and reuse those values across retries; authentication supplies account and source
authority. Notices default to 15 minutes of relevance and a 60-second alert window.
