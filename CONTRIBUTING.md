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

Run `swift test` from `apps/ios` for shared native contracts and the unsigned Xcode build when iOS
source or project settings change. PostgreSQL integration tests require an isolated disposable
database through `TEST_DATABASE_URL`.

## Documentation

Update the closest maintained document. Keep superseded plans, reports, and implementation journals
out of the public tree; do not create another competing current-status document. The root roadmap is
the only active plan.

## Public source boundary

The future public source-available repository is produced from the explicit rules in
`public-export.json`, not
by copying the private working tree. Use `pnpm public:report` to see remaining blockers and
`pnpm public:check` as the eventual release gate. `pnpm public:export -- <new-directory>` refuses to
write anything until required public documents exist and maintainer-specific material is gone.
The repository and packaged Relo components use the PolyForm Noncommercial License 1.0.0. The
legacy `pnpm public:stage -- <new-directory>` path remains only for testing a deliberately
license-incomplete candidate; normal release work must use `public:check` and `public:export`.

The export never includes internal research, local agent hooks/skills, private operations, or this
repository's Git history.
