# Relo Codex lifecycle integration

This package uses Codex lifecycle hooks to keep one Relo Live Activity aligned with each Codex
turn. `UserPromptSubmit` starts the activity, `PostToolUse` advances it, `PermissionRequest` marks
it as waiting, and `Stop` ends it using an exact, privacy-safe session/turn identity. `SessionEnd`
performs best-effort cleanup for orphaned turns.

The external `notify` adapter is a terminal lifecycle reconciler. Codex
invokes the configured command with one JSON argument. The adapter accepts
`agent-turn-complete`, ignores other event types, and uses `thread-id` and `turn-id` only for a
stable idempotency key. It derives non-verbatim computer/project labels locally: the computer is
an OS class such as `Mac`, while the project is the final folder name from `cwd`. It never forwards
the hostname, absolute `cwd`, user input, or the full assistant message. Instead, it derives a
bounded completion summary from `last-assistant-message`. Supported completion events must include
non-empty official `thread-id` and `turn-id`. When configured with a private persistent
installation identity, the adapter derives the same privacy-safe task origin used by the lifecycle
hooks, resolves it, and ends the active generation. If the lifecycle is already terminal it does
nothing; if no lifecycle exists it safely skips. It never starts a Live Activity or sends an
ordinary notification merely because a turn completed. Ordinary completion delivery is
available only through the explicit `--notification-fallback` option.

The implementation follows the Codex hook and notification contracts documented at
<https://learn.chatgpt.com/docs/hooks> and
<https://learn.chatgpt.com/docs/config-file/config-advanced#notifications>. Personal skills belong
in `$HOME/.agents/skills`.

## Security behavior

- The adapter requires an absolute `--relo-bin` path and never invokes a shell.
- Relo credentials remain in its mode-`0600` config and never appear in argv.
- Child processes receive a minimal environment that excludes `RELO_TOKEN`, API keys, and
  unrelated secrets.
- User input is ignored. The body uses only the first sanitized sentence of the final assistant
  message, capped at 120 characters. Code blocks, inline code, patches, commands, URLs, credentials,
  private keys, and absolute paths are removed; missing or emptied text uses a generic fallback.
- The title is stable per OS/project: `Codex Auto · Mac · Project`. This identifies the automatic
  hook and lets repeated completions group together instead of looking like agent-authored alerts.
- The body starts with `Finished` or `Needs attention`. Attention is used only for an explicit
  blocker, request for input, or final question.
- `--generic` omits the `Automatic completion hook` task label while retaining the safe summary.
- Lifecycle thread and operation identities are domain-separated SHA-256 derivations; raw Codex
  thread IDs never enter CLI argv, Relo content, or diagnostics.
- Hostnames and absolute paths are never emitted. Only the final folder basename is used as the
  project label; suspicious or empty names fall back to `Project`.

## Codex configuration

Authorize each host before enabling the adapter. The adapter never starts an authorization flow,
opens a browser, or accepts a token argument/environment variable. Lifecycle reconciliation
requires `activities:read` and `activities:write`:

```bash
relo auth login \
  --api-url "https://relo.example" \
  --client-name "Relo server Codex notifier" \
  --scope activities:read \
  --scope activities:write \
  --no-open \
  --json

relo auth status --json
```

Compare the terminal and dashboard codes, inspect the requested scope, and explicitly approve the
client in the signed-in Relo server dashboard. The normal lifecycle-only installation needs only
`activities:read` and `activities:write`; `notifications:send` is required only for an explicit
ordinary notification or the explicit `--notification-fallback` option. Use a distinct named
credential on every host. Missing,
revoked, or expired authentication remains a visible adapter failure; never provision or copy a
plaintext token as a fallback.

## Versioned local installation, update, rollback, and removal

This private package is not a public release. Co-install it with the reviewed CLI from distinct,
versioned local tarballs. Run both packages' tests, checks, and pack dry-runs in the reviewed
checkout, then use the repository's paired release helper to pack both artifacts exactly once:

```bash
npm --prefix skills/relo-notifications run release:artifacts -- \
  pack --output /absolute/private/artifacts
node skills/relo-notifications/scripts/artifact-pair.mjs verify \
  --manifest /absolute/private/artifacts/relo-tooling-pair-0.7.17.json \
  --cli /absolute/private/artifacts/relo-cli-0.7.17.tgz \
  --notifier /absolute/private/artifacts/relo-codex-notify-0.7.17.tgz

npm install --global \
  "/absolute/private/artifacts/relo-cli-0.7.17.tgz" \
  "/absolute/private/artifacts/relo-codex-notify-0.7.17.tgz"

relo --version
relo-codex-notify --dry-run \
  '{"type":"agent-turn-complete","thread-id":"install-check","turn-id":"1"}'
relo auth login --api-url "https://relo.example" \
  --client-name "Workstation Codex notifier" --scope notifications:send \
  --scope activities:read --scope activities:write --no-open --json
relo auth status --json
```

Update to `0.7.17` only from the exact reviewed pair. The helper records SHA-256, byte count, npm
integrity and shasum, packed-file inventory, source-tree digest, and Node/npm versions, and binds
both packages into one pair identity. A same-version artifact with different content is invalid.
Before updating, keep and verify both exact prior tarballs and their pair manifest. Repeat the
version, dry-run, auth, and hook/config checks after installation. If validation fails, verify the
prior pair again and roll back by reinstalling both retained tarballs—not a tag, range, directory,
same-version substitute, or newly repacked source. The retained `0.7.10` pair is the rollback boundary:

