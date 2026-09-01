#!/bin/sh
set -eu

: "${POSTGRES_RUNTIME_PASSWORD:?POSTGRES_RUNTIME_PASSWORD is required}"

PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}" \
  psql --no-psqlrc --set=ON_ERROR_STOP=1 \
    --host="${POSTGRES_HOST:-postgres}" \
    --username="${POSTGRES_USER:-relo}" \
    --dbname="${POSTGRES_DB:-relo}" <<'SQL'
\getenv runtime_password POSTGRES_RUNTIME_PASSWORD
SELECT format(
  'ALTER ROLE relo_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'runtime_password'
) \gexec
SQL
