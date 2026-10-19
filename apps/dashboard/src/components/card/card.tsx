/**
 * The card set: the one card every surface builds on (styles/card.css, tokens in index.css).
 *
 * The standard: Header / Content / Footer, a plain top-to-bottom stack with the same spacing everywhere.
 *
 *   <Card variant="live" | "row" | "plain" tone tint live open>
 *     <CardHit onOpen label>                       the open target (everything but the footer)
 *       <CardLead>glyph</CardLead>                 28px; a live card hides it under ~420px of its own width
 *       <CardMain>
 *         <CardHeader eyebrow origin trailing/>    ONE small line: eyebrow · origin leading; ONE trailing thing
 *                                                  (the countdown, else the state badge). Never the clock or the computer.
 *         <CardTitle/>  <CardStatus/>  <CardProgressRow/>  extra  <CardNote/>
 *                                                  content; progress = the bar across the full width, the step line under it
 *       </CardMain>
 *     </CardHit>
 *     <CardFooter meta time actions/>              ONE small line, omitted when empty: facts leading (truncate),
 *                                                  trailing the actions, else the time
 *   </Card>
 *
 * No absolute positioning for content, no side columns, no measuring, no field moving between slots,
 * the same layout at every width (a wider card has longer lines; only the glyph and, under ~480px,
 * the buttons answer to the card's width). The row variant is the same three slots, compact.
 */
import { ChevronRight } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import * as React from "react"

import { EncryptedText } from "@/components/atoms/encrypted-text"
import { cn } from "@/lib/utils"
import type { NeonTone } from "@/lib/status-tone"
import { toneClass, type WorkTone } from "@/lib/work-outcome"

export type CardVariant = "live" | "row" | "plain"
export type DataAttributes = Record<`data-${string}`, string | undefined>

export function Card({
  variant = "plain",
  tone,
  tint = false,
  live = false,
  open = false,
  className,
  ...props
}: {
  variant?: CardVariant
  /** The meaning colour (`--tone`): eyebrow, state word, tint, meter. Crossfades when it changes. */
  tone?: WorkTone | NeonTone
  /** The tone washes the glass: needs you only. */
  tint?: boolean
  /** Moving work: its state shimmers. */
  live?: boolean
  /** Ringed while its detail sheet is open. */
  open?: boolean
} & React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      data-variant={variant}
      data-tint={tint || undefined}
      data-live={live || undefined}
      data-open={open || undefined}
      className={cn("card", tone && toneClass(tone as WorkTone), variant !== "row" && "glass", className)}
      {...props}
    />
  )
}

function openOnKey(event: React.KeyboardEvent, open: () => void) {
  if (event.target !== event.currentTarget) return
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault()
    open()
  }
}

/** The open target. Without `onOpen` it is a plain container; buttons never sit inside it. */
export function CardHit({
  onOpen,
  label,
  chevron = false,
  attrs,
  children,
}: {
  onOpen?: () => void
  label?: string
  chevron?: boolean
  attrs?: DataAttributes
  children: React.ReactNode
}) {
  if (!onOpen) {
    return (
      <div className="card-hit" {...attrs}>
        {children}
      </div>
    )
  }
  return (
    <div
      role="button"
      tabIndex={0}
      className="card-hit"
      onClick={onOpen}
      onKeyDown={(event) => openOnKey(event, onOpen)}
      aria-label={label}
      {...attrs}
    >
      {children}
      {chevron ? <ChevronRight className="card-chevron" aria-hidden="true" /> : null}
    </div>
  )
}

/** The leading glyph (a SignalGlyph, 28px). */
export function CardLead({ children }: { children: React.ReactNode }) {
  return <span className="card-lead">{children}</span>
}

export function CardMain({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("card-main", className)} {...props} />
}

/** The header's right corner (also the trailing slot of a plain card: a toggle, a button, a badge). */
export function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-action" className={cn("card-action", className)} {...props} />
}

/** The header's trailing slot content: the state badge. */
export function CardCorner({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("card-corner", className)} {...props} />
}

/**
 * ONE small line: the eyebrow and the origin share it, the one trailing thing sits on the right. A plain card's
 * header stacks its title and description in the left column, with `CardAction` in the corner.
 */
