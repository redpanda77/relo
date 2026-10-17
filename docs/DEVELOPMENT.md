# Developing Relo

## Requirements

- Node.js 22 or newer
- pnpm 11.20.0
- PostgreSQL for database integration tests (17 in the Compose test profile; `scripts/gates.sh --db`
  uses local binaries, Homebrew `postgresql@18` by default)
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

## Local gates

Verification runs on your own machine, not in a hosted pipeline. `scripts/gates.sh` runs every gate
and reports all of them at the end (it exits non-zero when any failed):

```sh
scripts/gates.sh                   # contracts, server typecheck, CLI, skill, Dashboard, owner-surface check, public:check
scripts/gates.sh --db              # the same, plus the server database suite
scripts/gates.sh --db --changed F  # only the gates the paths listed in file F need (scripts/select-gates.mjs)
scripts/gates.sh --db --all        # every gate, even with --changed
```

- Order: the contracts and Dashboard builds first (the other gates read them), then every other gate at
  once with each gate's output captured and printed in order, then the tests that wait on the wall clock
  (the Dashboard UI tests and the CLI hook-time budgets) alone, so a busy machine does not fail them.
- `--changed` maps each path to the gates whose tests read it (`scripts/select-gates.mjs`, tested by
  `scripts/select-gates.test.mjs`). A path no rule knows selects every gate; the owner-surface check,
  public:check and release state always run. The selection and each skipped gate are printed.

- `--db` creates a throwaway PostgreSQL cluster in a temporary directory, on a random loopback port
  with a C locale, runs the server suite against it, and removes it. It needs PostgreSQL binaries:
  set `PG_BIN_DIR` to their directory (default: Homebrew `postgresql@18`). It never touches an
  operator database. The suite runs its files in parallel: the Vitest global setup migrates the base
  database once, and each worker clones it (`CREATE DATABASE … TEMPLATE`) into its own
  `<base>_w<N>_test` database (`apps/server/src/test-support/worker-database.ts`).
- Any install step inside the gates runs with an isolated `HOME` and npm prefix, so a gate never
  changes your global npm, your installed `relo` or your credentials.
- `node scripts/check-owner-surfaces-display-only.mjs` fails when the Dashboard or the iOS app
  computes policy (timers, windows, phases) instead of displaying what `GET /api/now` derived.
- The iOS gate is separate: `bash scripts/test-ios.sh` ([TESTING.md](TESTING.md)).

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

A localhost database whose name ends in `_test` is used as a template: each worker gets its own clone,
so the role needs `CREATEDB`. Set `RELO_TEST_DB_PER_WORKER=0` to use the one database as it is (then
keep `--no-file-parallelism`, as `pnpm --filter @relo/server test` does).

Do not point tests at an operator database. Without `TEST_DATABASE_URL` the run says once that every database
suite is skipped; a skip is never a pass. `scripts/gates.sh --db` creates a disposable cluster, runs the suite and
then fails any test file that ran no tests (`scripts/check-test-ran.mjs`; a file that skips on purpose is listed
there with its reason). Gates without `--db` print "server DB suite NOT RUN". Releases run
`scripts/release/head-gates.sh`, which always uses `--db` on an archive of HEAD; a server deploy passes
`--since <live commit>`, so it runs only the gates the paths changed since the live release need.

## Several sessions, one checkout

Several agent sessions often work in this checkout at once, so a file can hold another session's edits next to
yours. Read the diff of every file you stage; a file another session is editing is staged by hunk or not at all.
Never stage a whole directory or `git add -A`. `scripts/stage-review.sh` prints exactly what the commit would
carry, flags a file that changed again after you staged it, and asks before continuing (`--yes` once you have
read it). Run `npm run public:check` after staging, since it reads the staged file list. Releases gate an archive
of HEAD (`scripts/release/head-gates.sh`), so nobody's uncommitted work reaches a release.

## The CLI while you develop

CLI tests are hermetic. `npm test` in `packages/cli` preloads `test/hermetic-env.mjs`, so a test
file run directly (`node --test test/x.test.mjs`) is as isolated as the suite: an empty temporary
`HOME`, a temporary state folder and outbox, a throwaway npm prefix, no inherited agent session
variables, no update check, no background outbox flusher, and no access to your key store or harness
credential. A test can therefore never queue a write to, or send anything to, a real server.
Every new test file imports that module first.

Do not `npm install --global ./packages/cli` or `npm link` the working tree for the CLI that your own
agents use: a linked install inherits every half-finished edit, and agent reporting breaks at random.
Install a snapshot of a clean commit instead:

```sh
git status --short packages/cli skills/relo-notifications   # must be empty
node scripts/release/build-cli-release.mjs                  # runs the CLI and skill checks, scans the package
npm install --global dist/release/<version>/relo-cli-<version>.tgz
```

The release script refuses an uncommitted `packages/cli` or skill, packs the CLI with its bundled
skill, writes `SHA256SUMS`, a manifest with the source commit, and an SBOM, and fails on a secret,
a private path or a license problem. `relo doctor` reports the installed version.

## iOS

```sh
cd apps/ios
swift test
xcodebuild -project Relo.xcodeproj -scheme Relo -sdk iphonesimulator build CODE_SIGNING_ALLOWED=NO
```

`bash scripts/test-ios.sh` runs the shipping app, widget, notification service extension, hosted
tests and reference host on a simulator it creates and removes ([TESTING.md](TESTING.md)). The user
owns signing, installation, and physical-device acceptance. Source changes must still keep the
package tests and unsigned project build green.

## Repository rules

- Add new product code under `apps/`, `packages/`, or `skills/`.
- Put maintained adopter/contributor documentation directly under `docs/`.
- Put research, operator topology, reports, and superseded plans under `docs/internal/`.
- Keep machine-local agent state in ignored `.claude/`, `.codex/`, or `.impeccable/` directories;
  never vendor global skill installations into product source.
- Run `pnpm public:check` before committing: it fails on maintainer-specific names, hosts and paths
  and on a missing required public document. Use neutral names in fixtures and examples
  (`relo.example.com`, "My workstation"). `pnpm public:report` lists what it finds.
- Published migrations remain ordered deployment records, not runtime compatibility contracts.
  A future schema consolidation will preserve the current contract without replaying development-only
  compatibility behavior.
- Keep [`ROADMAP.md`](../ROADMAP.md) as the single active plan.
