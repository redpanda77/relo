# CLI workflows and stable output

## Installation doctor

Run `relo doctor --json` to check the local protected config, server reachability, live credential,
schema, worker heartbeat, APNs configuration category, and registered notification-capable phone in
one result. A nonzero exit means at least one required stage is broken. `relo doctor --smoke --json`
also enqueues one ordinary notification, but `serverAccepted`, `providerAccepted`, and
`phoneReceived` remain separate facts; `null` means the later fact was not observed, never success.
An activity-capable credential must include `devices:read`; otherwise doctor fails because provider
and exact-event phone evidence would be inaccessible.

Use an already installed, user-trusted `relo` or `reloctl` with Node.js 22 or newer. Resolve it
locally with `command -v`; the resolved executable path is local-only and must never be sent to the
server. Do not download, replace, or upgrade the CLI during an ordinary notification task.

Every automation command uses `--json`. Stdout is one stable object:

```json
{"ok":true,"command":"notify.send","data":{}}
```

Branch on process exit before inspecting `data`; stderr is diagnostic only. Do not scrape prose.

| Exit | Meaning |
| ---: | --- |
| `0` | Command success, or an affirmative/replied terminal interaction |
| `1` | API, prerequisite, or other failure |
| `2` | Invalid command or arguments |
| `3` | Missing, invalid, or insufficient authentication |
| `4` | Canceled, expired, or timed-out interaction |
| `5` | Explicit denial or `no` |
| `6` | Network unreachable; retry identical work with the same idempotency key |
| `7` | No durable device command was enqueued |

This is the stable `0.5.0` mapping. Earlier Relo source checkpoints used the shifted
`3`–`8` failure range. Do not request a legacy numeric mode because those values now have different
meanings. Migrate automation before installation and use the stable JSON `error.code` for semantic
error handling.

Exit `0` alone never authorizes a permission because yes/no and text replies can also exit `0`.

## Notifications and decisions

Every agent-authored notification and Live Activity must carry both a project and a thread name.
`Direct CLI` describes how the event entered Relo; it is not identity. Use the canonical product
label for `--project` and current task name for `--thread-name`, or short categorical fallbacks.
Pass both on notification send and activity start/ensure/update. Activity end deliberately accepts
no context replacement: inspect the activity first and end only when it already retains the same
pair. Never leave known identity empty or change it within one lifecycle.

```bash
relo notify send "Reviewed work is ready" --title "Codex" \
  --project "Relo" --thread-name "Release verification" \
  --idempotency-key "codex:task-184:review:ready" --json

relo notify Build validation finished --title "Codex" \
  --project "Relo" --thread-name "Build validation" --json

relo notify ask "Approve the reviewed deployment?" --approval \
  --expires-in 30m --wait --timeout 15m \
  --idempotency-key "codex:task-184:deploy:approval" --json
```

Ask selectors are exactly one of `--approval`, `--yes-no`, `--text`, or
`--type approval|yes-no|text`. `--timeout` requires `--wait`. `--poll` performs one fixed
20-second wait and cannot be combined with `--wait` or `--timeout`. Body/prompt data may instead
come from a JSON object on stdin with `--stdin`; explicit flags take precedence.
Both `relo notify BODY...` and `relo notify send BODY...` join multiple positional tokens into
one body. Use `--` when a direct notification body begins with `send` or `ask`. Ordinary
notification asks accept `--image` and `--url`; interactive Live Activity asks reject them. Image
URLs must be public HTTPS, while destination URLs must be HTTPS and remain untrusted.

A caller-supplied `--idempotency-key` is 1–200 characters using only letters, digits, `.`, `_`,
`:`, or `-`. Reuse it only for an identical logical operation and identical visible content.

Use `interaction get ID --json` to read without waiting. Use
`interaction wait ID --timeout 15m --json` to resume a known pending interaction. A local timeout
does not delete the server interaction. Always reuse the original ID. Wait output may omit the
interaction type; a standalone `interaction wait` also has no creation delivery summary. A
`notify ask --wait` or `--poll` result preserves the creation delivery summary while replacing its
interaction with the waited server result. Before authorizing a protected action, fetch the
canonical record with `interaction get` and apply every gate in `permissions.md`.

