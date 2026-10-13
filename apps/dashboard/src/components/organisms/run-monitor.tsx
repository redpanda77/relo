import { ChevronRight } from "lucide-react"

import { DeliveryTrail } from "@/components/molecules/delivery-chain"
import { SheetTrigger } from "@/components/ui/sheet"
import {
  deliveryHeadline,
  deliveryStages,
} from "@/features/test-lab/delivery-chain"
import type { TestRun } from "@/features/test-lab/types"
import { relativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const headlineTone = {
  danger: "text-[var(--status-danger)]",
  warning: "text-[var(--status-warning)]",
  active: "text-[var(--status-active)]",
  neutral: "text-muted-foreground",
} as const

const markTone = {
  danger: "bg-[var(--status-danger)]",
  warning: "bg-[var(--status-warning)]",
  active: "bg-[var(--status-active)] shadow-[0_0_10px_var(--status-active)]",
  neutral: "bg-[var(--status-neutral)]/60",
} as const

/** The list of tests: one glass list, hairline rows, a delivery trail per row. */
export function RunMonitor({
  runs,
  onSelect,
}: {
  runs: TestRun[]
  onSelect: (run: TestRun) => void
}) {
  return (
    <ul
      aria-label="Tests"
      className="glass divide-y divide-border overflow-hidden rounded-2xl"
    >
      {runs.map((run) => {
        const stages = deliveryStages(run)
        const headline = deliveryHeadline(run, stages)
        const live = run.state === "active"
        const time = relativeTime(run.updatedAt ?? run.createdAt)
        return (
          <li key={run.id}>
            <SheetTrigger asChild>
              <button
                type="button"
                className="test-row group grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent"
                data-live={live ? "true" : "false"}
                onClick={() => onSelect(run)}
              >
                <span
                  className={cn("size-2 rounded-full", markTone[headline.tone])}
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {run.title}
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={cn("shrink-0", headlineTone[headline.tone])}>
                      {headline.text}
                    </span>
                    {run.targetDeviceName ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">{run.targetDeviceName}</span>
                      </>
                    ) : null}
                    {time ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <time
                          className="shrink-0"
                          dateTime={run.updatedAt ?? run.createdAt ?? undefined}
                        >
                          {time}
                        </time>
                      </>
                    ) : null}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="hidden sm:block">
                    <DeliveryTrail stages={stages} />
                  </span>
                  <ChevronRight
                    className="size-4 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
              </button>
            </SheetTrigger>
          </li>
        )
      })}
    </ul>
  )
}
