#!/usr/bin/env bash
# Local gates (plan X.1/X.4): run on this Mac before committing; GitHub CI is not the gate.
#   scripts/gates.sh                    contracts, server typecheck, CLI, skill, dashboard, F.1, repository scripts,
#                                       public:check, release state
#   scripts/gates.sh --db               also the server DB suite against a throwaway Postgres it creates and removes
#   scripts/gates.sh --changed <file>   only the gates the listed paths need (scripts/select-gates.mjs), and inside the
#                                       server and dashboard suites only the tests they reach (narrow-tests.mjs); F.1,
#                                       public:check and release state always run
#   scripts/gates.sh --all              every gate, even with --changed
# Order: the contracts and dashboard builds first (the others read them); then every other gate at once, the DB
# suite included, output captured per gate and printed in order; then the tests that wait on the wall clock
# (dashboard UI tests, CLI hook-time budgets) alone.
# The DB suite gives each Vitest worker its own database cloned from one migrated template
# (apps/server/src/test-support/worker-database.ts), so its files run in parallel.
# Any install step runs with an isolated HOME and npm prefix, so a gate never touches the owner's
# global npm, linked CLI or credentials. Exit status is non-zero when any gate fails; all selected gates run.
# Resources (plan 15): every gate is a bounded step (scripts/step.mjs: a budget, a no-output timeout, no stdin);
# at most RELO_GATES_PARALLEL gates run at once (default 3) and the DB suite uses RELO_GATES_DB_WORKERS Vitest
# workers (default 4), so the gates never take every core. head-gates.sh runs this whole script in the one heavy
# slot at background priority.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_DB=0; ALL=0; CHANGED=""; RAN_FILE=""; KEYS_FILE=""; PASSED_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) WITH_DB=1 ;;
    --all) ALL=1 ;;
    --changed) CHANGED="${2:?--changed needs a file listing changed paths}"; shift ;;
    --ran-file) RAN_FILE="${2:?--ran-file needs a path}"; shift ;;
    --keys) KEYS_FILE="${2:?--keys needs a file of group key lines}"; shift ;;
    --passed) PASSED_FILE="${2:?--passed needs a path}"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# Stale build output goes first; gates need room for their builds and the throwaway Postgres.
