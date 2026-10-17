import { ChevronRight } from "lucide-react"
import type * as React from "react"

import { ListItem } from "@/components/list"
import { CrossfadeText } from "@/components/atoms/animated-height"
import { GlideHighlight } from "@/components/molecules/glide-highlight"
import { useGlideRow } from "@/lib/use-glide"

/**
 * A list row that opens in place: the row itself is the summary (leading tile, name, meta and a
 * turning chevron with its word), and the controls open beneath it. Inside a presence List it is
 * the motion item's content; a renamed row crossfades its name.
 */
export function DisclosureRow({
  leading,
  title,
  meta,
  badge,
  label = "Manage",
  busy = false,
  open = false,
  children,
}: {
  leading?: React.ReactNode
  title: React.ReactNode
  meta?: React.ReactNode
  /** A quiet chip beside the Manage word (a setting the owner should see without opening the row). */
  badge?: React.ReactNode
  label?: string
  busy?: boolean
  open?: boolean
  children: React.ReactNode
}) {
  const glide = useGlideRow()
  return (
    <ListItem aria-busy={busy || undefined}>
      <details className="group/disclosure" open={open}>
        <summary
          onPointerEnter={glide.onPointerEnter}
          className={`row-hit relative isolate flex min-w-0 cursor-pointer list-none items-center gap-3 px-4 py-3.5 outline-none hover:bg-accent focus-visible:bg-accent [&::-webkit-details-marker]:hidden${glide.gliding ? " row-glide" : ""}`}
        >
          <GlideHighlight row={glide.row} />
          {leading ? <span className="shrink-0">{leading}</span> : null}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">
              {typeof title === "string" ? <CrossfadeText className="max-w-full grid-cols-[minmax(0,1fr)] [&>*]:truncate">{title}</CrossfadeText> : title}
            </span>
            {meta ? (
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{meta}</span>
            ) : null}
          </span>
          {badge ? <span className="shrink-0">{badge}</span> : null}
          <span className="hover-fade flex shrink-0 items-center gap-1 text-xs text-muted-foreground group-hover/disclosure:text-foreground">
            <span className="max-sm:sr-only">{label}</span>
            <ChevronRight
              className="fold-chevron size-4 group-open/disclosure:rotate-90"
              aria-hidden="true"
            />
          </span>
        </summary>
        <div className="border-t border-white/[0.06] px-4 pt-4 pb-5">{children}</div>
      </details>
    </ListItem>
  )
}
