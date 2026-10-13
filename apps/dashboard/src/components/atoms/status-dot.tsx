import { cn } from "@/lib/utils"

const tone: Record<string, string> = {
  active: "bg-[var(--status-active)]",
  confirmed: "bg-[var(--status-success)]",
  delivered: "bg-[var(--status-success)]",
  waiting: "bg-[var(--status-warning)]",
  pending: "bg-[var(--status-warning)]",
  failed: "bg-[var(--status-danger)]",
  error: "bg-[var(--status-danger)]",
}

export function StatusDot({
  state,
  active = false,
}: {
  state: string
  active?: boolean
}) {
  return (
    <span className="relative inline-flex size-3 shrink-0" aria-hidden="true">
      {active ? (
        <span
          className={cn(
            "animate-status-pulse absolute inset-0 rounded-full",
            tone[state] ?? "bg-[#a4a4b6]"
          )}
        />
      ) : null}
      <span
        className={cn(
          "relative m-0.5 size-2 rounded-full",
          tone[state] ?? "bg-[#a4a4b6]"
        )}
      />
    </span>
  )
}
