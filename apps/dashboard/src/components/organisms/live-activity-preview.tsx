import * as React from "react"

import { ComputerIcon } from "@/components/atoms/computer-icon"
import { LIVE_ACTIVITY_TONES, type LiveActivityPreviewModel } from "@/components/organisms/live-activity-model"
import { cn } from "@/lib/utils"

/**
 * The iPhone Lock Screen Live Activity, drawn the way ReloLiveActivityWidget.swift draws it
 * (PresentationCardView, PresentationPalette, PresentationBackdrop, OwnerChipView): always dark, an ink base,
 * a diagonal wash and a corner glow in the state's colors, a header with the accent on the icon only, the
 * title and status, then a meter (steps when the card has a plan, a bar otherwise). The Test Lab preview shares
 * this surface; everything else on the card is the card's own words.
 */

/** The card's own background: ink base, a diagonal wash (clear until 58%, then the state's colors), a glow at the top left. */
export function LockScreenSurface({
  lead,
  end,
  className,
  children,
  ...props
}: {
  lead: string
  end: string
  className?: string
  children: React.ReactNode
} & Omit<React.ComponentProps<"div">, "children">) {
  const id = React.useId().replaceAll(":", "")
  return (
    <div
      className={cn("relative mx-auto w-full max-w-[380px] overflow-hidden rounded-[24px] p-4 text-white shadow-2xl shadow-black/40 ring-1 ring-white/10", className)}
      {...props}
    >
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 size-full">
        <defs>
          <linearGradient id={`${id}-wash`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={lead} stopOpacity="0" />
            <stop offset="0.58" stopColor={lead} stopOpacity="0" />
            <stop offset="0.82" stopColor={lead} stopOpacity="0.2" />
            <stop offset="1" stopColor={end} stopOpacity="0.42" />
          </linearGradient>
          <radialGradient id={`${id}-glow`} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="90">
            <stop offset="0" stopColor={lead} stopOpacity="0.1" />
            <stop offset="1" stopColor={lead} stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="#05060B" />
        <rect width="100%" height="100%" fill={`url(#${id}-wash)`} />
        <rect width="100%" height="100%" fill={`url(#${id}-glow)`} />
      </svg>
      <div className="relative flex flex-col gap-1.5">{children}</div>
    </div>
  )
}

/** Up to twelve capsules: finished in the state's lead color, the current one white 32%, the rest white 12%. */
function StepCapsules({ done, total, lead }: { done: number; total: number; lead: string }) {
  const count = Math.max(1, Math.min(12, total))
  // Twelve capsules stand for any longer plan, scaled.
  const finished = total > 12 ? Math.floor((done / total) * 12) : done
  return (
    <div className="flex w-full gap-[3px]" aria-hidden="true" data-preview-steps>
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className="h-1 min-w-0 flex-1 rounded-full"
          style={{ backgroundColor: index < finished ? lead : index === finished ? "rgb(255 255 255 / .32)" : "rgb(255 255 255 / .12)" }}
        />
      ))}
    </div>
  )
}

export function LiveActivityPreview({ model, className }: { model: LiveActivityPreviewModel; className?: string }) {
  const ramp = LIVE_ACTIVITY_TONES[model.tone]
  const steps = model.steps && model.steps.total > 0 ? model.steps : null
  const position = steps ? Math.min(steps.done + 1, steps.total) : 0
  return (
    <LockScreenSurface
      lead={ramp.lead}
      end={ramp.end}
      className={className}
      role="img"
      aria-label={`Lock Screen Live Activity preview. ${model.projectLabel}, ${ramp.chip.toLowerCase()}. ${model.title}. ${model.status}.${steps ? ` Step ${position} of ${steps.total}, ${steps.current}.` : ""}`}
    >
      <div className="flex items-baseline gap-2" data-preview-header>
        <span className="flex min-w-0 items-center gap-1.5 self-center">
          <ComputerIcon icon={model.icon} className="size-3 shrink-0" style={{ color: model.accent }} />
          <span className="truncate text-xs font-semibold">{model.projectLabel}</span>
        </span>
        <span
          className="rounded-full px-1.5 py-0.5 text-[11px] leading-none font-bold tracking-[0.4px]"
          style={{ color: `${ramp.chipColor}${ramp.chipAlpha}`, backgroundColor: `${ramp.chipColor}29` }}
          data-preview-chip
        >
          {ramp.chip}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-xs tabular-nums text-white/72">{model.elapsed}</span>
      </div>
      <p className="line-clamp-2 text-[15px] leading-5 font-semibold">{model.title}</p>
      <p className="line-clamp-2 text-xs leading-4 text-white/72">{model.status}</p>
      {steps ? (
        <>
          <StepCapsules done={steps.done} total={steps.total} lead={ramp.lead} />
          <p className="text-xs leading-4 text-white/72" data-preview-caption>
            {position} of {steps.total} · {steps.current}
          </p>
        </>
      ) : (
        <div className="h-[5px] w-full overflow-hidden rounded-full" style={{ backgroundColor: "rgb(255 255 255 / .13)" }} aria-hidden="true" data-preview-bar>
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.round(Math.min(1, Math.max(0, model.progress ?? 0.42)) * 100)}%`,
              backgroundImage: `linear-gradient(to right, ${ramp.lead}, ${ramp.end})`,
            }}
          />
        </div>
      )}
    </LockScreenSurface>
  )
}
