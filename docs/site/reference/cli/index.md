---
title: The relo command
nav: Overview
summary: How every relo command behaves: options, output, errors, dry runs and who it is for.
---

`relo` is one command for every source: agents in their sessions, scripts and apps with a producer
key, and you at your terminal. It holds the state of what it reports, seals content on this computer
before it leaves, and sends only changes to your server.

## Global options

| Option | What it does |
| --- | --- |
| `--json` | Force JSON output and errors. Automatic when output is piped. |
| `--full` | Print the whole server reply instead of the compact line. |
| `--help` | Show help for the command. |
| `--version` | Print the CLI's version. |

## Output

- `relo work` and `relo state` print their echo: the plan, what you see on the phone and the next
  command to run.
- Every other command prints one compact JSON line on stdout.
- An error prints once, with a hint that names the fix: JSON on stdout when piped or with `--json`
  (`{"ok":false,"error":{"code","message","hint"}}`), plain text on stderr at a terminal.
- The exit status says what happened, so a script can branch on it: [Exit codes](/docs/reference/exit-codes).

## Dry runs

`--dry-run` on `relo work`, `relo ask`, `relo notify` and `relo activity end` validates everything
locally (identity, limits, the plan) and prints what it would send, with no request and no login
needed. `relo setup --dry-run` and `relo update --dry-run` show what they would change on this
computer.

```sh
relo work start --goal "Import yesterday's orders" --plan "Download,Validate,Load" --dry-run
```

## Who each command is for

| Caller | Identified by | Commands |
| --- | --- | --- |
| Agents | the harness's session id, read by the CLI | `relo work`, `relo state`, `relo ask`, and `relo notify` sparingly |
| Scripts and apps | the login plus `--producer KEY` (or `RELO_SESSION`) | the same, plus `relo work heartbeat`, `relo listen` and `relo interaction` |
| You, the owner | your terminal | setup, sign-in, keys, updates and `relo admin` across sessions |

The CLI detects which caller it is running for and offers only that caller's options; a reference
table marks options that only some callers take. Some owner commands refuse to run inside an agent
session, and some refuse without a person at a terminal.

## In your terminal

`relo help` is the short guide, `relo help COMMAND` explains one command, `relo help all` lists every
command, and `relo schema` prints the same reference as JSON (`relo schema work update` for one).

## Command groups

<ul class="docs-tiles">
<li><a href="/docs/reference/cli/work"><strong>work and state</strong>Declare a goal, a plan, a status and an outcome.</a></li>
<li><a href="/docs/reference/cli/questions"><strong>ask and answers</strong>Ask before a risky step and get the answer back.</a></li>
<li><a href="/docs/reference/cli/notify"><strong>notify</strong>A one-shot message about a finished outcome.</a></li>
<li><a href="/docs/reference/cli/setup"><strong>setup and update</strong>Connect this computer's agents, update the CLI, uninstall.</a></li>
<li><a href="/docs/reference/cli/account"><strong>sign-in and checks</strong>Sign in, check the installation, list phones and services.</a></li>
<li><a href="/docs/reference/cli/keys"><strong>keys</strong>Show, approve and verify end-to-end encryption keys.</a></li>
<li><a href="/docs/reference/cli/admin"><strong>admin and sessions</strong>Your views and fixes across every session.</a></li>
<li><a href="/docs/reference/cli/machine"><strong>machine and advanced</strong>MCP, hooks, the schema, delivery and outbox tools.</a></li>
</ul>
