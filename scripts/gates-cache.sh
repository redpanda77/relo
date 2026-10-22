#!/usr/bin/env bash
# Pass cache for scripts/gates.sh (sourced): a gate group whose "group key" line (scripts/gate-keys.mjs) is in the
# passed file already passed on identical inputs and is not run again. Only groups whose gates all passed are
# recorded. The file keeps the 200 newest lines.

# Moves the selected groups with a passed key from SELECTED to CACHED. Args: keys file, passed file.
cache_apply() {
  local keys="$1" passed="$2" group line kept=""
  CACHED=""
  [[ -r "$keys" ]] || return 0
  for group in $SELECTED; do
    line="$(grep -m1 "^$group " "$keys" || true)"
    if [[ -n "$line" && -r "$passed" ]] && grep -qxF "$line" "$passed"; then CACHED+="$group "; else kept+="$group "; fi
  done
  SELECTED="${kept% }"; CACHED="${CACHED% }"
}

# The group a gate belongs to (empty: not a group's own gate, so its failure records nothing at all).
gate_group() {
  case "$1" in
    "contracts tests") echo contracts ;;
    "server typecheck"|"server DB suite"*) echo server ;;
    "CLI tests"|"CLI wall-clock budgets"*) echo cli ;;
    "skill validation") echo skill ;;
    "repository scripts") echo repo ;;
    "dashboard tests"*) echo dashboard ;;
  esac
}

_reverse() { awk '{a[NR]=$0} END{for(i=NR;i>=1;i--)print a[i]}'; }

# Appends the key line of each group that ran and passed. Args: keys file, passed file, then the failed gate names.
# Any failure outside a group's own gates (a build, install, F.1, public:check) records nothing: the run is not clean.
cache_record() {
  local keys="$1" passed="$2" group failed="" name g; shift 2
  [[ -r "$keys" ]] || return 0
  for name in "$@"; do
    g="$(gate_group "$name")"
    [[ -n "$g" ]] || return 0
    failed+="$g "
  done
  mkdir -p "$(dirname "$passed")"
  for group in $SELECTED; do
    [[ " $failed " != *" $group "* ]] || continue
    grep -m1 "^$group " "$keys" >> "$passed" || true
  done
  [[ -f "$passed" ]] || return 0
  # Newest wins: dedupe keeping the last occurrence, then cap.
  _reverse < "$passed" | awk '!s[$0]++' | head -200 | _reverse > "$passed.tmp" && mv "$passed.tmp" "$passed"
}
