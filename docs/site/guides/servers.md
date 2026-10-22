---
title: Connect a computer
nav: Connect a computer
summary: One command, or one prompt for your agent, connects a computer or server with its agents set up and no sign-in on it.
---

## Why

A server you reach over SSH has no browser to sign in with, often runs its agents as services with a
minimal `PATH`, and may not have the Node.js the CLI needs. **Connect a computer** is a short wizard
that does all of it: it installs the CLI from your own Relo server, signs the computer in and sets up
its agents. It opens right after you create your account, and again whenever you add a computer.

## How

<ol class="docs-steps">
<li>

**Open the wizard on a device you trust.** In the Dashboard: **Account → Computers → Add a
computer**. On your iPhone: **Settings → Devices → Add a computer**. **Now** also offers it while no computer is
connected. Choose how deep Relo goes on the new computer (`notify`, `track`, `guide` or `optimize`,
default `track`).

</li>
<li>

**Choose who runs it.**

- **I'll run a command.** Paste one line on the new computer, as the user its agents run as:

  ```sh
  curl -fsSL https://relo.example.com/install.sh | sh -s -- rci_…
  ```

  It installs Node.js 22 if the computer has no recent one (the official build, checked against its
  checksums), then this server's CLI (checked against its digest) under `~/.local/share/relo`, and a
  `relo` launcher in `~/.local/bin` that names both by path, so hooks and services find it whatever
  their `PATH`. Then it signs in with the code and runs `relo setup` as you chose. Nothing runs as root.

  On a Mac, the command ends in `--mac-app` (the wizard's **Options**, on by default): it also puts
  **Relo for Mac** in `~/Applications` (checked against its digest) and opens it in the notch already
  signed in, with no browser sign-in. Your iPhone then asks once to approve this Mac's keys, as it
  does for the computer. A server with no Mac app to hand out (every public image) says so and skips it.

- **Let my agent do it.** Paste a prompt into Claude Code, Codex or another agent on that computer:

  ```text
  Read https://relo.example.com/install.md?code=rci_… and set up Relo on this computer at the track level.
  ```

  The agent runs the same install with your code and never asks you to sign in. Its harness may ask
  you to allow the command. It works the same in OpenCode: paste the prompt into OpenCode on that
  computer. To set up only OpenCode, open the wizard's **Options** and limit setup to OpenCode (agent
  id `opencode`).

</li>
<li>

**Watch it connect.** The wizard follows live: the computer connected, the agents found, then a test
notification on your phone. On the iPhone, a Live Activity shows the wait.

</li>
<li>

**Restart the agents** on it (Claude Code, OpenCode, Codex) so they load Relo. The computer shows on
your phone under its hostname.

</li>
</ol>

:::note The code
A code works once, for 30 minutes, needs no sign-in, and only its hash is stored. It signs in one
computer and nothing else. Make a new one if it expires. On a computer that is already signed in,
`relo auth invite` makes one too.
:::

## Trust

A computer that joins with a code is like any computer you sign in: it can send you cards and
questions, never read them. The device that made the code approves the computer's key for you,
after checking that the key is the one that used your code (see
[keys and devices](/docs/guides/keys) and [encryption](/docs/concepts/encryption)). If the code came
from another device, your devices show the computer as waiting until one of them approves it.

## OpenCode on the computer

`relo setup` writes three things for OpenCode:

- The instruction block, in OpenCode's own `~/.config/opencode/AGENTS.md`. OpenCode 2 no longer reads
  `~/.claude/CLAUDE.md`.
- The skill. OpenCode also reads `~/.claude/skills` and `~/.agents/skills`, so setup adds its own copy in
  `~/.config/opencode/skills` only when neither has one. Setting `OPENCODE_DISABLE_CLAUDE_CODE` or
  `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` stops OpenCode reading the shared folders.
- At `guide` or `optimize`, Relo's plugin in `~/.config/opencode/plugins/` and `relo-hooks.json` beside
  it. OpenCode has no command hooks, so the plugin runs the `relo hook` commands.

Restart OpenCode after setup. If OpenCode will not start after you edit its config, check that
`config.json` is valid: an `mcp` entry needs `type: "local"`, `command` as an array, and `enabled`.

## My computer shows a code

Without a code, run `relo auth login` on the computer. It prints a link, a QR code, a code and a
two-digit number. Approve it in the Relo app (**Settings → Devices → Sign in a computer**: scan the QR code or
type the code), or open the link in a browser. Pick the number the terminal shows. `relo auth join
CODE` is the step the install command runs, for a CLI you installed yourself.

## Cloud sandboxes

A cloud sandbox, such as Claude Code on the web, is not a computer: it is gone when the task ends.
Relo does not enroll it. Give it a CI token instead: set `RELO_API_URL` and `RELO_TOKEN` from
the sandbox's secrets (see [Scripts, cron and CI](/docs/guides/scripts)).
