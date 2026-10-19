import type * as React from "react"

import { cn } from "@/lib/utils"

/** Steps always draw as divided segments (a round holds at most 30); only a plan past this is one bar (as on the iPhone). */
export const STEP_SEGMENTS_MAX = 40

/**
 * The work meter, as the iPhone's `LiveStepsBar` / `LiveProgressBar` (ReloWorkCard.swift): 4px high,
 * capsule ends, in the card's tone (`--tone`).
 *
 * - Steps (up to 40): one segment per TOP-LEVEL step, 3px apart (1.5px past 16) (substeps never add segments). Done steps in
 *   the tone, the current step white at 28% and filled to the server's `fill` (its substeps, or its own
 *   progress), pending ones white at 10%. A finished work fills them all.
 * - More than 40 steps, or a plain `progress` (0...1): one bar filled to the fraction.
 * - `live`: a sweep of light runs through the filled part only (masked by it), never the track.
 *
 * No caption: the card's standing line says "2 of 6 · Run migrations".
 */
export function StepTrack({
  done = 0,
  total = 0,
  current,
  currentIndex,
  fill,
  progress,
  live = false,
  finished = false,
  className,
}: {
  done?: number
  total?: number
  current?: string | null
  /** Which top-level step is current, counting from 1 (the server's). */
  currentIndex?: number | null
  /** How far the current step is, 0...1 (the server's). */
  fill?: number | null
  /** A fraction (0...1) for work that reports progress instead of steps. */
  progress?: number | null
  /** Moving work: the sweep runs through the filled part. */
  live?: boolean
  /** A finished work: every step filled. */
  finished?: boolean
  className?: string
}) {
  const hasSteps = total > 0
  const filled = hasSteps ? (finished ? total : Math.min(Math.max(done, 0), total)) : 0
  if (hasSteps && total <= STEP_SEGMENTS_MAX) {
    const at = finished ? total : Math.min(Math.max((currentIndex ?? filled + 1) - 1, 0), total - 1)
    const label = `Step ${at + 1} of ${total}${current && !finished ? `: ${current}` : ""}`
    return (
      <div
        className={cn("step-bar", className)}
        role="progressbar"
        aria-label={finished || filled >= total ? `All ${total} steps` : label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={filled}
        data-live={(live && filled > 0) || undefined}
        data-many={total > 16 || undefined}
        style={{ ["--steps" as string]: total, ["--done" as string]: filled } as React.CSSProperties}
      >
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            data-step={finished || (index < filled && index !== at) ? "done" : index === at ? "current" : undefined}
            style={index === at && !finished && fill != null ? ({ ["--seg-fill" as string]: `${Math.min(Math.max(fill, 0), 1) * 100}%` } as React.CSSProperties) : undefined}
          />
        ))}
        {live && filled > 0 ? <span className="step-sweep" aria-hidden="true" /> : null}
      </div>
    )
  }
  const fraction = hasSteps ? filled / total : Math.min(Math.max(progress ?? 0, 0), 1)
  if (!hasSteps && (progress == null || !Number.isFinite(progress))) return null
  const percent = Math.round((finished ? 1 : fraction) * 100)
  return (
    <div
      className={cn("step-meter", className)}
      role="progressbar"
      aria-label={hasSteps ? `Step ${Math.min(filled + 1, total)} of ${total}` : "Progress"}
      aria-valuemin={0}
      aria-valuemax={hasSteps ? total : 100}
      aria-valuenow={hasSteps ? filled : percent}
      data-live={live || undefined}
      style={{ ["--fill" as string]: `${finished ? 100 : fraction * 100}%` } as React.CSSProperties}
    >
      <span className="step-meter-fill">{live ? <span className="step-sweep" aria-hidden="true" /> : null}</span>
    </div>
  )
}
