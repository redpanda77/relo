#!/usr/bin/env bash
# Release gates on exactly what is committed (plan 10 M8): other sessions' uncommitted work never reaches a release.
#   scripts/release/head-gates.sh                   archive HEAD, install offline, run scripts/gates.sh --db on the archive
#   scripts/release/head-gates.sh --releasing       also require a version newer than the recorded release
#   scripts/release/head-gates.sh --since <commit>  only the gates the paths changed since <commit> need (the deploy
#                                                   passes the live commit); version-only package.json/openapi.json
#                                                   changes count as covered by the release-state gate
#   scripts/release/head-gates.sh --all             every gate, even with --since
#   scripts/release/head-gates.sh --remote HOST     run the gates on HOST's capped builder container (plan 15 wave 2),
#                                                   not on this Mac; RELO_BUILDER_FILES names its Dockerfile folder
# Pass cache: a gate group whose inputs (scripts/gate-keys.mjs) passed before is not run again; RELO_GATES_NO_CACHE=1
# turns it off. The record lives on the builder (remote) or in the local gates state folder.
# Uncommitted edits (often another session's) are listed and left out: only HEAD is archived. Refuses a HEAD
# that is not on the pushed branch. Prints the archive path on success so the deploy copies the same tree.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASING=0; SINCE=""; ALL=0; REMOTE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --releasing) RELEASING=1 ;;
    --since) SINCE="${2:?--since needs a commit}"; shift ;;
    --all) ALL=1 ;;
    --remote) REMOTE="${2:?--remote needs a host}"; shift ;;
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
ARCHIVE="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/relo-head.${SHA:0:8}.XXXXXX")" && pwd -P)"   # the real path: see scripts/entrypoints.test.mjs
git archive HEAD | tar -x -C "$ARCHIVE"
git ls-tree -r -z --name-only HEAD > "$ARCHIVE/.relo-tracked-files"
echo "head-gates: $SHA archived to $ARCHIVE"
# The keys are computed here, where git is (the archive has none), and travel with the archive.
CACHE_ARGS=()
if [[ "${RELO_GATES_NO_CACHE:-}" != 1 ]] && node scripts/gate-keys.mjs HEAD > "$ARCHIVE/.relo-gate-keys"; then
  CACHE_ARGS=(--keys)
else
  rm -f "$ARCHIVE/.relo-gate-keys"
fi


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
# A change no gate group covers (the notch, the phone, internal notes) leaves only the always-run checks, which need no
# install and take a second: they run here on the archive, not on the builder (its copy, image and install took 40 to
# 60 s for a notch release, 22 Oct).
LIGHT=0
if [[ "${SELECT[0]}" == --changed ]] && node scripts/select-gates.mjs "${SELECT[1]}" | head -1 | grep -qxE 'gates: ?'; then
  LIGHT=1; REMOTE=""
  echo "head-gates: no gate group selected: the always-run checks run here"
fi