Use `interaction cancel ID --json` only when the user asks to abandon a known pending request.
Cancellation is requester-scoped and idempotent; a successful cancel command exits `0` with the
canonical `canceled` record. That mutation success never counts as approval, and canceling an
already answered interaction is an API error.

Denial, `no`, cancellation, expiry, and local wait/poll timeout remain nonzero error envelopes.
For `notify ask`, their safe creation proof and last canonical interaction are preserved at
`error.details.result`, including `delivery`, `eventId`, `liveActivityId`, queue count, and replay
metadata when the create response supplied them. This diagnostic result never converts the error
to success and must never be interpreted as permission.

## Live Activities

The common workflow is handle-free. `ensure` asks the server to reuse the one active session owned
by the authenticated CLI credential and exact target set, or to create it when none exists. Update,
status, and end select that same session only when selection is unambiguous:

```bash
relo activity ensure --title "Build validation" \
  --status "Starting" \
  --project "Relo" --thread-name "Release automation" \
  --idempotency-key "codex:task-184:activity:start" --json

relo activity update --status "Testing" \
  --thread-name "Release automation" \
  --task-title "Validate the reviewed release" \
  --idempotency-key "codex:task-184:activity:2" --json

relo activity wait ACTIVITY_ID "Approve the reviewed release?" --approval \
  --wait --timeout 15m \
  --idempotency-key "codex:task-184:activity:wait:approval" --json

relo activity end --status "Complete" --dismiss-after 5m \
  --idempotency-key "codex:task-184:activity:end" --json
```

The CLI defaults terminal dismissal to five minutes so a completed activity remains visible when
the user checks their phone after the task finishes. Use `--dismiss-after 0s` only when immediate
removal is intentional.

For a human-readable stable handle, add `--name "release-build"` to `ensure` and use the same name
on later commands. The name is not the activity's machine
identity: the server also retains an immutable `act_...` ID, authenticated requester, optional
provider/run binding, generation, sequence, and operation history. If multiple active sessions are
valid for one credential, handle-free selection returns `ACTIVITY_SELECTION_AMBIGUOUS` and the
caller must use a name, ID, or lifecycle identity instead of guessing.

For agent/runtime integrations, prefer the origin-aware session surface. Put only the four-field
origin descriptor in an owner-only mode-`0600` JSON file; never include credentials, prompts,
transcripts, commands, hostnames, or absolute paths:

```json
{
  "sourceInstance": "persistent-integration-identity",
  "project": "safe-project-label",
  "thread": "opaque-provider-task-digest",
  "channel": "task-progress"
}
```

Provider/runtime integrations use `activity ensure --stdin` with both origin and lifecycle identity
to create, reuse, resume, or bind the exact provider run. Use
`activity status --origin-file ORIGIN.json --json` to recover server truth. `activity update` and
`activity end` accept the same lifecycle input and resolve the concrete activity on every
mutation. A same-credential manual call may also update or end that one active run without carrying
the provider handle; the provider binding remains on the server and contradictory lifecycle input
is rejected. A manual session may be adopted by a later hook only when it is unnamed and
selector-free, for the same credential, exact targets, and one unambiguous active row. An explicit
name remains a separate manual identity: a named ensure never adopts a provider run, and a hook
never adopts a named manual run. Do not put origin JSON directly in argv. The same origin
and provider-run identity must be used by hooks for the whole run. Local state is a recovery hint
only; the server remains authoritative. Resolve a cached activity against server truth before
mutation. Reacquire a terminal or missing generation through the same idempotent ensure path;
never continue updating a locally cached ID after reconciliation or explicit end.
A completion-only provider integration may end an existing lifecycle or send an ordinary fallback
when none exists, but it must never use completion as a delayed start signal.

