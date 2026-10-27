// Where Relo for Windows looks for updates and when a waiting update is shown again (the Mac's UpdatePolicy.swift).

/**
 * The public release feed's origin for a local install or a server on this PC (the Mac's RELOAPIOrigin): set by the
 * build (VITE_RELO_RELEASE_ORIGIN), never a host baked into the source. Unset: such installs do not check for updates.
 */
export const RELEASE_ORIGIN: string | null = (import.meta.env.VITE_RELO_RELEASE_ORIGIN as string | undefined) || null

export function isLoopback(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase()
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".localhost")
  } catch {
    return false
  }
}

/**
 * A local install, or a server on this PC, hands out no Windows app: they use the public release feed. A remote
 * server keeps its own feed. Null (no check) when there is nothing to ask.
 */
export function updateFeedUrl(serverOrigin: string | null, releaseOrigin: string | null, localMode: boolean): string | null {
  const useRelease = localMode || (serverOrigin !== null && isLoopback(serverOrigin))
  const origin = useRelease ? releaseOrigin : serverOrigin
  if (!origin) return null
  try {
    return new URL("/windows/update.json", origin).toString()
  } catch {
    return null
  }
}

/** "Later" hides the reminder for a day. */
export const SNOOZE_MS = 24 * 3_600_000

export interface Snooze {
  version: string
  until: number
}

/** A stored snooze, or null for anything that is not one (the Mac reads `relo.update.snoozedVersion` / `snoozedUntil`). */
export function parseSnooze(text: string | null): Snooze | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<Snooze> | null
    return value && typeof value.version === "string" && typeof value.until === "number" && Number.isFinite(value.until) ? { version: value.version, until: value.until } : null
  } catch {
    return null
  }
}

export function snoozedUntil(now: number): number {
  return now + SNOOZE_MS
}

/** Whether the reminder is hidden: a snooze for another version no longer counts. */
export function isSnoozed(version: string, snooze: Snooze | null, now: number): boolean {
  return snooze !== null && snooze.version === version && now < snooze.until
}

/** The line after an update: "Updated to 0.2.32", with what happened to the agents' setup when it ran. */
export function updatedLine(version: string, agents: "notApplicable" | "refreshed" | "failed"): string {
  const base = `Updated to ${version}`
  if (agents === "refreshed") return `${base} · agents refreshed`
  if (agents === "failed") return `${base} · agents not refreshed: Set up agents again in Settings`
  return base
}

/** "Version 0.2.32": the one way the app's version reads, never with the build. */
export function versionText(version: string): string {
  return `Version ${version}`
}

/** What the banner says about a waiting update. */
export function bannerText(version: string, ready: boolean): string {
  return ready ? `Relo ${version} is ready` : `Relo ${version} is available`
}
