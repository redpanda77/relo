# Installing and updating (maintainers only)

Agents using the skill never install or upgrade the CLI mid-task. This page is for the owner or a
maintainer working from a reviewed checkout of the Relo repository.

## The CLI

```bash
npm pack ./packages/cli --pack-destination ~/.local/share/relo/tooling-artifacts/
npm install --global ~/.local/share/relo/tooling-artifacts/relo-cli-<version>.tgz
relo --version
relo auth login          # browser sign-in; never paste tokens
relo doctor --json
```

Keep the previous `.tgz` beside the new one: rolling back is `npm install --global` of the older file.
CI and containers skip `auth login` and set `RELO_TOKEN` and `RELO_API_URL` from their secret store.

## The skill

Install one global copy per agent from the reviewed checkout, and audit that discovery sees exactly
one active copy at the expected version:

```bash
node skills/relo-notifications/scripts/skill-discovery.mjs archive \
  --skills-dir "$HOME/.agents/skills" \
  --archive-dir "$HOME/.local/share/relo/skill-archives/pre-<version>" --execute
npx --yes skills@1.5.22 add ./skills/relo-notifications --skill relo-notifications \
  --agent codex --yes --copy --global
node "$HOME/.agents/skills/relo-notifications/scripts/skill-discovery.mjs" audit \
  --skills-dir "$HOME/.agents/skills" --expected-version <version>
```

Use `--agent claude-code` for Claude Code. Archives live outside every skill discovery root, so an
old copy can never shadow the active one. Before installing, run `node scripts/validate-skill.mjs`
and `node --test tests/*.test.mjs` in the source copy.

## Removing

```bash
npm uninstall --global @relo/cli
mkdir -p "$HOME/.local/share/relo/skill-archives/removed"
mv "$HOME/.agents/skills/relo-notifications" "$HOME/.local/share/relo/skill-archives/removed/"
```

Relo installs no agent hooks. Older releases added Codex hooks and a Codex notifier: remove any
`relo-codex-hook` entries from `~/.codex/hooks.json` and run `npm uninstall --global @relo/codex-notify`.
