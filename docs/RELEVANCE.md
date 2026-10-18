# Relevance contract

The executable definitions are `packages/contracts/src/relevance.ts` and
`apps/ios/Sources/ReloCore/RelevancePolicy.swift`. Both consume the same
policy, evaluation, and ordering examples. The contracts test checks that the
Swift fixture is byte-for-byte identical. Ordinary API notices persist and
enforce the contract at admission, claim, and final APNs authorization. Ordinary
API decisions also use canonical identity, action deadlines and exact response
adjudication. Ordinary webhook and Dashboard text questions, API ActivityKit
questions, and activity waits share canonical admission. Native activity adapters
share typed lifecycle commands and an immutable occurrence journal; iOS consumes the bounded current-state
projection. Operational progress and incidents have their own admission and retention
protection, and the CLI records each notice's and question's occurrence durably before sending.

## Ordinary API notice admission

Every ordinary notification is admitted with a relevance row; a request without a `relevance`
command gets an independent subject derived from its idempotency key. Current state reads only
admitted subjects and native Live Activities (migration 0058 retired the last metadata-free rows).
Live Activity events never carry relevance; their delivery uses bounded windows from event time.

`POST /api/notifications` accepts an optional `relevance` command:

```json
{
  "subjectKey": "build:release",
  "generation": 1,
  "revision": 1,
  "operation": "replace",
  "occurredAt": "2026-09-30T12:00:00Z",
  "policy": { "kind": "notice" }
}
```

The enclosing notification fields are unchanged. `notice`, `progress` and `incident`
policies are accepted on this route. Account and source are derived from authentication; a client cannot
supply them. The credential identity is the source boundary, independently of its
display name. Omission creates an independent subject from the idempotency key,
using the first event's creation time. Existing clients therefore gain bounded
notice lifetimes without conflating unrelated work by title, project, or thread.

Admission stores the current subject/version outside prunable history, together
with the immutable request hash and normalized original deadlines. Replacement
cancels only unstarted older jobs and explicitly records supersession. A replay
at the same version returns its original receipt and deadlines; changed intent
returns `409 version_conflict`. Pruned receipts return `409 retired_replay`; old
versions return `409 stale`. Unsupported/future lifetime input returns 400.

Useful notices remain in history/current evidence after their 60-second alert
window closes. Admission queues no late alert; claim and final short dispatch
authorization independently check the canonical version and deadline. The APNs
expiration is bounded by delivery time, separately from the 15-minute relevance
deadline. Dispatch-started and ambiguous provider evidence is never rewritten.

Rows without canonical relevance have an explicit compatibility delivery ceiling
from the original event time: 60 seconds for notices, 15 seconds for progress,
900 seconds for decisions, and 3,600 seconds for terminal ActivityKit cleanup.
An earlier existing event or request deadline wins. Creating another job cannot
restart the window, and a settled request cannot dispatch. The same ceiling
governs claiming, final recipient authorization, provider retry, APNs expiration,
and cancellation of unstarted jobs. This policy does not shorten a still-valid
decision's action deadline, end underlying work, delete history, or infer
supersession. Canonical metadata always takes precedence over the fallback.
A release drains pending, retry and processing work before promotion or records
migration-specific compatibility proof for the exact untouched jobs allowed across
the handover. Dispatched or ambiguous evidence and stored hashes are preserved.

## Operational progress and incidents

Credential and webhook notification commands accept `policy.kind=progress`. These
update current state and its committed-change stream without ordinary APNs alerts.
Declared heartbeats supply a freshness warning; absent heartbeat metadata creates
no idle-expiry guess. Native ActivityKit frames retain their separate silent transport.

Incidents declare `policy: { kind: "incident", mode: "until_resolved" }` or a leased
policy with an absolute `leaseUntil`. A newer same-generation revision with
`operation: update` and `status: resolved` retires the incident and cancels its
unsent alert. A resolved generation cannot reopen, even after event history is
pruned. Reopening requires the next generation, revision1 and `operation: replace`.
Changing policy kind also requires a new generation. An expired lease creates
history without current work or a newly eligible alert.

Current canonical heads survive history retention after their delivery jobs finish.
Stale progress remains current. Resolved, expired, withdrawn and superseded records
become eligible under ordinary history policy; retained subject/version fences
continue to reject obsolete replay.

The CLI accepts these explicit policies through `--stdin`. It also saves default
notice/question occurrence, intent digest and independent identity before sending,
including ActivityKit questions. Retry after process restart keeps the original
alert/action window; capture failure sends nothing. Explicit producer occurrence
and policy remain immutable. The CLI's native activity journal additionally captures
the exact activity target and sequence before mutation.

## Ordinary decision admission and responses

`POST /api/interactions` with either supported presentation accepts the same
`relevance` envelope with `policy.kind=decision`. The action duration comes from
`expiresInSeconds` (default 300); if the policy repeats `actionSeconds`, the two
values must agree. An optional shorter `deliverySeconds` controls alerts without
shortening the action. An already-past original action deadline creates an expired
receipt and event, with no delivery job. A settled/expired decision cannot reopen
through a same-generation revision; new work requires explicit next-generation
replacement. Independent default requests retain independent subject keys.

Phone response requests may include `expectedSubject`, the complete identity
returned at admission. A mismatch is rejected. Older clients still bind to the
immutable notification/request IDs, and the server checks their canonical
version under the same request lock. Previously accepted exact idempotent replies
remain valid receipts after replacement; a new reply to replaced work returns
`409 interaction_superseded`. Accepted responses include the canonical decision
state and response time so clients need no follow-up inbox fetch for confirmation.

