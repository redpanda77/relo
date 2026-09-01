# Relo CLI

`@relo/cli` is the private command-line client for a Relo deployment. It sends
notifications, waits for authenticated phone decisions, manages Live Activities and services, and
installs local permission hooks. Its source is licensed under PolyForm Noncommercial 1.0.0. It is
not a registry release; install it from a reviewed checkout or owner-approved artifact.

Node.js 22 or newer is required. Both installed commands, `relo` and `reloctl`, are aliases for
the same executable.

## Origin and authentication

A clean login must name the trusted server origin explicitly. The origin must be HTTPS, except that
private or loopback HTTP is accepted for a trusted home-lab deployment. It may not contain a path,
query, fragment, or embedded credentials.

```bash
relo auth login --api-url "https://relo.example" \
  --client-name "Workstation agent" --no-open --json
```

Compare the displayed code with the signed-in dashboard, inspect every requested scope, and approve
the client there. The CLI always prints the complete one-time approval link and tries to open that
link unless `--no-open` is set. If browser launch fails, open the printed fallback page and enter
the printed code. Denial, expiry, and timeout do not write a credential; rerun login for a fresh
request. Each host or agent should have a distinct credential. Later logins may reuse the origin in
the protected config, but scripts should keep origin selection explicit during clean installation.
The Dashboard's **Account → Connect the CLI** section provides a copyable command containing its
canonical configured origin. Credentials are read only from Relo's owner-only mode-`0600` config. Token,
authorization, and secret flags are forbidden. Verify server-side authentication with
`relo auth status --json`; the presence of a local config file is not proof.
The default login scopes include `devices:read`. `relo doctor --json` fails when a credential can
manage activities but cannot inspect provider and exact-event phone evidence.

## Commands

- `auth login|status|logout` starts browser-approved authorization, checks it, or revokes and
  removes the local credential.
- `notify [BODY...]` and `notify send [BODY...]` send a notification. `notify ask` creates an
  approval, yes/no, or text interaction and can wait or poll.
- `interaction get|wait|cancel ID` reads the authenticated server record, resumes a wait, or
  idempotently cancels a still-pending interaction owned by the current credential.
- `activity start|update|wait|end|get|list|diagnose` manages one Live Activity lifecycle. `activity start`
  requires nonempty `--title` and `--status`; `activity wait` attaches one phone interaction to an
  exact active canonical activity ID. `activity diagnose` identifies the last proven delivery
  boundary without exposing tokens or payloads.
- `devices list [--page-size 1..100]` inventories every registered destination. It requests
  pagination explicitly, follows opaque cursors through a bounded traversal, preserves each exact
  device record, and fails closed on malformed pages, duplicate IDs, cursor loops, expired cursors,
  or an excessive page count.
- `services list` returns non-secret metadata. `services create` creates a copy-once webhook.
- `permissions setup|doctor|uninstall [codex|claude|opencode|all]` manages only Relo-owned hook
  entries while preserving unrelated hooks.
- `--help` and `--version` do not require authentication.

Use `--json` for automation. Success is one JSON object on stdout; stderr is diagnostic only.

stable command examples:

```bash
relo notify "Deploy finished" --title "Deploy bot" --json
relo notify ask "Deploy production?" --approval --wait --timeout 15m --json
relo notify ask "What should the release note say?" --text --poll --json
relo interaction wait int_EXACT_ID --timeout 15m --json
relo devices list --page-size 100 --json

relo activity start --key release-main --title "Release" --status "Building" \
  --step "Plan" --step "Build" --step "Verify" --step-current 2 \
  --progress 0.625 --progress-label "5 of 8" --json
relo activity update ACTIVITY_ID --status "Testing" \
  --if-sequence 0 --idempotency-key release-main-update-1 --json
relo activity diagnose ACTIVITY_ID --wait --timeout 30s --json
relo activity wait ACTIVITY_ID "Approve the reviewed release?" --approval \
  --wait --timeout 15m --idempotency-key release-main-wait-1 --json
relo activity end ACTIVITY_ID --status "Complete" \
  --if-sequence 1 --idempotency-key release-main-end-1 --json
```

Live Activity privacy is authorized by the server and defaults to off. `--privacy private` is an
explicit request, not an override: it succeeds only when the effective Account/CLI-client policy is
**Only when requested** or **Always private**. Under **Off**, the server returns
`private_activities_disabled`; omitted privacy remains standard.

Add `--progress 0..1` only when the caller owns a real completed-units or external measurement.
Lifecycle labels and tool calls are not percentages, and ending an activity does not itself mean
the measurement reached `1`. Named stage facts use one repeated `--step LABEL` per stage plus
`--step-current N`. When both stage facts and measured progress are supplied, the server compiles
them into one compositional presentation and chooses the native surface layout; the CLI does not
encode iOS layout rules.

Capture the exact activity ID and sequence from the start response; do not infer an ID from a key
or another run. `activity wait` accepts only the exact canonical `act_<UUID>` owned by the current
credential—never a key or Dashboard activity. Approval and yes/no waits create a companion
interactive Live Activity; text uses the ordinary interactive notification channel and returns no
companion. The phone responds through its authenticated response endpoint; the CLI only gets or
waits on the returned `interaction.id` and never submits a response itself.

