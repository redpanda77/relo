---
title: Harnesses
summary: What relo setup writes for each agent harness, and how a harness Relo does not know joins in.
---

`relo setup` looks for each harness on this computer and writes only what that harness supports.
Run it again any time: it changes nothing that is already current. How to use it:
[Agent harnesses](/docs/guides/agents).

## What setup writes

{{harnesses}}

- **`--agent`**: the name to pass to `relo setup --agent NAME` to set up only that harness.
- **Instructions block**: a short marked block in the harness's global instructions file that tells
  the agent when to use Relo. `relo setup --project` puts it in the repository instead.
- **Skill**: the relo-notifications skill, copied into the harness's skills folder, with the full
  rules and commands.
- **Hooks**: optional, only with `relo setup --level guide` or `optimize`. They restore the agent's
  memory of its work locally and send the session's phase for your Sessions view. See
  [Depth and hooks](/docs/guides/hooks).
- **MCP**: optional, only with `relo setup --mcp`: an entry that launches `relo mcp`, for clients
  that cannot run a shell command. See [MCP](/docs/guides/mcp).

Where each of these files lives: [Files and folders](/docs/reference/files#harness-files).

## A harness Relo does not detect

Inside a detected harness the CLI reads the session id itself, so each conversation gets its own
work and card. Any other harness, or a long-running process of your own, sets two variables in the
environment the agent's shell commands run in:

```sh
export RELO_SOURCE="My harness"
export RELO_SESSION="conversation-7f3a"
relo work start --goal "Migrate the billing tables" --plan "Back up,Migrate,Verify"
```

`RELO_SOURCE` is the sender name on your phone. `RELO_SESSION` is a stable id for one conversation:
every command with the same id lands on the same work and card, and questions wait up to {{fact question.agentWaitSeconds}}
per command, as in a detected session. Both are ignored inside a detected harness.