if [[ -n "$REMOTE" ]]; then
  # The gates on the builder: the release copy goes to HOST, the capped container installs (its pnpm store is a
  # volume) and runs gates.sh there; progress streams back. The container has its own deadline, so a dropped
  # connection cannot leave it running; the copy is removed afterwards either way.
  SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
  BUILDER='~/services/relo-builder'
  WORKDIR="$BUILDER/work/${SHA:0:8}-$$"
  [[ -d "${RELO_BUILDER_FILES:-}" ]] || { echo "head-gates: --remote needs RELO_BUILDER_FILES (the builder's Dockerfile folder)" >&2; exit 2; }
  tar -C "$RELO_BUILDER_FILES" -cf - . | "${SSH[@]}" "$REMOTE" "mkdir -p $BUILDER/work && tar -x -C $BUILDER"
  COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$ARCHIVE" -czf - . | "${SSH[@]}" "$REMOTE" "mkdir -p $WORKDIR && tar -xzf - -C $WORKDIR"
  REMOTE_SELECT=("${SELECT[@]//$ARCHIVE//work}")
  REMOTE_CACHE=()
  if [[ ${#CACHE_ARGS[@]} -gt 0 ]]; then
    "${SSH[@]}" "$REMOTE" "cp $BUILDER/passed-gates $WORKDIR/.relo-gates-passed 2>/dev/null || true" </dev/null
    REMOTE_CACHE=(--keys /work/.relo-gate-keys --passed /work/.relo-gates-passed)
  fi
  # The container has a known name, so stopping this run (Ctrl-C, a release's own stop) stops it on the host too:
  # a killed ssh leaves a `docker compose run` going on its own.
  RUN_NAME="relo-gates-${SHA:0:8}-$$"
  trap '"${SSH[@]}" "$REMOTE" "docker stop -t 5 $RUN_NAME >/dev/null 2>&1; rm -rf $WORKDIR" </dev/null; exit 130' INT TERM
  set +e
  node "$ARCHIVE/scripts/step.mjs" --name "head gates ${SHA:0:8} on $REMOTE" --timeout 30m --quiet 6m -- "${SSH[@]}" "$REMOTE" \
    "cd $BUILDER && export RELO_BUILDER_WORK=$WORKDIR && docker compose build -q gates && docker compose run --rm -T --name $RUN_NAME \
      -e RELO_PUBLIC_FILES_FROM=/work/.relo-tracked-files -e RELO_RELEASING=$([[ "$RELEASING" == 1 ]] && echo 1 || true) gates \
      timeout -k 30s 28m bash -c 'node scripts/step.mjs --name install --timeout 5m --quiet 3m -- pnpm install --frozen-lockfile --reporter=silent \
        && scripts/gates.sh --db --ran-file /work/.relo-gates-ran ${REMOTE_CACHE[*]:-} ${REMOTE_SELECT[*]}'"
  CODE=$?
  RAN="$("${SSH[@]}" "$REMOTE" "cat $WORKDIR/.relo-gates-ran 2>/dev/null; cp $WORKDIR/.relo-gates-passed $BUILDER/passed-gates 2>/dev/null; rm -rf $WORKDIR" </dev/null)"
  set -e
  [[ -n "$RAN" ]] || { echo "head-gates: the gates did not run on $REMOTE (no summary written); not a pass" >&2; exit 1; }
  echo "head-gates: $RAN"
  [[ "$CODE" == 0 ]] || { echo "head-gates: gates failed on $REMOTE" >&2; exit "$CODE"; }
  echo "head-gates: $SHA passed on $REMOTE; release from $ARCHIVE"
  exit 0
fi

if [[ $LIGHT == 0 ]]; then
  STORE="$(pnpm store path)"
  (cd "$ARCHIVE" && node scripts/step.mjs --name "install (offline)" --timeout 5m --quiet 2m -- \
    pnpm install --frozen-lockfile --offline --store-dir "$STORE" --reporter=silent)
fi

LOCAL_CACHE=()
if [[ ${#CACHE_ARGS[@]} -gt 0 ]]; then
  PASSED_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/relo/gates/passed"
  mkdir -p "$(dirname "$PASSED_FILE")"
  LOCAL_CACHE=(--keys "$ARCHIVE/.relo-gate-keys" --passed "$PASSED_FILE")
fi

# The whole gate run is one heavy step (plan 15): it waits for the machine's one heavy slot, runs at background
# priority, and stops after 25 minutes or 6 silent ones instead of running on.
RELO_PUBLIC_FILES_FROM="$ARCHIVE/.relo-tracked-files" \
  RELO_RELEASING="$([[ "$RELEASING" == 1 ]] && echo 1 || true)" \
  node "$ARCHIVE/scripts/step.mjs" --name "head gates ${SHA:0:8}" $([[ $LIGHT == 1 ]] || echo --heavy) --timeout 25m --quiet 6m -- \
  "$ARCHIVE/scripts/gates.sh" --db --ran-file "$ARCHIVE/.relo-gates-ran" "${LOCAL_CACHE[@]+"${LOCAL_CACHE[@]}"}" "${SELECT[@]}"
# A pass counts only if the gates really ran to their summary (a runner that silently did nothing exits 0 too).
[[ -s "$ARCHIVE/.relo-gates-ran" ]] || { echo "head-gates: the gates did not run (no summary written); not a pass" >&2; exit 1; }
echo "head-gates: $(cat "$ARCHIVE/.relo-gates-ran")"

echo "head-gates: $SHA passed; release from $ARCHIVE"
