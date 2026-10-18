/**
 * The card set: the one card every surface builds on (styles/card.css, tokens in index.css).
 *
 * Anatomy, top to bottom, and where each field goes:
 *
 *   <Card variant="live" | "row" | "plain" tone tint live open>
 *     <CardHit onOpen label>                       the open target (everything but the footer)
 *       <CardLead>glyph</CardLead>                 28px; a live card hides it under ~420px of its own width
 *       <CardMain>
 *         <CardHeader eyebrow origin trailing/>    ONE row: eyebrow · origin, a single corner (time | state | countdown)
 *         <CardTitle/>  <CardStatus/>  <CardNote/>
 *       </CardMain>
 *     </CardHit>
 *     <CardFooter meta actions/>                   metadata leading, buttons trailing, one row while they fit
 *     <CardProgress/>                              the meter, docked on the bottom edge (no row)
 *   </Card>
 *
 * Rules the set keeps so call sites cannot break them: a field never gets a row of its own (a lone
 * short field rides the header's corner, several share the footer); badges sit inline; phones get
 * the same rows, narrower (the card is a size container, so its glyph and its buttons answer to its
 * own width). The row variant (`CardRow`) is the one compact design for every list item.
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

/** A short word in the header's corner: a time, a state, a computer. */
export function CardCorner({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("card-corner", className)} {...props} />
}

/**
 * ONE row: the eyebrow and the origin share a line, the corner sits on the right. A plain card's
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
 * Metadata leading, actions trailing, on one row while they fit. Outside the open target, so a
 * button never sits inside one; the metadata still opens the card with a click (`onOpenMeta`).
 */
export function CardFooter({
  meta,
  actions,
  onOpenMeta,
  className,
}: {
  meta?: React.ReactNode
  actions?: React.ReactNode
  onOpenMeta?: () => void
  className?: string
}) {
  if (!meta && !actions) return null
  return (
    <div data-slot="card-footer" className={cn("card-foot", className)}>
      {meta ? (
        <div className="card-foot-meta" onClick={onOpenMeta} data-open={onOpenMeta ? "" : undefined}>
          {meta}
        </div>
      ) : null}
      {actions ? <CardActions>{actions}</CardActions> : null}
    </div>
  )
}

/** The meter, docked on the card's bottom edge: it costs no row. */
export function CardProgress({ children }: { children: React.ReactNode }) {
  return <div className="card-progress">{children}</div>
}
