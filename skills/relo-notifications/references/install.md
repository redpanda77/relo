# Installing and updating

Agents using the skill never install or upgrade the CLI or the skill mid-task without the owner's go-ahead. This page is
for the owner, a maintainer working from a reviewed checkout of the Relo repository, or an agent the owner has
asked to set Relo up.

## First run, end to end

Only when a relo command fails with an auth or no-phone error, or `relo doctor` prints `"ready":false`
(never as a preamble to a task, and one question to the owner per missing step at most):

1. `relo` not found: ask the owner, then install the CLI from the reviewed tarball or checkout (next section).
2. `relo doctor`, then run `next.run` for the first unmet `next.step`, repeating until `ready` is `true`:
   - `login`: `relo auth login --no-wait --api-url https://YOUR-RELO-SERVER` (the server address comes from
     the owner) prints `{"state":"pending","url","code","qr"}` and returns. Show the owner the **url** and the **qr**
     (in a code block): they approve in the Relo app (Settings → Devices → Sign in a computer, scan it) or by
     opening the link in a signed-in browser. Never answer it for them with a yes/no question. Then run
     `relo auth login --wait` (up to 100s; exit `4` state `pending`: run it again; exit `8` "expired": start over).
     A pending sign-in resumes (`next.run` is `relo auth login --wait`) instead of starting a second one.
   - `phone`: the owner opens the Relo app, signs in and allows Live Activities; `relo devices list` shows it.
   - `test`: `relo test` shows a short card and asks "Can you see this card on your iPhone?". Done once; a
     phone that passed is remembered. `relo test --again` forces a re-run.
   - `skill` (warning only): `next.run` is the exact `relo setup --agent <x>` (or `relo setup --refresh` for an
     older copy); tell the owner once and run it only with their go-ahead, never mid-task.

## The CLI

A fresh machine installs the CLI the owner's server hands out (checked against its digest; Node.js 22 comes
with it when missing), then checks itself:

```bash
curl -fsSL https://YOUR-RELO-SERVER/install.sh | sh          # the CLI only; then relo auth login
curl -fsSL https://YOUR-RELO-SERVER/install.sh | sh -s -- rci_…   # with a code from Add a computer: signed in and set up
relo doctor
```

GitHub releases (`cli-v<version>`, `npm install --global` of their tarball) remain for an npm install.

`relo doctor` names the next step (sign in with `relo auth login`, a phone, `relo test`); never paste tokens.
CI and containers skip `auth login` and set `RELO_TOKEN` and `RELO_API_URL` from their secret store; the owner makes that token with `relo auth token create --secret-file PATH`.

### Updating

A CLI from the install script updates itself in the background when the server offers a newer one. An npm install says so once in a relo reply ("Relo CLI … is behind your server's …"): then run `relo update`.

`relo doctor` shows `"warnings":{"update":{"state":"behind","latest","hint":"relo update"}}` when a newer release
exists (checked at most once a day with a 2 s timeout; off with `RELO_NO_UPDATE_CHECK=1`). It never changes `ready`.

```bash
relo update --check      # {"ok":true,"current","latest","updateAvailable"}; installs nothing
relo update              # {"ok":true,"from","to","verified":true}: from the signed-in server (else GitHub), checked, then installed
relo update --rollback   # reinstalls the previous release kept in ~/.local/share/relo/cli-releases/<version>/
relo update --version 0.10.0 --dry-run
```

A checksum mismatch or a download failure installs nothing and prints the reason. If npm cannot write its global
folder, use a user-owned prefix (`npm config set prefix ~/.local`). From a reviewed checkout instead:
`npm pack ./packages/cli --pack-destination DIR` then `npm install --global DIR/relo-cli-<version>.tgz`.

## Telling agents about Relo: `relo setup` (the owner's command)

One command, for the owner (an agent runs it only when the owner asks). For each harness found on this computer
(or named with `--agent`) it writes a short marked block into the harness's instructions file, so an agent knows
Relo from its first message, and installs this skill into the harness's skills folder, at the CLI's exact version:

```bash
relo setup                          # every harness found here: block + skill
relo setup --agent codex            # only these (repeat --agent); config-dir variables are honoured
relo setup --project                # the block in this repository instead of the harnesses' own files
relo setup --dry-run                # the plan and the exact block, nothing written
relo setup --refresh                # after an update: stale blocks, older skill copies, hooks, MCP paths; adds nothing
```

It prints what changed, what was skipped and why, and what to do next (restart the harness); `--json` gives
`{"ok":true,"changed":[{"kind","harness","file","action"}],"unchanged":N,"skipped"?,"errors"?,"next"}`. Running it
again changes nothing. Only the text between `<!-- relo:start -->` and `<!-- relo:end -->` is ever touched, and
the rest of the file keeps its bytes and line endings; a line `<!-- relo:keep -->` inside the block freezes it. A
file Relo cannot read safely (an unfinished block, JSON with comments) is reported and left alone.

