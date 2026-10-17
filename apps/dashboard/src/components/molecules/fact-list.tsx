import type * as React from "react"

import { cn } from "@/lib/utils"

const columnClass = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
} as const

/** Labelled facts as a definition list: a small muted label over its value, in a grid. */
export function FactList({
  columns = 2,
  className,
  children,
}: {
  columns?: keyof typeof columnClass
  className?: string
  children: React.ReactNode
}) {
  return <dl className={cn("grid gap-x-6 gap-y-4", columnClass[columns], className)}>{children}</dl>
}

export function Fact({
  label,
  wide = false,
  children,
}: {
  label: React.ReactNode
  /** Spans the whole row (a note, a long identifier). */
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-full")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-sm break-words text-foreground">{children}</dd>
    </div>
  )
}
