import { Bell, ChevronRight } from "lucide-react"
import * as React from "react"

import type { BuilderDraft } from "@/features/test-lab/types"

export function NotificationPreview({ draft }: { draft: BuilderDraft }) {
  const gradientId = `notification-preview-${React.useId().replaceAll(":", "")}`
  const accentColor = /^#[\da-f]{6}$/i.test(draft.accentColor)
    ? draft.accentColor
    : "#ff6b5e"
  const progress = Math.min(100, Math.max(0, draft.progress))
  const steps = draft.stepLabels
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 8)
  const currentStep =
    steps[Math.max(0, Math.min(steps.length - 1, draft.stepCurrent - 1))]

  return (
    <div
      className="mx-auto w-full max-w-[330px] rounded-[30px] border border-white/10 bg-[#080709] p-3"
      aria-label="Lock screen notification preview"
    >
      <div className="relative min-h-52 overflow-hidden rounded-[22px] border border-white/10 p-4">
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="1">
              <stop offset="0" stopColor={accentColor} stopOpacity="0.3" />
              <stop offset="0.72" stopColor="#0c090e" />
            </linearGradient>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${gradientId})`} />
        </svg>
        <div className="relative flex items-center gap-2 text-xs font-semibold tracking-[0.14em] text-white/70 uppercase">
          <span className="relative grid size-7 place-items-center overflow-hidden rounded-lg text-black">
            <svg aria-hidden="true" className="absolute inset-0 size-full">
              <rect width="100%" height="100%" rx="8" fill={accentColor} />
            </svg>
            <Bell className="relative size-4" />
          </span>
          {draft.header || "Relo"}
          <span className="ml-auto font-normal tracking-normal normal-case">
            now
          </span>
        </div>
        <h3 className="relative mt-5 text-lg leading-snug font-semibold text-white">
          {draft.title || "Notification title"}
        </h3>
        <p className="relative mt-1 text-sm leading-5 text-white/65">
          {draft.subtitle || "Notification subtitle"}
        </p>
        {draft.visual === "steps" ? (
          <div className="relative mt-5 min-w-0" data-preview-steps>
            <div className="flex min-w-0 gap-1.5" aria-hidden="true">
              {steps.map((step, index) => (
                <svg
                  key={`${step}-${index}`}
                  aria-hidden="true"
                  className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full"
                  preserveAspectRatio="none"
                  viewBox="0 0 100 6"
                >
                  <rect
                    width="100"
                    height="6"
                    rx="3"
                    fill="white"
                    fillOpacity="0.15"
                  />
                  <rect
                    width={index + 1 <= draft.stepCurrent ? "100" : "0"}
                    height="6"
                    rx="3"
                    fill={accentColor}
                  />
                </svg>
              ))}
            </div>
            <div className="mt-2 truncate text-xs text-white/70">
              {currentStep || "Current step"}
            </div>
          </div>
        ) : draft.visual === "progress_bar" ? (
          <div className="relative mt-5">
            <svg
              aria-hidden="true"
              className="h-1.5 w-full overflow-hidden rounded-full"
              preserveAspectRatio="none"
              viewBox="0 0 100 6"
            >
              <rect
                width="100"
                height="6"
                rx="3"
                fill="white"
                fillOpacity="0.15"
              />
              <rect width={progress} height="6" rx="3" fill={accentColor} />
            </svg>
          </div>
        ) : null}
        {draft.behavior === "approval" || draft.behavior === "yes_no" ? (
          <div
            className="relative mt-4 grid min-w-0 grid-cols-2 gap-2"
            data-preview-actions
          >
            <span className="min-w-0 truncate rounded-lg border border-white/15 bg-white/8 px-3 py-2 text-center text-xs font-medium text-white/75">
              {draft.secondaryLabel || "Not now"}
            </span>
            <span className="min-w-0 truncate rounded-lg px-3 py-2 text-center text-xs font-semibold text-white ring-1 ring-white/20">
              {draft.primaryLabel || "Approve"}
            </span>
          </div>
        ) : null}
        <div className="relative mt-4 flex items-center text-sm font-medium text-white/80">
          {draft.status || "Ready"}
          <ChevronRight className="ml-auto size-4" />
        </div>
      </div>
    </div>
  )
}