Replacement locks the subject, associated activity, and every prior request
before advancing the head. Subject/activity locks precede provisional event
insertion because resource-binding triggers also take row locks. Response/expiry
locks the activity before its request and reads the head without locking it.
This orders competing decisions without a reverse lock cycle.
Adjudication uses one actual database-clock sample, not the transaction's start
time, for its final deadline guard and response timestamp. Settlement and the
response receipt commit together. Terminal status lives in event relevance;
the head's original admission receipt remains immutable for retry comparison.

API ActivityKit questions and the CLI accept explicit canonical relevance.
Request, event and native activity share the original action deadline; expired
arrivals persist terminal state and queue zero jobs. Replacement ends the old
native prompt through an independent one-hour cleanup command. Legacy per-device
activity requests are arbitrated by the common activity lock: one settlement
cancels pending sibling prompts across phones.

`POST /api/live-activities/{id}/wait` creates an independent canonical question.
Its original action and delivery deadlines cannot exceed the parent's expiry,
and a longer parent cannot extend a shorter question. Replay preserves the first
deadline even if the parent later changes. Expiry during admission contention
persists an expired request and, where applicable, an expired companion with no
delivery jobs. Its response includes `relevance` for exact-version submission.

## Identity and replacement

A subject is `(accountId, sourceId, subjectKey)`. The account and source are
authenticated canonical identities. A display name, project, notification
title, timestamp, or client-supplied account claim is not replacement authority.
An independent decision has its own subject key, even when it belongs to the
same work item as another decision or a stream of progress.

The server opens generation 1 at revision 1. Only an explicit start/replace
operation opens the next generation, also at revision 1. Within a generation,
update revisions can advance with gaps. Old revisions and old generations stay
historical. A completion cannot create or promote a generation. Admission must
lock the current pointer, authorize the source, and check immutable intent hashes;
the pure ordering guard alone is not a transaction or an idempotency guarantee.

Persist explicit supersession and current-generation fences separately from
prunable history. An absent or older pointer cannot validate a newer decision.
An explicit supersession survives even when the pointer is unavailable.

## Independent lifetimes

| Purpose | Default relevance/action | Default delivery | Exception |
| --- | --- | --- | --- |
| Notice/completion | 900 seconds | 60 seconds, bounded by relevance | Explicit finite durations |
| Decision | 300 seconds | Until its original action deadline | Explicit shorter delivery window |
| Routine progress | No invented idle expiry | 15 seconds, silent | Declared heartbeat becomes stale after 3 intervals |
| Incident | Explicit until-resolved or absolute lease | 60 seconds, bounded by lease | Exact identity resolves/renews it |
| Internal terminal cleanup | Separate 3,600-second window | Silent cleanup only | Targets the old native activity, never a new action |

Normalization uses the original occurrence, not the time of a retry. Admission
persists the normalized result once; retries reuse it and cannot change the
hashed occurrence or deadlines. Producer clock lead up to one second is tolerated;
deadline calculation uses the earlier of occurrence and server acceptance so
clock lead adds no lifetime. Larger future occurrence/heartbeat timestamps are
rejected. An incident lease
already in the past stays expired. Contradictory policy fields are rejected.

An event may stay current after its delivery window closes. Unread does not
mean relevant, and expiration is not a read receipt. A stale heartbeat does not
mean failure, completion, or settlement. A settled decision remains evidence
after replacement. Silent routine progress can be transport-eligible without
being alert-eligible.

## Offline evaluation

Evaluate against the authoritative pointer for the exact subject and a scoped
server-time sample advanced with a monotonic clock. With an uncertain clock,
`now` is a persisted lower bound on server time, not an arbitrary phone wall
clock. Known expiry can still retire an item; an unexpired-looking action is
unverified and cannot become silently accepted. Clock ownership and persistence
are supplied by the current-state runtime, not this pure policy.

A valid online tap goes directly to atomic server adjudication with the exact
identity, revision, and original deadline. Do not add a preflight fetch or
transfer a queued response/draft to replacement work. Server integration must
enforce these rules during response/expiry/replacement races and preserve replay
fences across retention.

## Durable decision expiry

The worker settles ordinary approval, yes/no, and text decisions as well as
ActivityKit decisions. Each pass locks at most 100 due requests with SKIP LOCKED;
request/event settlement and cancellation of unsent jobs commit together.
Dispatched and ambiguous attempts remain evidence. Deadline-aware badges exclude
expired or terminal work before maintenance runs. Expiry wakes connected request
waiters through the existing committed-change signal and releases the pending
retention guard. Canonical subject replacement and producer integration are
governed by [Identity and replacement](#identity-and-replacement); general expiry
alone does not retire superseded work.

## Verification

```sh
pnpm --filter @relo/notification-contracts test
pnpm --filter @relo/notification-contracts typecheck
cd apps/ios
swift test --filter RelevancePolicyTests
```

The unsigned shipping-target gate is documented in [TESTING.md](TESTING.md).

## Native activity cadence

Producer starts calculate absolute expiry and stale time from the earlier of the
original occurrence and server admission. Updates and origin reuse likewise base
staleness on their occurrence, without extending absolute expiry. The configured
stale interval is persisted separately from the remaining lifetime, so delayed
arrival does not silently change the cadence of later updates. A fresh explicit
heartbeat renews its declared lease from the actual write time. Historical rows
without a stored cadence derive it from their matching occurrence evidence, or
from their last write when a heartbeat superseded that evidence.
