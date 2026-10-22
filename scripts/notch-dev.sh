#!/usr/bin/env bash
# Try a Relo for Mac change on this Mac, without a release: an incremental Debug build of apps/notch from this checkout,
# then the running Relo quits and the build opens in its place. No gates, no server, no version bump: a release
# (`pnpm deploy:prod`) is for shipping a change to every Mac, not for trying one.
#   scripts/notch-dev.sh            build, quit the running Relo, open the build
#   scripts/notch-dev.sh --test     run ReloNotchKit's tests first (about 30 s)
#   scripts/notch-dev.sh --no-open  build only
# The build uses Xcode's own derived data for the project (the folder an Xcode build of it uses too), so only what
# changed compiles. The installed app (from a release) comes back with `open ~/Applications/Relo.app`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOTCH="$ROOT/apps/notch"
STEP="$ROOT/scripts/step.mjs"
TEST=0; OPEN=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --test) TEST=1 ;;
    --no-open) OPEN=0 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "notch-dev: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
say() { printf 'notch-dev: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

[[ "$(uname -s)" == Darwin ]] || die "builds only on a Mac"
[[ -f "$NOTCH/Configuration/Relo.local.xcconfig" ]] || die "no apps/notch/Configuration/Relo.local.xcconfig (team and bundle id; see apps/notch/README.md)"

if [[ $TEST == 1 ]]; then
  node "$STEP" --name "Relo for Mac tests" --timeout 15m --quiet 10m --heavy -- \
    bash -c "cd '$NOTCH/ReloNotchKit' && swift test --quiet" || die "the tests failed: not building"
fi

LOG="$(mktemp "${TMPDIR:-/tmp}/notch-dev.XXXXXX")"
XCODE=(-project "$NOTCH/boringNotch.xcodeproj" -scheme boringNotch -configuration Debug -allowProvisioningUpdates COMPILER_INDEX_STORE_ENABLE=NO)
say "building (Debug, incremental)"
# Normal priority, not the heavy slot: the owner is waiting on this build, as on one from Xcode. The background
# priority a release build takes (taskpolicy -b) tripled a no-change build here (9 s to over 30 s, 22 Oct).
node "$STEP" --name "Relo for Mac (Debug)" --timeout 40m --quiet 10m -- xcodebuild "${XCODE[@]}" build >"$LOG" 2>&1 \
  || { grep -E 'error:' "$LOG" | head -20 >&2; tail -5 "$LOG" >&2; die "the build failed (log: $LOG)"; }
# The app's path from the build's own log: asking xcodebuild for its settings costs another 9 s, so only a build
# that changed nothing (and so names no product) asks.
APP="$(grep -oE '/[^ ]*/Build/Products/Debug/[^/ ]+\.app' "$LOG" | tail -1 || true)"
if [[ -z "$APP" ]]; then
  PRODUCTS="$(xcodebuild "${XCODE[@]}" -showBuildSettings 2>/dev/null | sed -n 's/^ *BUILT_PRODUCTS_DIR = //p' | head -1)"
  APP="$(find "$PRODUCTS" -maxdepth 1 -name '*.app' | head -1)"
fi
[[ -n "$APP" && -d "$APP" ]] || die "the build made no app (log: $LOG)"
rm -f "$LOG"
say "built $APP"
[[ $OPEN == 1 ]] || exit 0

BUNDLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
# One Relo at a time: the installed one and the build share the bundle id, the Keychain items and the notch.
osascript -e "tell application id \"$BUNDLE\" to quit" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do pgrep -f "/Contents/MacOS/$(basename "$APP" .app)\$" >/dev/null || break; sleep 0.5; done
open -n "$APP"
say "running the Debug build; the installed app comes back with: open ~/Applications/Relo.app"