export function CardHeader({
  eyebrow,
  origin,
  trailing,
  className,
  children,
}: {
  eyebrow?: React.ReactNode
  origin?: React.ReactNode
  trailing?: React.ReactNode
  className?: string
  children?: React.ReactNode
}) {
  const line = eyebrow || origin
  return (
    <div data-slot="card-header" className={cn("card-header", className)}>
      {line ? (
        <div className="card-header-line">
          {eyebrow ? <span className="card-eyebrow">{eyebrow}</span> : null}
          {eyebrow && origin ? <span className="card-sep" aria-hidden="true">·</span> : null}
          {origin}
        </div>
      ) : null}
      {children}
      {trailing ? <CardAction>{trailing}</CardAction> : null}
    </div>
  )
}

/** The title: 15px, up to three lines. A sealed one shows the lock instead. */
export function CardTitle({
  encrypted = false,
  lines,
  as: Tag = "h3",
  className,
  children,
  ...props
}: {
  encrypted?: boolean
  lines?: 1
  as?: "h2" | "h3" | "h4" | "div"
} & React.ComponentProps<"h3">) {
  if (encrypted) return <EncryptedText className="card-title-encrypted" />
  return (
    <Tag data-slot="card-title" data-lines={lines} className={cn("card-title", className)} {...props}>
      {children}
    </Tag>
  )
}

/** The status in the producer's words: 13px, two lines (four when it is the point of the card). */
export function CardStatus({ lines = 2, className, ...props }: { lines?: 1 | 2 | 4 } & React.ComponentProps<"p">) {
  return <p data-slot="card-status" data-lines={lines} className={cn("card-status", className)} {...props} />
}

/** Prose under a plain card's title: wraps, never clamps. */
export function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("card-description", className)} {...props} />
}

/** A footnote: small, muted. What a late answer means, where to answer. */
export function CardNote({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="card-note" className={cn("card-note", className)} {...props} />
}

/** A plain card's body. */
export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={className} {...props} />
}

/** "Running", "Your turn", "Done": the state in the card's tone, with its mark. */
export function CardState({ label, icon: Icon }: { label: string; icon?: LucideIcon | null }) {
  return (
    <span className="card-state" data-part="state">
      {Icon ? <Icon aria-hidden="true" /> : null}
      <span className="card-state-label">{label}</span>
    </span>
  )
}

/** Muted parts on one wrapping line, joined by dots: "Running · 2 of 6 · Run migrations · Studio Mac". */
export function CardMeta({ parts, className }: { parts: readonly React.ReactNode[]; className?: string }) {
  const shown = parts.filter((part) => part != null && part !== "" && part !== false)
  if (!shown.length) return null
  return (
    <p className={cn("card-meta", className)}>
      {shown.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <span className="card-sep" aria-hidden="true"> · </span> : null}
          {part}
        </React.Fragment>
      ))}
    </p>
  )
}

/** The footer's buttons, trailing. Equal-width and full-width only when they no longer fit beside the metadata. */
export function CardActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-actions" className={cn("card-actions", className)} {...props} />
}

/**
 * Facts leading (one line, truncates), trailing the actions, else the time. Outside the open target,
 * so a button never sits inside one; the facts still open the card with a click (`onOpenMeta`).
 */
export function CardFooter({
  meta,
  actions,
  time,
  onOpenMeta,
  className,
}: {
  meta?: React.ReactNode
  actions?: React.ReactNode
  /** The clock time or the running timer; shown only when there are no actions. */
  time?: React.ReactNode
  onOpenMeta?: () => void
  className?: string
}) {
  const trailingTime = actions ? null : time
  if (!meta && !actions && !trailingTime) return null
  return (
    <div data-slot="card-footer" className={cn("card-foot", className)}>
      {meta ? (
        <div className="card-foot-meta" onClick={onOpenMeta} data-open={onOpenMeta ? "" : undefined}>
          {meta}
        </div>
      ) : null}
      {actions ? <CardActions>{actions}</CardActions> : null}
      {trailingTime ? <span className="card-foot-time">{trailingTime}</span> : null}
    </div>
  )
}

/**
 * The progress row, in the card's flow: the meter across the full width, the step caption (one line,
 * truncates) on its own line under it. The Lock Screen's layout, on every surface.
 */
export function CardProgressRow({ caption, children }: { caption?: string | null; children: React.ReactNode }) {
  return (
    <div className="card-progress">
      <div className="card-progress-bar">{children}</div>
      {caption ? <span className="card-progress-caption">{caption}</span> : null}
    </div>
  )
}
