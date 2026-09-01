# Install, update, validate, and uninstall

These steps cover the skill bundle, private CLI tarball, and private Codex notifier tarball. Never
install or modify any of them during an ordinary notification request.

For a clean CLI installation, require an explicit reviewed server origin during browser-approved
authentication: `relo auth login --api-url URL --client-name NAME --no-open --json`. Never infer
the origin from a link or notification.

The signed-in Dashboard's Account page may provide the owner a copyable login command containing
its canonical configured origin. During login, the CLI prints the complete one-time approval link
before attempting to open it, followed by a fallback page and short code. If browser launch fails,
use those printed values; denial, expiry, and timeout require a fresh login request and must not be
treated as authentication.

## Validate source

From `skills/relo-notifications` in a trusted repository checkout, require Node.js 22 or newer and run:

```bash
node scripts/validate-skill.mjs
node --test tests/*.test.mjs
```

Both commands must exit zero. Review the source and its provenance before installation.

The exact reviewed CLI and notifier versions are recorded in this skill's `package.json` under
`reviewedToolingVersions`. The versioned tarball names below must match that record and the two
source package manifests. Any mismatch means the bundle has not been reviewed as one unit; stop
before packing or installation.

For CLI and notifier source, also run each package's `npm test`, `npm run check`, and `npm pack
--dry-run`. Do not proceed when a package is not still private and licensed as
`PolyForm-Noncommercial-1.0.0`.

At the release boundary, pack the reviewed pair exactly once from the repository root. The helper
refuses existing artifact names and writes a mode-`0600` identity record into a private mode-`0700`
directory. It records only safe relative filenames, package versions, SHA-256, npm integrity and
shasum, byte count, packed inventory, source-tree digest, and Node/npm versions:

```bash
npm --prefix skills/relo-notifications run release:artifacts -- \
  pack --output /absolute/private/artifacts
```

Do not use a digest printed by a development run as a release identity. The release gate owns the
single candidate pack and retains its exact `relo-tooling-pair-0.7.17.json` beside both tarballs.
The prior pair must already be retained from its original pack. Repacking an old checkout or an
installed directory does not recreate the prior artifact and is not rollback evidence.

## Install the CLI and Codex notifier

Verify the retained bytes immediately before installation, then install the exact CLI and notifier
pair together; never use a registry tag or version range:

```bash
node skills/relo-notifications/scripts/artifact-pair.mjs verify \
  --manifest /absolute/private/artifacts/relo-tooling-pair-0.7.17.json \
  --cli /absolute/private/artifacts/relo-cli-0.7.17.tgz \
  --notifier /absolute/private/artifacts/relo-codex-notify-0.7.17.tgz

npm install --global \
  /absolute/private/artifacts/relo-cli-0.7.17.tgz \
  /absolute/private/artifacts/relo-codex-notify-0.7.17.tgz

relo --version
relo-codex-notify --dry-run \
  '{"type":"agent-turn-complete","thread-id":"install-check","turn-id":"1"}'
relo auth login --api-url "https://relo.example" \
  --client-name "Workstation agent" --no-open --json
```

The notifier configuration helper is a packaged script, not a file in the installed skill or the
current project. Resolve it from npm's actual global package root and stop if that exact installed
file is absent. Never invoke a cwd-relative `configure-codex-notify.mjs`:

```bash
RELO_NOTIFY_PACKAGE_ROOT="$(npm root --global)/@relo/codex-notify"
RELO_NOTIFY_ADAPTER="$(command -v relo-codex-notify)"
RELO_CLI_BIN="$(command -v relo)"
test -f "$RELO_NOTIFY_PACKAGE_ROOT/scripts/configure-codex-notify.mjs"
node "$RELO_NOTIFY_PACKAGE_ROOT/scripts/configure-codex-notify.mjs" install \
  --config "$HOME/.codex/config.toml" \
  --adapter "$RELO_NOTIFY_ADAPTER" \
  --relo "$RELO_CLI_BIN" \
  --backup-suffix "relo-reviewed-install"

node "$RELO_NOTIFY_PACKAGE_ROOT/scripts/configure-codex-notify.mjs" doctor \
  --config "$HOME/.codex/config.toml" \
  --adapter "$RELO_NOTIFY_ADAPTER" \
  --relo "$RELO_CLI_BIN" \
  --installation-id-path "$HOME/.codex/relo-codex-notify.identity"
```

The helper creates a private exclusive backup, inserts a missing notifier, or reconciles one exact
Relo command—including one nested below another notifier's `--previous-notify` option. It adds
`--lifecycle-only`, preserves the outer notifier, and refuses unrelated, ambiguous, unsafe, or
concurrently changed config. Doctor must report `installed: true`. Do not print the discovered
package path or config contents.

Pack each candidate artifact once. Record its SHA-256, byte count, npm integrity, packed-file
inventory, source-tree digest, and Node/npm versions without storing an absolute path, hostname, or
credential in the identity record. Bind the two artifact digests as one release pair and reject a
same-version artifact with different content.

Before update, retain the exact installed pair and its identity. Verify both the retained prior pair
and the candidate pair before changing the installation. Install both reviewed new tarballs, then
run the version, dry-run, `auth status --json`, and `permissions doctor --json` checks. If any gate
fails, verify the prior pair again and roll back by reinstalling those exact retained bytes—not
same-version substitutes or newly repacked source. For the retained `0.7.5` baseline that has its own
verified pair manifest:

```bash
node skills/relo-notifications/scripts/artifact-pair.mjs verify \
  --manifest /absolute/private/artifacts/relo-tooling-pair-0.7.5.json \
  --cli /absolute/private/artifacts/relo-cli-0.7.5.tgz \
  --notifier /absolute/private/artifacts/relo-codex-notify-0.7.5.tgz

