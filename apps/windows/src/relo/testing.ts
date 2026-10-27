// Test helper: the shared contract fixture (owner-state-v1.json, mirrored in apps/ios) as a parsed Now summary.

import { nowSummarySchema, type NowSummary } from "@relo/notification-contracts"
import { readFileSync } from "node:fs"

export function fixtureSummary(): NowSummary {
  const url = new URL("../../../ios/Tests/ReloCoreTests/Fixtures/owner-state-v1.json", import.meta.url)
  return nowSummarySchema.parse(JSON.parse(readFileSync(url, "utf8")).nowSummary)
}
