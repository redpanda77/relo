# Private CLI and skill 0.7.17 release checklist

Use this single checklist only at the named `0.7.17` release gate. A source checkpoint, package
test, durable Inbox command, APNs job, provider acceptance, and exact phone receipt are different
evidence layers. Do not claim a later layer from an earlier one.

## 1. Freeze and local gate

- Require the intended release commit and verify the component-owned source manifest before any
  pack. Record Node and npm versions; Node.js must be 22 or newer.
- Run the complete CLI, notifier, and skill syntax/tests/validators plus each package prepack and
  copied install lifecycle exactly once on the frozen candidate. Record totals and every skip.
- Run `git diff --check`, package inventory review, and secret/generated-file scans. Stop on any
  source change after the freeze.
- Keep CLI and notifier private and licensed as `PolyForm-Noncommercial-1.0.0`. Do not publish or
  use a registry tag at this private release gate.

### CLI-EXIT-P1-04 exit-code migration

`0.5.0` intentionally adopts the published `1` API/other, `3` auth, `4` timeout/canceled/expired, `5`
negative, `6` network, and `7` no accepted device mapping; usage remains `2`. Do not add a legacy
numeric mode because the old Relo values overlap these meanings. Before installing, inventory
every local wrapper or automation that branches on `3`–`8`, update it once, and prefer JSON
`error.code` for semantic distinctions. Run the focused golden exit matrix against the frozen
candidate and confirm CLI help, package README, and installed skill reference match exactly.

## 2. Bind exact retained prior and candidate artifacts

Create the candidate pair exactly once in a new private mode-`0700` directory. The prior pair must
be the originally retained manifest and tarballs; never reconstruct it from source or an installed
package.

```bash
npm --prefix skills/relo-notifications run release:artifacts -- \
  pack --output /absolute/private/release

node skills/relo-notifications/scripts/artifact-pair.mjs bind-transition \
  --output /absolute/private/release \
  --prior-manifest /absolute/private/release/relo-tooling-pair-0.7.16.json \
  --prior-cli /absolute/private/release/relo-cli-0.7.16.tgz \
  --prior-notifier /absolute/private/release/relo-codex-notify-0.7.16.tgz \
  --candidate-manifest /absolute/private/release/relo-tooling-pair-0.7.17.json \
  --candidate-cli /absolute/private/release/relo-cli-0.7.17.tgz \
  --candidate-notifier /absolute/private/release/relo-codex-notify-0.7.17.tgz

node skills/relo-notifications/scripts/artifact-pair.mjs verify-transition \
  --transition /absolute/private/release/relo-tooling-transition-0.7.16-to-0.7.17.json \
  --prior-manifest /absolute/private/release/relo-tooling-pair-0.7.16.json \
  --prior-cli /absolute/private/release/relo-cli-0.7.16.tgz \
  --prior-notifier /absolute/private/release/relo-codex-notify-0.7.16.tgz \
  --candidate-manifest /absolute/private/release/relo-tooling-pair-0.7.17.json \
  --candidate-cli /absolute/private/release/relo-cli-0.7.17.tgz \
  --candidate-notifier /absolute/private/release/relo-codex-notify-0.7.17.tgz
```

Retain the three pair/transition JSON records and four tarballs until the acceptance window closes.
Record their SHA-256 values and the transition digest without recording their absolute directory.
Missing original prior bytes are a rollback blocker, not permission to repack them.

## 3. Installed-host package lifecycle

Choose a safe opaque host ID that is not a hostname. First run `release:host -- preflight` with all
seven absolute identity/artifact paths, the absolute reviewed `skills/relo-notifications` source,
`--host-id`, `--run-id`, a private evidence directory, and exactly one of an isolated `--prefix` or
explicit `--system-global`. Add every credential/config/hook file that must remain byte-for-byte
unchanged as a repeated `--preserve-file` argument. The script hashes those files in memory and
records only their count. Pass the Codex hook registry and `config.toml` separately through
`--codex-hooks-config` and `--codex-config` with `--installation-id-path`; both are managed state,
not byte-preserved state. The gate surgically reconciles only Relo-owned lifecycle handlers and
the one Relo completion notifier command at each install/rollback stage. It preserves any outer
notifier and fails unless both doctors prove they target the selected installed lifecycle-only
pair. Never also pass either managed Codex file through `--preserve-file`.

From the repository root, use this exact shape; repeat the artifact arguments from the transition
commands above without substitution by a registry tag or directory:

```bash
npm --prefix skills/relo-notifications run release:host -- preflight \
  --transition /absolute/private/release/relo-tooling-transition-0.7.16-to-0.7.17.json \
  --prior-manifest /absolute/private/release/relo-tooling-pair-0.7.16.json \
  --prior-cli /absolute/private/release/relo-cli-0.7.16.tgz \
  --prior-notifier /absolute/private/release/relo-codex-notify-0.7.16.tgz \
  --candidate-manifest /absolute/private/release/relo-tooling-pair-0.7.17.json \
  --candidate-cli /absolute/private/release/relo-cli-0.7.17.tgz \
  --candidate-notifier /absolute/private/release/relo-codex-notify-0.7.17.tgz \
  --skill-source /absolute/reviewed/repository/skills/relo-notifications \
  --evidence-dir /absolute/private/evidence --prefix /absolute/selected/prefix \
  --host-id opaque-host-a --run-id release-preflight-1 \
  --codex-hooks-config /absolute/private/codex/hooks.json \
  --codex-config /absolute/private/codex/config.toml \
  --installation-id-path /absolute/private/codex/relo-codex-notify.identity \
  --preserve-file /absolute/private/relo-config.json
```

