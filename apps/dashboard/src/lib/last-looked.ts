/**
 * The owner's last look at Now in this browser: a device fact sent to the server as `since`
 * (category E). Absent or unreadable storage means the server's default window.
 */
const key = (accountId: string) => `relo.now.lastLookedAt.${accountId}`

export function readLastLooked(accountId: string): string | null {
  try {
    const value = window.localStorage.getItem(key(accountId))
    return value && Number.isFinite(new Date(value).valueOf()) ? value : null
  } catch {
    return null
  }
}

export function writeLastLooked(accountId: string, at: string = new Date().toISOString()) {
  try {
    window.localStorage.setItem(key(accountId), at)
  } catch {
    // Storage blocked: the server falls back to its default window.
  }
}
