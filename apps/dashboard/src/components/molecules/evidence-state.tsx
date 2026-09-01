import { StatusDot } from "@/components/atoms/status-dot"

export function EvidenceState({
  label,
  state,
  summary,
  animated = false,
}: {
  label: string
  state: string
  summary: string
  animated?: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
        <StatusDot state={state} active={animated} />
        {label}
      </div>
      <p className="mt-1 truncate text-sm text-foreground" title={summary}>
        {summary}
      </p>
    </div>
  )
}
