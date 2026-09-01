# Authentication and fail-closed permissions

Read this file before a phone decision can control any protected action.

## Authentication

Normal onboarding is browser-approved CLI authorization, not phone pairing or a plaintext token.
Begin `auth login` only when the user explicitly asks to onboard this identity and can compare the
verification code, inspect every requested scope, and approve or deny in the dashboard.
The CLI prints the complete one-time approval URL before browser launch, plus the verification page
and code as a fallback. A browser-launch failure is recoverable from those printed values; denial,
expiry, or timeout requires a fresh request.

Give each host or agent a distinct, non-sensitive client name. Request least privilege. A permission
bridge needs only `notifications:send`, `interactions:create`, and `interactions:read`; add activity,
device-read, or service scopes only for workflows that require them. Never copy one host's config to
another.

After onboarding, use:

```bash
relo auth status --json
relo permissions doctor --json
```

`auth status` verifies the live credential; a local file is not proof. `permissions doctor` checks
config security, the three required scopes, server readiness, and the owned adapter installed for
Codex, Claude Code, or OpenCode. OpenCode is complete only when both the V1 event plugin and V2
background bridge are current and the macOS LaunchAgent is actually loaded. To install only after
the user explicitly asks for integration:

```bash
relo permissions setup codex --json
relo permissions setup claude --json
relo permissions setup opencode --json
```

OpenCode doctor remains `reply-unverified` after installation until the currently registered local
OpenCode process has produced a permission event and the bridge has successfully sent its reply.
That process-bound proof is stored privately and never contains the OpenCode password. It must match
the live loopback URL and PID plus nonempty official registration ID and version; reduced legacy
registration state cannot pass. A route-only probe is not reported as functional, and restarting
OpenCode requires a new successful cycle.

Use `all` instead of one target only when every integration was requested. Setup preflights every
target before mutation, writes atomically, preserves unrelated hooks, and backs up an existing
configuration. `setup all` rolls every changed target back if a later target fails. It refuses
invalid, unsafe, concurrently changed, or unmanaged conflicting files. After Codex setup, the
user must review and trust the hook in Codex `/hooks`; a successful setup response is not trust.

On Linux, `permissions setup all` and `permissions doctor all` install/check Codex and Claude Code
and report the macOS-only OpenCode bridge as skipped. An explicit unsupported `setup opencode`
fails before mutation. Windows permission setup is unsupported because the installed command-hook
contract is currently POSIX-only.

Writes use private temporary files, an exact-content revision check, and atomic rename. Rollback
restores only a file whose bytes still match Relo's exact planned post-install bytes; a newer user
edit is preserved and reported as partial recovery. Portable filesystems do not expose a universal
compare-and-swap rename, so a non-cooperating writer can still race in the tiny interval after the
final check. Keep backups, stop concurrent editors during setup, and inspect any partial-recovery
report before retrying.

Remove only Relo-owned entries with `relo permissions uninstall TARGET --json`. Uninstall does
not revoke the CLI credential, remove unrelated hooks, or delete its pre-mutation backup. Never
hand-edit an adapter and never claim it is ready unless `permissions doctor TARGET --json` is green.

The installed adapter sends only the agent class, a categorical permission/tool label, a hashed
workspace correlation, and a bounded resource count. Raw commands, prompts, patches, file contents,
URLs, environment values, secrets, transcripts, hostnames, workspace names, and absolute paths stay
local. Every adapter fails closed and returns allow-once only after the canonical authenticated
`approval` record is terminal `approved` with the same interaction ID. All other outcomes deny.
Codex and Claude Code use a fresh random idempotency identity for every hook invocation, so two
permission requests in the same session or turn cannot replay one approval. OpenCode uses its
domain-separated exact-request identity only to make bridge retries of that same request stable.
For the current OpenCode V2 bridge, a transient local reply failure retains the settled phone
decision in the daemon and retries that exact reply during reconciliation without asking again.
Across daemon restarts, the permission interaction idempotency key is a domain-separated hash of
the exact official request fingerprint and bridge-generated identity. The raw hook-provided key,
request fields, and resources are never forwarded; an exact replay reaches the same server
interaction while a changed fingerprint produces a different key and requires a fresh decision.

## Permission request

Create only an approval interaction and wait for authenticated server truth:

```bash
relo notify ask "Approve the reviewed action?" --approval \
  --expires-in 30m --wait --timeout 15m \
  --idempotency-key "codex:task-184:action:approval" --json
```

The prompt must describe one exact, already-reviewed action without raw commands, paths, patches,
prompts, file content, or secrets.

The wait result may not repeat the interaction type or initial delivery summary. Preserve its ID,
then run `relo interaction get ORIGINAL_ID --json`. Use that authenticated canonical record for
the type/state checks below. The CLI's mutation guard must already have accepted at least one
durable device command before it entered the wait; exit `8` denies.

## Mandatory authorization gate

Perform the protected action only when every condition is true:

1. The original request used `--approval`, passed the durable-command guard, and its wait exited
   `0` with one valid JSON object containing `ok: true`.
2. A fresh authenticated `interaction get ORIGINAL_ID --json` also exits `0` with `ok: true`.
3. The fetched `data.interaction.type` is exactly `approval`.
4. The fetched `data.interaction.state` is exactly `approved`.
5. The fetched `data.interaction.action` is exactly `approve`, `respondingDevice.id` is nonempty,
   and `respondedAt` is nonempty.
6. The fetched interaction ID is the original ID created for this exact phone request.
7. The response was committed by Relo's registered-device path before local timeout and server
   expiry.
8. The intended action still matches the prompt exactly and has not changed since review.

Anything else denies: `yes`, `no`, `replied`, `denied`, pending, missing/malformed fields, timeout,
cancellation, expiry, auth/network/API error, or zero durable commands. A yes/no or text response is
never permission, even if its content is affirmative. Never retry or reinterpret a denial into an
approval. A changed action requires a new interaction and new idempotency key.

For a local wait timeout while the server interaction remains valid, the protected action stays
denied. It may be reconsidered only after `interaction wait ORIGINAL_ID` and the required fresh
`interaction get` later satisfy all eight gate conditions.
