#!/usr/bin/env bash
# One command for everything this repository releases: `pnpm ship`.
#   pnpm ship            push this branch's commits, then release them (docs/internal/operations/release/deploy.sh):
#                        gates, the server and Dashboard, the CLI with its skill and Relo for Mac, each version bumped
#                        when its code changed; computers and Macs then update themselves from the server.
#   pnpm ship -- --plan  what would ship; changes nothing
# Only committed work ships: commit first (several sessions share this checkout; uncommitted files are never taken).
#   pnpm ship -- --windows   on a Windows PC (Git Bash): build Relo for Windows (scripts/release/build-windows-app.mjs, Authenticode
#                        and updater signing from the environment) into build/windows-app/windows and say how to hand it to the
#                        release. The release runs on the Mac (deploy.sh needs ssh, the Mac toolchain and the server's keys), so
#                        Windows is a hand-off, not a step of the Mac run: copy that folder to the Mac and run
#                          RELO_WINDOWS_ARTIFACTS=/path/to/windows pnpm ship
#                        deploy.sh then publishes it only when it is Authenticode signed and updater signed; otherwise the
#                        Windows app people have stays as it is (apps/server/windows/README.md). There is no CI for this yet:
#                        a Windows runner would run the same command and upload the folder.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
if [[ " $* " == *" --windows "* ]]; then
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *) echo "ship --windows: Relo for Windows builds on a Windows PC (NSIS and signtool are Windows tools). Run it there, then set RELO_WINDOWS_ARTIFACTS on the Mac" >&2; exit 2 ;;
  esac
  OUT="${RELO_WINDOWS_OUT:-$ROOT/build/windows-app/windows}"
  node scripts/release/build-windows-app.mjs --out "$OUT"
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1]+"/manifest.json","utf8"));
    const ok=m.signed==="authenticode"&&m.signature;
    console.log(`ship --windows: ${m.version} (build ${m.build??"?"}) is ${ok?"ready to publish":"NOT publishable: "+(m.signed==="authenticode"?"no updater signature (TAURI_SIGNING_PRIVATE_KEY)":"not Authenticode signed (RELO_WINDOWS_CERT_FILE or RELO_WINDOWS_CERT_THUMBPRINT)")}`)' "$OUT"
  echo "ship --windows: copy $OUT to the Mac, then: RELO_WINDOWS_ARTIFACTS=<that folder> pnpm ship"
  exit 0
fi
if [[ -z "${RELO_WINDOWS_ARTIFACTS:-}" ]]; then
  echo "ship: no Relo for Windows in this release (RELO_WINDOWS_ARTIFACTS is unset; build it on Windows with pnpm ship -- --windows)"
else
  echo "ship: Relo for Windows from $RELO_WINDOWS_ARTIFACTS is published only if it is Authenticode and updater signed"
fi
[[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || { echo "ship: releases main; this checkout is on $(git rev-parse --abbrev-ref HEAD)" >&2; exit 2; }
git fetch -q origin
if [[ " $* " != *" --plan "* ]] && [[ -n "$(git rev-list origin/main..HEAD)" ]]; then
  git merge-base --is-ancestor origin/main HEAD || { echo "ship: origin/main moved; pull --rebase first" >&2; exit 1; }
  echo "ship: pushing $(git rev-list --count origin/main..HEAD) commit(s)"
  git push -q origin HEAD:main
fi
dirty="$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
[[ "$dirty" == 0 ]] || echo "ship: $dirty uncommitted file(s) stay out of this release"
# The whole release is one bounded step: 45 minutes at most (the target is far less: plan 15), and 10 silent
# minutes mean a hang, not slow work. Each step inside has its own, tighter budget.
exec node scripts/step.mjs --name ship --timeout 45m --quiet 10m -- bash docs/internal/operations/release/deploy.sh "$@"
