---
title: relo setup, relo update and relo uninstall
nav: setup and update
summary: The owner's commands that connect this computer's agents, update the CLI and remove what Relo wrote.
---

These commands change this computer, so they are yours to run: an agent runs them only when you ask.
`relo setup` tells each harness it finds about Relo (an instructions block and the skill, plus hooks
and the MCP entry at the depths and switches that include them). `relo setup --show` reads what is installed. `relo config` shows each setting of this computer and
where it comes from (an environment variable, the config file, detection or the default). `relo
update` moves the CLI to a verified release, and `relo uninstall` lists, then removes, everything
Relo wrote. Guides: [Agent harnesses](/docs/guides/agents), [Depth and hooks](/docs/guides/hooks),
[Update and uninstall](/docs/guides/update). What lands where: [Files and folders](/docs/reference/files).

```sh
relo setup --dry-run
relo setup --agent claude-code --level guide
relo setup --computer "Studio Mac" --icon desktop
```

## Depth

`--level` sets how deep Relo plugs into each agent. At a terminal, setup asks once, with the installed
depth preselected. An agent or script that passes no `--level` keeps the installed depth (`track` on a
first install), so it never downgrades.

| Depth | Block | Skill | Hooks | You get |
| --- | --- | --- | --- | --- |
| `notify` | questions and notifications | no | none | notifications, no cards |
| `track` (default) | reporting, planning | yes | none | live cards, rounds, plan trees |
| `guide` | `track`, plus continuity | yes | presence | continuity across requests, compaction and `/clear`; the Sessions view |
| `optimize` | `guide`, plus efficiency | yes | presence, plus a subagent model nudge | `guide`, plus lean context and subagents (see below) |

- `--approvals on|off` answers permission prompts from your phone. It works at `guide` and `optimize`
  only, and uses the `approvals` hook set.
- `--modules a,b` picks the block's parts yourself (`notify`, `reporting`, `planning`, `continuity`,
  `efficiency`). Hooks still follow `--level`, and the report says `custom`.
- `--show` writes nothing. It prints each harness's depth, modules, hook set and block. With `--level X`
  it prints what `X` would install.
- Going down to `track` or `notify` removes the hooks and revokes the harness credential.
- `--mcp` is independent of the depth.

## Optimize extras

At `optimize`, setup also installs three things for Claude Code. Each has its own switch, and each is
taken out again by `relo uninstall` or by choosing a shallower depth. Codex gets the agents only (it has
no status line or subagent model setting of this kind); the block's efficiency lines apply there too.

- `--statusline on|off` (default on) wraps Claude Code's status line. `relo statusline` reads the context
  use and session cost, keeps them in the session's local state, then runs the status line command you had
  before with the same input and prints its output unchanged. Your previous command is saved in Relo's own
  state, never in `settings.json`, and put back exactly when the wrapper comes out. With none, it prints a
  short line of its own. It makes no network call. With the session hooks on, the phone is told the context
  percent and cost only after they moved 5 points or 50 cents.
- `--agents on|off` (default on) writes `~/.claude/agents/relo-explore.md` (small model, read-only tools,
  for searching and reading) and `relo-worker.md` (mid model, for well-specified changes). A file of the
  same name that Relo did not write is never touched; Relo's files carry a marker line, and deleting that
  line keeps your edits. For Codex the same two agents are written as `~/.codex/agents/relo-explore.toml`
  (low reasoning effort) and `relo-worker.toml` (medium), both on the session's own model, one custom agent per file, with the marker as a
  leading `#` comment line.
- `--subagent-model MODEL` sets `CLAUDE_CODE_SUBAGENT_MODEL` in the settings `env`. Only when you ask,
  never by default; `--subagent-model off` takes Relo's value out (and restores yours).

At a terminal, `relo setup --level optimize` asks about the first two (Enter is yes); an agent or script is
never asked and gets both. A bare `relo setup` on an optimize install keeps the extras as they are.

Two nudges come with it. When the status line reading is at or past 60% of the window (change it with the
environment variable `RELO_HANDOFF_THRESHOLD`) or beyond 200K tokens, the next prompt gets one line,
once per round, to deliver with `relo work handoff` and continue fresh. A subagent call that names no model
gets one line asking for one. Without the status line there is no reading and no handoff nudge.

## Name and icon

When you are signed in, `relo setup` also names this computer on your phone and in the Dashboard. At a
terminal it asks once, "What should Relo call this computer?" and for an icon (laptop, desktop, server,
cloud, terminal or build), offering this computer's own name and a guess at its kind. `--computer NAME`
and `--icon ICON` answer for you and work from anywhere, so a script or an agent you asked to set the
machine up can pass them; without a terminal, with `--json` or with `--dry-run` setup never asks. Signed
out, setup works as before and says how to sign in. The name and icon are kept by your Relo server, so
`relo uninstall` leaves them; change them later in the Dashboard.

## Commands

{{cli setup}}
