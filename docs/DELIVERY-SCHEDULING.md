# Delivery scheduling

The worker continuously replenishes completed dispatch slots. It claims only
work that can start, rather than waiting for a complete batch before claiming
again. Maintenance sweeps and heartbeat writes run separately from admission.

The active cap is the smaller of `APNS_LOCAL_CONCURRENCY_CAP` and
`WORKER_BATCH_SIZE`. `WORKER_URGENT_RESERVED_SLOTS` defaults to 2, bounded to
leave at least one shared slot. Routine work cannot occupy reserved slots.
Valid decisions and terminal activity ends use the urgent lane. Each shared
slot offers normal FIFO work a turn after at most three urgent admissions.
This is a bound on admissions, not a promise that an already occupied provider
slot can be preempted. A one-slot configuration has fairness but no reservation.

When the provider returns a known 429/5xx response, it persists the original
attempt epoch, remaining attempt cap, retry horizon, and exact jittered retry
time, then returns the slot. The job is eligible again at that durable time.
Restart does not extend its budget. The wake timer uses the next scheduled
boundary; PostgreSQL commit notifications wake newly ready work immediately.
The poll interval remains recovery. Unknown transport outcomes still require
reconciliation, and an unconfirmed finalization stops new admission.

Migration 0045 captures the ordinary notification's badge/avatar inputs once,
before the original serialization fence. A retry reuses them even when current
account state changes. Existing intent/projection/provider hashes are retained.
An old pinned job without reconstructable inputs fails closed; operators must
not clear its hashes or blindly retry an ambiguous attempt. The release inventory
must account for pre-existing pending, retry, and reconciliation-required work.
No APNs token or response capability is added to the snapshot.

## Short dispatch authorization

Recipient selection takes a short transaction with a 250 ms lock limit and a
two-second statement limit. It validates the owned claim, active event, explicit
device target, authorization, environment and current token, then commits an
opaque token-generation hash and authorization time. The returned token snapshot
owns no database connection. APNs network time cannot block token rotation,
revocation or newer activity mutations by retaining those row locks.

Revocation before authorization prevents the attempt. Revocation after that
fence cannot promise recall: the attempt is in flight, and its provider outcome
is persisted under the original claim. Invalid-token feedback clears only the
exact captured ciphertext and activity generation. A replacement surviving old
feedback is a successful no-op, not a reason to quarantine the provider pool.
Accepted terminal cleanup also compares the captured token hash before removal.

## Current ActivityKit frames

Domain revisions do not manufacture provider time. A burst of 30 revisions
keeps one current unsent frame; history remains intact. If no initial start has
crossed its dispatch fence, the current frame can take its place. Once a start
has crossed that fence, updates wait for its matching token. An end never becomes
a start. Terminal cleanup has its own one-hour deadline, including after an
interaction expires.

The worker serializes briefly with canonical activity mutations and pins the
current frame's timestamp, payload hashes and dispatch marker atomically.
The first frame uses the current database wall-clock second. Another frame
waits until the next actual second when necessary; revision count adds no debt.
The durable head is per activity/device/generation and survives event pruning.
A pinned retry retains its exact timestamp and bytes. Known obsolete retries
are retired; ambiguous or in-flight attempts remain evidence.

Clock rollback preserves that head, defers the latest frame, and records
`activity_clock_rollback` plus a clock-health operational event. It does not
invent future timestamps. The next-second bound assumes a healthy clock and
excludes scheduling, provider and phone delivery time. Equal-second ordering is
not assumed safe. An older generation cannot send through a newer token.

Migrations 0046–0047 add authorization evidence and durable frame heads. Legacy
pinned timestamps are copied from their immutable events, never repinned.
An unreconstructable legacy pin fails closed. Promotion requires a quiesced
queue inventory, an exact image rollback identity, and a database checkpoint;
do not clear payload hashes or blindly replay ambiguous work during cutover.

## Immediate dependency wakeups

Activity token registration and eligibility wakeup commit together. Only matching
activity/device/generation token-wait jobs become ready; unrelated devices,
obsolete revisions and provider backoff retain their existing state. An exact
token can register after completion while a current terminal-cleanup job remains
within its deadline. A stale-generation registration cannot replace or wake the
current generation. Token persistence does not depend on permission-heartbeat
ordering; dispatch still checks current authorization.

Both worker and API LISTEN connections reconnect with bounded exponential delay
(250 ms to five seconds). A disconnect and successful recovery each request a
catch-up read. One API listener fans out committed interaction changes to scoped
waiters; each waiter subscribes before its first authoritative read. The trigger
contains only account/request identities and cannot publish rolled-back state.
Timers provide five-second missed-hint recovery and wake at the request deadline.
No database connection is held by an HTTP long poll.

Wait subscriptions are bounded to 16 per credential and 1,000 per process, and
are released on cancellation, completion or server shutdown. Responses remain
credential-scoped and recheck revocation. `timeoutSeconds` accepts integers 0–300;
the inbox `limit` accepts integers 1–100. Malformed, fractional, infinite and
out-of-range inputs return 400. Elapsed wait time uses a monotonic clock.

Phone decisions use a separate `decision-responses` rate-limit family from
producer progress and receipt traffic. The existing per-account and per-device
limits still apply to that family. A saturated producer cannot consume response
capacity. General notification relevance and supersession are specified in
[RELEVANCE.md](RELEVANCE.md).

## Controlled latency measurement

After migrations, run against a disposable local database whose name ends in
`_test`, from an exact clean candidate:

```sh
git diff --quiet
git diff --cached --quiet
export RELO_BENCHMARK_SOURCE_COMMIT="$(git rev-parse HEAD)"
# Set TEST_DATABASE_URL to the disposable local database.
pnpm --filter @relo/server exec tsx src/benchmarks/delivery-latency.ts > /tmp/relo-delivery-spans.ndjson
node scripts/relo-latency-report.mjs /tmp/relo-delivery-spans.ndjson
```

The benchmark records 100 committed decisions reaching an injected dispatch
boundary while one older send stays suspended. It uses real PostgreSQL claims
and LISTEN/NOTIFY. The monotonic interval begins immediately before COMMIT,
including commit overhead. It ends at the injected dispatch callback, before
APNs preparation/network work. No push is sent. Results are scheduler evidence;
they do not establish phone latency or the complete production APNs path.
The report identifies other latency stages still missing from this measurement.