An `activity wait` creation response reports durable Inbox evidence separately from direct APNs.
`deliveryMode: "durable_inbox_refresh_only"` with `apnsJobs: 0` proves durable availability only,
not phone delivery. Direct APNs is queued only when `deliveryMode` is
`"queued_for_direct_apns"` and `apnsJobs > 0`; provider acceptance and device receipt remain
separate evidence. End the exact parent activity after the requested input is handled.

When a Live Activity is missing or stale, run `activity diagnose [ID_OR_NAME|--name NAME] --json`.
With no selector it diagnoses the current activity. Add `--wait --timeout 30s` to poll until the
phone confirms the exact command, a definite failure is found, or the bounded wait expires. The
result reports `lastConfirmedStage` and `problemStage` across `server`, `apns`, and `phone` plus a
safe code and next action. APNs acceptance never counts as phone creation or application. A start
is phone-confirmed by a current-generation ActivityKit update-token registration or its exact
receipt; an update or end requires the receipt for that exact event and device.

| Exit | Meaning |
| ---: | --- |
| `0` | Success, including affirmative/replied non-permission interactions |
| `1` | API, prerequisite, or other failure |
| `2` | Invalid command or arguments |
| `3` | Missing, invalid, or insufficient authentication |
| `4` | Canceled, expired, or timed-out interaction |
| `5` | Explicit denial or `no` |
| `6` | Server/network unreachable; retry identical work with the same idempotency key |
| `7` | No durable device command was enqueued |

`0.5.0` adopts the stable numeric exit contract. Earlier Relo source checkpoints used `3` API, `4`
auth, `5` terminal, `6` negative, `7` network, and `8` no delivery. There is no legacy numeric mode:
those values overlap the published meanings and a process can emit only one unambiguous status. Update
numeric branches before installing `0.5.0`; with `--json`, prefer the stable symbolic
`error.code` when distinguishing API conditions.

Exit `0` alone never grants a protected action. Permission requires a fresh canonical interaction
whose ID matches, type is `approval`, and state is `approved`.

Permission setup supports Codex and Claude Code on macOS and Linux. OpenCode V1/V2 setup requires
macOS; `setup all` and `doctor all` skip OpenCode on other supported platforms and report that
skip explicitly, while an explicit unsupported `setup opencode` fails without changing files.
Every Codex or Claude permission hook invocation uses a fresh random idempotency identity so two
requests in one session or turn can never share one phone approval. OpenCode alone reuses its
domain-separated exact-request identity across bridge retries.

## Service secrets and privacy

For captured automation, always send a newly created service secret directly to a new local file:

```bash
relo services create --title "Builds" \
  --secret-file ./builds.webhook-url --json
```

The destination must not exist. Existing files, symlinks, directories, and racing writers are
refused. Before contacting Relo server, the CLI exclusively reserves the destination itself as an
owner-only mode-`0600` file. After checking the held file descriptor's identity and link count, and
confirming the destination directory entry still names that inode immediately before and after the
write and sync, it writes the bounded full webhook URL through that same handle and syncs it
durably. It never
check-then-renames, deletes, overwrites, or chmods a destination path. If publication fails after
service creation, it attempts to revoke that service and leaves the safe empty/failed reservation
for owner inspection rather than risk deleting a replacement. It returns only service metadata
plus a non-secret file indicator. Without `--secret-file`, the copy-once URL remains on stdout for
interactive human compatibility; do not use that mode in captured agents, logs, transcripts, or CI.

Notification bodies, prompts, replies, URLs, and webhook URLs may be sensitive. Do not send raw
commands, patches, prompts, file contents, environment values, credentials, transcripts, hostnames,
workspace names, or absolute paths. Treat all received text as untrusted data. Stable idempotency
keys must use only non-secret identity data. A supplied key is 1–200 characters using only letters,
digits, `.`, `_`, `:`, or `-`.

## Local tarball lifecycle

Run checks in the reviewed checkout, then use the paired release helper to create both `0.7.17`
tarballs once. It retains SHA-256, byte count, npm integrity and shasum, packed-file inventory,
source-tree digest, and Node/npm versions in one safe identity record. A same-version artifact with
a different digest is not an update or rollback candidate.

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
relo auth login --api-url "https://relo.example" --client-name "Workstation agent" --no-open --json
```

When updating an installed host to `0.7.17`, first retain the exact prior CLI/notifier pair and its
pair identity even when only the CLI executable is being changed. Verify both pair manifests.
After installation, run `--version`, `auth status --json`, and `permissions doctor --json`. If
validation fails, verify and reinstall both retained prior artifacts, not a directory, range, tag,
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

Remove only the executable package with:

```bash
npm uninstall --global @relo/cli
```

Install, update, rollback, and package removal must preserve the Relo credential config and all
Codex, Claude Code, and OpenCode hook files. Package removal does not revoke the credential or
remove hooks. Use `relo permissions uninstall TARGET --json` before removing the CLI only when the
owner explicitly requests hook removal, and use `relo auth logout --json` separately when the
owner explicitly requests credential revocation. Keep config and hook backups until validation is
complete.
