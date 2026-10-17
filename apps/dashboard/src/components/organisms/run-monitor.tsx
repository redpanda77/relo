import { DeliveryTrail } from "@/components/molecules/delivery-chain"
import { List, Row } from "@/components/list"
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

/**
 * One test, as the shared Row: its state as a dot and words (both follow a change in 200 ms), the
 * title, the phone and time, the delivery trail. It opens the test's sheet, which hands focus back.
 */
function RunRow({ run, onSelect }: { run: TestRun; onSelect: (run: TestRun) => void }) {
  const stages = deliveryStages(run)
  const headline = deliveryHeadline(run, stages)
  const live = run.state === "active"
  const time = relativeTime(run.updatedAt ?? run.createdAt)
  return (
    <Row
      onClick={() => onSelect(run)}
      hit={(element) => <SheetTrigger asChild>{element}</SheetTrigger>}
      leading={
        <span
          className={cn("run-mark block size-2 rounded-full", markTone[headline.tone])}
          data-live={live ? "true" : "false"}
          aria-hidden="true"
        />
      }
      title={run.title}
      meta={
        <>
          <span className={cn("run-headline", headlineTone[headline.tone])}>{headline.text}</span>
          {run.targetDeviceName ? <> · {run.targetDeviceName}</> : null}
          {time ? (
            <>
              {" · "}
              <time dateTime={run.updatedAt ?? run.createdAt ?? undefined}>{time}</time>
            </>
          ) : null}
        </>
      }
      trailing={
        <span className="hidden sm:block">
          <DeliveryTrail stages={stages} />
        </span>
      }
    />
  )
}

/**
 * The list of tests: the shared frosted List, a delivery trail per row. A new test rises in at the
 * top and the rest make room; on a pointer one highlight glides between the rows.
 */
export function RunMonitor({
  runs,
  onSelect,
}: {
  runs: TestRun[]
  onSelect: (run: TestRun) => void
}) {
  return (
    <List label="Tests" items={runs} getKey={(run) => run.id}>
      {(run) => <RunRow run={run} onSelect={onSelect} />}
    </List>
  )
}
