#!/usr/bin/env bash
# Local gates (plan X.1/X.4): run on this Mac before committing; GitHub CI is not the gate.
#   scripts/gates.sh                    contracts, server typecheck, CLI, skill, dashboard, F.1, repository scripts,
#                                       public:check, release state
#   scripts/gates.sh --db               also the server DB suite against a throwaway Postgres it creates and removes
#   scripts/gates.sh --changed <file>   only the gates the listed paths need (scripts/select-gates.mjs); F.1,
#                                       public:check and release state always run
#   scripts/gates.sh --all              every gate, even with --changed
# Order: the contracts and dashboard builds first (the others read them); then every other gate at once, the DB
# suite included, output captured per gate and printed in order; then the tests that wait on the wall clock
# (dashboard UI tests, CLI hook-time budgets) alone.
# The DB suite gives each Vitest worker its own database cloned from one migrated template
# (apps/server/src/test-support/worker-database.ts), so its files run in parallel.
# Any install step runs with an isolated HOME and npm prefix, so a gate never touches the owner's
# global npm, linked CLI or credentials. Exit status is non-zero when any gate fails; all selected gates run.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_DB=0; ALL=0; CHANGED=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) WITH_DB=1 ;;
    --all) ALL=1 ;;
    --changed) CHANGED="${2:?--changed needs a file listing changed paths}"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/relo-gates.XXXXXX")"