bash "$ROOT/scripts/clean-builds.sh" --quiet --min-free 10 || exit 1
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/relo-gates.XXXXXX")" && pwd -P)"
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
export ROOT SCRATCH PG_BIN PG_DATA   # bounded steps run shell functions in a child bash
# Gate logs outlive the run (a stopped run's cleanup must not take the evidence with it): the last 10 runs are kept.
LOGS_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/relo/gates"
LOGS="$LOGS_ROOT/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$LOGS"
ls -1dt "$LOGS_ROOT"/*/ 2>/dev/null | tail -n +11 | while read -r old; do rm -rf "$old"; done
echo "gates: logs in $LOGS"

# ---- selection --------------------------------------------------------------------------------------------
SELECTED="contracts dashboard server cli skill repo"
NARROW_SERVER=all; NARROW_DASHBOARD=all
if [[ -n "$CHANGED" && "$ALL" != 1 ]]; then
  printf '\n== gate selection (%s changed paths)\n' "$(grep -c . "$CHANGED" || true)"
  SELECTION="$(node "$ROOT/scripts/select-gates.mjs" "$CHANGED")" || { echo "gate selection failed" >&2; exit 1; }
  # Fail closed: without its "gates:" line the selection said nothing, and nothing is not "skip everything".
  [[ "$(echo "$SELECTION" | head -1)" == "gates:"* ]] || { echo "gate selection printed no gates: line" >&2; exit 1; }
  SELECTED="$(echo "$SELECTION" | head -1)"; SELECTED="${SELECTED#gates:}"
  echo "$SELECTION" | tail -n +2
  echo "  always F.1, public:check, release state"
  # Inside a selected suite, only the test files the changed modules reach (scripts/narrow-tests.mjs); "all" otherwise.
  for suite in server dashboard; do
    narrowed="$(node "$ROOT/scripts/narrow-tests.mjs" "$suite" "$CHANGED" "$ROOT")" || narrowed=all
    [[ "$narrowed" == all || "$narrowed" == "related "* ]] || narrowed=all
    # The safety net for selection: a suite that has not run whole for a day runs whole (its "full-<suite> <epoch>"
    # line in the pass record). Only a run that selects the suite pays it; a run that does not select it skips it.
    last_full="$(grep "^full-$suite " "${PASSED_FILE:-/dev/null}" 2>/dev/null | tail -1 | cut -d' ' -f2)"
    stale=""; (( $(date +%s) - ${last_full:-0} > 86400 )) && stale=1
    [[ -n "$stale" ]] && narrowed=all
    if [[ "$suite" == server ]]; then NARROW_SERVER="$narrowed"; else NARROW_DASHBOARD="$narrowed"; fi
    [[ " $SELECTED " == *" $suite "* ]] || continue
    if [[ "$narrowed" == all && -n "$stale" ]]; then echo "  $suite tests: the whole suite (its daily full run)"
    elif [[ "$narrowed" == all ]]; then echo "  $suite tests: the whole suite"
    else echo "  $suite tests: $(($(wc -w <<<"$narrowed") - 1)) related paths (changed modules and the tests that read files)"; fi
  done
elif [[ "$ALL" == 1 ]]; then
  printf '\n== gate selection\n  every gate (--all)\n'
fi
# Pass cache (needs --keys and --passed): a group that already passed on identical inputs is not run again.
CACHED=""
# shellcheck source=scripts/gates-cache.sh
source "$ROOT/scripts/gates-cache.sh"
if [[ -n "$KEYS_FILE" && -n "$PASSED_FILE" ]]; then
  cache_apply "$KEYS_FILE" "$PASSED_FILE"
  [[ -z "$CACHED" ]] || echo "  passed before on identical inputs, not run again: $CACHED"
fi
wants() { [[ " $SELECTED " == *" $1 "* ]]; }

# Isolated environment for install steps only (tests keep the real PATH and toolchain).
iso() {
  mkdir -p "$SCRATCH/home" "$SCRATCH/npm-prefix" "$SCRATCH/npm-cache"
  HOME="$SCRATCH/home" NPM_CONFIG_PREFIX="$SCRATCH/npm-prefix" npm_config_cache="$SCRATCH/npm-cache" \
    PNPM_HOME="$SCRATCH/pnpm-home" XDG_CONFIG_HOME="$SCRATCH/home/.config" "$@"
}
export -f iso

FAILED=(); PASSED=(); SKIPPED=()
GATE_BUDGET="${RELO_GATE_BUDGET:-10m}"; GATE_QUIET="${RELO_GATE_QUIET:-5m}"
PARALLEL="${RELO_GATES_PARALLEL:-3}"
# A shell function (db_suite, iso) runs in a child bash, which gets it and the variables it reads exported.
bounded() {
  local name="$1"; shift
  if declare -F "$1" >/dev/null; then set -- bash -c '"$@"' bash "$@"; fi
  node "$ROOT/scripts/step.mjs" --name "$name" --timeout "$GATE_BUDGET" --quiet "$GATE_QUIET" -- "$@"
}
# A gate in the foreground: output streams as it runs.
gate() {
  local name="$1"; shift
  printf '\n== %s\n' "$name"
  local started=$SECONDS
  if (cd "$ROOT" && bounded "$name" "$@"); then PASSED+=("$name ($((SECONDS - started))s)"); else FAILED+=("$name"); fi
}
# Gates in the background: each writes its own log and exit status; finish_parallel prints them in start order.
P_NAMES=(); P_PIDS=(); P_N=0
start_gate() {
  local name="$1"; shift
  local n=$P_N; P_N=$((P_N + 1))
  # At most $PARALLEL at once: wait for the one started $PARALLEL gates ago (they finish roughly in order).
  if (( n >= PARALLEL )); then wait "${P_PIDS[$((n - PARALLEL))]}" 2>/dev/null || true; fi
  echo "$name" > "$LOGS/gate-$n.name"; date +%s > "$LOGS/gate-$n.started"
  (
    started=$SECONDS
    cd "$ROOT" && bounded "$name" "$@" > "$LOGS/gate-$n.log" 2>&1
    code=$?
    echo "$code $((SECONDS - started))" > "$LOGS/gate-$n.status"
    echo "gates: $name $([[ $code == 0 ]] && echo passed || echo FAILED) in $((SECONDS - started))s"
  ) &
  P_NAMES+=("$name"); P_PIDS+=($!)
}
finish_parallel() {
  local i code seconds
  for ((i = 0; i < P_N; i++)); do
    wait "${P_PIDS[$i]}" 2>/dev/null
    printf '\n== %s\n' "${P_NAMES[$i]}"
    cat "$LOGS/gate-$i.log" 2>/dev/null
    read -r code seconds < "$LOGS/gate-$i.status" 2>/dev/null || { code=1; seconds=0; }
    if [[ "$code" == 0 ]]; then PASSED+=("${P_NAMES[$i]} (${seconds}s)"); else FAILED+=("${P_NAMES[$i]}"); fi
  done
  P_NAMES=(); P_PIDS=(); P_N=0
}
skip() {
  if [[ -n "${2:-}" && " $CACHED " == *" $2 "* ]]; then SKIPPED+=("$1 (passed before on identical inputs)")
  else SKIPPED+=("$1 (not selected: no changed path it covers)"); fi
}

# Only a run with a gate group needs the workspace installed: the always-run checks use node alone.
if [[ -n "${SELECTED// /}" && ! -d "$ROOT/node_modules" ]]; then
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
  local mode=(run)
  [[ "$NARROW_SERVER" == "related "* ]] && { read -ra mode <<<"$NARROW_SERVER"; mode+=(--run); }
  TEST_DATABASE_URL="postgresql://relo_test@127.0.0.1:$port/relo_gates_test" \
    pnpm --filter ./apps/server exec vitest "${mode[@]}" --maxWorkers="${RELO_GATES_DB_WORKERS:-4}" --testTimeout=30000 --reporter=default --reporter=json --outputFile.json="$SCRATCH/server-tests.json" \
    || return 1
  node scripts/check-test-ran.mjs "$SCRATCH/server-tests.json" "$ROOT"
}

export -f db_suite
export NARROW_SERVER

# ---- 1. builds the other gates read -----------------------------------------------------------------------
if wants contracts || wants dashboard || wants server; then
  gate "contracts build"      pnpm --filter @relo/notification-contracts build
  gate "dashboard build"      pnpm --filter @relo/dashboard build
else
  skip "contracts build"; skip "dashboard build"
fi

# ---- 2. everything else at once ---------------------------------------------------------------------------
printf '\n== running the remaining gates in parallel (output follows in order)\n'
# A line a minute naming what still runs: the run is never silent while gates work (the caller's no-output
# timeout is for hangs), and a slow gate is visible as it happens.
# The sleep holds no output pipe: killed with the loop, a sleep still holding stdout kept the caller (step.mjs, which
# waits for the output to close) waiting out its minute after the gates finished (60 s of a 61 s notch release, 22 Oct).
(
  while sleep 60 >/dev/null 2>&1; do
    now=$(date +%s); running=""
    for started in "$LOGS"/gate-*.started; do
      [[ -e "$started" ]] || continue
      n="${started%.started}"; [[ -e "$n.status" ]] && continue
      running+="$(cat "$n.name") $((now - $(cat "$started")))s, "
    done
    [[ -n "$running" ]] && echo "gates: still running: ${running%, }"
  done
) &
HEARTBEAT=$!
if wants contracts; then start_gate "contracts tests" pnpm --filter @relo/notification-contracts test; else skip "contracts tests" contracts; fi
# vitest and tsc directly: the package's pre-scripts would rebuild contracts under the gates running beside it.
if wants contracts; then start_gate "owner-client typecheck" pnpm --filter @relo/owner-client exec tsc -p tsconfig.json --noEmit; else skip "owner-client typecheck" contracts; fi
if wants contracts; then start_gate "owner-client tests" pnpm --filter @relo/owner-client exec vitest run; else skip "owner-client tests" contracts; fi
# tsc directly: the package's typecheck script would rebuild contracts and the dashboard (pre-scripts) under
# the gates running beside it.
if wants server; then start_gate "server typecheck" pnpm --filter ./apps/server exec tsc -p tsconfig.json --noEmit; else skip "server typecheck" server; fi
if wants cli; then start_gate "CLI tests" bash -c 'cd packages/cli && RELO_GATES_DEFER_TIMING=1 npm test --silent'; else skip "CLI tests" cli; fi
if wants skill; then
  start_gate "skill validation" bash -c 'cd skills/relo-notifications && node scripts/validate-skill.mjs && node --test tests/*.test.mjs'
else skip "skill validation" skill; fi
if wants dashboard; then
  # Source-exported (no build): its tests and types run beside the Dashboard's, which import it.
  start_gate "owner-crypto tests" pnpm --filter @relo/owner-crypto test
  start_gate "owner-crypto typecheck" pnpm --filter @relo/owner-crypto typecheck
else skip "owner-crypto tests" dashboard; fi
start_gate "owner surfaces display-only (F.1)" node scripts/check-owner-surfaces-display-only.mjs
if wants repo; then
  start_gate "repository scripts" node --test scripts/step.test.mjs scripts/load-audit.test.mjs scripts/sim.test.mjs scripts/entrypoints.test.mjs scripts/check-changed.test.mjs scripts/public-export.test.mjs scripts/check-test-ran.test.mjs \
    scripts/select-gates.test.mjs scripts/narrow-tests.test.mjs scripts/gate-keys.test.mjs scripts/gates-cache.test.mjs scripts/release/build-cli-release.test.mjs scripts/release/sparkle-key.test.mjs
else skip "repository scripts" repo; fi
start_gate "public:check" npm run --silent public:check
if [[ -f docs/internal/operations/release/validate-release-state.mjs ]]; then
  start_gate "release state" bash -c 'node --test docs/internal/operations/release/validate-release-state.test.mjs && node docs/internal/operations/release/validate-release-state.mjs ${RELO_RELEASING:+--releasing}'
else skip "release state"; fi
if [[ "$WITH_DB" == 1 ]]; then
  if wants server; then start_gate "server DB suite (throwaway Postgres)" db_suite; else skip "server DB suite" server; fi
fi
finish_parallel
kill "$HEARTBEAT" 2>/dev/null; wait "$HEARTBEAT" 2>/dev/null

if [[ "$WITH_DB" != 1 ]]; then
  printf '\n== server DB suite\n  NOT RUN: pass --db (a skipped suite is not a pass)\n'
fi

# ---- 3. tests that wait on the wall clock, alone: the parallel gates (the DB suite uses every core) would starve
# the dashboard's UI waits and the CLI's hook-time budgets into false failures.
if wants dashboard && [[ "$NARROW_DASHBOARD" == "related "* ]]; then
  read -ra related <<<"$NARROW_DASHBOARD"
  gate "dashboard tests (alone)" pnpm --filter @relo/dashboard exec vitest "${related[@]}" --run
elif wants dashboard; then gate "dashboard tests (alone)" pnpm --filter @relo/dashboard test; else skip "dashboard tests" dashboard; fi
# Wall-clock budgets measure the machine the hooks run on, the owner's Mac: elsewhere (the Linux builder) they are
# skipped, and `pnpm check:changed` measures them on the Mac when hook code changes.
if wants cli && [[ "$(uname -s)" != Darwin ]]; then
  SKIPPED+=("CLI wall-clock budgets (measured on the Mac by check:changed, not on $(uname -s))")
elif wants cli; then
  gate "CLI wall-clock budgets (alone)" bash -c 'cd packages/cli && node --import ./test/hermetic-env.mjs --test \
    --test-name-pattern="costs at most 20 ms|p95 under 50 ms" test/startup-budget.test.mjs test/harness-invariants.test.mjs'
fi

printf '\n== summary\n'
for p in "${PASSED[@]+"${PASSED[@]}"}"; do echo "  pass  $p"; done
for s in "${SKIPPED[@]+"${SKIPPED[@]}"}"; do echo "  skip  $s"; done
for f in "${FAILED[@]+"${FAILED[@]}"}"; do echo "  FAIL  $f"; done
# Proof the gates ran (head-gates.sh accepts a pass only with it): how many passed, failed and were skipped.
[[ -z "$RAN_FILE" ]] || echo "gates ran: ${#PASSED[@]} passed, ${#FAILED[@]} failed, ${#SKIPPED[@]} skipped" > "$RAN_FILE"
[[ -z "$KEYS_FILE" || -z "$PASSED_FILE" ]] || cache_record "$KEYS_FILE" "$PASSED_FILE" "${FAILED[@]+"${FAILED[@]}"}"
# A suite that ran whole and passed starts its day again (the daily full run above).
if [[ -n "$PASSED_FILE" ]]; then
  passed_whole() { [[ " ${PASSED[*]+"${PASSED[*]}"} " == *" $1"* ]]; }
  [[ "$NARROW_SERVER" == all && "$WITH_DB" == 1 ]] && wants server && passed_whole "server DB suite" && echo "full-server $(date +%s)" >> "$PASSED_FILE"
  [[ "$NARROW_DASHBOARD" == all ]] && wants dashboard && passed_whole "dashboard tests" && echo "full-dashboard $(date +%s)" >> "$PASSED_FILE"
fi
[[ ${#FAILED[@]} -eq 0 ]]