Codex lifecycle hooks automatically send the local App Server task name, official task ID, official
turn ID, bounded workspace project, and a bounded redacted instruction summary. If the App Server
does not return a task name, the instruction summary becomes the thread label; if neither is
available, hooks use the categorical fallbacks `Codex task` and `Agent work`. The first hook stores
this identity and all later milestone updates preserve it. The CLI carries these internal fields only
in stdin context; users do not need to type handles. The server persists them as source conversation
and work-item correlation evidence. `--thread-name` and `--task-title` remain optional display-label
overrides for manual or non-Codex integrations. Never copy a raw prompt, transcript, command, path,
tool name, tool input, or tool output into these fields.

The canonical hierarchy is producer/computer, project, provider conversation, then provider work
item. For Codex these are host, repository, task, and turn/instruction. Services and webhooks use
their stable service plus caller-supplied correlation; manual calls use a readable name or an
unambiguous server-owned current session. These producer-specific keys adapt into the same server
conversation/work-item resources without making the iOS app or agent infer identity.

Both `--title` and nonempty `--status` are required by `activity start`, matching the server and
published CLI contract. Current task styles are `standard`, `hero`, `terminal`, and `steps`. Progress is
`0..1`, but it is optional and meaningful only when the caller owns a real completed-units or
external measurement. Planning, Researching, Working, Verifying, Finishing, tool count, elapsed
time, and model confidence are not percentages. Do not send `0` merely to make a progress layout
appear and do not send `1` merely because the lifecycle ended. Without a measurement, omit
progress and let the server select an informational native renderer. Manual and provider-owned
workflows let the server serialize and resolve the current sequence. Provider-run measured
progress is monotonic, so a delayed lower value cannot overwrite a later manual percentage. Use an
explicit `--if-sequence` only for an operator-authored compare-and-swap
diagnostic; on conflict, resolve by the same key or lifecycle identity before deciding what to do.

For a measured workflow with named stages, repeat `--step LABEL` for each stage, add
`--step-current N`, and supply the independent `--progress 0..1`; `--progress-label TEXT` is an
optional bounded measurement label. The CLI sends semantic facts only. The server assigns identity,
compiles the compositional recipe, and selects native surfaces. Do not
encode iOS layout rules in an agent command.

Different origin threads can coexist canonically on the same phone. The server records a
foreground/background presentation lease and relevance for each eligible activity; the CLI does
not choose which thread iOS displays. A foreground change never changes another activity's
canonical state. Treat server acceptance, APNs acceptance, device receipt, and effective iOS
presentation as separate evidence.
Use `--clear-detail` to send
JSON `null`, never the literal text `null`. `activity list --json` lists known activities.
Use measured progress for meaningful quantitative progress, `steps` for a small named stage
sequence, `terminal` for a generic agent/build status without logs or commands, `hero` for a single
prominent milestone, and `standard` otherwise. Semantic progress uses the compact linear
representation. Style is presentation, not a reason to send extra content.

`activity heartbeat --stdin` is integration plumbing for a provider lifecycle. It renews the
server lease without incrementing sequence, changing visible content, or enqueueing an APNs update.
Ordinary agents should not call it directly; the automatic hook adapter uses it when a repeated
categorical event proves the run is still alive. A missed lease is expired and silently ended by
server reconciliation while preserving the last real progress value.

`activity wait` attaches one approval, yes/no, or text interaction to an exact active parent. It
accepts only the canonical returned `act_<UUID>`—never an activity key, alias, foreign credential,
or Dashboard-owned ID. Approval and yes/no create a companion interactive Live Activity; text uses
the ordinary interaction channel and has `companionActivityId: null`. Custom primary/secondary
labels are one line and 1–24 characters and are forbidden for text. The phone responds through its
authenticated response endpoint; the agent resumes with the returned `interaction.id` via the
command's `--wait`/`--poll` or `interaction wait|get`. The CLI never responds for the phone.

