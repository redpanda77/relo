import type * as React from "react"
import { Check, Minus, X } from "lucide-react"

import { cn } from "@/lib/utils"

export type StageState = "done" | "waiting" | "failed" | "skipped"

export type DeliveryStage = {
  id: string
  label: string
  state: StageState
  summary: string
  /** Optional time shown at the end of a vertical row. */
  at?: React.ReactNode
}

const stateWord: Record<StageState, string> = {
  done: "done",
  waiting: "waiting",
  failed: "failed",
  skipped: "not needed",
}

const nodeClass: Record<StageState, string> = {
  done: "border-transparent bg-[var(--status-success)] text-background",
  waiting:
    "border-[var(--status-active)] bg-[color-mix(in_srgb,var(--status-active)_18%,transparent)] text-[var(--status-active)]",
  failed: "border-transparent bg-[var(--status-danger)] text-background",
  skipped: "border-border bg-transparent text-muted-foreground",
}

function describe(stages: DeliveryStage[]) {
  return stages
    .map((stage) => `${stage.label} ${stateWord[stage.state]}`)
    .join(", ")
}

/** Five linked dots: the at-a-glance delivery trail for a run row. */
export function DeliveryTrail({ stages }: { stages: DeliveryStage[] }) {
  return (
    <span
      role="img"
      aria-label={`Delivery: ${describe(stages)}`}
      className="flex items-center"
      data-delivery-trail
    >
      {stages.map((stage, index) => (
        <span key={stage.id} className="flex items-center">
          {index > 0 ? (
            <span
              className={cn(
                "h-px w-2.5",
                stages[index - 1].state === "done"
                  ? "bg-[var(--status-success)]/60"
                  : "bg-border"
              )}
            />
          ) : null}
          <span
            title={`${stage.label}: ${stage.summary}`}
            className={cn(
              "relative size-2 rounded-full border",
              nodeClass[stage.state]
            )}
          >
            {stage.state === "waiting" ? (
              <span className="animate-status-pulse absolute -inset-px rounded-full bg-[var(--status-active)]" />
            ) : null}
          </span>
        </span>
      ))}
    </span>
  )
}

function StageNode({ state }: { state: StageState }) {
  return (
    <span
      className={cn(
        "relative z-10 grid size-7 shrink-0 place-items-center rounded-full border",
        nodeClass[state]
      )}
      aria-hidden="true"
    >
      {state === "done" ? (
        <Check className="size-3.5" strokeWidth={3} />
      ) : state === "failed" ? (
        <X className="size-3.5" strokeWidth={3} />
      ) : state === "skipped" ? (
        <Minus className="size-3.5" />
      ) : (
        <>
          <span className="animate-status-pulse absolute inset-0 rounded-full bg-[var(--status-active)]/40" />
          <span className="size-2 rounded-full bg-current" />
        </>
      )}
    </span>
  )
}

/** The full chain; horizontal on wide screens unless forced vertical. */
export function DeliveryChain({
  stages,
  orientation = "responsive",
}: {
  stages: DeliveryStage[]
  orientation?: "responsive" | "vertical"
}) {
  const wide = orientation === "responsive"
  return (
    <ol
      aria-label="Delivery"
      className={cn("grid gap-0", wide && "sm:grid-cols-5")}
      data-delivery-chain
    >
      {stages.map((stage, index) => {
        const last = index === stages.length - 1
        const linkDone = stage.state === "done"
        return (
          <li
            key={stage.id}
            className={cn(
              "relative flex gap-3 pb-5 last:pb-0",
              wide && "sm:flex-col sm:gap-2.5 sm:pr-3 sm:pb-0"
            )}
            data-stage={stage.id}
            data-state={stage.state}
          >
            {!last ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-7 bottom-0 left-[13.5px] w-px",
                  wide &&
                    "sm:top-[13.5px] sm:right-0 sm:bottom-auto sm:left-7 sm:h-px sm:w-auto",
                  linkDone ? "bg-[var(--status-success)]/50" : "bg-border"
                )}
              />
            ) : null}
            <StageNode state={stage.state} />
            <span className={cn("min-w-0 flex-1 pt-0.5", wide && "sm:pt-0")}>
              <span className="block text-sm font-medium text-foreground">
                {stage.label}
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                <span className="sr-only">{stateWord[stage.state]}: </span>
                {stage.summary}
              </span>
            </span>
            {stage.at ? (
              <span className="shrink-0 pt-1 text-xs text-muted-foreground tabular-nums">
                {stage.at}
              </span>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