| Harness | Instructions | Skills folder |
| --- | --- | --- |
| `claude-code` | `$CLAUDE_CONFIG_DIR` or `~/.claude`, `CLAUDE.md` | same folder, `skills/` |
| `codex` | `$CODEX_HOME` or `~/.codex`, `AGENTS.md` | `~/.agents/skills` (shared by Codex, Cline, Warp, Zed, Pi) |
| `gemini` | `~/.gemini/GEMINI.md` | `~/.gemini/skills` |
| `opencode` | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/skills` |
| `copilot` | `$COPILOT_HOME` or `~/.copilot`, `copilot-instructions.md` | same folder, `skills/` |
| `amp` | `~/.config/amp/AGENTS.md` | `~/.config/agents/skills` |
| `cursor` | none | `~/.cursor/skills` |

`--project` writes the repository's `AGENTS.md` or `CLAUDE.md`, whichever exists. Both with their own text is an
error (make `CLAUDE.md` the line `@AGENTS.md`); neither creates `AGENTS.md`, the cross-harness standard, plus a
`CLAUDE.md` holding `@AGENTS.md`, because Claude Code reads only `CLAUDE.md`. The block has no versions or dates,
so tracked files do not churn. Before a copy of the skill is replaced it is moved to
`~/.local/share/relo/skill-archives/<timestamp>-<version>/`, outside every discovery root.

No CLI yet? The public flow still works, and a later `relo setup` replaces it:

```bash
npx --yes skills@1.5.22 add redpanda77/relo@relo-notifications --agent codex --yes --copy --global
```

Maintainers: run `node scripts/validate-skill.mjs` and `node --test tests/*.test.mjs` in the source copy, and
keep the skill's `package.json` version and its `@relo/cli` pin equal to the CLI's: `npm pack` fails otherwise.

## MCP server (harnesses without a shell): `relo setup --mcp`

`relo mcp` is a stdio MCP server inside the CLI (same credentials, no extra install) for Claude desktop, Cursor chat
and other clients that cannot run a shell command. Tools: `relo_work_start`, `relo_work_update`, `relo_work_finish`,
`relo_work_state`, `relo_ask` (waits up to <!--f:question.defaultSeconds-->5 minutes<!--/f-->, sending MCP progress notifications), `relo_interaction_wait`,
`relo_notify`, `relo_doctor`. The tool descriptions carry the plan and approval rules. One work per MCP connection.

```bash
relo setup --mcp                          # every harness here that has an MCP config
relo setup --mcp --agent claude-desktop   # only that one (macOS and Windows)
```

| Harness | File | Key |
| --- | --- | --- |
| `claude-code` | `~/.claude.json` | `mcpServers` |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` (Windows `%APPDATA%\Claude\…`) | `mcpServers` |
| `cursor` | `~/.cursor/mcp.json` | `mcpServers` |
| `codex` | `$CODEX_HOME` or `~/.codex`, `config.toml` | `[mcp_servers.relo]` |
| `gemini` | `~/.gemini/settings.json` | `mcpServers` |

The entry is named `relo` and is user-level, so it works in every project (a project's own MCP file is shared with
the team, so Relo never writes one). Shell harnesses get `{"command":"relo","args":["mcp"]}`; GUI apps (Claude
desktop, Cursor) do not inherit the shell `PATH`, so they get the absolute `node` and `relo.mjs` paths of this CLI
(`relo setup --refresh` updates them after node or the CLI moves). Codex's table also sets
`tool_timeout_sec = 330`, because its default of 60 s would cut a question short. Restart the harness after.

## Depth: `relo setup --level notify|track|guide|optimize`

The owner picks how deep Relo plugs into the agent, once per computer. A person at the terminal is asked once.
An agent or script without `--level` keeps what is installed (track on a first install), so it never downgrades.

| Depth | Installs | Owner gets |
| --- | --- | --- |
| `notify` | a short block (questions and notifications) | no cards |
| `track` (default) | the block for cards and plans, and this skill | live cards, rounds, plan trees |
| `guide` | `track`, plus a continuity part and the presence hooks | continuity across requests, compaction and `/clear`; the Sessions view |
| `optimize` | `guide`, plus a part on lean context and subagents | see [efficiency](efficiency.md) |

Hooks are optional and only at `guide` and `optimize`. They report the session's phase (working, waiting, idle,
ended) and, with Claude Code, its name for the owner's Sessions view. A local state machine turns hook events into
phases and the CLI sends only changes, over a harness credential that can write presence and nothing else (no
prompts, tool names or tool input or output). Hooks never start, change or end a work, plan or question. Never
change the depth on your own.

```bash
relo setup --level guide                  # block, skill and presence hooks
relo setup --level guide --approvals on   # also answer permission prompts from the phone (guide, optimize)
relo setup --level track --project        # this repository's block only
relo setup --level track                  # hooks out everywhere; the harness credential revoked
relo setup --show                         # the installed depth and block per harness; writes nothing
relo setup --modules reporting,planning   # a custom mix of block parts
```

Gemini CLI has hooks at `guide` and `optimize`, in its user settings only. OpenCode too, approvals included: it has
no command hooks, so setup writes `~/.config/opencode/relo-hooks.json` and Relo's plugin `plugins/relo.js`, which runs
those commands (a subagent's child session rolls up into its session), adds the continuity context to the session's
system text, and with `--approvals on` asks the owner when OpenCode asks for permission. OpenCode gets its own
`AGENTS.md` block and reads the skill from Claude Code's or the shared skills folder. `relo state` and the owner's
`relo outbox status` show what is queued; `relo outbox flush` sends it at once.

## Removing

```bash
relo uninstall            # lists everything Relo wrote on this computer
relo uninstall --apply    # removes Relo's parts only: blocks, skill copies (archived), hooks, MCP entries
relo auth logout          # optional: forget this computer's sign-in
npm uninstall --global @relo/cli
```

A block marked `<!-- relo:keep -->` stays. Older releases added Codex hooks and a Codex notifier: remove any
`relo-codex-hook` entries from `~/.codex/hooks.json` and run `npm uninstall --global @relo/codex-notify`.
