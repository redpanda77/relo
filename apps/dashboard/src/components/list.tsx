import { ChevronRight } from "lucide-react"
import { AnimatePresence, LazyMotion, m } from "motion/react"
import * as React from "react"

import { StatusDot } from "@/components/atoms/status-dot"
import { GlideHighlight, GlideProvider } from "@/components/molecules/glide-highlight"
import { useGlideList, useGlideRow } from "@/lib/use-glide"
import { PresenceList } from "@/components/molecules/presence-list"
import { DUR, EASE_IN, EASE_OUT, loadMotionFeatures, usePrefersReducedMotion } from "@/lib/motion"
import { toneFor, type NeonTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

/**
 * The one section caption (Now, History, every page): mono 12px, weight 600, tracked 0.16em,
 * uppercase and muted, the count after it in the section's meaning colour.
 */
export const SECTION_CAPTION_CLASS =
  "section-caption flex items-center gap-2 font-mono text-[12px] leading-4 font-semibold tracking-[0.16em] uppercase text-muted-foreground"

/**
 * A titled block of a page: the section caption (with an optional count in its meaning colour),
 * an optional sentence under it, and an action on the right.
 */
export function Section({
  title,
  count,
  color,
  description,
  action,
  id,
  className,
  children,
}: {
  title: string
  count?: number
  /** The count's meaning colour ("Needs you" orange, "Running" cyan). */
  color?: NeonTone
  /** One or two sentences under the caption; long prose belongs here, not in `action`. */
  description?: React.ReactNode
  action?: React.ReactNode
  /** The section's anchor (for in-page links and section indexes). */
  id?: string
  className?: string
  children: React.ReactNode
}) {
  const headingId = `section-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`
  return (
    <section id={id} aria-labelledby={headingId} className={cn("scroll-mt-6", className)}>
      <div className="mb-3 flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id={headingId} className={cn(SECTION_CAPTION_CLASS, color && `tone-${color}`)}>
            {title}
            {count != null ? (
              <span aria-hidden="true" className="tabular-nums" style={{ color: color ? "var(--tone)" : undefined }}>
                {count}
              </span>
            ) : null}
          </h2>
          {description ? (
            <div className="mt-1.5 max-w-[65ch] text-sm leading-6 text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

const LIST_CLASS = "glass divide-y divide-white/[0.06] overflow-hidden rounded-card"

/** Inside a presence list the motion item is the <li>, so a Row renders a <div>. */
const RowElement = React.createContext<"li" | "div">("li")

/** The list's rise, shared by an Empty state that takes over after the last item leaves. */
const RISE_FROM = { opacity: 0, y: 10, scale: 0.985 }
const RISE_TO = { opacity: 1, y: 0, scale: 1 }

type StaticListProps = { items?: undefined; children: React.ReactNode }
type PresenceListProps<T> = {
  /** Rows that arrive, leave and close the gap (PresenceList); `children` renders one. */
  items: readonly T[]
  getKey: (item: T) => string
  children: (item: T) => React.ReactNode
  /** Shown instead of the list when `items` is empty; it rises in once the last row has left. */
  empty?: React.ReactNode
  animateFirst?: boolean
}

/**
 * A frosted list: rows separated by hairlines, never cards inside cards. On a pointer that hovers,
 * one highlight glides between its rows. Pass `items` (and `getKey`, and a render function as
 * children) for a list that changes in place: revoked rows leave, new ones rise in, and `empty`
 * takes over with the same rise after the last one has gone.
 */
export function List<T>({
  label,
  className,
  ...props
}: {
  label: string
  className?: string
} & (StaticListProps | PresenceListProps<T>)) {
  const glide = useGlideList()
  const reduced = usePrefersReducedMotion()
  if (props.items === undefined) {
    return (
      <GlideProvider value={glide.value}>
        <ul aria-label={label} className={cn(LIST_CLASS, className)} onPointerLeave={glide.onPointerLeave}>
          {props.children}
        </ul>
      </GlideProvider>
    )
  }
  const { items, getKey, children, empty, animateFirst } = props
  const list = (
    <RowElement.Provider value="div">
      <GlideProvider value={glide.value}>
        <div onPointerLeave={glide.onPointerLeave}>
          <PresenceList label={label} items={items} getKey={getKey} className={cn(LIST_CLASS, className)} animateFirst={animateFirst}>
            {children}
          </PresenceList>
        </div>
      </GlideProvider>
    </RowElement.Provider>
  )
  if (empty === undefined) return list
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <AnimatePresence initial={false} mode="wait">
        {items.length ? (
          <m.div key="list" exit={{ opacity: 0, transition: { duration: DUR.micro, ease: EASE_IN } }}>
            {list}
          </m.div>
        ) : (
          <m.div
            key="empty"
            initial={reduced ? { opacity: 0 } : RISE_FROM}
            animate={RISE_TO}
            transition={{ duration: DUR.base, ease: EASE_OUT }}
          >
            {empty}
          </m.div>
        )}
      </AnimatePresence>
    </LazyMotion>
  )
}

/** A list item that is an <li> in a plain List and a <div> inside a presence List's motion <li>. */
export function ListItem(props: React.ComponentProps<"li">) {
  const Item = React.useContext(RowElement)
  return Item === "li" ? <li {...props} /> : <div {...(props as React.ComponentProps<"div">)} />
}

export function Row({
  href,
  onClick,
  leading,
  title,
  meta,
  status,
  description,
  trailing,
  actions,
  wrap = false,
  busy,
  children,
  label,
  hit,
}: {
  href?: string
  onClick?: () => void
  leading?: React.ReactNode
  title: React.ReactNode
  meta?: React.ReactNode
  /** A state line right under the title (a StatusDot, readiness). */
  status?: React.ReactNode
  /** Prose under the title that wraps instead of truncating. */
  description?: React.ReactNode
  trailing?: React.ReactNode
  /** Buttons beside the row, outside its link; a row with actions has no chevron. */
  actions?: React.ReactNode
  /** Let the title and meta wrap to two lines instead of truncating (narrow screens). */
  wrap?: boolean
  busy?: boolean
  children?: React.ReactNode
  label?: string
  /** Wraps the row's link or button (a `SheetTrigger asChild`, so the sheet it opens hands focus back to it). */
  hit?: (element: React.ReactElement) => React.ReactElement
}) {
  const interactive = Boolean(href || onClick)
  const glide = useGlideRow()
  const lineClass = wrap ? "line-clamp-2 break-words" : "truncate"
  const body = (
    <>
      {leading ? <span className="mt-0.5 shrink-0">{leading}</span> : null}
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm font-medium text-foreground", lineClass)}>
          {title}
        </span>
        {status ? <span className="mt-0.5 block text-xs">{status}</span> : null}
        {meta ? (
          <span className={cn("mt-0.5 block text-xs text-muted-foreground", lineClass)}>
            {meta}
          </span>
        ) : null}
        {description ? (
          <span className="mt-1 block max-w-[65ch] text-sm leading-6 text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      {trailing ? (
        <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          {trailing}
        </span>
      ) : null}
      {interactive && !actions ? (
        <ChevronRight
          className="row-chevron size-4 shrink-0 text-muted-foreground/60"
          aria-hidden="true"
        />
      ) : null}
    </>
  )
  const rowClass = cn(
    "group relative isolate flex min-h-[52px] w-full min-w-0 items-center gap-3 px-4 py-3 text-left",
    actions && "flex-1"
  )
  const hitClass = cn(rowClass, "row-hit hover:bg-accent focus-visible:bg-accent", glide.gliding && "row-glide")
  const target = href ? (
    <a href={href} aria-label={label} className={hitClass} onPointerEnter={glide.onPointerEnter}>
      <GlideHighlight row={glide.row} />
      {body}
    </a>
  ) : onClick ? (
    <button type="button" onClick={onClick} aria-label={label} className={hitClass} onPointerEnter={glide.onPointerEnter}>
      <GlideHighlight row={glide.row} />
      {body}
    </button>
  ) : null
  const main = target ? (hit ? hit(target) : target) : <div className={rowClass}>{body}</div>
  return (
    <ListItem aria-busy={busy || undefined}>
      {actions ? (
        <div className="flex min-w-0 items-center">
          {main}
          <div className="flex shrink-0 items-center gap-2 pr-4">{actions}</div>
        </div>
      ) : (
        main
      )}
      {children}
    </ListItem>
  )
}

/** State as a coloured dot plus its word; colour is never the only cue. */
export function Status({ value }: { value: string }) {
  const tone = toneFor(value)
  return (
    <StatusDot
      tone={tone}
      live={tone === "cyan"}
      className="whitespace-nowrap capitalize"
      label={value.replaceAll("_", " ")}
    />
  )
}

export function Empty({
  icon,
  title,
  description,
  action,
}: {
  /** Replaces the orb (a lucide icon element). */
  icon?: React.ReactNode
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="glass flex flex-col items-center rounded-card px-6 py-12 text-center">
      {icon ? (
        <span aria-hidden="true" className="mb-4 text-muted-foreground [&_svg]:size-6">
          {icon}
        </span>
      ) : (
        <span aria-hidden="true" className="brand-orb mb-4 size-10 opacity-80" />
      )}
      <p className="text-base font-semibold">{title}</p>
      {description ? (
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  )
}
