# Reproducible local latency baseline

Run from a clean committed checkout, after installing workspace dependencies and migrating a disposable local PostgreSQL database. Use Node 22 and release Xcode 27. Choose an available iPhone simulator; this never installs on a physical phone or signs an app.

```sh
TEST_DATABASE_URL=postgresql://relo_test@127.0.0.1:55439/relo_frame_final_test \
RELO_SIMULATOR_UDID=<installed-simulator-udid> \
bash scripts/benchmark-latency.sh
```

The runner refuses dirty source identities and non-local databases. Database names must end in `_test`. Do not run alongside database test suites, a worker, or another benchmark: they share fixture tables and process resources. It creates and removes only its own fixture principals; it never truncates tables or sends APNs. The output directory is new by default. `RELO_BENCHMARK_OUTPUT_DIR` and `RELO_DERIVED_DATA` may point to dedicated scratch directories. Preserve the result bundle, identity, raw spans and logs with the report.

| Stage | Actual measured boundary | Exclusions |
| --- | --- | --- |
| Commit to dispatch, 100 samples | Immediately before the enqueue COMMIT is submitted through the real PostgreSQL claim/LISTEN/dispatcher path, until injected provider dispatch begins, with one older provider held indefinitely | APNs preparation, provider network and phone |
| Decision commit to requester, 100 samples | Immediately before decision COMMIT through the real trigger, PostgreSQL listener, authenticated HTTP wait handler, authoritative reread and response decoding | External HTTP network; decision validation preceding COMMIT |
| Tap to request start, 100 warm samples | `AppModel.respond` entry through the shipping protected cross-process response file to the injected mobile API call | URLSession, server and radio; this is the app submission boundary |
| Tap behind unavailable older response, 20 samples | Same app path with an older failing queue entry | Missing request starts are failed samples, not zero-latency successes |
| Extension text, 100 samples | Shipping extension orchestrator start through real mutable content copying to content-handler invocation | OS launch/scheduling before entry; receipts and platform donation service |
| Extension suspended donation, 20 samples | Same handler boundary with an indefinitely suspended donation and the real 150 ms timeout | Physical-phone scheduling; real timers can execute after their deadline |

Each span uses one process's monotonic clock. The two COMMIT spans deliberately start before COMMIT submission, producing a conservative bound including the commit round trip. A worker/listener can observe a committed transaction before the issuing connection receives COMMIT's response; post-response subtraction would lose that interval or become negative. Database `created_at` is never relabeled as an exact commit timestamp.

The JSON report separates p50/p95/p99/max for successful samples from failed/cancelled counts and missing stages. Failed samples have no successful duration. Native samples are exported as two XCTest attachments. The collector rejects mixed source identities and missing native attachments. No sample includes content, tokens, reply text, personal identifiers, or server URLs.

This baseline measures current behavior, including known failures. The integrated gate, `bash scripts/benchmark-integrated.sh`, runs this baseline plus API-arrival-to-acknowledgement, cold/warm/burst current paint, blocked-provider and offline fixtures. It requires a clean commit, a fresh `RELO_INTEGRATED_OUTPUT_DIR`, a configured `RELO_DERIVED_DATA`, `RELO_SIMULATOR_UDID`, and a migrated `_test` database, and it rejects missing spans and failed budgets. The p95 budgets are: commit-to-dispatch, decision-commit-to-requester and tap-to-request under 100 ms; API-arrival-to-acknowledgement under 200 ms; foreground hint-to-render under 250 ms plus measured query RTT; extension text completion under 150 ms. Simulator results never prove background iPhone timing; physical-phone measurements remain a separate acceptance step. The normal unsigned shipping gate remains `bash scripts/test-ios.sh`; opt-in benchmark tests skip unless the dedicated runner provides their source identity.
