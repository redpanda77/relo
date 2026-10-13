# Developing Relo

## Requirements

- Node.js 22 or newer
- pnpm 11.20.0
- PostgreSQL 16 for database integration tests
- Xcode 27 for the full iOS project; Swift Package Manager is enough for shared Swift tests

Install the repository's pinned pnpm directly. Do not rely on the Corepack version bundled with an
older Node 22 release; older Corepack signing keys can reject current pnpm packages.

```sh
npm install --global pnpm@11.20.0
```

## Install and verify

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Useful focused commands:

```sh
pnpm --filter @relo/server test
pnpm --filter @relo/dashboard test
pnpm --filter @relo/cli test
npm --prefix skills/relo-notifications test
```

For PostgreSQL integration tests, create a disposable database and export its URL only for the test
process:

```sh
TEST_DATABASE_URL=postgresql://user:password@localhost:5432/relo_test pnpm --filter @relo/server test
```

Do not point tests at an operator database. Missing database cases are reported as skipped and must
not be described as passing.

## iOS

```sh
cd apps/ios
swift test
xcodebuild -project Relo.xcodeproj -scheme Relo -sdk iphonesimulator build CODE_SIGNING_ALLOWED=NO
```

The user owns signing, installation, and physical-device acceptance. Source changes must still keep
the package tests and unsigned project build green.

## Repository rules

- Add new product code under `apps/`, `packages/`, or `skills/`.
- Put maintained adopter/contributor documentation directly under `docs/`.
- Put research, operator topology, reports, and superseded plans under `docs/internal/`.
- Keep machine-local agent state in ignored `.claude/`, `.codex/`, or `.impeccable/` directories;
  never vendor global skill installations into product source.
- Run `pnpm public:report` while preparing the public tree. The stricter `pnpm public:check` remains
  red until every reported adoption blocker and required public document is resolved.
- Published migrations remain ordered deployment records, not runtime compatibility contracts.
  A future schema consolidation will preserve the current contract without replaying development-only
  compatibility behavior.
- Keep [`ROADMAP.md`](../ROADMAP.md) as the single active plan.
