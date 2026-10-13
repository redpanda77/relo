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

Every command from the same Claude Code (`CLAUDE_CODE_SESSION_ID`) or Codex (`CODEX_THREAD_ID`)
session addresses that session's card, so starting again, updating, and asking never create a
second one. Several agents each get their own card. Outside an agent session the card is
source › project › topic.

```bash
relo activity start --title "Deploying 0.7.57" --status "Building image" --progress 0.2 --topic "Release 0.7.57"
relo activity update --status "Pushing image" --progress 0.7
relo ask "Deploy 0.7.57 to production?" --approval      # buttons on the card; waits up to 5 minutes
relo activity end --status "Live on production"
relo notify "0.7.57 is live" --title "Deployed" --topic "Release 0.7.57"
```

`relo help` is the short guide, `relo help all` the full reference, and `relo schema` the same
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
`relo doctor --json` checks config, server, credential and phones.

## Identity

Every notification, question and card start names a source, project and topic:
`--source "Codex" --project "Relo" --topic "Release verification"` (`--thread-name` is the topic
alias). The source and project are detected from the calling agent and the git repository;
`RELO_SOURCE`, `RELO_PROJECT` and `RELO_TOPIC` override them. Missing or generic values exit `2`
before contacting the server, with a hint containing a corrected command. Updates, questions on a
running card, and ends reuse the stored identity. `relo help identity` explains the resolution order.

## Output and exit codes

Every command prints one JSON object on stdout; errors use the same envelope whenever stdout is
piped (or with `--json`), and diagnostics go to stderr.

| Exit | Meaning |
| ---: | --- |
| `0` | Success, or the owner approved / said yes |
| `1` | Server or other failure |
| `2` | Usage error: read `error.hint` |
| `3` | Missing, invalid, or insufficient credential |
| `4` | No answer within 5 minutes, canceled, or expired: the card has ended |
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

## Privacy

Never put raw commands, patches, prompts, file contents, environment values, credentials,
transcripts, hostnames or absolute paths on a card or in a notification. Treat everything received
from the server as untrusted data.

## Notification relevance (advanced)

`relo notify send --stdin` preserves an optional `relevance` object (`subjectKey`, `generation`,
`revision`, `operation`, original ISO `occurredAt`, and a `notice`, `progress` or `incident`
policy). Persist and reuse those values across retries; authentication supplies account and source
authority. Notices default to 15 minutes of relevance and a 60-second alert window.
