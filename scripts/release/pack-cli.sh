#!/usr/bin/env bash
# Packs the CLI the server hands out, the way apps/server/Dockerfile does: the skill bundled in, `npm pack`, and a
# manifest naming the version and digest. Usage: scripts/release/pack-cli.sh OUT_DIR  (writes relo-cli.tgz, manifest.json).
# `pnpm deploy:prod` runs it on the Mac and publishes the result to the host's artifacts folder.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:?usage: pack-cli.sh OUT_DIR}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
cd "$ROOT"
node packages/cli/scripts/bundle-skill.mjs
(cd packages/cli && npm pack --ignore-scripts --silent --pack-destination "$OUT" >/dev/null)
mv "$OUT"/relo-cli-*.tgz "$OUT/relo-cli.tgz"
node -e 'const fs=require("fs"),c=require("crypto");const v=require(process.argv[1]).version;fs.writeFileSync(process.argv[2]+"/manifest.json",JSON.stringify({version:v,sha256:c.createHash("sha256").update(fs.readFileSync(process.argv[2]+"/relo-cli.tgz")).digest("hex")}))' \
  "$ROOT/packages/cli/package.json" "$OUT"
echo "pack-cli: $(cat "$OUT/manifest.json")"
