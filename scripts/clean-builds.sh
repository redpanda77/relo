#!/usr/bin/env bash
# Removes stale build output on this Mac and checks free space, so rebuilds never fill the disk (a full disk stops
# every session, even its shell). Age-based only: nothing a running build or another session uses right now.
#   scripts/clean-builds.sh                 clean, then print free space
#   scripts/clean-builds.sh --dry-run       list what would go, change nothing
#   scripts/clean-builds.sh --min-free 20   also exit 1 when under 20 GB stay free after cleaning
#   scripts/clean-builds.sh --quiet         print only removals and a low-space refusal
# deploy.sh and gates.sh run it with --min-free before their heavy steps.
set -uo pipefail

DRY=0; QUIET=0; MIN_FREE=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --quiet) QUIET=1 ;;
    --min-free) MIN_FREE=${2:?--min-free needs a number of GB}; shift ;;
    *) echo "clean-builds: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

# The build output it clears is this Mac's: elsewhere (the gates' Linux container on the build server, an archived checkout
# with no .git) there is nothing to clean, and macOS's `df -g` does not exist.
[[ "$(uname -s)" == Darwin ]] || exit 0

REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
TMP="${TMPDIR:-/tmp}"
freed=0

# remove PATH: deletes (or, with --dry-run, counts) one stale folder; folders of 50 MB or more are named.
count=0
remove() {
  local path=$1 kb
  [[ -e $path ]] || return 0
  kb=$(du -sk "$path" 2>/dev/null | cut -f1); kb=${kb:-0}
  freed=$((freed + kb)); count=$((count + 1))
  (( kb >= 51200 )) && echo "clean-builds: $([[ $DRY == 1 ]] && echo "would remove" || echo "removing") $path ($((kb / 1024)) MB)"
  [[ $DRY == 1 ]] || rm -rf "$path"
}

# Temporary folders our scripts make (deploy and gate clones, e2e homes, packing dirs) that a trap missed.
while IFS= read -r -d '' dir; do remove "$dir"
done < <(find "$TMP" -mindepth 1 -maxdepth 1 -type d -user "$(id -u)" -mtime +0 \
  \( -name 'relo-*' -o -name 'tmp.*' -o -name 'notch-dev.*' \) -print0 2>/dev/null)

# Xcode derived data per project, untouched for three days (the shared caches Xcode keeps itself stay).
DERIVED="$HOME/Library/Developer/Xcode/DerivedData"
if [[ -d $DERIVED ]]; then
  while IFS= read -r -d '' dir; do remove "$dir"
  done < <(find "$DERIVED" -mindepth 1 -maxdepth 1 -type d -mtime +2 ! -name '*.noindex' \
    ! -name 'SDKExplicitPrecompiledModules' -print0 2>/dev/null)
fi

# Build trees inside the repository (.build/*, apps/*/build) untouched for a week.
while IFS= read -r -d '' dir; do remove "$dir"
done < <(find "$REPO/.build" "$REPO"/apps/*/build -mindepth 1 -maxdepth 1 -mtime +6 -print0 2>/dev/null)

# Simulators whose runtime is gone.
if [[ $DRY == 0 ]] && command -v xcrun >/dev/null; then xcrun simctl delete unavailable >/dev/null 2>&1 || true; fi

free_gb=$(df -Pk "$HOME" | awk 'NR==2 { print int($4 / 1048576) }')
[[ $QUIET == 1 ]] || echo "clean-builds: $([[ $DRY == 1 ]] && echo "would free" || echo "freed") $((freed / 1024)) MB in $count stale folders; ${free_gb} GB free"
if (( MIN_FREE > 0 && free_gb < MIN_FREE )); then
  echo "clean-builds: only ${free_gb} GB free, under ${MIN_FREE} GB: free space before building (Xcode Archives, other folders)" >&2
  exit 1
fi
exit 0
