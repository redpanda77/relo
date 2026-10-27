import { Timer } from "lucide-react"

import { useTicker } from "@/lib/ticker"
import { timeLeft } from "@/lib/time-left"

const two = (value: number) => String(value).padStart(2, "0")

/** 754 -> "12:34", 4_330 -> "1:12:10". */
function clockOf(totalSeconds: number) {
  const total = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return hours > 0 ? `${hours}:${two(minutes)}:${two(total % 60)}` : `${two(minutes)}:${two(total % 60)}`
}

/**
 * The one countdown: "4:05 left", "1 h 20 min left", "Expired" once past (lib/time-left.ts). It
 * ticks on the page's one clock, a leaf, so only these words re-render. Nothing without a deadline.
 * Display only: the server decides when a question expires.
 */
export function Countdown({ deadline, className }: { deadline: string | null | undefined; className?: string }) {
  const now = useTicker(Boolean(deadline))
  const left = timeLeft(deadline ?? null, now)
  if (left === "") return null
  return (
    <span className={className ? `card-corner ${className}` : "card-corner"} data-slot="countdown">
      <Timer aria-hidden="true" />
      <time className="tabular-nums" dateTime={deadline ?? undefined}>{left ?? "Expired"}</time>
    </span>
  )
}

/** The time left alone ("4:05", "Expired"; the chip says what it is), ticking: a leaf for a chip's words. Nothing without a deadline. */
export function CountdownText({ deadline }: { deadline: string | null | undefined }) {
  const now = useTicker(Boolean(deadline))
  const left = timeLeft(deadline ?? null, now)
  if (left === "") return null
  return <time className="tabular-nums" dateTime={deadline ?? undefined}>{left?.replace(/ left$/u, "") ?? "Expired"}</time>
}

/** "QUIET 14 MIN": minutes since the instant, ticking. */
export function QuietFor({ since }: { since: string }) {
  const now = useTicker(true)
  const started = new Date(since).valueOf()
  if (!Number.isFinite(started)) return <>Quiet</>
  const minutes = Math.max(1, Math.floor(((now || started) - started) / 60_000))
  return <>{`Quiet ${minutes} min`}</>
}

/** "12:40", ticking on the page's one clock (a leaf: only these words re-render); `prefix` adds a word ("running "). Display only. */
export function RunningFor({ since, className, prefix = "" }: { since: string; className?: string; prefix?: string }) {
  const now = useTicker(true)
  const started = new Date(since).valueOf()
  if (!Number.isFinite(started)) return null
  return (
    <time className={className ? `tabular-nums ${className}` : "tabular-nums"} dateTime={since}>
      {`${prefix}${clockOf(((now || started) - started) / 1000)}`}
    </time>
  )
}
