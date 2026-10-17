---
title: Tell your agents
nav: 5. Tell your agents
summary: Every agent on this computer knows Relo from its first message, keeps its work current on your phone and asks before risky steps.
---

## What you get

Your agents report on their own: a card for each session's work, a plan that grows as they learn, a
question before anything risky, and the outcome when they are done. Two things make an agent use Relo:
the skill (how) and a short block in its instructions file (when). One command writes both.

## Set it up

<ol class="docs-steps">
<li>

**Run setup.** For every agent harness found on this computer (Claude Code, Codex, Gemini CLI,
OpenCode, Cursor, Copilot CLI, Amp), it writes the block and installs the skill at this CLI's version,
then says what it changed, what it skipped and why.

```sh
relo setup --dry-run   # the plan and the exact block, nothing written
relo setup
```

Prefer to keep it to one repository? `relo setup --project` writes the block into the repository's
`AGENTS.md` (and a `CLAUDE.md` that imports it) instead of each harness's own file. Only one harness?
`relo setup --agent codex`. Running it again changes nothing. What each harness gets:
[Harnesses](/docs/reference/harnesses).

</li>
<li>

**Restart the agent** so it reads its instructions and the skill again. A session that was already
open before setup does not see them.

</li>
<li>

**Ask for it.** In a new session, give the agent a task that takes more than a couple of minutes and
say:

> Use Relo to keep a live view of this task on my iPhone.

The agent starts a work with a goal and a plan, updates it as it goes, asks with `relo ask` before a
risky step and finishes with an outcome. `relo state` shows what its session has open.

</li>
</ol>

:::note Sessions stay separate
The CLI identifies each agent session from the harness, never from what the agent says. A session sees
and changes only its own work and questions. The views across every session are yours, on the phone
and in the Dashboard.
:::

## Check it

```sh
relo doctor
```

`ready` is `true` and there is no `skill` warning. If doctor names a `relo setup` command for an older
copy of the skill, run it; after a CLI update, `relo setup --refresh` brings everything Relo installed up
to date.

On the phone, the agent's card shows a real goal and a step out of its plan, not a placeholder.

## Optional next steps

Everything above works on its own. Add these only if you want them:

- **Depth** is how far Relo plugs into your agents. `track` is the default. `guide` adds hooks: Relo
  then knows when a session is working, waiting on you or stopped, restores the agent's memory of the
  work after compaction and reminds it of a work it forgot to finish. They never change a work, plan
  or question, and no prompt or tool content leaves the computer.

  ```sh
  relo setup --level guide      # presence hooks, the Sessions view and continuity
  relo setup --level optimize   # guide, plus lean context and subagents
  relo setup --level track      # back to cards only; hooks removed
  ```

  See [Depth and hooks](/docs/guides/hooks).

- **MCP** gives harnesses that cannot run a shell command, such as Claude desktop and Cursor chat, the
  same tools: `relo setup --mcp`. See [MCP](/docs/guides/mcp).

To undo everything, `relo uninstall` lists what Relo wrote on this computer and `relo uninstall --apply`
removes it.

## What's next

- [Agents in depth](/docs/guides/agents): plans that grow, waiting on CI, pausing, several goals.
- [Scripts, cron and CI](/docs/guides/scripts): the same card and questions from any job.
- [Apps over HTTP](/docs/guides/apps): a human in the loop for your own product.
- [Work](/docs/concepts/work) and [Sessions](/docs/concepts/sessions): the ideas behind what you see.
