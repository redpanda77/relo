#!/usr/bin/env bash
# Release gates on exactly what is committed (plan 10 M8): other sessions' uncommitted work never reaches a release.
#   scripts/release/head-gates.sh                   archive HEAD, install offline, run scripts/gates.sh --db on the archive
#   scripts/release/head-gates.sh --releasing       also require a version newer than the recorded release
#   scripts/release/head-gates.sh --since <commit>  only the gates the paths changed since <commit> need (the deploy
#                                                   passes the live commit); version-only package.json/openapi.json
#                                                   changes count as covered by the release-state gate
#   scripts/release/head-gates.sh --all             every gate, even with --since
# Uncommitted edits (often another session's) are listed and left out: only HEAD is archived. Refuses a HEAD
# that is not on the pushed branch. Prints the archive path on success so the deploy copies the same tree.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASING=0; SINCE=""; ALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --releasing) RELEASING=1 ;;
    --since) SINCE="${2:?--since needs a commit}"; shift ;;
    --all) ALL=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$ROOT"
if ! git diff --quiet || ! git diff --cached --quiet; then
  # Other sessions share this checkout: their edits are expected and simply not part of the release.
  echo "head-gates: not in this release (uncommitted):"
  git status --short --untracked-files=no | sed 's/^/  /'
fi
git fetch --quiet origin
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')"
if ! git merge-base --is-ancestor HEAD "$UPSTREAM"; then
  echo "head-gates: HEAD is not on $UPSTREAM; push it first so the release is a pushed commit." >&2
  exit 1
fi

SHA="$(git rev-parse HEAD)"
ARCHIVE="$(mktemp -d "${TMPDIR:-/tmp}/relo-head.${SHA:0:8}.XXXXXX")"
git archive HEAD | tar -x -C "$ARCHIVE"
git ls-tree -r -z --name-only HEAD > "$ARCHIVE/.relo-tracked-files"
echo "head-gates: $SHA archived to $ARCHIVE"

STORE="$(pnpm store path)"
(cd "$ARCHIVE" && pnpm install --frozen-lockfile --offline --store-dir "$STORE" --reporter=silent)

# Gate selection: the paths changed since --since, minus files whose only change is a "version" line (the
# release bump; validate-release-state checks those versions agree). Unsure (no base, not an ancestor): every gate.
SELECT=(--all)
if [[ -n "$SINCE" && "$ALL" != 1 ]]; then
  if git merge-base --is-ancestor "$SINCE" HEAD 2>/dev/null; then
    : > "$ARCHIVE/.relo-changed-files"
    while IFS= read -r path; do
      lines="$(git diff --no-renames "$SINCE" HEAD -- "$path" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)( |$)' || true)"
      if [[ "$path" == *.json && -n "$lines" ]] && ! grep -qvE '^[+-][[:space:]]*"version": "[^"]*",?$' <<<"$lines"; then
        echo "head-gates: $path changes only its version (covered by the release-state gate)"
      else
        echo "$path" >> "$ARCHIVE/.relo-changed-files"
      fi
    done < <(git diff --name-only --no-renames "$SINCE" HEAD)
    SELECT=(--changed "$ARCHIVE/.relo-changed-files")
    echo "head-gates: selecting gates for the paths changed since ${SINCE:0:8}"
  else
    echo "head-gates: ${SINCE:0:8} is not an ancestor of HEAD; running every gate"
  fi
fi

RELO_PUBLIC_FILES_FROM="$ARCHIVE/.relo-tracked-files" \
  RELO_RELEASING="$([[ "$RELEASING" == 1 ]] && echo 1 || true)" \
  "$ARCHIVE/scripts/gates.sh" --db "${SELECT[@]}"

echo "head-gates: $SHA passed; release from $ARCHIVE"
