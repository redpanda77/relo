#!/bin/bash
set -euo pipefail

RELO_REPOSITORY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export RELO_DERIVED_DATA="${RELO_DERIVED_DATA:-$(mktemp -d /tmp/relo-ios-build.XXXXXX)}"
RELO_RESULT_BUNDLE="${RELO_RESULT_BUNDLE:-$RELO_DERIVED_DATA/ReloTests-$(date +%s).xcresult}"

# Select the newest installed release (non-beta) Xcode 27+, without relying on runner defaults.
if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  DEVELOPER_DIR="$(python3 - <<'PY'
import os, pathlib, re, subprocess
candidates = []
for app in pathlib.Path('/Applications').glob('Xcode*.app'):
    if 'beta' in app.name.lower():
        continue
    developer = str(app / 'Contents/Developer')
    probe = subprocess.run(['xcodebuild', '-version'], env={**os.environ, 'DEVELOPER_DIR': developer}, capture_output=True, text=True)
    match = re.search(r'^Xcode (\d+(?:\.\d+)*)', probe.stdout)
    if probe.returncode == 0 and match:
        version = tuple(map(int, match[1].split('.')))
        if version[0] >= 27:
            candidates.append((version, developer))
if not candidates:
    raise SystemExit('Install a release Xcode 27 or newer before running the native gate.')
print(max(candidates)[1])
PY
)"
  export DEVELOPER_DIR
fi
xcodebuild -version
swift --version

RELO_CREATED_SIMULATOR=""
cleanup() {
  if [[ -n "$RELO_CREATED_SIMULATOR" ]]; then
    xcrun simctl shutdown "$RELO_CREATED_SIMULATOR" >/dev/null 2>&1 || true
    xcrun simctl delete "$RELO_CREATED_SIMULATOR" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -z "${RELO_SIMULATOR_UDID:-}" ]]; then
  RELO_SIMULATOR_UDID="$(python3 - <<'PY'
import json, subprocess
devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '-j']))['devices']
for runtime, entries in sorted(devices.items(), reverse=True):
    if '.iOS-' not in runtime:
        continue
    template = next((d for d in entries if d.get('isAvailable') and d['name'].startswith('iPhone')), None)
    if template:
        print(subprocess.check_output(['xcrun', 'simctl', 'create', 'Relo Native CI', template['deviceTypeIdentifier'], runtime], text=True).strip())
        break
else:
    raise SystemExit('Install an iPhone simulator runtime before running the native gate.')
PY
)"
  RELO_CREATED_SIMULATOR="$RELO_SIMULATOR_UDID"
fi

node "$RELO_REPOSITORY_ROOT/scripts/check-ios-boundaries.mjs"
node "$RELO_REPOSITORY_ROOT/scripts/check-ios-design-system.mjs"

cd "$RELO_REPOSITORY_ROOT/apps/ios"
xcodegen generate
# project.yml is the source of truth; the committed project must be exactly what it generates.
if ! git diff --quiet -- Relo.xcodeproj || [ -n "$(git ls-files --others --exclude-standard -- Relo.xcodeproj)" ]; then
  echo "Relo.xcodeproj is out of date with project.yml: commit the regenerated project." >&2
  git status --short -- Relo.xcodeproj >&2
  exit 1
fi
xcodebuild -project Relo.xcodeproj -scheme Relo \
  -destination "platform=iOS Simulator,id=$RELO_SIMULATOR_UDID" \
  -derivedDataPath "$RELO_DERIVED_DATA" \
  -resultBundlePath "$RELO_RESULT_BUNDLE" \
  test CODE_SIGNING_ALLOWED=NO ENABLE_DEBUG_DYLIB=NO \
  'RELO_SIMULATOR_TEST_ENTITLEMENTS_FLAGS=-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements -Xlinker $(SRCROOT)/Config/SimulatorTest.entitlements'

# Build shared intent/widget source in its independent host as well.
xcodebuild -project Relo.xcodeproj -scheme ReloNativeReference \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$RELO_DERIVED_DATA" build CODE_SIGNING_ALLOWED=NO
