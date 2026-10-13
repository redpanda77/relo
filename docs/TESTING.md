# Test gates

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
