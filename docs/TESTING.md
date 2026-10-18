# Test gates

The maintainer verifies everything locally; for contributors, `.github/workflows/ci.yml` is the gate on a pull request. `scripts/gates.sh` runs the contracts, server typecheck, CLI, skill,
Dashboard, owner-surface and public-boundary gates; `scripts/gates.sh --db` adds the server database
suite on a throwaway PostgreSQL it creates and removes ([DEVELOPMENT.md](DEVELOPMENT.md#local-gates)).
A skipped database suite is not a pass. The native gate is separate:

Run the shared Swift suite with `swift test --package-path apps/ios`. Run the shipping
iOS app, widget, notification service, hosted tests, and independent reference host with:

```sh
bash scripts/test-ios.sh
```

The native gate requires a release (non-beta) Xcode 27 or newer, XcodeGen, and an installed iPhone simulator
runtime. It selects an installed Xcode explicitly. It creates and cleans up its own simulator unless
`RELO_SIMULATOR_UDID` names an existing one. `RELO_DERIVED_DATA` and
`RELO_RESULT_BUNDLE` can select persistent output locations. Results are retained for inspection.

All builds use `CODE_SIGNING_ALLOWED=NO`. The Debug simulator test executable receives
an embedded, test-only Keychain identity so the real Security API tests can run unsigned.
This is activated only by the native test command; ordinary app builds and hardware targets
do not receive that identity. Debug library splitting is disabled for this command so those
simulator entitlements live in the executable. No signing identity, provisioning profile,
physical phone installation, or distribution is performed.

Hosted test processes suppress automatic scene/delegate startup. Tests instantiate the
real AppModel with AppDependencies and controlled system closures. Normal Debug launches
and all Release launches retain the production startup behavior. The existing Core Keychain
tests also run inside this host; the gate does not skip their assertions.

## CLI tests are hermetic

`packages/cli` tests run with an empty temporary `HOME`, a temporary state folder and outbox, a
throwaway npm prefix and no inherited agent-session variables; `test/hermetic-env.mjs` applies this
whether the suite or a single file runs. The outbox flusher never starts in a test, update checks are
off, and the key store and harness credential paths point at files that do not exist. A test that
installs the CLI lands in the temporary prefix, never your global one. Queued writes name the server
they were queued for and are never sent to another, so a fixture cannot reach a real server.

## State-model invariants

These tests pin the three-source separation ([ARCHITECTURE.md](ARCHITECTURE.md#state-model)); a
change that lets one source write another's fields fails them.

- `apps/server/src/work-model-invariants.test.ts`: a second start never rewrites a running card, and
  a phone's key change never ends one ([ADR 0007](adr/0007-presence-messages-work-separation.md)).
- `apps/server/src/edge-invariants.test.ts`: the server never interprets raw harness activity;
  observed state is read only by its storage module and `derive()`; a harness credential is refused
  on every route but the observed one, and an ordinary credential cannot post observed state
  ([ADR 0008](adr/0008-relo-design-framework.md)).
- `packages/cli/test/harness-invariants.test.mjs`: adapters never reach the network, the core never
  branches on the adapter, no prompt, tool name, tool I/O or transcript path reaches the outbox or a
  hook file, and a hook returns at once with the network down.
- `scripts/check-owner-surfaces-display-only.mjs`: the Dashboard and the iOS app display derived
  state and keep no policy of their own.

## Latency evidence format

Run the report checks with `node --test scripts/relo-latency-report.test.mjs`. Report captured
newline-delimited JSON spans with `node scripts/relo-latency-report.mjs spans.jsonl`.
Each record has exactly these fields:

```json
{"stage":"commit_to_dispatch","scenario":"warm","sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","process":"worker-1","clock":"monotonic","outcome":"ok","startNs":"100000000000000000","endNs":"100000000012000000"}
```

This is an illustrative record, not a performance measurement. Start and end must come from
the same process's monotonic clock, in nanoseconds encoded as decimal strings. Supported
stages are `commit_to_dispatch`, `tap_to_request_start`, `decision_commit_to_wakeup`,
`nse_processing`, `api_to_ack`, and `foreground_hint_to_render`. Outcomes are `ok`, `failed`,
and `cancelled`. Use a distinct scenario for warm, cold, burst, blocked-provider, or device runs.

The report separates scenarios and source commits, includes failure/cancellation counts,
and reports nearest-rank p50/p95/p99 for successful measurements. Missing stages are explicit;
no samples never means zero latency. The report does not infer a passing product budget or
complete instrumentation coverage. Collectors must record their fixture, toolchain, and device
context alongside the report; exclude notification contents, tokens, URLs, and reply text.

Do not subtract phone and server wall-clock timestamps to claim an exact end-to-end latency.
Provider acceptance, phone presentation, and human response are separate observations.

## Account isolation

`apps/server/src/tenant-isolation.test.ts` enforces [ADR 0004](adr/0004-isolated-multi-user-accounts.md).
Account A calls every route with account B's identifiers, using A's CLI key, phone credential and
Dashboard session. A foreign identifier must answer exactly like a missing one, B's content must
never appear in A's responses, and none of B's rows may change. Every route must be classified;
a new route fails the suite until it is placed in the by-id attack, a body-id attack, an
own-account action, or the documented list of routes that take no owner identifier. Dashboard pages
must render for the check to mean anything, so build the Dashboard first
(`pnpm --filter @relo/dashboard build`); a page that errors fails the suite.
