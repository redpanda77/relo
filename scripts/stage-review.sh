#!/usr/bin/env bash
# Shows exactly what a commit would carry, file by file, before it is made (plan 10 E1). Several sessions share
# this checkout, so a staged file may hold another session's edits next to yours: read every diff.
#   scripts/stage-review.sh          print the staged files and their diffs, then ask to continue
#   scripts/stage-review.sh --yes    print them and continue (scripts and agents that have read the output)
set -euo pipefail
YES=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
if git diff --cached --quiet; then echo "Nothing is staged."; exit 1; fi
git --no-pager diff --cached --stat
# A file staged and also changed since: the unstaged part may be another session's, and is not in the commit.
mixed="$(comm -12 <(git diff --cached --name-only | sort) <(git diff --name-only | sort))"
if [[ -n "$mixed" ]]; then
  echo
  echo "Staged and also changed since staging (the newer edits are NOT in this commit; check whose they are):"
  echo "$mixed" | sed 's/^/  /'
fi
echo
git --no-pager diff --cached
if [[ "$YES" == 1 ]]; then exit 0; fi
if [[ ! -t 0 ]]; then echo "Read the diff above, then run again with --yes to continue." >&2; exit 1; fi
read -r -p "Commit exactly this? [y/N] " answer
[[ "$answer" == "y" || "$answer" == "Y" ]]