```bash
node skills/relo-notifications/scripts/artifact-pair.mjs verify \
  --manifest /absolute/private/artifacts/relo-tooling-pair-0.7.10.json \
  --cli /absolute/private/artifacts/relo-cli-0.7.10.tgz \
  --notifier /absolute/private/artifacts/relo-codex-notify-0.7.10.tgz
npm install --global \
  "/absolute/private/artifacts/relo-cli-0.7.10.tgz" \
  "/absolute/private/artifacts/relo-codex-notify-0.7.10.tgz"
```

Remove the executables without changing credentials or hooks:

```bash
npm uninstall --global @relo/codex-notify @relo/cli
```

Install, update, rollback, and removal must preserve the Relo mode-`0600` credential config,
Codex `config.toml`, notifier chain config, runtime-wrapper collision backups, and all permission
hooks. Removing packages does not revoke authentication or edit Codex. Run `relo auth logout
--json`, `relo permissions uninstall`, or the configuration helper only when the owner separately
requests those state changes. Keep exact config and hook backups until the updated pair passes its
checks.

For a host without an existing notifier:

```toml
notify = [
  "/home/relo/.local/bin/relo-codex-notify",
  "--relo-bin",
  "/home/relo/.local/bin/relo",
  "--installation-id-path",
  "/home/relo/.codex/relo-codex-notify.identity",
  "--lifecycle-only",
]
```

If a notifier already exists, preserve its exact command array in a mode-`0600` JSON file:

```json
{
  "nextCommand": ["/absolute/path/to/existing-notifier", "existing-fixed-argument"]
}
```

Then configure the adapter as the outer notifier:

```toml
notify = [
  "/absolute/path/to/relo-codex-notify",
  "--relo-bin",
  "/absolute/path/to/relo",
  "--installation-id-path",
  "/absolute/private/path/to/relo-codex-notify.identity",
  "--lifecycle-only",
  "--chain-config",
  "/absolute/path/to/relo-notify-chain.json",
]
```

The adapter invokes the existing command with its original fixed arguments plus a sanitized,
Codex-compatible completion event. That event contains a hashed identity, empty input messages,
the already-sanitized completion body, and no `cwd`; the raw Codex payload is never forwarded. The adapter
then reconciles Relo's lifecycle. Both commands are attempted even if one fails. The chained
notifier remains independently owned; Relo does not convert its output into an ordinary Relo
notification.

Validate mapping without sending:

```bash
relo-codex-notify --dry-run \
  '{"type":"agent-turn-complete","thread-id":"test","turn-id":"1","cwd":"/tmp/demo","last-assistant-message":"Done"}'
```

When the host's normal service PATH may resolve an older Node.js, install wrappers with an explicit
Node 22 runtime. This changes only the four Relo executables under the selected prefix:

```bash
/absolute/node22 scripts/install-runtime-wrappers.mjs \
  --node /absolute/node22 \
  --prefix /home/relo/.local
```

Every generated wrapper contains a Relo ownership marker. The helper updates only marked
wrappers or the exact package-owned npm symlinks that point at the expected installed Relo
entrypoints. It preflights all four destinations before changing any of them. If an unmanaged
regular file already occupies a wrapper path, it creates an exclusive adjacent backup and stops
without replacing the file; symlinks to any other target and other non-regular paths are refused.
Review the reported backup and resolve the collision explicitly.

The configuration helper creates an exclusive
backup and verifies that the held file descriptor and backup pathname still identify the same inode
immediately before and after writing. A detected rename or replacement retains both artifacts and
aborts without mutating the replacement. It inserts a missing top-level setting or reconciles one
exact Relo command, including a Relo command nested under another notifier's
`--previous-notify` array. It preserves the outer notifier and refuses unrelated, ambiguous, or
unsupported shapes:

```bash
/absolute/node22 scripts/configure-codex-notify.mjs install \
  --config /home/relo/.codex/config.toml \
  --adapter /home/relo/.local/bin/relo-codex-notify \
  --relo /home/relo/.local/bin/relo \
  --backup-suffix 20260806

/absolute/node22 scripts/configure-codex-notify.mjs doctor \
  --config /home/relo/.codex/config.toml \
  --adapter /home/relo/.local/bin/relo-codex-notify \
  --relo /home/relo/.local/bin/relo \
  --installation-id-path /home/relo/.codex/relo-codex-notify.identity
```

Install lifecycle hooks additively after the binaries and Relo credential are ready. The helper
preserves unrelated hook handlers and creates a private backup before its atomic update:

```bash
/absolute/node22 scripts/configure-codex-hooks.mjs install \
  --hooks-config /home/relo/.codex/hooks.json \
  --hook /home/relo/.local/bin/relo-codex-hook \
  --relo /home/relo/.local/bin/relo \
  --installation-id-path /home/relo/.codex/relo-codex-notify.identity

/absolute/node22 scripts/configure-codex-hooks.mjs doctor \
  --hooks-config /home/relo/.codex/hooks.json \
  --hook /home/relo/.local/bin/relo-codex-hook \
  --relo /home/relo/.local/bin/relo \
  --installation-id-path /home/relo/.codex/relo-codex-notify.identity
```

Codex asks for trust before running project-level hooks. Review the generated `.codex/hooks.json`
and trust the repository in Codex; an untrusted hook configuration cannot provide lifecycle-aware
Live Activities. `configure-codex-hooks.mjs uninstall` removes only Relo-owned handlers.
