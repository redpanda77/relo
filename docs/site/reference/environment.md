---
title: Environment variables
nav: Environment
summary: Every variable the relo CLI reads, for CI, containers, other harnesses and other locations.
---

The CLI works without any of these: `relo auth login` stores the server and credential in the
config file, and the source, project, computer and account are detected. Set a variable when the
default does not fit: `RELO_TOKEN` and `RELO_API_URL` in CI and containers, `RELO_SOURCE` and
`RELO_SESSION` for a harness Relo does not detect, `RELO_PROFILE` for a second login. Never put a
token on the command line; there are no token flags.

## Variables

{{environment}}

## In CI

```sh title="CI job"
# RELO_API_URL and RELO_TOKEN come from the pipeline's secret store
relo work start --producer nightly-import --goal "Import yesterday's orders" --idempotency-key "import-$RUN_ID"
```

Where each file lives by default: [Files and folders](/docs/reference/files).
