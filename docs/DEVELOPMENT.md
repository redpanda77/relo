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
in order and reports all of them at the end (it exits non-zero when any failed):

```sh
scripts/gates.sh          # contracts, server typecheck, CLI, skill, Dashboard, owner-surface check, public:check
scripts/gates.sh --db     # the same, plus the server database suite
```

- `--db` creates a throwaway PostgreSQL cluster in a temporary directory, on a random loopback port
  with a C locale, runs the server suite against it, and removes it. It needs PostgreSQL binaries:
  set `PG_BIN_DIR` to their directory (default: Homebrew `postgresql@18`). It never touches an
  operator database.
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

Do not point tests at an operator database. Missing database cases are reported as skipped and must
not be described as passing. `scripts/gates.sh --db` does this for you with a disposable cluster.

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
