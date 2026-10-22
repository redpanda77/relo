#!/usr/bin/env bash
# Developer ID signing without Xcode's export (scripts/release/build-mac-app.sh). `xcodebuild -exportArchive` spends about
# 35 s of its 48 looking up signing assets with Apple on every release (22 Oct), then runs nine `codesign` calls. This
# records what an export signed (each nested item, in order, with its entitlements and designated requirement, the
# identity and the Developer ID profile) and repeats those calls on the next build, while that build's code and
# entitlements are those the export saw.
#   devid-sign.sh record <exported app> <built app> <export Packaging.log> <reference dir>
#   devid-sign.sh sign <app copy to sign> <built app> <reference dir>
# `sign` exits 0 only with a signature that verifies and matches the reference item by item; any other exit means
# "export instead" (no reference, the code or entitlements changed, the profile is near expiry, a check failed).
set -euo pipefail

die() { echo "devid-sign: $*" >&2; exit 1; }
xml_entitlements() { codesign -d --entitlements - --xml "$1" 2>/dev/null || true; }
# What decides how a build is signed: its bundle id, every executable it holds, and each recorded item's own
# entitlements (development-signed in the build, but they change exactly when the distribution ones would).
fingerprint() {
  local app="$1" items="$2" rel
  {
    /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist"
    (cd "$app" && find . -type f -perm +111 | LC_ALL=C sort)
    while IFS= read -r rel; do echo "== $rel"; xml_entitlements "$app/$rel" | sed 's|<key>com.apple.security.get-task-allow</key><true/>||'; done < "$items"
  } | shasum -a 256 | cut -d' ' -f1
}

case "${1:-}" in
  record)
    exported="$2"; built="$3"; log="$4"; ref="$5"
    rm -rf "$ref.tmp"; mkdir -p "$ref.tmp"
    # The order the export signed in (inside out), from its own log: paths under the exported app.
    # Each "invoking codesign" block ends with the signed path; nothing else in the log counts.
    awk '/invoking codesign/ {on=1; next} on && /Root\/Applications\// {path=$0} on && /^\)/ {print path; on=0}' "$log" \
      | grep -oE 'Root/Applications/[^"]+' | sed -E 's|^Root/Applications/[^/]+\.app/?||; s|^$|.|' > "$ref.tmp/items"
    [[ "$(tail -1 "$ref.tmp/items")" == . ]] || die "the export log does not end with the app itself"
    authority="$(codesign -dvv "$exported" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
    [[ "$authority" == "Developer ID Application:"* ]] || die "the export is not Developer ID signed"
    security find-identity -v -p codesigning | grep -F "\"$authority\"" | awk '{print $2}' | head -1 > "$ref.tmp/identity"
    [[ -s "$ref.tmp/identity" ]] || die "no identity in the keychain for $authority"
    n=0
    while IFS= read -r rel; do
      xml_entitlements "$exported/$rel" > "$ref.tmp/entitlements-$n.plist"
      codesign -d -r- "$exported/$rel" 2>&1 | sed -n 's/^designated => //p' > "$ref.tmp/requirement-$n"
      [[ -s "$ref.tmp/requirement-$n" ]] || die "no designated requirement for $rel"
      n=$((n + 1))
    done < "$ref.tmp/items"
    cp "$exported/Contents/embedded.provisionprofile" "$ref.tmp/"
    fingerprint "$built" "$ref.tmp/items" > "$ref.tmp/fingerprint"
    rm -rf "$ref"; mv "$ref.tmp" "$ref"
    echo "devid-sign: recorded $n items from the export"
    ;;
  sign)
    app="$2"; built="$3"; ref="$4"
    [[ -s "$ref/fingerprint" && -s "$ref/identity" && -f "$ref/embedded.provisionprofile" ]] || die "no reference yet"
    [[ "$(fingerprint "$built" "$ref/items")" == "$(cat "$ref/fingerprint")" ]] || die "the build's code or entitlements changed since the reference"
    expires="$(security cms -D -i "$ref/embedded.provisionprofile" 2>/dev/null | plutil -extract ExpirationDate raw -o - - 2>/dev/null || true)"
    [[ -n "$expires" ]] && (( $(date -j -f '%Y-%m-%dT%H:%M:%SZ' "$expires" +%s) > $(date +%s) + 86400 )) || die "the reference profile expires within a day"
    cp "$ref/embedded.provisionprofile" "$app/Contents/embedded.provisionprofile"
    identity="$(cat "$ref/identity")"
    n=0
    while IFS= read -r rel; do
      # The arguments Xcode's export passes (its Packaging.log), plus an explicit secure timestamp.
      # A framework has no entitlements, and codesign refuses an empty entitlements file.
      entitlements=(); [[ -s "$ref/entitlements-$n.plist" ]] && entitlements=(--entitlements "$ref/entitlements-$n.plist")
      codesign -f -s "$identity" "${entitlements[@]+"${entitlements[@]}"}" --requirements "=designated => $(cat "$ref/requirement-$n")" \
        --preserve-metadata=identifier,flags,runtime,launch-constraints,library-constraints --generate-entitlement-der \
        --strip-disallowed-xattrs --timestamp "$app/$rel" 2>/dev/null || die "codesign failed on $rel"
      n=$((n + 1))
    done < "$ref/items"
    codesign --verify --deep --strict "$app" 2>/dev/null || die "the signed app does not verify"
    n=0
    while IFS= read -r rel; do
      info="$(codesign -dvv "$app/$rel" 2>&1)"
      grep -q "^Authority=Developer ID Application:" <<<"$info" && grep -q '^Timestamp=' <<<"$info" || die "$rel lacks a Developer ID signature with a timestamp"
      [[ "$(xml_entitlements "$app/$rel")" == "$(cat "$ref/entitlements-$n.plist")" ]] || die "$rel's entitlements differ from the export's"
      n=$((n + 1))
    done < "$ref/items"
    echo "devid-sign: signed $n items as the export would"
    ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
