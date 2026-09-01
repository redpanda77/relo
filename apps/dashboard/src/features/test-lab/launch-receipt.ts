import { z } from "zod"

export const launchRunReceiptSchema = z.object({
  activityId: z.string().min(1),
  generation: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  operation: z.enum(["start", "update"]),
  reused: z.boolean(),
  resumed: z.boolean(),
})

export type LaunchRunReceipt = z.infer<typeof launchRunReceiptSchema>

const RECENT_LAUNCH_KEY = "relo:test-lab-recent-launch:v1"

export function rememberLaunchReceipt(receipt: LaunchRunReceipt) {
  try {
    sessionStorage.setItem(RECENT_LAUNCH_KEY, JSON.stringify(receipt))
  } catch {
    // A private browsing policy may disable session storage. The run still launches.
  }
}

export function takeLaunchReceipt(
  activityId: string,
  generation: number,
  sequence: number
): LaunchRunReceipt | null {
  try {
    const value = sessionStorage.getItem(RECENT_LAUNCH_KEY)
    sessionStorage.removeItem(RECENT_LAUNCH_KEY)
    if (!value) return null
    const receipt = launchRunReceiptSchema.parse(JSON.parse(value))
    return receipt.activityId === activityId &&
      receipt.generation === generation &&
      receipt.sequence === sequence
      ? receipt
      : null
  } catch {
    sessionStorage.removeItem(RECENT_LAUNCH_KEY)
    return null
  }
}
