/** "4:05 left", "1 h 20 min left"; "" without a deadline; null once the time is up. */
export function timeLeft(expiresAt: string | null, now: number): string | null {
  if (!expiresAt) return ""
  const ms = Date.parse(expiresAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return null
  const seconds = Math.ceil(ms / 1000)
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return minutes ? `${hours} h ${minutes} min left` : `${hours} h left`
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left`
}
