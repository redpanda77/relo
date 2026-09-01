#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_DIRECTORY=$(git -C "$SCRIPT_DIRECTORY" rev-parse --show-toplevel)
PRIMARY_WORKTREE=$(git -C "$REPOSITORY_DIRECTORY" worktree list --porcelain | awk '/^worktree / { sub(/^worktree /, ""); print; exit }')

if [ "$REPOSITORY_DIRECTORY" != "$PRIMARY_WORKTREE" ]; then
  echo "Relo builds must run from the primary checkout: $PRIMARY_WORKTREE" >&2
  exit 1
fi

EXPECTED_ORIGIN=${RELO_EXPECTED_ORIGIN:-}
COMMITTED_CONFIG="$REPOSITORY_DIRECTORY/apps/ios/Config/Signing.xcconfig"
LOCAL_CONFIG="$REPOSITORY_DIRECTORY/apps/ios/Config/Signing.local.xcconfig"

if [ -z "$EXPECTED_ORIGIN" ]; then
  echo "Set RELO_EXPECTED_ORIGIN to the exact HTTPS origin embedded in this build." >&2
  exit 1
fi
if ! grep -Eq '^[[:space:]]*RELO_API_ORIGIN[[:space:]]*=' "$COMMITTED_CONFIG"; then
  echo "Signing.xcconfig must define the portable RELO_API_ORIGIN fallback." >&2
  exit 1
fi
if [ -f "$LOCAL_CONFIG" ] && ! grep -Eq '^[[:space:]]*RELO_API_ORIGIN[[:space:]]*=' "$LOCAL_CONFIG"; then
  echo "Signing.local.xcconfig must define the deployment RELO_API_ORIGIN." >&2
  exit 1
fi

SOURCE_COMMIT=$(git -C "$REPOSITORY_DIRECTORY" rev-parse HEAD)
if ! git -C "$REPOSITORY_DIRECTORY" diff --quiet || ! git -C "$REPOSITORY_DIRECTORY" diff --cached --quiet; then
  if [ "${RELO_ALLOW_DIRTY_BUILD:-0}" != "1" ]; then
    echo "Authoritative Relo artifacts require a clean source checkout." >&2
    echo "Set RELO_ALLOW_DIRTY_BUILD=1 only for an explicitly non-promotable development build." >&2
    exit 1
  fi
  SOURCE_COMMIT="$SOURCE_COMMIT-dirty"
fi

DERIVED_DATA_PATH=${RELO_DERIVED_DATA_PATH:-$REPOSITORY_DIRECTORY/.build/ios-authoritative}
xcodebuild \
  -project "$REPOSITORY_DIRECTORY/apps/ios/Relo.xcodeproj" \
  -scheme Relo \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  RELO_GIT_COMMIT="$SOURCE_COMMIT" \
  "$@"

APP_BUNDLE="$DERIVED_DATA_PATH/Build/Products/Debug-iphoneos/Relo.app"
APP_PLIST="$APP_BUNDLE/Info.plist"
EXTENSION_PLIST="$APP_BUNDLE/PlugIns/ReloLiveActivities.appex/Info.plist"

APP_ORIGIN=$(/usr/libexec/PlistBuddy -c 'Print :RELOAPIOrigin' "$APP_PLIST")
EXTENSION_ORIGIN=$(/usr/libexec/PlistBuddy -c 'Print :RELOAPIOrigin' "$EXTENSION_PLIST")
APP_COMMIT=$(/usr/libexec/PlistBuddy -c 'Print :RELOSourceCommit' "$APP_PLIST")
EXTENSION_COMMIT=$(/usr/libexec/PlistBuddy -c 'Print :RELOSourceCommit' "$EXTENSION_PLIST")

if [ "$APP_ORIGIN" != "$EXPECTED_ORIGIN" ] || [ "$EXTENSION_ORIGIN" != "$EXPECTED_ORIGIN" ]; then
  echo "App/Live Activity origin mismatch: app=$APP_ORIGIN extension=$EXTENSION_ORIGIN" >&2
  exit 1
fi
if [ "$APP_COMMIT" != "$SOURCE_COMMIT" ] || [ "$EXTENSION_COMMIT" != "$SOURCE_COMMIT" ]; then
  echo "Artifact source commit mismatch" >&2
  exit 1
fi

echo "Verified Relo artifact: origin=$APP_ORIGIN source=$APP_COMMIT"