After preflight, change only `preflight` to `lifecycle` and append `--execute`; the resulting command
is `npm --prefix skills/relo-notifications run release:host -- lifecycle --execute` plus the same options.
It verifies the bound transition, installs the retained prior pair, updates to the candidate, rolls
back to the exact prior bytes, and restores the exact candidate. Every stage checks both installed
package versions, CLI version, and notifier dry-run. It writes one mode-`0600` evidence record and
leaves `0.7.17` installed for the functional gate. Never run `--execute` on an unselected host.

Confirm independently:

- CLI and notifier resolve from the intended global prefix under Node.js 22+.
- Credential config remains mode `0600`; chain files and permission hooks retain their original
  bytes and modes. The Codex lifecycle registry may change only in its five Relo-owned handlers;
  `config.toml` may change only in the exact Relo notifier command nested or top-level. Both final
  doctors must report the selected prefix and lifecycle-only mode.
- No token, config content, absolute path, hostname, raw prompt, command, patch, or file content is
  present in stdout, stderr, evidence, process arguments, or captured server data.
- Two selected hosts use distinct opaque host evidence IDs, browser client names, credential IDs,
  and requester identities.

## 4. Install the exact skill directory

Before installation, run the source `skill-discovery.mjs audit` against the global discovery root.
If it reports snapshots, move them with `archive --execute` into a private directory under
`.local/share/relo/skill-archives`; never place a backup, rejected copy, or rollback directory
inside any agent or project skill discovery root.

From the reviewed repository root run exactly:

```bash
npx --yes skills@1.5.22 add ./skills/relo-notifications \
  --skill relo-notifications --agent codex --yes --copy --global
```

Require exactly one discovered, selected, and installed skill. Repository-root discovery with
`skills add .` is unsupported. Validate and test the installed copy at the installer-reported path;
confirm it contains no credential and uses the independently installed CLI. Then run the installed
discovery script with `--expected-version 0.7.17`; any duplicate or project-local Relo copy blocks
the release until it is moved outside discovery.

## 5. Installed CLI functional matrix

Use only the reviewed server origin and an exact device ID returned by the paginated inventory.
Capture one JSON stdout envelope and separate stderr per command without printing credentials.

1. `auth login`: browser approval displays the same code, intended client name, scopes, origin, and
   expiry. Prove approve and deny behavior; then prove `auth status --json` for the exact client.
2. `devices list --page-size 1 --json`: traverse all pages without duplicates and retain the exact
   target device ID. Prove malformed/cursor-loop/410/auth failures remain closed with mocked or
   isolated server cases, not the live account.
3. Send one ordinary notification to the exact device. Require a durable command; separately record
   APNs job, provider acceptance, and exact event/device `received` evidence when available.
4. Start one activity and retain its exact canonical ID and sequence. Update percentages `25`, `60`,
   and `100` with state/detail changes and optimistic sequence checks. Get/list must return that ID.
5. On that exact parent, create approval, yes/no, and text waits. Preserve each returned interaction
   ID and any companion activity ID. Prove exact replay with one idempotency key and conflict on
   changed content. Wait/get only by interaction ID; end only the exact parent ID.
6. Create at least two simultaneous ordinary questions and prove independent canonical results.
   Approval requires type `approval`, state `approved`, action `approve`, responding device ID, and
   `respondedAt`. Every missing, mismatched, negative, canceled, expired, timed-out, malformed, auth,
   network, or zero-durable-command outcome denies.
7. Verify the completion notifier ends an active hook lifecycle, no-ops for an already-terminal
   lifecycle, and safely skips a missing lifecycle without creating an ordinary notification.
   Separately prove that `--notification-fallback` is the only opt-in to ordinary completion alerts.
   Assert absence of user input, full assistant output, hostname, command, code, patch, file
   contents, secret, token, URL, and absolute path in every case.
8. Revoke through `auth logout --json`; require requester-scoped server revocation when reachable,
   local credential removal, idempotent repeated logout, and post-logout command rejection with exit
   `3`. Never accept local deletion as proof of confirmed server revocation.

## 6. Exact phone permission gate

On each supported installed adapter run setup, doctor, one protected request, and uninstall for
Codex, Claude Code, OpenCode V1, and OpenCode V2. Linux must skip only the macOS OpenCode adapter and
must keep supported adapters visible. Same-turn Codex calls use fresh request nonces; only an exact
hook retry may reuse its stable identity.

Continue once only after the durable exact interaction returns every canonical approval field.
Prove denial for every other outcome. Keep APNs/provider/device receipt evidence separate from the
server result. Do not use Dashboard-session routes or synthetic phone responses.

## 7. Removal and release decision

- Back up and atomically update the installed skill using only a private non-discovery archive,
  validate it, restore the exact backup, validate again, then reinstall `0.7.17`. Audit discovery
  after every transition. Remove it only with the pinned installer and confirm it is absent.
- After functional logout, run `release:host -- uninstall --execute` with the same transition,
  source, host/run IDs, scope, evidence directory, and preserved-file arguments. Confirm binaries are
  absent and all preserved state remains unchanged. Package removal must not revoke credentials or
  remove hooks implicitly.
- Record exact source commit/manifest, transition identity, Node/npm versions, host evidence IDs,
  command/exit matrix, test totals/skips, server deployment/version, iOS build/device identity, APNs
  mode, exact receipts, failures, and rollback/removal evidence.
- Release only if every applicable gate is exact and green. Otherwise retain artifacts, roll back,
  and report the narrow blocker. Never describe `0.7.17` as installed, phone-proven, deployed, or
  public until those respective gates have actually completed.
