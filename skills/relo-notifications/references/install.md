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
     the owner) prints `{"state":"pending","url","code"}` and returns. Relay the **url** to the owner, then run
     `relo auth login --wait` (up to 100s; exit `4` state `pending`: run it again; "expired": start over).
     A pending sign-in resumes (`next.run` is `relo auth login --wait`) instead of starting a second one.
   - `phone`: the owner opens the Relo app, signs in and allows Live Activities; `relo devices list` shows it.
   - `test`: `relo test` shows a short card and asks "Can you see this card on your iPhone?". Done once; a
     phone that passed is remembered. `relo test --again` forces a re-run.
   - `skill` (warning only): `next.run` is the exact `relo skill install --agent <x>`; tell the owner once and
     run it only with their go-ahead, never mid-task.
3. The instruction file (`relo setup`) is not a step: only if the owner asks, for the one file they choose.

## The CLI

A fresh machine installs a release (GitHub Releases of `redpanda77/relo`, tag `cli-v<version>`, assets
`relo-cli-<version>.tgz`, `SHA256SUMS`, `sbom.cdx.json`, `manifest.json`), then checks itself:

```bash
npm install --global https://github.com/redpanda77/relo/releases/download/cli-v<version>/relo-cli-<version>.tgz
relo doctor
```

`relo doctor` names the next step (sign in with `relo auth login`, a phone, `relo test`); never paste tokens.
CI and containers skip `auth login` and set `RELO_TOKEN` and `RELO_API_URL` from their secret store.

### Updating (the owner agrees first; an agent never updates mid-task)

`relo doctor` shows `"warnings":{"update":{"state":"behind","latest","hint":"relo update"}}` when a newer release
exists (checked at most once a day with a 2 s timeout; off with `RELO_NO_UPDATE_CHECK=1`). It never changes `ready`.

```bash
relo update --check      # {"ok":true,"current","latest","updateAvailable"}; installs nothing
relo update              # {"ok":true,"from","to","verified":true}: sha256 checked against SHA256SUMS, then npm install --global
relo update --rollback   # reinstalls the previous release kept in ~/.local/share/relo/cli-releases/<version>/
relo update --version 0.10.0 --dry-run
```

A checksum mismatch or a download failure installs nothing and prints the reason. If npm cannot write its global
folder, use a user-owned prefix (`npm config set prefix ~/.local`). From a reviewed checkout instead:
`npm pack ./packages/cli --pack-destination DIR` then `npm install --global DIR/relo-cli-<version>.tgz`.

## The skill

The skill ships inside the CLI, at the CLI's exact version. One command copies it into **one** harness's
skills directory (`relo doctor` names the right one when it is missing or stale; it never installs):

```bash
relo skill install --agent claude-code      # or codex, opencode, gemini, amp, cursor, copilot, agents
relo skill install --dir ~/path/to/skills   # a harness not listed: its skills directory
relo skill install --agent codex --dry-run  # report only
relo skill status                           # every copy found: {"cli","copies":[{"dir","version","current"}]}
relo skill remove --agent codex             # archives the copy, then removes it
```

Result: `{"ok":true,"agent","dir":"~/.agents/skills/relo-notifications","version","action":"installed|updated|unchanged","archived"?}`.
`unchanged` means the same version and content is already there. Before replacing a copy it is moved to
`~/.local/share/relo/skill-archives/<timestamp>-<version>/`, outside every skill discovery root, so an old
copy can never shadow the active one.

| `--agent` | Skills directory |
| --- | --- |
| `claude-code` | `$CLAUDE_CONFIG_DIR` or `~/.claude`, `skills/` |
| `codex`, `agents` | `~/.agents/skills` (shared by Codex, Cline, Warp, Zed, Pi and other universal harnesses) |
| `opencode` | `~/.config/opencode/skills` |
| `gemini` | `~/.gemini/skills` |
| `amp` | `~/.config/agents/skills` |
| `cursor` | `~/.cursor/skills` |
| `copilot` | `$COPILOT_HOME` or `~/.copilot`, `skills/` |

