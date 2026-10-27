#!/usr/bin/env bash
# Puts the server payload (scripts/release/mac-server-payload.sh) in a built Relo for Mac and signs it (plan 16):
# Contents/Resources/server (the payload), Contents/MacOS/relo-server (apps/notch/ReloServerLauncher, compiled here) and
# Contents/Library/LaunchAgents/<bundle id>.server.plist, the login agent the app registers with SMAppService.
#
#   scripts/release/embed-server.sh APP PAYLOAD [IDENTITY]
#
# IDENTITY is a codesign identity (default: the Developer ID Application the app itself was signed with, read from its
# `codesign -dvv` Authority, so the server is never signed by another certificate that happens to be first in the
# keychain). Every Mach-O under Contents/Resources (found with `file`, not by extension) is signed inside out with the
# hardened runtime and a timestamp, and codesign's errors are printed; Node alone gets com.apple.security.cs.allow-jit.
# At the end the signed Node and PostgreSQL are run from the bundle: an embed that cannot run fails the build. The app itself is
# signed again with the entitlements and provisioning profile it already carries, so a Developer ID build stays one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="${1:?usage: embed-server.sh APP PAYLOAD [IDENTITY]}"
PAYLOAD="${2:?usage: embed-server.sh APP PAYLOAD [IDENTITY]}"
STEP="$ROOT/scripts/step.mjs"
say() { printf 'embed-server: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

[[ -d "$APP/Contents" ]] || die "$APP is not an app"
[[ -x "$PAYLOAD/node" && -d "$PAYLOAD/app/server/dist" ]] || die "$PAYLOAD is not a server payload"
IDENTITY="${3:-$(codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=\(Developer ID Application: .*\)$/\1/p' | head -1)}"
[[ -n "$IDENTITY" ]] || die "$APP was not signed with a Developer ID Application identity (no such Authority in codesign -dvv)"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rm -rf "$APP/Contents/Resources/server" && cp -R "$PAYLOAD" "$APP/Contents/Resources/server"
node "$STEP" --name launcher --timeout 5m --quiet 3m -- xcrun swiftc -O -target arm64-apple-macos14 \
  -o "$APP/Contents/MacOS/relo-server" "$ROOT/apps/notch/ReloServerLauncher/main.swift"
mkdir -p "$APP/Contents/Library/LaunchAgents"
cat > "$APP/Contents/Library/LaunchAgents/$BUNDLE_ID.server.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$BUNDLE_ID.server</string>
<key>BundleProgram</key><string>Contents/MacOS/relo-server</string>
<key>AssociatedBundleIdentifiers</key><array><string>$BUNDLE_ID</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<!-- The launcher (apps/notch/ReloServerLauncher) redirects its own output to ~/Library/Application Support/Relo/server/logs/relo.log. -->
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
PLIST

cat > "$WORK/node.entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>
PLIST
# codesign's own messages stay visible: a failure says which file and why.
sign() { codesign --force --options runtime --timestamp --sign "$IDENTITY" "$@" >&2 || die "could not sign ${*: -1}"; }
say "signing the server (inside out)"
# Every Mach-O under Resources (libraries, loadable modules, PostgreSQL's programs, the app's own helpers) is told by its
# content, not its name or mode; Node is signed after them, with its entitlement.
MACHO=0
while IFS= read -r -d '' file; do
  [[ "$file" == "$APP/Contents/Resources/server/node" ]] && continue
  if file -b "$file" | grep -q "Mach-O"; then sign "$file"; MACHO=$((MACHO + 1)); fi
done < <(find "$APP/Contents/Resources" -type f -print0)
(( MACHO > 0 )) || die "found no Mach-O under $APP/Contents/Resources to sign"
sign --entitlements "$WORK/node.entitlements" "$APP/Contents/Resources/server/node"
sign "$APP/Contents/MacOS/relo-server"
# The app last, keeping what it was signed with: its entitlements (the profile stays embedded in the bundle).
codesign -d --entitlements - --xml "$APP" > "$WORK/app.entitlements" 2>/dev/null || true
if [[ -s "$WORK/app.entitlements" ]]; then sign --entitlements "$WORK/app.entitlements" "$APP"; else sign "$APP"; fi
node "$STEP" --name verify --timeout 3m --quiet 2m -- codesign --verify --deep --strict "$APP" || die "$APP does not verify"
# The signed server must run from inside the bundle (a library signed wrongly or left out fails here, not on the owner's Mac).
"$APP/Contents/Resources/server/node" -v >&2 || die "the signed Node does not run from the bundle"
"$APP/Contents/Resources/server/app/postgres/bin/postgres" --version >&2 || die "the signed PostgreSQL does not run from the bundle"
say "ready: $(du -sh "$APP" | cut -f1) $(basename "$APP") with its server, agent $BUNDLE_ID.server"
