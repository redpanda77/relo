import { useEffect, useState } from "react"

/** `Text(date, style: .time)`: "9:55 AM". */
export const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

/** `Text(date, style: .timer)`: "3:07". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** A running timer for work that started within the hour; later it reads "since 9:55 AM". */
export function Elapsed({ since, bare = false }: { since: number; bare?: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  if (now - since < 3_600_000) return <span className="tabular-nums">{elapsed(now - since)}</span>
  return bare ? null : <span>since {timeOf(since)}</span>
}
