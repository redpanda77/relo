#!/usr/bin/env bash
# The server Relo for Mac carries (plan 16): Node, the server with its production dependencies, the Dashboard,
# migrations and PostgreSQL, laid out the way the server finds its pieces by relative path (the Dockerfile's workspace
# layout). scripts/release/embed-server.sh puts it in the app and signs it.
#
#   scripts/release/mac-server-payload.sh OUT_DIR
#
# OUT_DIR/ gets: node (the official darwin-arm64 build), cli (the relo CLI, unpacked),
# app/server/{dist,migrations,node_modules,package.json,cli},
# app/dashboard/dist, app/postgres (17, thinned to arm64) and VERSION (the server's package version). Node and
# PostgreSQL are pinned and checked against their published digests. A payload is cached by the tree of what it is
# built from, so an unchanged server is not built again.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:?usage: mac-server-payload.sh OUT_DIR}"
STEP="$ROOT/scripts/step.mjs"
NODE_VERSION=22.23.4
POSTGRES_PACKAGE=@embedded-postgres/darwin-arm64@17.10.0-beta.17
POSTGRES_INTEGRITY=sha512-E2dxhSllrcyAJBHuvgTrBTx2BaPlX2vvjXClPKHxfwBezk+nTZ01uAEraKiRJMpzHSCyN8J1dTjKh4q/uTsBLQ==
say() { printf 'server-payload: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

[[ "$(uname -s)" == Darwin ]] || die "builds only on a Mac"
# What the payload is built from: the pinned releases of Node and PostgreSQL named in the key, the code, the lockfile its
# dependencies resolve from, and the two release scripts that lay it out (this one, pack-cli). Tests are not shipped, so
# a change to a test (or to another release script) keeps the cached payload.
BUILT_FROM=(apps/server apps/dashboard packages/contracts packages/owner-crypto packages/cli skills/relo-notifications scripts/release/mac-server-payload.sh scripts/release/pack-cli.sh pnpm-lock.yaml)
KEY="$(git -C "$ROOT" ls-tree -r HEAD -- "${BUILT_FROM[@]}" | grep -vE '(\.test\.[a-z]+|/test/|/tests/|/test-support/|/fixtures/)' | shasum | cut -c1-16)-node$NODE_VERSION-pg17.10"
CACHE="${XDG_CACHE_HOME:-$HOME/Library/Caches}/relo/server-payload/$KEY"
if ! git -C "$ROOT" diff --quiet HEAD -- "${BUILT_FROM[@]}"; then
  say "what the payload is built from has uncommitted changes: building them, not caching"
  CACHE=""
fi
if [[ -n "$CACHE" && -f "$CACHE/VERSION" ]]; then
  say "unchanged ($KEY): reusing it"
  rm -rf "$OUT" && mkdir -p "$(dirname "$OUT")" && cp -R "$CACHE" "$OUT"
  exit 0
fi

WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
P="$WORK/payload"
mkdir -p "$P/app/server" "$P/app/dashboard"

# Node: the official build, checked against nodejs.org's SHASUMS256.
FILE="node-v$NODE_VERSION-darwin-arm64.tar.gz"
node "$STEP" --name node-shasums --timeout 2m --quiet 1m -- curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
node "$STEP" --name node-download --timeout 10m --quiet 2m -- curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$FILE" -o "$WORK/$FILE"
[[ "$(shasum -a 256 "$WORK/$FILE" | cut -d' ' -f1)" == "$(grep " $FILE\$" "$WORK/SHASUMS256.txt" | cut -d' ' -f1)" ]] || die "Node did not match its checksum"
tar -xzf "$WORK/$FILE" -C "$WORK" "node-v$NODE_VERSION-darwin-arm64/bin/node" "node-v$NODE_VERSION-darwin-arm64/LICENSE"
mv "$WORK/node-v$NODE_VERSION-darwin-arm64/bin/node" "$P/node"
mv "$WORK/node-v$NODE_VERSION-darwin-arm64/LICENSE" "$P/NODE-LICENSE"

# PostgreSQL: EnterpriseDB's build from the embedded-postgres package, checked against its registry integrity, its
# library symlinks recreated (the package stores them in pg-symlinks.json) and thinned to arm64 (plan 16 section 5).
TARBALL="$(npm view "$POSTGRES_PACKAGE" dist.tarball)"
node "$STEP" --name postgres-download --timeout 10m --quiet 2m -- curl -fsSL "$TARBALL" -o "$WORK/pg.tgz"
[[ "sha512-$(openssl dgst -sha512 -binary "$WORK/pg.tgz" | base64)" == "$POSTGRES_INTEGRITY" ]] || die "PostgreSQL did not match its integrity"
mkdir -p "$WORK/pg" && tar -xzf "$WORK/pg.tgz" -C "$WORK/pg"
mv "$WORK/pg/package/native" "$P/app/postgres"
(cd "$P/app/postgres" && node -e '
  const fs = require("fs"), path = require("path");
  for (const { source, target } of JSON.parse(fs.readFileSync("pg-symlinks.json", "utf8"))) {
    const s = source.replace(/^native\//, ""), t = target.replace(/^native\//, "");
    try { fs.symlinkSync(path.relative(path.dirname(t), s), t); } catch {}
  }' && rm pg-symlinks.json)
find "$P/app/postgres" -type f \( -perm -u+x -o -name "*.dylib" \) | while IFS= read -r f; do
  if lipo -info "$f" 2>/dev/null | grep -q "x86_64 arm64"; then lipo "$f" -thin arm64 -output "$f.thin" && mv "$f.thin" "$f"; fi
done
cat > "$P/app/postgres/LICENSE" <<'LICENSE'
PostgreSQL Database Management System (also known as Postgres, formerly known as Postgres95)
Portions Copyright (c) 1996-2025, The PostgreSQL Global Development Group
Portions Copyright (c) 1994, The Regents of the University of California
Permission to use, copy, modify, and distribute this software and its documentation for any purpose, without fee, and
without a written agreement is hereby granted, provided that the above copyright notice and this paragraph and the
following two paragraphs appear in all copies.
IN NO EVENT SHALL THE UNIVERSITY OF CALIFORNIA BE LIABLE TO ANY PARTY FOR DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR
CONSEQUENTIAL DAMAGES, INCLUDING LOST PROFITS, ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS DOCUMENTATION, EVEN IF
THE UNIVERSITY OF CALIFORNIA HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
THE UNIVERSITY OF CALIFORNIA SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. THE SOFTWARE PROVIDED HEREUNDER IS ON AN "AS IS"
BASIS, AND THE UNIVERSITY OF CALIFORNIA HAS NO OBLIGATIONS TO PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR
MODIFICATIONS.
LICENSE

# The server, the contracts it imports and the Dashboard, built from this checkout at background priority. A release
# builds from a fresh clone with no node_modules: the workspace's dependencies come from the lockfile first.
if [[ ! -x "$ROOT/apps/server/node_modules/.bin/tsc" || ! -d "$ROOT/packages/contracts/node_modules" ]]; then
  node "$STEP" --name workspace-install --timeout 15m --quiet 5m -- taskpolicy -b pnpm --dir "$ROOT" install --frozen-lockfile >&2 \
    || die "could not install the workspace's dependencies"
fi
node "$STEP" --name contracts-build --timeout 5m --quiet 3m -- taskpolicy -b pnpm --dir "$ROOT" --filter @relo/notification-contracts build >&2
node "$STEP" --name dashboard-build --timeout 10m --quiet 5m --heavy -- taskpolicy -b pnpm --dir "$ROOT" --filter @relo/dashboard build >&2
node "$STEP" --name server-build --timeout 5m --quiet 3m -- taskpolicy -b "$ROOT/apps/server/node_modules/.bin/tsc" -p "$ROOT/apps/server/tsconfig.json" --outDir "$P/app/server/dist"
cp -R "$ROOT/apps/server/migrations" "$P/app/server/migrations"
cp "$ROOT/apps/server/package.json" "$P/app/server/package.json"
cp -R "$ROOT/apps/dashboard/dist" "$P/app/dashboard/dist"
# Production dependencies only, hoisted (plain node_modules, relative links), versions from the lockfile's resolution.
DEPS="$WORK/deps"
mkdir -p "$DEPS"
node -e '
  const fs = require("fs"), path = require("path"); const server = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const deps = { ...server.dependencies }; delete deps["@relo/notification-contracts"]; const resolved = {};
  for (const name of Object.keys(deps)) resolved[name] = JSON.parse(fs.readFileSync(path.join(process.argv[2], "node_modules", name, "package.json"), "utf8")).version;
  fs.writeFileSync(process.argv[3], JSON.stringify({ name: "relo-server-payload", private: true, dependencies: resolved }, null, 2));
' "$ROOT/apps/server/package.json" "$ROOT/apps/server" "$DEPS/package.json"
printf 'node-linker=hoisted\nauto-install-peers=false\n' > "$DEPS/.npmrc"
node "$STEP" --name server-deps --timeout 10m --quiet 3m -- taskpolicy -b pnpm --dir "$DEPS" install --prod --ignore-scripts >&2
mv "$DEPS/node_modules" "$P/app/server/node_modules"
C="$P/app/server/node_modules/@relo/notification-contracts"
mkdir -p "$C" && cp "$ROOT/packages/contracts/package.json" "$C/" && cp -R "$ROOT/packages/contracts/dist" "$C/dist"
node -p 'require(process.argv[1]).version' "$ROOT/apps/server/package.json" > "$P/VERSION"
# The CLI: the tarball and manifest where the server serves it (dist/../cli), and an unpacked copy the app's `relo`
# launcher runs (the CLI has no dependencies).
node "$STEP" --name pack-cli --timeout 3m --quiet 2m -- "$ROOT/scripts/release/pack-cli.sh" "$P/app/server/cli" >&2
mkdir -p "$P/cli" && tar -xzf "$P/app/server/cli/relo-cli.tgz" -C "$P/cli" --strip-components=1
"$P/node" "$P/cli/bin/relo.mjs" --version >/dev/null || die "the payload's CLI does not run"

# A smoke check: the bundled Node loads the supervisor and the server's modules.
"$P/node" --input-type=module -e "await import('$P/app/server/dist/app.js')" || die "the payload's server does not load"
"$P/app/postgres/bin/postgres" --version >/dev/null || die "the payload's PostgreSQL does not run"

if [[ -n "$CACHE" ]]; then rm -rf "$CACHE" && mkdir -p "$(dirname "$CACHE")" && cp -R "$P" "$CACHE"; fi
for old in "${XDG_CACHE_HOME:-$HOME/Library/Caches}"/relo/server-payload/*; do
  [[ -d "$old" && "$old" != "${CACHE%/}" ]] && rm -rf "$old"
done
rm -rf "$OUT" && mkdir -p "$(dirname "$OUT")" && mv "$P" "$OUT"
say "ready: server $(cat "$OUT/VERSION"), Node $NODE_VERSION, PostgreSQL 17.10, $(du -sh "$OUT" | cut -f1) in $OUT"
