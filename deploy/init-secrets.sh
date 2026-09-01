#!/bin/sh
set -eu

deployment_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
environment_file="$deployment_dir/.env"
secrets_dir="$deployment_dir/secrets"

if [ -e "$environment_file" ] || [ -e "$secrets_dir" ]; then
  echo "Refusing to overwrite existing deploy/.env or deploy/secrets." >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || {
  echo "openssl is required to initialize Relo secrets." >&2
  exit 1
}

umask 077
mkdir "$secrets_dir"
openssl rand -hex 32 > "$secrets_dir/owner_token"
openssl rand -hex 32 > "$secrets_dir/better_auth_secret"
postgres_password=$(openssl rand -hex 32)
runtime_password=$(openssl rand -hex 32)
uid=$(id -u)
gid=$(id -g)

sed \
  -e "s/^RELO_UID=.*/RELO_UID=$uid/" \
  -e "s/^RELO_GID=.*/RELO_GID=$gid/" \
  -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$postgres_password/" \
  -e "s/^POSTGRES_RUNTIME_PASSWORD=.*/POSTGRES_RUNTIME_PASSWORD=$runtime_password/" \
  "$deployment_dir/.env.example" > "$environment_file"

echo "Created deploy/.env and deploy/secrets with owner-only permissions."
echo "Review RELO_APP_URL, then run: docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build"