Paths follow the `skills` CLI's agent table. Install for **each** agent that should have it; `relo doctor`
checks every copy's version against the CLI and names the stale one.

No CLI yet (an agent that only has the skill, or a machine without Relo)? The public flow still works, and
a later `relo skill install` replaces it:

```bash
npx --yes skills@1.5.22 add redpanda77/relo@relo-notifications --agent codex --yes --copy --global
```

Maintainers: run `node scripts/validate-skill.mjs` and `node --test tests/*.test.mjs` in the source copy, and
keep the skill's `package.json` version and its `@relo/cli` pin equal to the CLI's: `npm pack` fails otherwise.

## Telling agents Relo exists: `relo setup` (the owner's choice)

The skill triggers on matching requests; `relo setup` optionally makes sure one agent also knows Relo exists
from the first message. It is **never automatic**: an agent runs it only when the owner asks, for the one file
the owner picked, and `relo doctor` never suggests it. The block lives in **exactly one** file, so tools that
re-inject their own blocks into every `AGENTS.md` and `CLAUDE.md` cannot make it spread.

```bash
relo setup                                   # writes nothing: exit 2, lists the choices below
relo setup --project                         # this repo's AGENTS.md or CLAUDE.md (git root, else the folder)
relo setup --global --agent codex            # that harness's one global file (see the table)
relo setup --file path/to/AGENTS.md          # exactly that file
relo setup --project --move                  # relocate the block from the file it is in now
relo setup --remove                          # delete the block wherever it is; no target flags needed
relo setup --project --dry-run               # report what would change, write nothing
```

`--project` uses the one of `AGENTS.md` / `CLAUDE.md` that exists; both existing is an error (pick with
`--file`); neither creates `AGENTS.md`, the cross-harness standard. `--global --agent NAME` supports only
files confirmed from each harness's documentation:

| `--agent` | File |
| --- | --- |
| `claude-code` | `$CLAUDE_CONFIG_DIR` or `~/.claude`, `CLAUDE.md` |
| `codex` | `$CODEX_HOME` or `~/.codex`, `AGENTS.md` |
| `gemini` | `~/.gemini/GEMINI.md` |
| `opencode` | `~/.config/opencode/AGENTS.md` |
| `copilot` | `$COPILOT_HOME` or `~/.copilot`, `copilot-instructions.md` |
| `amp` | `~/.config/amp/AGENTS.md` |

Any other harness: `--file PATH`. Before writing, setup looks for an existing Relo block in the repository's
`AGENTS.md`/`CLAUDE.md` and in every file above. If one is in a different file it refuses (exit 2) with
`Relo is already set up in ~/.codex/AGENTS.md.`; keep it, or pass `--move` to remove the old block and write the
new one. The same file is refreshed in place. The command is idempotent and touches only the block between the
marker lines, keeping the rest of the file and its line endings byte for byte. The result is
`{"ok":true,"file":"~/.codex/AGENTS.md","action":"created|appended|updated|unchanged|kept|moved|removed","from":"<old path when moved>","skill":{…}}`.
It also reports the installed skill copies and a hint with the install command when the skill is missing or not
at the CLI's version, but it never installs the skill.

The block, exactly (no versions or dates, so tracked files do not churn):

```markdown
<!-- relo:start -->
## Relo (live status on the owner's iPhone)
For work longer than a couple of minutes, keep one Relo card current; ask on it before risky actions.
- `relo activity start --title "…" --status "…" --steps "A,B,C" --topic "<the work>"` → `update --status … --next-step` → `end --status "…"`
- Judgment work: `--steps` (3-6 named phases). A counted job (10 images, 400 rows): `--progress 3/10`. Never both.
- `relo ask "Deploy to production?" --approval`: only exit 0 with state `approved` is permission; anything else means no.
- `relo notify "…"` only for a finished outcome worth a buzz. Never put secrets, paths or raw output in card text.
- Details: the relo-notifications skill, or `relo help`.
<!-- relo:end -->
```

