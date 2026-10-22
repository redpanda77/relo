---
title: Files and folders
summary: Everything Relo writes on a computer, where it lives and what is safe to delete.
---

Relo keeps its credential and keys in one protected folder, its working state in another, and
writes into a harness's own files only what `relo setup` installs. Every folder is created with mode
0700 and every file with 0600, readable only by you. `relo uninstall` lists everything Relo wrote and
removes it with `--apply`. Each default location can be moved with a variable:
[Environment variables](/docs/reference/environment).

## Config folder

| Platform | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/relo/` |
| Linux | `$XDG_CONFIG_HOME/relo/`, else `~/.config/relo/` |
| Windows | `%APPDATA%\relo\` |

| File | What it holds |
| --- | --- |
| `config.json` | Your sign-ins, one per profile (server, credential, expiry), the active profile, account nicknames from `relo account` and the computer name. The CLI refuses to read it unless its mode is 0600. Moved with `RELO_CONFIG_PATH`. |
| `e2ee.json` | This computer's end-to-end identity key and the phone keys it trusts, with strict mode. `relo keys rotate` replaces the identity. Moved with `RELO_KEY_STORE_PATH`. |
| `harness-credential` | The hooks' presence-only credential, written by `relo setup --level guide` and revoked by `relo setup --level track`. Moved with `RELO_HARNESS_CREDENTIAL_PATH`. |

:::never Never copy these files to another computer
They are this computer's identity. Sign in on each computer with `relo auth login`; in CI use
`RELO_TOKEN` and `RELO_API_URL`.
:::

## State folder

`$RELO_STATE_DIR`, else `$XDG_STATE_HOME/relo`, else `~/.local/state/relo`.

| Path | What it holds |
| --- | --- |
| `sessions/` | Each session's and producer's local copy of its declared work, which `relo state` reads. |
| `handoffs/` | The handoff a session left for the next one in a project (one file per project, mode 0600, 24 hours): the handle, goal, round and note. It never leaves this computer. |
| `outbox/` | Changes waiting to reach the server, one file per entry, sent oldest first. `relo outbox status` shows them. |
| `outbox/dead.json` | Entries the server refused for good, with the reason, kept 7 days. |
| `observed/` | Each session's observed phase, from hooks. |
| `hooks/` | Hook bookkeeping, and `hook-debug.log` when `RELO_DEBUG=1`. |
| `sealed-cards/` | This computer's readable copy of the card text it sealed. |
| `questions/` | The questions it asked, so it can check a signed answer. |
| `names.json` | Project and topic names behind their opaque handles. |
| `seen-notes.json` | Notes a session has already been shown. |
| `machine-report.json` | A fingerprint of the last setup report sent to the server (so an unchanged one is not sent again) and when it was sent. The report carries which tools are set up and how current they are, never a path, a variable's value or a project, topic or account name. |
| `computer-identity.json` | That `relo setup` has already asked for this computer's name and icon, so it asks once. The name and icon themselves live on your Relo server. |
| `doctor-last.json` | The last `relo doctor`: when it ran, whether it passed and the names of the checks that failed. It goes into the setup report. |
| `activity-commands/` | A short record of each card and notification command, so a retry sends the same thing once. |

Everything Relo keeps locally is in this one folder: setting `RELO_STATE_DIR` moves all of it.

Deleting the state folder changes nothing on the server, but changes still in the outbox are never
sent. A session's work comes back on its next command: the CLI keeps a copy on the server, sealed so
that only this computer can open it.

## Data folder

`~/.local/share/relo/`

| Path | What it holds |
| --- | --- |
| `cli/` | The CLI the install script installed (`cli/<version>/`), one folder per version; the `relo` launcher in `~/.local/bin` names the one in use. |
| `node/` | Node.js 22, when the install script found no recent one on this computer. |
| `cli-releases/` | Verified releases that `relo update` installed, so `relo update --rollback` can go back. |
| `skill-archives/` | Skill copies that `relo setup` replaced or `relo uninstall` removed, kept outside every skills folder. |
| `update-check.json` | The latest release `relo doctor` saw, cached for 24 hours. Off with `RELO_NO_UPDATE_CHECK=1`. |
| `auto-update.json` | The last automatic update: the version it went for, when, and how it ended. One attempt per version an hour. |
| `updates.json` | How this computer takes a newer CLI: auto, ask or off (`relo update --mode`). |
| `auto-update.lock` | Held while an update runs, so only one runs at a time; a lock older than 10 minutes is taken over. |

## Harness files

`relo setup` writes into each harness's own folder (`~/.claude`, `~/.codex`, `~/.gemini`, and so on;
a harness's own variable such as `CLAUDE_CONFIG_DIR` or `CODEX_HOME` moves it). It changes only
Relo's marked parts:

- **Instructions**: a marked block in the global instructions file (`CLAUDE.md`, `AGENTS.md`,
  `GEMINI.md`, `copilot-instructions.md`). A block you mark `relo:keep` stays on uninstall.
- **Skill**: `relo-notifications/` in the harness's skills folder.
- **Hooks** (only when asked): entries in the harness's `settings.json`.
- **MCP** (only when asked): a `relo` entry in the harness's MCP config, such as `~/.claude.json`,
  Codex's `config.toml`, Cursor's `mcp.json` or Claude desktop's `claude_desktop_config.json`.

With `relo setup --project`, the block goes in the repository instead (`AGENTS.md`, plus a
`CLAUDE.md` that imports it when neither exists) and hooks go in its personal, uncommitted
`.claude/settings.local.json`. Which harness gets which: [Harnesses](/docs/reference/harnesses).
