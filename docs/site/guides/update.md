---
title: Update and uninstall
nav: Update and uninstall
summary: Move the CLI to a verified release, roll back if you need to, or remove everything Relo wrote on this computer.
---

## Why

A new CLI release brings fixes and keeps your agents' instructions current. Deploying your server is
enough: every computer signed in to it follows. Every release is checked against its published checksums
before anything is installed, and the previous release is kept so you can go back.

## Automatic updates

Your server names the newest CLI it hands out on every reply, so noticing a new one costs no extra request.

- **Installed with the install script** (the `relo` launcher in `~/.local/bin`): the CLI updates itself in
  the background after the command that noticed. The new version is unpacked beside the running one and
  the launcher switches with one rename, so a command already running finishes on its own version and the
  next runs the new one. Then the skill, instructions and hooks are refreshed. One update runs at a time, and
  a version is tried at most once an hour.
- **Installed with npm**: npm replaces files under running processes, so Relo does not update it by
  itself. An agent session is told once to run `relo update`, and it may.

`RELO_NO_UPDATE_CHECK=1` turns both off.

## Check for an update

```sh
relo update --check
```

It prints the current and latest versions and whether an update is available, and installs nothing.
`relo doctor` also shows an `update` warning when you are behind; it checks at most once a day and never
changes whether Relo is ready. `RELO_NO_UPDATE_CHECK=1` turns that check off.

## Update

<ol class="docs-steps">
<li>

**Install the latest release.**

```sh
relo update
```

Relo downloads the CLI your server hands out (or, from a server without one, the GitHub release), verifies
it against its digest, then installs it: beside the old version behind the `relo` launcher the install
script made, or with `npm install --global` for an npm install. It prints the version it moved from and to, with `verified:true`. A checksum
mismatch or a failed download installs nothing and says why.

</li>
<li>

**Let it refresh what setup wrote.** The new CLI runs `relo setup --refresh` for you: older instruction
blocks, older skill copies, hook entries and MCP paths are brought up to date. Nothing new is added. If
the refresh fails, the update still stands and the result tells you to run it by hand:

```sh
relo setup --refresh
```

</li>
<li>

**Restart your agents.** Running sessions keep the instructions they started with.

</li>
</ol>

Install one particular release instead of the latest with `--version`, and preview with `--dry-run`:

```sh
relo update --version 0.10.0 --dry-run
```

If npm cannot write its global folder, give it a folder you own (`npm config set prefix ~/.local`) and
run the update again. A self-hosted mirror of the releases is set with `RELO_RELEASES_URL`. Every flag:
[setup reference](/docs/reference/cli/setup).

## Roll back

```sh
relo update --rollback
```

This reinstalls the newest earlier release kept in `~/.local/share/relo/cli-releases/`, verifying its
checksum again. Run `relo setup --refresh` afterwards if the older CLI should rewrite what is installed.

## Uninstall

`relo uninstall` removes only Relo's parts of the files it wrote: the instruction blocks, the skill
copies, the hook entries and the harness credential, and the MCP entries. Your own text, hooks and MCP
servers stay.

<ol class="docs-steps">
<li>

**See what it would remove.** Without `--apply` it only lists.

```sh
relo uninstall
```

</li>
<li>

**Remove it.**

```sh
relo uninstall --apply
```

Skill copies are archived, not deleted. A block you marked `<!-- relo:keep -->` stays.

</li>
<li>

**Sign out and remove the CLI.** Signing out revokes this computer's login on your server.

```sh
relo auth logout
npm uninstall --global @relo/cli
```

</li>
</ol>

## Check it

- After an update: `relo --version` prints the new version, and `relo doctor` prints `ready:true` with no
  `update` warning.
- Before removing the CLI: `relo uninstall` again lists nothing left to remove.
- After signing out: this computer's login is gone from the Dashboard.