npm install --global \
  /absolute/private/artifacts/relo-cli-0.7.5.tgz \
  /absolute/private/artifacts/relo-codex-notify-0.7.5.tgz
```

Bind the verified prior and candidate manifests and bytes into one transition identity with
`artifact-pair.mjs bind-transition`, then use `verify-transition` immediately before every
installed-host lifecycle. The transition record contains only safe filenames, versions, byte
counts, and digests; it never contains absolute paths, hostnames, or credentials. Follow the exact
commands and stop conditions in [release-checklist.md](release-checklist.md).

Before removing the packages, run the packaged notifier helper with `uninstall` and the same
config/adapter/CLI/identity arguments; it removes only the exact Relo command and preserves an
outer notifier. Then remove the packages with
`npm uninstall --global @relo/codex-notify @relo/cli`. Install, update, exact rollback,
and removal must preserve the credential config, unrelated Codex notifier state and chain files,
and every permission hook. Package removal does not revoke authentication; that remains a separate
explicit owner action.

## Install the skill bundle

Choose installation scope from the request. Use a repository-scoped `.agents/skills` location when
the capability belongs only to that reviewed project; use the user skill directory only when the
user explicitly wants Relo available across projects. Never silently widen scope.

From the root of a reviewed Relo repository checkout, use the reviewed, pinned Agent Skills
installer version, select this skill explicitly, and provide its reviewed package directory:

```bash
npx --yes skills@1.5.22 add ./skills/relo-notifications --skill relo-notifications --agent codex --yes --copy
```

For an explicitly user-wide installation, add `--global`; without it the pinned installer selects
repository scope while running inside a project:

```bash
npx --yes skills@1.5.22 add ./skills/relo-notifications --skill relo-notifications --agent codex --yes --copy --global
```

Repository-root discovery with `skills add .` is unsupported: a repository can expose unrelated
skills and prevent exact Relo discovery. Use `./skills/relo-notifications` unless a separate reviewed
root-discovery contract and test gate is opened.

Change the `--agent` value only to the documented target agent. Omit `--copy` only when you
deliberately want the installer to manage links. The installer must report exactly the selected
`relo-notifications` skill. Run the installed validator and tests from the path printed by the
installer. Then confirm an independently installed trusted `relo` or `reloctl` is discoverable;
run `auth status --json` and `permissions doctor --json` without reading the credential file.

Installation must not copy credentials, create tokens, alter hooks, or authenticate automatically.

## Update and exact rollback of the skill bundle

1. Validate the new source before touching the installed copy.
2. Audit the global discovery root and require exactly one active copy at the expected installed
   version. A globally selected Relo skill is the canonical copy for every project; do not add a
   repository-scoped copy that can shadow it.
3. Put every recoverable backup, rejected candidate, and rollback snapshot under a private archive
   outside all agent skill discovery roots. Never place a directory containing a Relo `SKILL.md`
   beside the active copy under `.agents/skills`, `.codex/skills`, or a project skill directory.
4. Re-run the exact pinned `skills add` command above from the reviewed new checkout. Its complete-copy
   update replaces stale files rather than merging partial versions.
5. Validate and test the installed copy, then run `auth status --json` and
   `permissions doctor --json`.
6. Keep the backup until triggering and functional checks pass. The credential config and CLI are
   outside this directory and must remain untouched.

Use the packaged discovery gate before and after every global update. `audit` fails if the active
directory is missing, has the wrong package version, or any sibling snapshot declares the same
skill name. `archive` moves snapshots into the selected private non-discovery directory and rolls
the move back if any rename fails:

```bash
node skills/relo-notifications/scripts/skill-discovery.mjs audit \
  --skills-dir "$HOME/.agents/skills" --expected-version 0.7.10

node skills/relo-notifications/scripts/skill-discovery.mjs archive \
  --skills-dir "$HOME/.agents/skills" \
  --archive-dir "$HOME/.local/share/relo/skill-archives/pre-0.7.17-release" \
  --expected-version 0.7.15 --execute

node "$HOME/.agents/skills/relo-notifications/scripts/skill-discovery.mjs" audit \
  --skills-dir "$HOME/.agents/skills" --expected-version 0.7.17
```

If validation or checks fail, restore the exact complete backup directory atomically, rerun its
validator and tests, and report the failed gate. Move the failed candidate into the same private
archive before restoring the active directory; never retain it inside discovery. Do not reconstruct
rollback from a newer checkout.

## Remove the skill bundle

Run the installer-owned removal from the same project scope:

```bash
npx --yes skills@1.5.22 remove relo-notifications --yes
```

Confirm `skills list --json` no longer reports the skill. Do not add `--agent` when the installed
skill is shared through the canonical project skill directory; agent-filtered removal can leave the
shared copy installed.

Uninstalling the skill does not revoke authentication, remove the CLI, delete notification history,
or remove hooks. If the user explicitly requests credential revocation, run
`relo auth logout --json` separately and report whether server revocation was confirmed. Current
Permission hooks are managed separately with `relo permissions setup|doctor|uninstall`; skill
removal must not change them.
