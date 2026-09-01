#!/bin/sh
set -eu

if [ -z "${RELO_PHONE:-}" ]; then
  echo "Set RELO_PHONE to the devicectl device identifier." >&2
  exit 2
fi

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_DIRECTORY=$(git -C "$SCRIPT_DIRECTORY" rev-parse --show-toplevel)
RELO_CLI=${RELO_CLI:-$(command -v relo)}
EXPECTED_ORIGIN=${RELO_EXPECTED_ORIGIN:-}
APP_BUNDLE_ID=${RELO_BUNDLE_ID:-com.example.relo.notifications}
APP_BUNDLE="$REPOSITORY_DIRECTORY/.build/ios-authoritative/Build/Products/Debug-iphoneos/Relo.app"
SMOKE_KEY="ios-real-device-smoke-$(date -u +%Y%m%dT%H%M%SZ)"
TEMPORARY_DIRECTORY=$(mktemp -d /tmp/relo-real-device-smoke.XXXXXX)
trap 'rm -rf "$TEMPORARY_DIRECTORY"' EXIT

if [ -z "$EXPECTED_ORIGIN" ]; then
  echo "Set RELO_EXPECTED_ORIGIN to the exact HTTPS origin used by this device build." >&2
  exit 2
fi

curl --fail --silent --show-error --output /dev/null "$EXPECTED_ORIGIN/dashboard"
"$SCRIPT_DIRECTORY/build-authoritative.sh" build
xcrun devicectl device install app --device "$RELO_PHONE" "$APP_BUNDLE"
xcrun devicectl device process launch --device "$RELO_PHONE" --terminate-existing "$APP_BUNDLE_ID"

DEVICES=$($RELO_CLI devices list --json)
DEVICE_ID=${RELO_DEVICE_ID:-$(printf '%s' "$DEVICES" | jq -r '.data.devices[0].deviceId // empty')}
if [ -z "$DEVICE_ID" ]; then
  echo "The Relo server did not report an active iPhone registration." >&2
  exit 1
fi

START=$($RELO_CLI activity start \
  --key "$SMOKE_KEY" \
  --title 'Relo real-device smoke' \
  --status Started \
  --progress 0.1 \
  --style standard \
  --device "$DEVICE_ID" \
  --idempotency-key "$SMOKE_KEY-start" \
  --json)
ACTIVITY_ID=$(printf '%s' "$START" | jq -r '.data.activity.id // empty')
if [ -z "$ACTIVITY_ID" ]; then
  echo "Live Activity start did not return an activity identifier." >&2
  exit 1
fi

wait_for_observation() {
  expected_sequence=$1
  terminal_required=$2
  attempt=1
  while [ "$attempt" -le 20 ]; do
    destination="$TEMPORARY_DIRECTORY/sequence-$expected_sequence-attempt-$attempt"
    if xcrun devicectl device copy from \
        --device "$RELO_PHONE" \
        --domain-type appDataContainer \
        --domain-identifier "$APP_BUNDLE_ID" \
        --source '/Library/Application Support/Relo/accounts' \
        --destination "$destination" \
        --quiet; then
      ledger=$(find "$destination" -name live-activity-ledger.json -print -quit)
      if [ -n "$ledger" ] && jq -e \
          --arg identity "$ACTIVITY_ID|1" \
          --argjson sequence "$expected_sequence" \
          --argjson terminal "$terminal_required" '
        .schemaVersion == 1
        and ((.payload.systemObservationsByActivityIdentity[$identity] // []) | any(
          .[];
          .snapshot.sequence == $sequence
          and ($terminal == false or .snapshot.isTerminal == true)
        ))
      ' "$ledger" >/dev/null; then
        return 0
      fi
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
}

if ! wait_for_observation 0 false; then
  echo "The phone did not record the Live Activity start within 20 seconds." >&2
  exit 1
fi

$RELO_CLI activity update "$ACTIVITY_ID" \
  --status Updated \
  --progress 0.7 \
  --idempotency-key "$SMOKE_KEY-update" \
  --json >/dev/null
if ! wait_for_observation 1 false; then
  echo "The phone did not record the Live Activity update within 20 seconds." >&2
  exit 1
fi

$RELO_CLI activity end "$ACTIVITY_ID" \
  --status Completed \
  --progress 1 \
  --dismiss-after 5s \
  --idempotency-key "$SMOKE_KEY-end" \
  --json >/dev/null

if ! wait_for_observation 2 true; then
  echo "The phone did not record the terminal Live Activity end within 20 seconds." >&2
  exit 1
fi

latest_accounts=$(find "$TEMPORARY_DIRECTORY" -type d -name 'acc_*' -print | tail -1)
inbox=$(find "$latest_accounts" -maxdepth 1 -name inbox.json -print -quit)
if [ -z "$inbox" ] || ! jq -e '
  .schemaVersion == 1
  and (.payload.items | length) <= 250
  and .payload.lastSuccessfulSyncAt != null
' "$inbox" >/dev/null; then
  echo "The phone did not expose a healthy bounded current Inbox snapshot." >&2
  exit 1
fi

echo "Real-device smoke passed: dashboard, registration, bounded Inbox sync, Live Activity start/update/end."