PG_BIN="${PG_BIN_DIR:-/opt/homebrew/opt/postgresql@18/bin}"
PG_DATA="$SCRATCH/pg"   # gates run in subshells, so the path is fixed here for cleanup
cleanup() {
  local pids; pids="$(jobs -p)"; [[ -n "$pids" ]] && kill $pids 2>/dev/null
  if [[ -f "$PG_DATA/postmaster.pid" ]]; then
    LANG=C LC_ALL=C "$PG_BIN/pg_ctl" -D "$PG_DATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

# ---- selection --------------------------------------------------------------------------------------------
SELECTED="contracts dashboard server cli skill repo"
if [[ -n "$CHANGED" && "$ALL" != 1 ]]; then
  printf '\n== gate selection (%s changed paths)\n' "$(grep -c . "$CHANGED" || true)"
  SELECTION="$(node "$ROOT/scripts/select-gates.mjs" "$CHANGED")" || { echo "gate selection failed" >&2; exit 1; }
  # Fail closed: without its "gates:" line the selection said nothing, and nothing is not "skip everything".
  [[ "$(echo "$SELECTION" | head -1)" == "gates:"* ]] || { echo "gate selection printed no gates: line" >&2; exit 1; }
  SELECTED="$(echo "$SELECTION" | head -1)"; SELECTED="${SELECTED#gates:}"
  echo "$SELECTION" | tail -n +2
  echo "  always F.1, public:check, release state"
elif [[ "$ALL" == 1 ]]; then
  printf '\n== gate selection\n  every gate (--all)\n'
fi
wants() { [[ " $SELECTED " == *" $1 "* ]]; }

# Isolated environment for install steps only (tests keep the real PATH and toolchain).
iso() {
  mkdir -p "$SCRATCH/home" "$SCRATCH/npm-prefix" "$SCRATCH/npm-cache"
  HOME="$SCRATCH/home" NPM_CONFIG_PREFIX="$SCRATCH/npm-prefix" npm_config_cache="$SCRATCH/npm-cache" \
    PNPM_HOME="$SCRATCH/pnpm-home" XDG_CONFIG_HOME="$SCRATCH/home/.config" "$@"
}

FAILED=(); PASSED=(); SKIPPED=()
# A gate in the foreground: output streams as it runs.
gate() {
  local name="$1"; shift
  printf '\n== %s\n' "$name"
  local started=$SECONDS
  if (cd "$ROOT" && "$@"); then PASSED+=("$name ($((SECONDS - started))s)"); else FAILED+=("$name"); fi
}
# Gates in the background: each writes its own log and exit status; finish_parallel prints them in start order.
P_NAMES=(); P_PIDS=(); P_N=0
start_gate() {
  local name="$1"; shift
  local n=$P_N; P_N=$((P_N + 1))
  (
    started=$SECONDS
    cd "$ROOT" && "$@" > "$SCRATCH/gate-$n.log" 2>&1
    code=$?
    echo "$code $((SECONDS - started))" > "$SCRATCH/gate-$n.status"
  ) &
  P_NAMES+=("$name"); P_PIDS+=($!)
}
finish_parallel() {
  local i code seconds
  for ((i = 0; i < P_N; i++)); do
    wait "${P_PIDS[$i]}" 2>/dev/null
    printf '\n== %s\n' "${P_NAMES[$i]}"
    cat "$SCRATCH/gate-$i.log" 2>/dev/null
    read -r code seconds < "$SCRATCH/gate-$i.status" 2>/dev/null || { code=1; seconds=0; }
    if [[ "$code" == 0 ]]; then PASSED+=("${P_NAMES[$i]} (${seconds}s)"); else FAILED+=("${P_NAMES[$i]}"); fi
  done
  P_NAMES=(); P_PIDS=(); P_N=0
}
skip() { SKIPPED+=("$1 (not selected: no changed path it covers)"); }

if [[ ! -d "$ROOT/node_modules" ]]; then
  gate "install (isolated)" iso pnpm install --frozen-lockfile
fi

# ---- the server DB suite ----------------------------------------------------------------------------------
db_suite() {
  [[ -x "$PG_BIN/initdb" ]] || { echo "no Postgres binaries at $PG_BIN (set PG_BIN_DIR)"; return 1; }
  local port
  for _ in $(seq 1 20); do
    port=$((20000 + RANDOM % 20000))
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || break
  done
  LANG=C LC_ALL=C "$PG_BIN/initdb" -D "$PG_DATA" --no-locale -E UTF8 -U relo_test --auth=trust >/dev/null || return 1
  # A throwaway cluster: no durability needed, and room for one pool per parallel worker.
  LANG=C LC_ALL=C "$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$SCRATCH/pg.log" \
    -o "-p $port -k '' -c max_connections=500 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" -w start >/dev/null \
    || { cat "$SCRATCH/pg.log"; return 1; }
  "$PG_BIN/createdb" -h 127.0.0.1 -p "$port" -U relo_test relo_gates_test || return 1
  # relo_gates_test is the migrated template; each worker runs on relo_gates_w<N>_test (worker-database.ts).
  # The longer per-test timeout is a hang guard sized for every core busy, not a time budget.
  TEST_DATABASE_URL="postgresql://relo_test@127.0.0.1:$port/relo_gates_test" \
    pnpm --filter ./apps/server exec vitest run --testTimeout=30000 --reporter=default --reporter=json --outputFile.json="$SCRATCH/server-tests.json" \
    || return 1
  node scripts/check-test-ran.mjs "$SCRATCH/server-tests.json" "$ROOT"
}

# ---- 1. builds the other gates read -----------------------------------------------------------------------
if wants contracts || wants dashboard || wants server; then
  gate "contracts build"      pnpm --filter @relo/notification-contracts build
  gate "dashboard build"      pnpm --filter @relo/dashboard build
else
  skip "contracts build"; skip "dashboard build"
fi

# ---- 2. everything else at once ---------------------------------------------------------------------------
printf '\n== running the remaining gates in parallel (output follows in order)\n'
if wants contracts; then start_gate "contracts tests" pnpm --filter @relo/notification-contracts test; else skip "contracts tests"; fi
# tsc directly: the package's typecheck script would rebuild contracts and the dashboard (pre-scripts) under
# the gates running beside it.
if wants server; then start_gate "server typecheck" pnpm --filter ./apps/server exec tsc -p tsconfig.json --noEmit; else skip "server typecheck"; fi
if wants cli; then start_gate "CLI tests" bash -c 'cd packages/cli && RELO_GATES_DEFER_TIMING=1 npm test --silent'; else skip "CLI tests"; fi
if wants skill; then
  start_gate "skill validation" bash -c 'cd skills/relo-notifications && node scripts/validate-skill.mjs && node --test tests/*.test.mjs'
else skip "skill validation"; fi
start_gate "owner surfaces display-only (F.1)" node scripts/check-owner-surfaces-display-only.mjs
if wants repo; then
  start_gate "repository scripts" node --test scripts/public-export.test.mjs scripts/check-test-ran.test.mjs \
    scripts/select-gates.test.mjs scripts/release/build-cli-release.test.mjs
else skip "repository scripts"; fi
start_gate "public:check" npm run --silent public:check
start_gate "release state" bash -c 'node --test docs/internal/operations/release/validate-release-state.test.mjs && node docs/internal/operations/release/validate-release-state.mjs ${RELO_RELEASING:+--releasing}'
if [[ "$WITH_DB" == 1 ]]; then
  if wants server; then start_gate "server DB suite (throwaway Postgres)" db_suite; else skip "server DB suite"; fi
fi
finish_parallel

if [[ "$WITH_DB" != 1 ]]; then
  printf '\n== server DB suite\n  NOT RUN: pass --db (a skipped suite is not a pass)\n'
fi

# ---- 3. tests that wait on the wall clock, alone: the parallel gates (the DB suite uses every core) would starve
# the dashboard's UI waits and the CLI's hook-time budgets into false failures.
if wants dashboard; then gate "dashboard tests (alone)" pnpm --filter @relo/dashboard test; else skip "dashboard tests"; fi
if wants cli; then
  gate "CLI wall-clock budgets (alone)" bash -c 'cd packages/cli && node --import ./test/hermetic-env.mjs --test \
    --test-name-pattern="costs at most 20 ms|p95 under 50 ms" test/startup-budget.test.mjs test/harness-invariants.test.mjs'
fi

printf '\n== summary\n'
for p in "${PASSED[@]+"${PASSED[@]}"}"; do echo "  pass  $p"; done
for s in "${SKIPPED[@]+"${SKIPPED[@]}"}"; do echo "  skip  $s"; done
for f in "${FAILED[@]+"${FAILED[@]}"}"; do echo "  FAIL  $f"; done
[[ ${#FAILED[@]} -eq 0 ]]