To edit the wording yourself, add a line `<!-- relo:keep -->` inside the block: `relo setup` (and
`--remove`) then leave it untouched and report `kept`; `--move` will not move a kept block.

## MCP server (harnesses without a shell): `relo setup --mcp` (the owner's choice)

`relo mcp` is a stdio MCP server inside the CLI (same credentials, no extra install) for Claude desktop, Cursor chat
and other clients that cannot run a shell command. Tools: `relo_card_start`, `relo_card_update`, `relo_card_end`,
`relo_ask` (waits up to 5 minutes, sending MCP progress notifications), `relo_interaction_wait`, `relo_notify`,
`relo_doctor`. Results are the same compact JSON as the CLI; the tool descriptions carry the steps-vs-progress and
approval rules. One card per MCP connection (a generated `RELO_SESSION`, unless you set one).

```bash
relo setup --mcp --agent claude-code --global      # ~/.claude.json, or --project for <repo>/.mcp.json
relo setup --mcp --agent claude-desktop            # macOS/Windows only
relo setup --mcp --agent cursor --project --dry-run
relo setup --mcp --agent codex --global --move     # relocate the entry from another file
relo setup --mcp --remove                          # delete Relo's entry wherever it is (--agent NAME to limit)
```

| `--agent` | `--global` | `--project` | Key |
| --- | --- | --- | --- |
| `claude-code` | `~/.claude.json` | `<repo>/.mcp.json` | `mcpServers` |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` (Windows `%APPDATA%\Claude\…`) | none | `mcpServers` |
| `cursor` | `~/.cursor/mcp.json` | `<repo>/.cursor/mcp.json` | `mcpServers` |
| `codex` | `$CODEX_HOME` or `~/.codex`, `config.toml` | `<repo>/.codex/config.toml` | `[mcp_servers.relo]` |
| `gemini` | `~/.gemini/settings.json` | `<repo>/.gemini/settings.json` | `mcpServers` |
| `vscode` | none | `<repo>/.vscode/mcp.json` | `servers` |

The entry is named `relo`. Shell harnesses (Claude Code, Codex, Gemini CLI) get `{"command":"relo","args":["mcp"]}`; GUI
apps (Claude desktop, Cursor, VS Code) do not inherit the shell `PATH`, so they get the absolute `node` and `relo.mjs` paths
of the CLI that ran setup (run setup again after moving node or reinstalling to refresh it; the result is `updated`).
Codex's table also sets `tool_timeout_sec = 330`, because its default of 60 s would cut a question short.
Like the instruction block, the entry lives in **one** file per harness (a second location is refused without
`--move`), setup is idempotent (`unchanged`), and `--remove` deletes only Relo's entry and leaves the rest of the
file as it was (JSON keeps 2-space formatting; a file with comments is refused, not edited). `relo doctor --full`
reports where the entry is, informationally; it never suggests adding it. Restart the harness after changing its config.

## Removing

```bash
relo setup --remove      # while the CLI is still installed
npm uninstall --global @relo/cli
relo skill remove --agent codex   # once per harness that has a copy (relo skill status lists them)
```

Hooks are optional: `relo setup … --hooks` reports session start/end so the server can end forgotten cards and show quiet agents; without them cards go stale on their own. Optional. Without hooks Relo works fully: cards go stale and end on their own. With hooks, the server also knows when a session is alive, shows quiet agents as quiet instead of ending their card, and ends a forgotten card as soon as the session ends. Only the owner runs it, for one settings file (`relo setup --global --agent claude-code --hooks`, `--project --hooks`, or `--agent gemini`); `relo setup --hooks --remove` deletes only Relo's entries. Never install hooks on your own. Older releases added Codex hooks and a Codex notifier: remove any
`relo-codex-hook` entries from `~/.codex/hooks.json` and run `npm uninstall --global @relo/codex-notify`.
