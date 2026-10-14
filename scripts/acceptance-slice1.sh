#!/bin/bash
# Slice 1 acceptance, end to end on THIS Mac: a throwaway Postgres + a local server from source, the CLI from the
# checkout, asserting /api/now for STATE-SPEC §9 scenarios. Never touches the live server or the owner's config.
# Usage: scripts/acceptance-slice1.sh            (needs Homebrew postgresql@18; no Docker)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@18/bin}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/relo-accept.XXXXXX")"
free_port() { local p; while :; do p=$((50000 + RANDOM % 10000)); lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 || { echo $p; return; }; done; }
PG_PORT="$(free_port)"; API_PORT="$(free_port)"
export LANG=C LC_ALL=C
cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  "$PGBIN/pg_ctl" -D "$WORK/pg" stop -m fast >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
"$PGBIN/initdb" -D "$WORK/pg" --no-locale -E UTF8 -U relo_test --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$WORK/pg" -l "$WORK/pg.log" -o "-p $PG_PORT -k ''" start >/dev/null
"$PGBIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U relo_test relo_accept_test
DB="postgresql://relo_test@127.0.0.1:$PG_PORT/relo_accept_test"
(cd "$ROOT/apps/server" && MIGRATION_DATABASE_URL="$DB" node_modules/.bin/tsx src/migrate.ts)
TOKEN="$(openssl rand -hex 24)"; printf '%s' "$TOKEN" > "$WORK/token"
(cd "$ROOT/apps/server" && DATABASE_URL="$DB" PORT="$API_PORT" APP_URL="http://127.0.0.1:$API_PORT" \
  BETTER_AUTH_SECRET="$(openssl rand -hex 24)" BOOTSTRAP_OWNER_TOKEN_FILE="$WORK/token" \
  exec node_modules/.bin/tsx src/index.ts) > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break; grep -q listening "$WORK/server.log" && break; sleep 0.5; done
# The bootstrap key reads Now too (the owner's own view; the script plays the phone).
"$PGBIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U relo_test relo_accept_test -qAtc \
  "UPDATE principal_api_keys SET scopes = array_append(scopes, 'inbox:read') WHERE label='bootstrap-owner' AND NOT 'inbox:read' = ANY(scopes)"
RELO_ACCEPT_API_URL="http://127.0.0.1:$API_PORT" RELO_ACCEPT_TOKEN="$TOKEN" RELO_ACCEPT_STATE="$WORK/state" \
  node "$ROOT/scripts/acceptance-slice1.mjs"
