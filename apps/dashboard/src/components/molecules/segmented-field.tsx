import { LazyMotion } from "motion/react"
import * as React from "react"

import { SelectionIndicator } from "@/components/atoms/selection-indicator"
import { Label } from "@/components/ui/label"
import { loadMotionFeatures } from "@/lib/motion"
import { cn } from "@/lib/utils"

/**
 * A few exclusive choices side by side (a radio group): the raised thumb slides to the chosen one and the arrow
 * keys move the choice, as in a native segmented control. Ids come from `useId`, never from a name.
 */
export function SegmentedField<Value extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  hideLabel = false,
  className,
}: {
  label: string
  value: Value
  options: ReadonlyArray<{ value: Value; label: string }>
  onChange(value: Value): void
  disabled?: boolean
  /** Keep the label for assistive technology only (a caption sits above already). */
  hideLabel?: boolean
  className?: string
}) {
  const uid = React.useId()
  const labelId = `${uid}-label`
  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0
    if (!step || disabled) return
    event.preventDefault()
    const current = Math.max(0, options.findIndex((option) => option.value === value))
    const index = (current + step + options.length) % options.length
    onChange(options[index]!.value)
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[index]?.focus()
  }
  return (
    <div className={cn("grid gap-2", className)}>
      <Label id={labelId} className={hideLabel ? "sr-only" : undefined}>{label}</Label>
      <LazyMotion features={loadMotionFeatures} strict>
        <div role="radiogroup" aria-labelledby={labelId} className="segmented" onKeyDown={move}>
          {options.map((option) => {
            const checked = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                disabled={disabled}
                className="segment"
                onClick={() => onChange(option.value)}
              >
                {checked ? <SelectionIndicator layoutId={`${uid}-thumb`} variant="segment" /> : null}
                {option.label}
              </button>
            )
          })}
        </div>
      </LazyMotion>
    </div>
  )
}
