---
title: MCP for tools without a shell
nav: MCP
summary: Claude desktop, Cursor chat and other clients that cannot run a command still show their work and ask you on your iPhone.
---

## Why

Most agents reach Relo by running `relo` in a shell. Some clients have no shell: Claude desktop, Cursor's
chat, and other apps that talk to tools only over the Model Context Protocol. `relo mcp` is a small MCP
server inside the CLI that gives them the same work, questions and rules. It uses the CLI's own sign-in
and encryption keys, so there is nothing else to install or sign in to.

Like the rest of `relo setup`, adding it is your choice.

## Add the MCP entry

<ol class="docs-steps">
<li>

**Write the entry.** For every harness on this computer that has an MCP config, or one named with
`--agent`:

```sh
relo setup --mcp
# only Claude desktop
relo setup --mcp --agent claude-desktop
```

Add `--dry-run` first to see the exact entry and file.

</li>
<li>

**Restart the client.** Clients read their MCP config at launch. After the restart, a tool list named
`relo` appears in the client.

</li>
</ol>

The entry is named `relo` and is user-level, so it works in every project. Relo never writes a project's
own MCP file, which is shared with your team. Shell harnesses get the command `relo mcp`. GUI apps such
as Claude desktop and Cursor do not read your shell's `PATH`, so they get the full path to `node` and to
this CLI; `relo setup --refresh` rewrites those paths after node or the CLI moves. Codex's entry also
raises its tool timeout, so a question is not cut short.

Which harnesses take an MCP entry is in the [harness table](/docs/guides/agents#what-each-harness-gets).
All flags: [setup reference](/docs/reference/cli/setup).

## The tools

Each tool runs the same `relo` command a shell agent would, with the same checks and the same compact
JSON result. The tool descriptions carry the rules (plan honestly, real words, only `approved` is
permission), so the model reads them where it decides.

| Tool | Does | Same as |
| --- | --- | --- |
| `relo_work_start` | declare the session's work: goal, plan or count | `relo work start` |
| `relo_work_update` | status, next step, plan changes, progress, a declared wait | `relo work update` |
| `relo_work_deliver` | end the current request with an outcome; the work stays open for the next | `relo work deliver` |
| `relo_work_handoff` | leave a note for a fresh session before the context fills | `relo work handoff` |
| `relo_work_finish` | finish once with an outcome, failed or dropped | `relo work finish` |
| `relo_work_state` | what this session has open and parked | `relo state` |
| `relo_ask` | an approval or yes/no question, waiting up to {{fact question.defaultSeconds}} | `relo ask` |
| `relo_interaction_wait` | keep waiting for a question still open | `relo interaction wait` |
| `relo_notify` | one notification, rarely, for a finished outcome | `relo notify` |
| `relo_doctor` | is Relo signed in and reachable | `relo doctor` |

`relo_ask` waits without a shell timeout and sends progress notifications while it waits, so the client
does not give up. If the answer has not come in {{fact question.defaultSeconds}} it returns state `timeout`, and the model calls
`relo_interaction_wait` with the question's id. As everywhere, only an approval answered `approved` is
permission; anything else means no.

## One session per connection

Each MCP connection is one session: one chat in Claude desktop is one card, with its own work, plan and
questions, and it sees nothing of other sessions. The source on the card is the client's own name
(Claude, Cursor); the goal and plan are the agent's, in your words.

## Check that it works

- In the client, ask the agent to check Relo. It calls `relo_doctor`, which returns `ready:true` or the
  first step that is missing.
- Give it a task that takes a few minutes. A card with its goal and plan appears on your iPhone.
- Nothing happens? Run `relo setup --mcp --dry-run` and confirm the entry points at a real file, then
  restart the client. `RELO_DEBUG=1` in the entry's environment makes `relo mcp` log to stderr.

To remove the entry with everything else Relo wrote: `relo uninstall` (see
[Update and uninstall](/docs/guides/update)).