Preserve `parentActivityId`, `companionActivityId`, `interaction.id`, `eventId`, delivery summary,
queue count, delivery mode, and replay marker. A successful create must still have
`delivery.durableCommands > 0`. `durable_inbox_refresh_only` with zero APNs jobs is durable Inbox
availability, not direct phone delivery; only `queued_for_direct_apns` with a positive APNs job
count means direct APNs was queued, and neither mode proves provider acceptance or device receipt.
Reuse an idempotency key only for the exact same canonical parent and request. A conflict, inactive
parent, unavailable target, missing scope, malformed response, or mismatched parent/interaction
evidence fails closed.

Interactive ask styles are `approval`, `shell`, `verdict`, and `signal`. They require
`notify ask --live-activity` with `--approval` or `--yes-no`; they never support `--text`. The
default interactive style is `approval` for a conventional allow/deny decision. Use `shell` for an
agent/runtime decision without including a raw command, `verdict` for an explicit reviewed outcome,
and `signal` for a compact high-salience go/stop decision. Keep canonical action order: primary
label is affirmative and the secondary label declines. Custom labels may clarify those actions but
must never invert them.

Update, end, status, and get accept a readable `--name NAME`; positional ID/name forms remain
available, but selectors cannot be combined. Omit the selector for the common
single-session path. A raw ID never bypasses credential isolation. Activity wait is the deliberate
exception: it requires an exact canonical ID. Bound inventory reads with
`activity list --limit 1..100 --json` when only recent state is needed.

When the visible Live Activity is missing or stale, diagnose the delivery boundary before sending
another mutation:

```bash
relo activity diagnose --wait --timeout 30s --json
relo activity diagnose ACTIVITY_ID --json
relo activity diagnose --name "release-build" --json
```

No selector uses the server-owned current activity. The result separates canonical server command
creation, APNs queue/provider outcome, ActivityKit creation proof, and the authenticated receipt for
the exact latest event/device. Read `assessment.lastConfirmedStage`, `problemStage`, `code`, and
`nextAction`; do not infer a later stage. A bounded wait that expires returns the latest safe
diagnosis with `wait.timedOut: true` rather than inventing failure or success. The response exposes
only public IDs, authorization/environment state, safe codes, timestamps, and token presence—never
an APNs token, ActivityKit token, native activity ID, payload, credential, or raw provider reason.

## Delivery evidence

Use the account-scoped evidence commands when a successful creation or update is not enough to
answer what happened downstream:

```bash
relo evidence timeline --notification ntf_PUBLIC_ID --limit 25 --json
relo evidence metrics --json
```

The timeline uses one ordered, versioned vocabulary from canonical acceptance through provider,
device, interaction, withdrawal, and reconciliation evidence. Follow `nextCursor` with the same
`--notification` filter; a cursor is bound to the original account and filter and must not be
reused for a different query. Treat each stage as its own fact. In particular, `provider_accepted`
does not imply `device_received`, `opened`, or `responded`.
For Live Activities, `device_applied` is derived only from a `received` interaction tied to the
same notification event and device. A presentation lease or an older receipt is not application
proof for a newer command.

Metrics are bounded operational aggregates for queue age, worker lag, retries, ambiguous provider
outcomes, invalidated tokens, and receipt latency. They intentionally contain no notification
content, device token, credential, private project/thread identity, or raw provider message. Do not
attempt to reconstruct private identity from hashes or diagnostic codes.

## Devices and stdin

Run `devices list --json` before explicit targeting; it follows all server pages within a bounded
traversal and returns no partial inventory when a page is unsafe. Use `--page-size 1..100` only
when a bounded page size is useful for diagnostics. Pass each validated server ID with a repeated
`--device`; never guess an ID. Notification, ask, activity start/update/end, and service create
accept `--stdin` JSON. Explicit flags override stdin fields. Do not use stdin to bypass the content
restrictions in `security.md`.

Use `services list --json` for non-secret inventory. In captured automation, `services create`
must include `--secret-file PATH`; follow [services.md](services.md) and never use its stdout-secret
compatibility mode.
