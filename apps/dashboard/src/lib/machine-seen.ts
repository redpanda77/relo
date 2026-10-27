/** A machine is "live" in the dot when it was seen within this window (the iPhone's machine header). */
export const MACHINE_LIVE_MS = 10 * 60_000

/** The status dot of a computer, phone or browser: mint when seen within 10 minutes, else slate. */
export function seenDot(lastSeenAt: string | null | undefined, now: number = Date.now()): "mint" | "slate" {
  if (!lastSeenAt) return "slate"
  const at = Date.parse(lastSeenAt)
  return Number.isFinite(at) && now - at <= MACHINE_LIVE_MS ? "mint" : "slate"
}
