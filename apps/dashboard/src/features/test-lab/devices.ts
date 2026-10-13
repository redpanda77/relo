import type { TestDevice } from "@/features/test-lab/types"

export const CONNECTIONS_HREF = "/dashboard/connections"

/** Why a phone can't take a test yet, in words the owner can act on. */
export function deviceBlocker(device: TestDevice): string | null {
  if (device.ready) return null
  if (device.notificationAuthorization !== "authorized")
    return "Notifications are turned off on this iPhone"
  if (device.liveActivityAuthorization !== "authorized")
    return "Live Activities are turned off on this iPhone"
  return "Open Relo on this iPhone to finish setup"
}
