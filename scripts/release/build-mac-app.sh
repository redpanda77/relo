#!/usr/bin/env bash
# Relo for Mac (apps/notch) as the server hands it out (apps/server/mac/README.md): build, sign, notarize when this
# Mac can, zip, and write the manifest the install script pins. `pnpm deploy:prod` runs it before the image is built.
#
#   scripts/release/build-mac-app.sh [OUT_DIR]      (default apps/server/mac)
#
# Signing: Developer ID Application (Xcode > Settings > Accounts signed in to the team, or the certificate in the
# keychain). Without it the build's own development signature is kept and the script says so: such a build runs on
# this team's registered Macs only. Notarization: when the keychain holds a notarytool profile (RELO_NOTARY_PROFILE,
# default relo-notary; `xcrun notarytool store-credentials relo-notary`). An install with curl adds no quarantine flag,
# so a build without it still opens.
# Updates: the zip is signed with Sparkle's EdDSA key from a file, never the keychain (a keychain read can wait on an
# invisible prompt): RELO_SPARKLE_KEY_FILE, default ~/.config/relo/sparkle/ed25519.key (`node scripts/release/sparkle-key.mjs
# init` makes it; its public half is RELO_SPARKLE_PUBLIC_KEY in Relo.local.xcconfig). The manifest carries the signature
# the server's /mac/appcast.xml hands installed apps. Without the file the build ships but apps never take it as an update.
# Every long command runs through scripts/step.mjs (plan 15): a budget, a no-output timeout, no stdin. The build is the
# one heavy step (background priority); Developer ID builds are exported from it, not archived. Derived data is fixed (RELO_MAC_DERIVED_DATA, default
# ~/Library/Caches/relo/notch-derived-data), and so is the source: apps/notch and apps/ios (its local package) are synced
# into RELO_MAC_SOURCE (default ~/Library/Caches/relo/mac-source, as notch/ and ios/) by content, so files that did not change keep their path and time and Xcode
# recompiles only what changed (a release builds from a fresh clone; built in place, every file looked new). Release
# compiles incrementally (SWIFT_COMPILATION_MODE=incremental, still optimized): whole-module mode recompiled every
# module on any change (446 s for a one-line change against 468 s from scratch, 19 Oct).
# A build is cached by the tree of apps/notch and apps/ios/Sources: an unchanged app is not built again.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-$ROOT/apps/server/mac}"
NOTCH="$ROOT/apps/notch"
PROFILE="${RELO_NOTARY_PROFILE:-relo-notary}"
STEP="$ROOT/scripts/step.mjs"
KEY_FILE="${RELO_SPARKLE_KEY_FILE:-$HOME/.config/relo/sparkle/ed25519.key}"
DERIVED="${RELO_MAC_DERIVED_DATA:-$HOME/Library/Caches/relo/notch-derived-data}"
SOURCE="${RELO_MAC_SOURCE:-$HOME/Library/Caches/relo/mac-source}"
say() { printf 'mac-app: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

[[ "$(uname -s)" == Darwin ]] || die "builds only on a Mac"
[[ -f "$NOTCH/Configuration/Relo.local.xcconfig" ]] || die "no apps/notch/Configuration/Relo.local.xcconfig (team and bundle id)"
TEAM="$(sed -n 's/^RELO_DEVELOPMENT_TEAM *= *//p' "$NOTCH/Configuration/Relo.local.xcconfig" | tr -d '[:space:]')"
[[ -n "$TEAM" ]] || die "Relo.local.xcconfig names no RELO_DEVELOPMENT_TEAM"

KEY="$(git -C "$ROOT" rev-parse HEAD:apps/notch | cut -c1-12)-$(git -C "$ROOT" rev-parse HEAD:apps/ios/Sources | cut -c1-12)"
BUILD="$(git -C "$ROOT" rev-list --count HEAD -- apps/notch apps/ios/Sources)"
CACHE="${XDG_CACHE_HOME:-$HOME/Library/Caches}/relo/mac-app/$KEY"
if ! git -C "$ROOT" diff --quiet HEAD -- apps/notch apps/ios/Sources; then
  say "apps/notch or apps/ios/Sources has uncommitted changes: building them, not caching"
  CACHE=""
fi

if [[ -n "$CACHE" && -f "$CACHE/manifest.json" && -f "$CACHE/relo-mac.zip" ]]; then
  say "unchanged since the last build ($KEY): reusing it"
else
  # The app's own tests first (ReloNotchKit): the release gates run on the Linux builder, which has no Swift for macOS,
  # so nothing else runs them, and a stale test once sat failing on main unnoticed (19 Oct). They run in a copy that
  # keeps the repository's layout (the kit, the iOS package it depends on, the fixtures its tests read) and its .build
  # between releases, so only what changed compiles: a release's fresh clone compiled the kit and its packages from
  # nothing every time (152 s, 22 Oct). They test ReloNotchKit alone, so a kit whose tree passed before (an app view, a
  # sound) skips them; uncommitted changes always run them.
  KIT="$(git -C "$ROOT" rev-parse HEAD:apps/notch/ReloNotchKit):$(git -C "$ROOT" rev-parse HEAD:apps/ios):$(git -C "$ROOT" rev-parse HEAD:packages/cli/test/fixtures)"
  KIT_PASSED="${XDG_STATE_HOME:-$HOME/.local/state}/relo/notch-kit-passed"
  KIT_SOURCE="${RELO_NOTCH_KIT_SOURCE:-$HOME/Library/Caches/relo/kit-source}"
  if [[ -n "$CACHE" ]] && grep -qxF "$KIT" "$KIT_PASSED" 2>/dev/null; then
    say "ReloNotchKit and what its tests read are unchanged since they last passed: not running them again"
  else
    for part in apps/notch/ReloNotchKit apps/ios packages/cli/test/fixtures; do
      mkdir -p "$KIT_SOURCE/$part"
      node "$STEP" --name "sync $part" --timeout 2m --quiet 1m -- rsync -rlc --delete --exclude=xcuserdata/ --exclude=build/ \
        --exclude=.build/ --exclude=DerivedData/ --exclude=.DS_Store "$ROOT/$part/" "$KIT_SOURCE/$part/" || die "could not sync $part into $KIT_SOURCE"
    done
    node "$STEP" --name "Relo for Mac tests" --timeout 15m --quiet 10m --heavy -- \
      swift test --quiet --package-path "$KIT_SOURCE/apps/notch/ReloNotchKit" || die "Relo for Mac's tests failed: not building it"
    if [[ -n "$CACHE" ]]; then
      mkdir -p "$(dirname "$KIT_PASSED")"; { tail -n 49 "$KIT_PASSED" 2>/dev/null || true; echo "$KIT"; } > "$KIT_PASSED.tmp" && mv "$KIT_PASSED.tmp" "$KIT_PASSED"
    fi
  fi
  WORK="$(cd "$(mktemp -d)" && pwd -P)"
  # One build at a time owns the shared source and derived-data folders, from the sync until the app is copied out:
  # the heavy slot alone covered only the compile, so two builds (a release and a fix build, 19 Oct) could compile or
  # package each other's code. The lock is a directory holding the owner's pid; a dead owner's lock is taken over.
  LOCK="${XDG_STATE_HOME:-$HOME/.local/state}/relo/mac-build.lock"
  mkdir -p "$(dirname "$LOCK")"
  for waited in $(seq 0 1800); do
    if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; break; fi
    owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [[ -n "$owner" ]] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
    (( waited % 60 == 0 )) && say "waiting for another Mac app build (pid ${owner:-?}) to finish"
    (( waited == 1800 )) && die "another Mac app build has held the build folders for 30 minutes"
    sleep 1
  done
  trap 'rm -rf "$WORK"; [[ "$(cat "$LOCK/pid" 2>/dev/null)" == $$ ]] && rm -rf "$LOCK"' EXIT
  # A whole-module compile prints nothing for minutes: a line a minute tells the steps around this one (the release's
  # own no-output limit) that the build is alive, not hung.
  ( while sleep 60 >/dev/null 2>&1; do say "still building"; done ) &   # the sleep holds no output pipe (scripts/gates.sh)
  HEARTBEAT=$!
  trap 'kill $HEARTBEAT 2>/dev/null; rm -rf "$WORK"; [[ "$(cat "$LOCK/pid" 2>/dev/null)" == $$ ]] && rm -rf "$LOCK"' EXIT
  # -c compares content; no -t: an unchanged file keeps its old time, a changed one gets a new one.
  for app in notch ios; do
    mkdir -p "$SOURCE/$app"
    node "$STEP" --name "sync-$app" --timeout 2m --quiet 1m -- rsync -rlc --delete --exclude=xcuserdata/ --exclude=build/ \
      --exclude=.build/ --exclude=DerivedData/ --exclude=.DS_Store "$ROOT/apps/$app/" "$SOURCE/$app/" || die "could not sync apps/$app into $SOURCE"
  done
  # Always a Release build into the fixed derived data, which compiles only what changed. Xcode's archive action
  # rebuilds everything every time (504 s with nothing changed, 19 Oct; over 25 min once the voice brought MLX's C++,
  # 21 Oct), so a Developer ID export wraps the built app in an archive folder of its own instead: the export re-signs
  # it with Developer ID and its profile exactly as it would an archive's.
  COMMON=(-project "$SOURCE/notch/boringNotch.xcodeproj" -scheme boringNotch -configuration Release -derivedDataPath "$DERIVED"
    -jobs 4 -allowProvisioningUpdates CURRENT_PROJECT_VERSION="$BUILD" COMPILER_INDEX_STORE_ENABLE=NO SWIFT_COMPILATION_MODE=incremental)
  say "building (build $BUILD)"
  node "$STEP" --name build --timeout 40m --quiet 10m --heavy -- xcodebuild "${COMMON[@]}" build \
    >"$WORK/build.log" 2>&1 || { tail -20 "$WORK/build.log" >&2; die "the build failed"; }
  BUILT="$(find "$DERIVED/Build/Products/Release" -maxdepth 1 -name '*.app' | head -1)"
  [[ -n "$BUILT" ]] || die "the build made no app"
  if [[ "${RELO_MAC_DEVELOPER_ID:-}" == 1 ]] || node "$STEP" --name find-identity --timeout 30s --quiet 30s -- \
      security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
    # Signing as the last export did takes about 10 s; Xcode's export spends some 35 s of its 48 looking up signing
    # assets with Apple (scripts/release/devid-sign.sh). It is used while the build's code and entitlements are those
    # the export saw; otherwise the export runs, and its result becomes the new reference.
    DEVID_REF="${XDG_CACHE_HOME:-$HOME/Library/Caches}/relo/devid-reference"
    mkdir -p "$WORK/export" && cp -R "$BUILT" "$WORK/export/"
    if node "$STEP" --name devid-sign --timeout 5m --quiet 2m -- "$ROOT/scripts/release/devid-sign.sh" sign "$WORK/export/$(basename "$BUILT")" "$BUILT" "$DEVID_REF"; then
      SIGNED="developer-id"
    else
      rm -rf "$WORK/export"
      say "exporting for Developer ID"
      mkdir -p "$WORK/notch.xcarchive/Products/Applications"
      cp -R "$BUILT" "$WORK/notch.xcarchive/Products/Applications/"
      plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$BUILT/Contents/Info.plist"; }
      cat >"$WORK/notch.xcarchive/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>ApplicationProperties</key><dict>
<key>ApplicationPath</key><string>Applications/$(basename "$BUILT")</string>
<key>Architectures</key><array><string>arm64</string></array>
<key>CFBundleIdentifier</key><string>$(plist CFBundleIdentifier)</string>
<key>CFBundleShortVersionString</key><string>$(plist CFBundleShortVersionString)</string>
<key>CFBundleVersion</key><string>$(plist CFBundleVersion)</string>
<key>Team</key><string>$TEAM</string>
</dict>
<key>ArchiveVersion</key><integer>2</integer>
<key>CreationDate</key><date>$(date -u +%Y-%m-%dT%H:%M:%SZ)</date>
<key>Name</key><string>boringNotch</string>
<key>SchemeName</key><string>boringNotch</string>
</dict></plist>
PLIST
      cat >"$WORK/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>developer-id</string>
<key>signingStyle</key><string>automatic</string>
<key>teamID</key><string>$TEAM</string>
<key>destination</key><string>export</string>
</dict></plist>
PLIST
      SIGNED="developer-id"
      if ! node "$STEP" --name export --timeout 10m --quiet 3m -- xcodebuild -exportArchive -archivePath "$WORK/notch.xcarchive" -exportOptionsPlist "$WORK/export.plist" \
          -exportPath "$WORK/export" -allowProvisioningUpdates >"$WORK/export.log" 2>&1; then
        SIGNED="development"
        say "the Developer ID export failed: keeping the development signature, which runs on this team's registered Macs only"
        mkdir -p "$WORK/export"
        cp -R "$WORK/notch.xcarchive/Products/Applications/"*.app "$WORK/export/"
      fi
      if [[ "$SIGNED" == developer-id ]]; then
        "$ROOT/scripts/release/devid-sign.sh" record "$(find "$WORK/export" -maxdepth 1 -name '*.app' | head -1)" "$BUILT" "$WORK/export/Packaging.log" "$DEVID_REF" \
          || say "could not record this export for direct signing; the next release exports again"
      fi
    fi
  else
    SIGNED="development"
    say "no Developer ID on this Mac (Xcode > Settings > Accounts): the development signature runs on this team's registered Macs only"
    mkdir -p "$WORK/export"
    cp -R "$BUILT" "$WORK/export/"
  fi
  APP_PATH="$(find "$WORK/export" -maxdepth 1 -name '*.app' | head -1)"
  [[ -n "$APP_PATH" ]] || die "the export holds no app"
  APP="$(basename "$APP_PATH")"
  node "$STEP" --name codesign-verify --timeout 2m --quiet 1m -- codesign --verify --deep --strict "$APP_PATH" || die "$APP does not verify"

  NOTARIZED=false
  if [[ "$SIGNED" == developer-id ]] && node "$STEP" --name notary-profile --timeout 1m --quiet 30s -- xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
    say "notarizing (profile $PROFILE)"
    node "$STEP" --name ditto-notarize --timeout 5m --quiet 3m -- ditto -c -k --keepParent "$APP_PATH" "$WORK/notarize.zip"
    node "$STEP" --name notarytool --timeout 30m --quiet 30m -- xcrun notarytool submit "$WORK/notarize.zip" --keychain-profile "$PROFILE" --wait >&2 || die "notarization failed"
    node "$STEP" --name stapler --timeout 5m --quiet 2m -- xcrun stapler staple "$APP_PATH" >&2
    NOTARIZED=true
  elif [[ "$SIGNED" == developer-id ]]; then
    say "not notarized: no notarytool profile $PROFILE in the keychain (an install with curl opens it all the same)"
  fi

  VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
  EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Contents/Info.plist")"
  MINIMUM="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$APP_PATH/Contents/Info.plist" 2>/dev/null || echo "")"
  STAGE="$WORK/out"
  mkdir -p "$STAGE"
  node "$STEP" --name ditto-zip --timeout 5m --quiet 3m -- ditto -c -k --keepParent "$APP_PATH" "$STAGE/relo-mac.zip"
  SHA="$(shasum -a 256 "$STAGE/relo-mac.zip" | cut -d' ' -f1)"
  SPARKLE_BIN="$DERIVED/SourcePackages/artifacts/sparkle/Sparkle/bin"
  ED_SIGNATURE=""
  if [[ -f "$KEY_FILE" && -x "$SPARKLE_BIN/sign_update" ]] && SIGNATURE_LINE="$(node "$STEP" --name sign_update --timeout 2m --quiet 30s -- "$SPARKLE_BIN/sign_update" --ed-key-file "$KEY_FILE" "$STAGE/relo-mac.zip" 2>/dev/null)"; then
    ED_SIGNATURE="$(sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p' <<<"$SIGNATURE_LINE")"
  fi
  [[ -n "$ED_SIGNATURE" ]] || say "no Sparkle signing key file (node scripts/release/sparkle-key.mjs init; now $KEY_FILE): installed apps will not take this build as an update"
  LENGTH="$(stat -f %z "$STAGE/relo-mac.zip")"
  node -e 'const [file,short,build,sha256,app,executable,signed,notarized,edSignature,length,minimumSystemVersion]=process.argv.slice(1);
    require("fs").writeFileSync(file,JSON.stringify({version:`${short}+${build}`,shortVersion:short,build,sha256,app,executable,signed,
      notarized:notarized==="true",...(edSignature?{edSignature}:{}),length:Number(length),...(minimumSystemVersion?{minimumSystemVersion}:{})},null,2)+"\n")' \
    "$STAGE/manifest.json" "$VERSION" "$BUILD" "$SHA" "$APP" "$EXECUTABLE" "$SIGNED" "$NOTARIZED" "$ED_SIGNATURE" "$LENGTH" "$MINIMUM"
  if [[ -n "$CACHE" ]]; then
    rm -rf "$CACHE" && mkdir -p "$CACHE" && cp "$STAGE/relo-mac.zip" "$STAGE/manifest.json" "$CACHE/"
  fi
  CACHE="${CACHE:-$STAGE}"
fi

mkdir -p "$OUT"
cp "$CACHE/relo-mac.zip" "$CACHE/manifest.json" "$OUT/"

# Storage keeps itself (dev mode): only the newest cached build (it skips rebuilding an unchanged app), and no Xcode derived data left by a release clone that is gone
# (on 19 Oct two such folders held 2.2 GB). The owner's own Xcode folders are never touched.
for old in "${XDG_CACHE_HOME:-$HOME/Library/Caches}"/relo/mac-app/*; do
  if [[ -d "$old" && "$old" != "${CACHE%/}" ]]; then rm -rf "$old"; fi
done
for data in "$HOME"/Library/Developer/Xcode/DerivedData/boringNotch-*; do
  workspace="$(/usr/libexec/PlistBuddy -c 'Print :WorkspacePath' "$data/info.plist" 2>/dev/null || true)"
  if [[ "$workspace" == */relo-deploy.*/repo/* && ! -e "$workspace" ]]; then rm -rf "$data"; fi
done
say "ready: $(node -p 'const m=require(process.argv[1]);`${m.app} ${m.version}, ${m.signed}${m.notarized?", notarized":""}`' "$OUT/manifest.json") in $OUT"
