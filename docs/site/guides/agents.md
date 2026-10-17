---
title: Agent harnesses
nav: Agent harnesses
summary: Every agent on this computer knows Relo from its first message, so its work shows on your iPhone without you asking.
---

## Why

An agent that does not know about Relo never starts a card. `relo setup` tells every harness on this
computer, once: Claude Code, Codex, Gemini CLI, Cursor and the rest. From then on each session keeps one
card current, asks before risky steps and finishes with an outcome. You type nothing per session.

It is your command. An agent runs it only when you ask it to.

## Set up this computer

{{command setup}}

<ol class="docs-steps">
<li>

**Preview what it writes.** Nothing is changed; you see every file and the exact block.

```sh
relo setup --dry-run
```

</li>
<li>

**Write it.** For each harness found here, Relo adds a short marked block to the harness's instructions
file and installs the `relo-notifications` skill at the CLI's exact version.

```sh
relo setup
# only some harnesses (repeat --agent for several)
relo setup --agent claude-code --agent codex
```

</li>
<li>

**Restart the harness.** Agents read their instructions when a session starts, so open a new session
(or restart Claude desktop, Cursor and other apps).

</li>
</ol>

Running it again changes nothing. It prints what changed, what it skipped and why, and what to do next.

### One repository instead of the whole computer

`--project` puts the block in this repository instead of the harnesses' own files: `AGENTS.md` or
`CLAUDE.md`, whichever exists. With neither, it creates `AGENTS.md` plus a `CLAUDE.md` that imports it,
because Claude Code reads only `CLAUDE.md`. The block has no versions or dates, so a tracked file does
not churn.

```sh
relo setup --project
```

### After an update

`relo setup --refresh` brings what is installed up to this CLI: older blocks, older skill copies, hook
entries and MCP paths. It adds nothing new. [`relo update`](/docs/guides/update) runs it for you.

All flags: [setup reference](/docs/reference/cli/setup).

## What each harness gets

{{harnesses}}

Hooks and MCP are never written by a plain `relo setup`. They are separate choices:
[session hooks](/docs/guides/hooks) and [MCP for tools without a shell](/docs/guides/mcp).

## What the block says

The block is about ten lines. It tells the agent to:

- keep one work current for anything longer than a couple of minutes: start with the goal in your words
  and a plan, move through the steps, close each request with `deliver` and finish only when the goal
  is done ([rounds](/docs/concepts/work#rounds-one-goal-many-requests));
- let the plan grow when it learns more, and count parallel work as one step;
- write real words only: no placeholders, paths or secrets;
- ask with `--approval` before a risky action, and treat anything but `approved` as no;
- run `relo state` when it loses track, and leave Relo to the orchestrating agent (subagents run no
  relo commands).

Only the text between `<!-- relo:start -->` and `<!-- relo:end -->` is ever touched; the rest of the
file keeps its bytes. Add a line `<!-- relo:keep -->` inside the block to freeze it. The full rules an
agent follows are on [For agents](/docs/agents).

## A harness Relo does not detect

Relo detects Claude Code, Codex, OpenCode, Gemini CLI and Cursor from the variables they set in the
agent's shell. Any other harness names itself and gives each session a stable id, so every command lands
on one card and questions wait the short agent way (up to 100 seconds per command):

```sh
export RELO_SOURCE="My Harness"
export RELO_SESSION="$MY_HARNESS_SESSION_ID"
```

Set them in the harness's shell environment, not per command. Point the agent at the rules with the
[For agents](/docs/agents) page, or with `relo setup --agent agents`, which installs the skill into the
shared `~/.agents/skills` folder that several harnesses read.

Gemini CLI and Cursor are detected but expose no session id. Their agents pass the handle that
`relo work start` prints as `--work` on later commands; the echo shows the exact command.

## OpenCode

OpenCode sets `OPENCODE_SESSION_ID`, so each conversation gets its own work and card. Setup writes the
block into `~/.config/opencode/AGENTS.md` (OpenCode 2 does not read `~/.claude/CLAUDE.md`) and adds its
own copy of the skill only when neither `~/.claude/skills` nor `~/.agents/skills` has one, since OpenCode reads
both (`OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` stop that). At `guide` or
`optimize` it also installs Relo's plugin and `relo-hooks.json` in `~/.config/opencode/`. Restart OpenCode
afterwards. If OpenCode will not start after a config edit, check that `config.json` is valid: an `mcp`
entry needs `type: "local"`, `command` as an array, and `enabled`.

## Check that it works

Start a new session and give the agent a task that takes a few minutes. Then:

- **On your iPhone:** a card appears on the Lock Screen and in Now, with the goal and plan in the agent's
  words, and moves as the agent works.
- **In the session:** ask the agent to run `relo state`. It prints what the session has open, the plan,
  what you see and the next command.
- **On this computer:** `relo doctor` prints `ready:true`, or names the first step that is missing.

No card? Check that the session started after `relo setup`, then see [troubleshooting](/docs/troubleshooting).
To remove everything later: [Update and uninstall](/docs/guides/update).
