import { LazyMotion, m } from "motion/react"
import * as React from "react"

import { DUR, loadMotionFeatures, usePrefersReducedMotion } from "@/lib/motion"
import { GlideContext, type Glide } from "@/lib/use-glide"

/** A firm spring: the highlight keeps up with a quick pointer and settles without a wobble. */
const GLIDE_SPRING = { type: "spring", stiffness: 500, damping: 40 } as const

/** Shares a list's glide (from `useGlideList`) with its rows. */
export function GlideProvider({ value, children }: { value: Glide | null; children: React.ReactNode }) {
  return <GlideContext.Provider value={value}>{children}</GlideContext.Provider>
}

/**
 * The list's one hover highlight, drawn inside the hovered row (`row` from `useGlideRow`). A shared
 * `layoutId` per list carries it from row to row on the spring; it fades in where the pointer
 * enters and out in 120 ms when it leaves the list. Nothing renders for other rows.
 */
export function GlideHighlight({ row }: { row: string }) {
  const glide = React.useContext(GlideContext)
  const reduced = usePrefersReducedMotion()
  if (!glide || glide.row !== row) return null
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <m.span
        aria-hidden="true"
        data-slot="glide-highlight"
        layoutId={`glide-${glide.id}`}
        className="glide-highlight pointer-events-none absolute inset-0 -z-10"
        initial={glide.fresh ? { opacity: 0 } : false}
        animate={{ opacity: glide.visible ? 1 : 0 }}
        transition={{
          layout: reduced ? { duration: 0 } : GLIDE_SPRING,
          opacity: { duration: DUR.micro },
        }}
      />
    </LazyMotion>
  )
}
