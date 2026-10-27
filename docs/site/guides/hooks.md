---
title: Depth and session hooks
nav: Depth and hooks
summary: Choose how deep Relo plugs into your agents, and whether hooks show you which sessions are working, waiting on you or stopped.
---

## Why

Without hooks, Relo knows only what an agent declares. That is enough: cards, plans, questions and
outcomes all work, and a card that stops updating is dimmed after {{fact card.freshSeconds}} and leaves the Lock Screen
after 60.

Hooks add two things. They help the agent keep its card honest (its work restored after compaction,
a reminder when it forgets). And they give you evidence: which sessions are working, waiting on you,
idle or ended, even when an agent has gone quiet. Hooks come with the `guide` and `optimize` depths,
and are your choice, never an agent's.

:::note Hooks never touch your cards
A hook never starts, changes or ends a work, plan or question. A broken hook can mislabel a session in
the Sessions view; it cannot end anyone's work.
:::

## What the hooks tell the agent

At `guide` and `optimize`, Claude Code hooks catch the usual slips the moment they happen, with one
line of context the agent reads:

- **Each request:** whether the session has a card. If it has one, the hook names its round and step. If
  not, it gives the command to start one, with the two plan shapes: 3 to 6 milestones for one sitting, or
  phases with steps under them for a large body of work.
- **Before an edit:** no card yet, a delivered round with a new request under way, or a card on the same
  step for 10 minutes. Each line comes once per occasion.
- **A relo command whose reply the agent would not read** (sent to `/dev/null`, or piped into `tail` or
  `grep`) is refused, so the agent runs it alone and sees what reached you. Without hooks, a reply sent to
  `/dev/null` goes to the agent's error output instead.
- **When a turn ends** with the round open, steps left and nothing declared as running: deliver, declare
  the wait, or end the turn if it asked you something.

## Pick a depth

You choose once per computer. At a terminal, `relo setup` asks. An agent or script that passes no
`--level` keeps what is installed, so re-running setup never downgrades you.

| Depth | What it installs | Hooks | What leaves this computer |
| --- | --- | --- | --- |
| `notify` | a short block for questions and notifications | none | only what the agent sends you |
| `track` (default) | the block for cards and plans, and the skill | none | only what the agent sends you |
| `guide` | `track`, plus continuity across requests, compaction, resume and `/clear` | presence | phase snapshots, too |
| `optimize` | `guide`, plus lean context and right-sized subagents | presence, plus a subagent model nudge | phase snapshots, plus context percent and cost after they move |

Permission prompts answered from your phone are a separate switch, `--approvals on`, at `guide` and
`optimize`. It adds a hook that relays each permission prompt to you.

At `optimize`, Relo also wraps Claude Code's status line to read context use and cost (your own status
line keeps printing, unchanged), installs the `relo-explore` and `relo-worker` subagents in
`~/.claude/agents`, and nudges twice: a handoff line when the context passes 60%, and a model line when a
subagent call names none. Each extra has a switch and comes out with `relo uninstall` or a shallower
depth. Details: [relo setup](/docs/reference/cli/setup#optimize-extras).

A presence snapshot holds a hash of the session id, the phase (working, waiting, stopped, ended) and its
times, since when a tool has been running, and the project, computer and account. The CLI sends one
only when the phase changes, plus a heartbeat at most every 5 minutes while working.

:::privacy What never leaves
Prompts, tool names, tool input and output, notification text and transcript paths are never sent. The
hook reads the few fields it needs from the harness and drops the rest unread. Names are sealed for
your phones, like card text.
:::

## Which harnesses support hooks

| Harness | Levels | Where Relo writes |
| --- | --- | --- |
| Claude Code | `off`, `presence`, `approvals` (and each with the subagent nudge at `optimize`) | user settings, or with `--project` the personal `.claude/settings.local.json` |
| Codex | `off`, `presence` | user only: `~/.codex/hooks.json`. Codex runs a hook only once you trusted it: after setup, type `/hooks` in Codex and trust Relo's |
| Antigravity | `off`, `presence` | user only: the named hook `relo` in `~/.gemini/config/hooks.json` |
| Gemini CLI | `off`, `presence` | user settings only |
| OpenCode | `off`, `presence`, `approvals` | user only: `~/.config/opencode/relo-hooks.json` and Relo's plugin, `plugins/relo.js` |

The other harnesses have no hooks Relo uses; everything else still works there. The full table is on
[Agent harnesses](/docs/guides/agents#what-each-harness-gets).

## Turn hooks on

<ol class="docs-steps">
<li>

**Choose the depth and where.** For every project on this computer:

```sh
relo setup --level guide
```

For one repository only, add `--project`. Relo writes the personal, uncommitted
`.claude/settings.local.json`, never the shared settings file, so a teammate without Relo gets no broken
hook.

```sh
relo setup --level guide --project
```

</li>
<li>

**Restart the harness.** Hooks load when a session starts.

</li>
<li>

**Check what is installed.**

```sh
relo setup --show
```

It writes nothing. It prints the depth, the hook set and the block for each harness.

</li>
</ol>

Relo's entries are the ones whose command starts with `relo hook`. Setup never touches anyone else's
hooks and refuses a settings file that is not plain JSON. All flags:
[setup reference](/docs/reference/cli/setup).

## The presence-only credential

Presence snapshots do not use your CLI login. `relo setup --level guide` mints a separate harness
credential, kept beside the CLI config in a file only you can read, with one scope: write presence. The
server refuses it on every other route, and refuses your ordinary login on the presence route. So a hook
can never write a card, a plan or a question, even by mistake.

If the server is unreachable during setup, the credential is minted on the first send instead.
`relo doctor` warns when presence hooks are installed without one.

## Turn hooks off

```sh
relo setup --level track
```

This removes Relo's hooks from every settings file, revokes the harness credential and drops snapshots
that were queued but not sent. Everything keeps working without them.

## What you will see

- **The agent:** gets a short note when its card looks forgotten (every step done but still open, a
  count that reached its total, no update for a while), and its open work back after compaction.
- **You:** your Sessions view lists each session as working, waiting on you, idle or ended. From a
  terminal, `relo sessions` shows the same list; it is empty without presence hooks. Relo also uses the
  phase as evidence for whether a card is still live, so a card whose session ended does not linger.

How the server combines declared and observed state: [Sessions](/docs/concepts/sessions) and
[State](/docs/concepts/state).
