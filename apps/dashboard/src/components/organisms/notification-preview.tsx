import { Bell } from "lucide-react"

import { LockScreenSurface } from "@/components/organisms/live-activity-preview"
import type { BuilderDraft } from "@/features/test-lab/types"

const HEX = /^#[\da-f]{6}$/i

/**
 * The Test Lab's Lock Screen preview of a draft: the shared card surface (live-activity-preview.tsx, drawn like
 * ReloLiveActivityWidget.swift) around the draft's source mark, title, subtitle, then exactly one of decision
 * buttons, a step track, a progress bar or ring, or a status line.
 */
export function NotificationPreview({
  draft,
  secondaryColor,
}: {
  draft: BuilderDraft
  secondaryColor?: string
}) {
  const accent = HEX.test(draft.accentColor) ? draft.accentColor : "#ff6b5e"
  const secondary =
    secondaryColor && HEX.test(secondaryColor) ? secondaryColor : accent
  const progress = Math.min(100, Math.max(0, draft.progress))
  const steps = draft.stepLabels
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 8)
  const current = Math.max(1, Math.min(steps.length, draft.stepCurrent))
  const decision = draft.behavior === "approval" || draft.behavior === "yes_no"
  const visual = decision ? "none" : draft.visual

  return (
    <LockScreenSurface
      lead={accent}
      end={secondary}
      className="max-w-[360px]"
      aria-label="Lock Screen Live Activity preview"
    >
      <div className="space-y-1.5">
        <p className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
          <svg aria-hidden="true" className="size-3.5 shrink-0" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="8" fill={accent} />
          </svg>
          <span className="truncate">{draft.header || "Relo"}</span>
        </p>
        <h3 className="text-[15px] leading-5 font-semibold">
          {draft.title || "Notification title"}
        </h3>
        {draft.subtitle ? (
          <p className="text-xs leading-4 text-white/72">{draft.subtitle}</p>
        ) : null}

        {decision ? (
          <div className="grid min-w-0 grid-cols-2 gap-2 pt-1.5" data-preview-actions>
            <span className="min-h-11 min-w-0 content-center truncate rounded-xl bg-white/10 px-3 text-center text-xs font-semibold text-white/85">
              {draft.secondaryLabel || "Not now"}
            </span>
            <span className="relative min-h-11 min-w-0 content-center truncate overflow-hidden rounded-xl px-3 text-center text-xs font-semibold">
              <svg aria-hidden="true" className="absolute inset-0 size-full" preserveAspectRatio="none">
                <rect width="100%" height="100%" fill={accent} fillOpacity="0.85" />
              </svg>
              <span className="relative">{draft.primaryLabel || "Approve"}</span>
            </span>
          </div>
        ) : visual === "steps" && steps.length ? (
          <div className="min-w-0 space-y-1 pt-1" data-preview-steps>
            <div className="flex min-w-0 gap-[5px]" aria-hidden="true">
              {steps.map((step, index) => (
                <svg
                  key={`${step}-${index}`}
                  aria-hidden="true"
                  className="h-[5px] min-w-0 flex-1"
                  preserveAspectRatio="none"
                  viewBox="0 0 100 5"
                >
                  <rect
                    width="100"
                    height="5"
                    rx="2.5"
                    fill={index + 1 > current ? "white" : accent}
                    fillOpacity={
                      index + 1 < current ? 1 : index + 1 === current ? 0.42 : 0.16
                    }
                  />
                </svg>
              ))}
            </div>
            <p className="flex items-baseline gap-2 text-xs">
              <span className="truncate font-semibold">{steps[current - 1]}</span>
              <span className="ml-auto shrink-0 text-white/72 tabular-nums">
                {current} of {steps.length}
              </span>
            </p>
          </div>
        ) : visual === "progress_ring" ? (
          <div className="flex items-center gap-2.5 pt-1" data-preview-ring>
            <svg aria-hidden="true" className="size-10 shrink-0" viewBox="0 0 40 40">
              <circle cx="20" cy="20" r="16" fill="none" stroke="white" strokeOpacity="0.16" strokeWidth="4" />
              <circle
                cx="20"
                cy="20"
                r="16"
                fill="none"
                stroke={accent}
                strokeWidth="4"
                strokeLinecap="round"
                pathLength="100"
                strokeDasharray={`${progress} 100`}
                transform="rotate(-90 20 20)"
              />
              <text
                x="20"
                y="20"
                fill="white"
                fontSize="10"
                fontWeight="700"
                textAnchor="middle"
                dominantBaseline="central"
              >
                {progress}%
              </text>
            </svg>
            {draft.progressLabel ? (
              <span className="truncate text-xs font-semibold text-white/72">
                {draft.progressLabel}
              </span>
            ) : null}
          </div>
        ) : visual === "progress_bar" ? (
          <div className="space-y-1 pt-1">
            <p className="flex items-baseline gap-2 text-[11px]">
              {draft.progressLabel ? (
                <span className="truncate text-white/72">{draft.progressLabel}</span>
              ) : null}
              <span className="ml-auto font-semibold tabular-nums">
                {progress}%
              </span>
            </p>
            <svg
              aria-hidden="true"
              className="h-1 w-full"
              preserveAspectRatio="none"
              viewBox="0 0 100 4"
            >
              <rect width="100" height="4" rx="2" fill="white" fillOpacity="0.16" />
              <rect width={progress} height="4" rx="2" fill={accent} />
            </svg>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-white/72">
            <Bell className="size-3" aria-hidden="true" />
            {draft.status || "Ready"}
          </p>
        )}
      </div>
    </LockScreenSurface>
  )
}
