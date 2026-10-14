#!/usr/bin/env bash
# Local gates (plan X.1/X.4): run on this Mac before committing; GitHub CI is not the gate.
#   scripts/gates.sh            contracts, server typecheck, CLI, skill, dashboard, F.1, public:check
#   scripts/gates.sh --db       also the server DB suite against a throwaway Postgres it creates and removes
# Any install step runs with an isolated HOME and npm prefix, so a gate never touches the owner's
# global npm, linked CLI or credentials. Exit status is non-zero when any gate fails; all gates run.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WITH_DB=0
for arg in "$@"; do
  case "$arg" in
    --db) WITH_DB=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/relo-gates.XXXXXX")"
PG_BIN="${PG_BIN_DIR:-/opt/homebrew/opt/postgresql@18/bin}"
PG_DATA="$SCRATCH/pg"   # gates run in subshells, so the path is fixed here for cleanup
cleanup() {
  if [[ -f "$PG_DATA/postmaster.pid" ]]; then
    LANG=C LC_ALL=C "$PG_BIN/pg_ctl" -D "$PG_DATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

# Isolated environment for install steps only (tests keep the real PATH and toolchain).
iso() {
  mkdir -p "$SCRATCH/home" "$SCRATCH/npm-prefix" "$SCRATCH/npm-cache"
  HOME="$SCRATCH/home" NPM_CONFIG_PREFIX="$SCRATCH/npm-prefix" npm_config_cache="$SCRATCH/npm-cache" \
    PNPM_HOME="$SCRATCH/pnpm-home" XDG_CONFIG_HOME="$SCRATCH/home/.config" "$@"
}

FAILED=(); PASSED=()
gate() {
  local name="$1"; shift
  printf '\n== %s\n' "$name"
  local started=$SECONDS
  if (cd "$ROOT" && "$@"); then PASSED+=("$name ($((SECONDS - started))s)"); else FAILED+=("$name"); fi
}

if [[ ! -d "$ROOT/node_modules" ]]; then
  gate "install (isolated)" iso pnpm install --frozen-lockfile
fi

gate "contracts tests"        pnpm --filter @relo/notification-contracts test
gate "contracts build"        pnpm --filter @relo/notification-contracts build
gate "server typecheck"       pnpm --filter ./apps/server typecheck
gate "CLI tests"              bash -c 'cd packages/cli && npm test --silent'
gate "skill validation"       bash -c 'cd skills/relo-notifications && node scripts/validate-skill.mjs && node --test tests/*.test.mjs'
gate "dashboard build"        pnpm --filter @relo/dashboard build
gate "dashboard tests"        pnpm --filter @relo/dashboard test
gate "owner surfaces display-only (F.1)" node scripts/check-owner-surfaces-display-only.mjs
gate "public:check"           npm run --silent public:check

if [[ "$WITH_DB" == 1 ]]; then
  db_suite() {
    [[ -x "$PG_BIN/initdb" ]] || { echo "no Postgres binaries at $PG_BIN (set PG_BIN_DIR)"; return 1; }
    local port
    for _ in $(seq 1 20); do
      port=$((20000 + RANDOM % 20000))
      lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || break
    done
    LANG=C LC_ALL=C "$PG_BIN/initdb" -D "$PG_DATA" --no-locale -E UTF8 -U relo_test --auth=trust >/dev/null || return 1
    LANG=C LC_ALL=C "$PG_BIN/pg_ctl" -D "$PG_DATA" -l "$SCRATCH/pg.log" -o "-p $port -k ''" -w start >/dev/null || { cat "$SCRATCH/pg.log"; return 1; }
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$port" -U relo_test relo_gates_test || return 1
    TEST_DATABASE_URL="postgresql://relo_test@127.0.0.1:$port/relo_gates_test" pnpm --filter ./apps/server test
  }
  gate "server DB suite (throwaway Postgres)" db_suite
fi

printf '\n== summary\n'
for p in "${PASSED[@]}"; do echo "  pass  $p"; done
for f in "${FAILED[@]+"${FAILED[@]}"}"; do echo "  FAIL  $f"; done
[[ ${#FAILED[@]} -eq 0 ]]
