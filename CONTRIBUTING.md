# Contributing to Relo

Start with [`ROADMAP.md`](ROADMAP.md), then read the closest maintained guide in [`docs/`](docs/).
Historical plans and private operator material are not part of the public project requirements.
Machine-local agent configuration belongs outside Git. The repository ignores `.claude/`, `.codex/`,
and `.impeccable/`; the maintained product skill lives only in `skills/relo-notifications/`.

## Working agreement

- Preserve unrelated work in a dirty tree.
- Make the smallest coherent change and test it at the layer where behavior changed.
- Keep authentication, account/device targeting, idempotency, transactional outbox behavior, and
  first-valid-response semantics explicit.
- Do not treat API commit, queued delivery, or APNs acceptance as an iPhone receipt.
- Do not edit applied migration history. Add a migration or preserve a compatibility identifier.
- iOS source may be built and tested locally; signing and device installation remain user-owned.
- Deploy meaningful non-iOS runtime changes only after the relevant gates pass.

## Baseline checks

```sh
npm install --global pnpm@11.20.0
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

`scripts/gates.sh` runs these and the other local gates in one go; `scripts/gates.sh --db` adds the
server database suite on a throwaway PostgreSQL. Run `bash scripts/test-ios.sh` when iOS source or
project settings change. PostgreSQL integration tests otherwise require an isolated disposable
database through `TEST_DATABASE_URL`. See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) and
[`docs/TESTING.md`](docs/TESTING.md).

## State model

Relo state has three sources: what a producer declares, what hooks observe, and what the server
derives. Each writes only its own fields, and a change that lets one write another's is rejected
in review. Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#state-model) and
[ADR 0007](docs/adr/0007-presence-messages-work-separation.md) and
[ADR 0008](docs/adr/0008-relo-design-framework.md) before changing work, plans, sessions, cards or
hooks.

## Documentation

Update the closest maintained document. Product copy, the landing page and the docs follow
[`docs/VALUE-PROPOSITION.md`](docs/VALUE-PROPOSITION.md): lead with why the owner should care. Keep superseded plans, reports, and implementation journals
out of the public tree; do not create another competing current-status document. The root roadmap is
the only active plan.

## Public source boundary

The public source-available repository is produced from the explicit rules in `public-export.json`,
not by copying the private working tree. Run `pnpm public:check` before committing: it fails on
maintainer-specific names, hosts and paths and on a missing required public document. Use neutral
names in fixtures and examples (`relo.example.com`). `pnpm public:report` lists what it finds, and
`pnpm public:export -- <new-directory>` refuses to write while either problem remains.
The repository and packaged Relo components use the PolyForm Noncommercial License 1.0.0.
`pnpm public:stage -- <new-directory>` exists only for testing a deliberately license-incomplete
candidate; release work uses `public:check` and `public:export`.

The export never includes internal research, local agent hooks/skills, private operations, or this
repository's Git history.
