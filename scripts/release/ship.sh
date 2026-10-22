#!/usr/bin/env bash
# One command for everything this repository releases: `pnpm ship`.
#   pnpm ship            push this branch's commits, then release them (docs/internal/operations/release/deploy.sh):
#                        gates, the server and Dashboard, the CLI with its skill and Relo for Mac, each version bumped
#                        when its code changed; computers and Macs then update themselves from the server.
#   pnpm ship -- --plan  what would ship; changes nothing
# Only committed work ships: commit first (several sessions share this checkout; uncommitted files are never taken).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
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
