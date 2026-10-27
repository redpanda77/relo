import { TriangleAlert } from "lucide-react"
import * as React from "react"

import { AnimatedHeight } from "@/components/atoms/animated-height"
import type { NeonTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

/**
 * A system card (the iPhone's SystemCard, board C4): something about Relo itself rather than
 * about the owner's work. A horizontal glass card washed in its tone, with a 34px icon tile, a
 * mono eyebrow, a heading, a sentence and its actions underneath. `edge` draws the 2px leading
 * edge that breathes, for the three states that need a glance (offline, a new computer, not
 * saved). It never carries outer margins: the stack around it spaces it.
 */
export function SystemCard({
  tone,
  icon,
  eyebrow,
  title,
  children,
  actions,
  edge = false,
  role,
  className,
  ...props
}: {
  tone: NeonTone
  icon?: React.ReactNode
  /** The mono caps line in the tone ("OFFLINE · SINCE 6:37 PM"). */
  eyebrow?: React.ReactNode
  title?: React.ReactNode
  children?: React.ReactNode
  /** Capsule buttons (`SystemButton`), 11px under the text. */
  actions?: React.ReactNode
  edge?: boolean
  role?: "status" | "alert" | "region"
  className?: string
} & Omit<React.ComponentProps<"section">, "title" | "role">) {
  return (
    <section
      role={role}
      data-slot="system-card"
      data-edge={edge || undefined}
      className={cn("sys-card", `tone-${tone}`, className)}
      {...props}
    >
      {icon ? (
        <span className="sys-card-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div className="sys-card-body">
        {eyebrow ? <p className="sys-card-eyebrow">{eyebrow}</p> : null}
        {title ? <h3 className="sys-card-title">{title}</h3> : null}
        {children ? <div className="sys-card-text">{children}</div> : null}
        {actions ? <div className="sys-card-actions">{actions}</div> : null}
      </div>
    </section>
  )
}

/** A system card's 36px capsule: the primary is filled with the card's tone, the other is quiet glass. */
export function SystemButton({
  primary = false,
  href,
  className,
  ...props
}: { primary?: boolean; href?: string } & Omit<React.ComponentProps<"button">, "href">) {
  const classes = cn("sys-btn press", primary && "sys-btn-primary", className)
  if (href) {
    return <a href={href} className={classes} {...(props as React.ComponentProps<"a">)} />
  }
  return <button type="button" className={classes} {...props} />
}

/** A spinning arc (Reconnecting); steady under reduced motion. */
export function SpinnerArc() {
  return (
    <svg className="sys-spin" width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M10 2.5a7.5 7.5 0 1 1-7.5 7.5" />
    </svg>
  )
}

/**
 * A failed save or submit, as the red system card: NOT SAVED, the error as the sentence, and Retry
 * where a retry exists. It opens in place when there is a message and closes when it clears, so the
 * form around it never jumps.
 */
export function SaveError({
  message,
  eyebrow = "NOT SAVED",
  title,
  onRetry,
  retryLabel = "Retry",
  id,
  className,
}: {
  message?: React.ReactNode
  eyebrow?: string
  title?: React.ReactNode
  onRetry?: () => void
  retryLabel?: string
  id?: string
  className?: string
}) {
  return (
    <AnimatedHeight show={Boolean(message)}>
      <SystemCard
        id={id}
        tone="red"
        edge
        role="alert"
        icon={<TriangleAlert />}
        eyebrow={eyebrow}
        title={title}
        className={className}
        actions={
          onRetry ? (
            <SystemButton primary onClick={onRetry}>
              {retryLabel}
            </SystemButton>
          ) : undefined
        }
      >
        {message}
      </SystemCard>
    </AnimatedHeight>
  )
}
