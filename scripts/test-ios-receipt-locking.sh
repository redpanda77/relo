#!/bin/bash
set -euo pipefail
RELO_RECEIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELO_RECEIPT_TEMP="$(mktemp -d /tmp/relo-receipt-locking.XXXXXX)"
trap 'rm -rf "$RELO_RECEIPT_TEMP"' EXIT
xcrun swiftc \
  "$RELO_RECEIPT_ROOT/apps/ios/Sources/NotificationSupport/ReceiptScope.swift" \
  "$RELO_RECEIPT_ROOT/apps/ios/Sources/NotificationSupport/NotificationReceiptFile.swift" \
  "$RELO_RECEIPT_ROOT/apps/ios/Tests/ReceiptProcessHarness/main.swift" \
  -o "$RELO_RECEIPT_TEMP/receipt-locking"
"$RELO_RECEIPT_TEMP/receipt-locking" "$RELO_RECEIPT_TEMP/store"
