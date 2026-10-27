import { AnimatedHeight, CrossfadeText } from "@/components/atoms/animated-height"
import { SaveError } from "@/components/molecules/system-card"
import { cn } from "@/lib/utils"

/** What an owner action is doing: idle, working, done, or failed. */
export type OperationState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; message: string }
  | { status: "success"; message: string }

/**
 * One line under a form or row action: muted while it works, mint when it is done, red when it
 * failed. At rest it takes no room: the line opens in place (AnimatedHeight) and closes again, so the
 * form never jumps; a change of words crossfades in the same line. `reserve` keeps the line open.
 */
export function OperationStatus({
  pending = false,
  pendingLabel = "Working…",
  error = null,
  success = null,
  state,
  reserve = false,
  card = false,
  id,
  className,
}: {
  pending?: boolean
  pendingLabel?: string
  error?: string | null
  success?: string | null
  /** The same thing as one value (account forms). */
  state?: OperationState
  reserve?: boolean
  /** A failure shows as the NOT SAVED card (a form's own submit) instead of a red line. */
  card?: boolean
  id?: string
  className?: string
}) {
  const failed = state?.status === "error" ? state.message : error
  const done = state?.status === "success" ? state.message : success
  const working = state ? state.status === "pending" : pending
  const text = failed ?? (working ? pendingLabel : done)
  if (card && !reserve) {
    return (
      <>
        <SaveError message={failed} />
        <AnimatedHeight show={!failed && Boolean(working ? pendingLabel : done)}>
          <p role="status" aria-live="polite" className={cn("text-sm", working ? "text-muted-foreground" : "text-[var(--status-success)]", className)}>
            {working ? pendingLabel : done}
          </p>
        </AnimatedHeight>
      </>
    )
  }
  const line = (
    <p
      id={id}
      tabIndex={id ? -1 : undefined}
      role={failed ? "alert" : "status"}
      aria-live="polite"
      className={cn(
        "text-sm outline-none transition-colors duration-(--dur-fast) ease-(--ease-out)",
        reserve && "min-h-5",
        failed
          ? "text-destructive"
          : working
            ? "text-muted-foreground"
            : "text-[var(--status-success)]",
        className
      )}
    >
      {text ? <CrossfadeText>{text}</CrossfadeText> : null}
    </p>
  )
  if (reserve) return line
  return <AnimatedHeight show={Boolean(text)}>{line}</AnimatedHeight>
}
