import type * as React from "react"

import { AnimatedHeight } from "@/components/atoms/animated-height"

import type { NeonTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

/**
 * An inline message in a page: a tinted glass strip with an icon, a title, a sentence and an
 * optional action. `quiet` is the untinted aside inside a card (a note, a hint). It never carries
 * outer margins: the page stack spaces it. Pass `show` to let it open and close in place
 * (AnimatedHeight) instead of mounting conditionally, so the page around it never jumps.
 */
export function Notice({
  tone = "violet",
  icon,
  title,
  children,
  action,
  variant = "default",
  role,
  show,
  className,
  ...props
}: {
  tone?: NeonTone
  icon?: React.ReactNode
  title?: React.ReactNode
  children?: React.ReactNode
  action?: React.ReactNode
  variant?: "default" | "quiet"
  role?: "status" | "alert" | "region"
  /** Opens and closes in place when it changes. Leave it out to render as is. */
  show?: boolean
  className?: string
} & Omit<React.ComponentProps<"section">, "title" | "role">) {
  const notice = (
    <section
      role={role}
      data-slot="notice"
      data-variant={variant}
      className={cn("notice text-sm", `tone-${tone}`, className)}
      {...props}
    >
      {icon ? (
        <span className="notice-icon shrink-0" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 max-w-[65ch]">
          {title ? <p className="font-medium text-foreground">{title}</p> : null}
          {children ? (
            <div className={cn("leading-6 text-muted-foreground", title ? "mt-0.5" : null)}>
              {children}
            </div>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
      </div>
    </section>
  )
  return show === undefined ? notice : <AnimatedHeight show={show}>{notice}</AnimatedHeight>
}
