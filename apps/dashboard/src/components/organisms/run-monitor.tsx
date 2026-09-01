import {
  Activity,
  CheckCircle2,
  ChevronRight,
  CircleX,
  Inbox,
  Radio,
  Smartphone,
} from "lucide-react"

import { SheetTrigger } from "@/components/ui/sheet"
import type { TestRun } from "@/features/test-lab/types"
import { semanticStatusTone, type SemanticStatusTone } from "@/lib/status-tone"

function phoneState(run: TestRun) {
  if (run.evidence.phone.expected === 0)
    return { state: "inactive", summary: "Phone receipt not expected" }
  return run.evidence.phone.confirmed >= run.evidence.phone.expected
    ? {
        state: "confirmed",
        summary: `${run.evidence.phone.confirmed}/${run.evidence.phone.expected} phone receipts`,
      }
    : {
        state: "waiting",
        summary: `${run.evidence.phone.confirmed}/${run.evidence.phone.expected} phone receipts`,
      }
}

function runTone(run: TestRun): SemanticStatusTone {
  if (semanticStatusTone(run.evidence.provider.state ?? "") === "danger")
    return "danger"
  if (run.state === "active") return "active"
  if (run.evidence.response.state === "pending") return "warning"
  return semanticStatusTone(run.state)
}

function RunStateIcon({ tone }: { tone: SemanticStatusTone }) {
  const Icon =
    tone === "active"
      ? Radio
      : tone === "success"
        ? CheckCircle2
        : tone === "danger"
          ? CircleX
          : Activity
  return <Icon className="relative size-5" aria-hidden="true" />
}

function formatRunTime(value: string | null) {
  if (!value) return "Time unavailable"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Time unavailable"
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)
}

function MetadataDivider() {
  return <span className="h-3 w-px shrink-0 bg-border" aria-hidden="true" />
}

export function RunMonitor({
  runs,
  onSelect,
}: {
  runs: TestRun[]
  onSelect: (run: TestRun) => void
}) {
  if (runs.length === 0) {
    return (
      <div className="grid min-h-64 place-items-center rounded-[14px] border border-dashed border-border bg-card/75 px-6 text-center">
        <div>
          <Inbox className="mx-auto size-6 text-muted-foreground" />
          <h2 className="mt-4 font-medium">No runs yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Launch a notification to start collecting delivery evidence.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3" aria-label="Test runs">
      {runs.map((run) => {
        const phone = phoneState(run)
        const tone = runTone(run)
        const provider = run.evidence.provider.state ?? "Provider waiting"
        const response =
          run.evidence.response.action ??
          (run.evidence.response.kind
            ? `${run.evidence.response.kind.replaceAll("_", " ")} ${run.evidence.response.state ?? "pending"}`
            : null)
        return (
          <SheetTrigger key={run.id} asChild>
            <button
              type="button"
              className="status-card run-row group grid min-h-[116px] w-full grid-cols-[52px_minmax(0,1fr)_24px] grid-rows-[auto_auto_auto_auto] items-center gap-x-3 gap-y-2 rounded-[14px] border px-3.5 py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:min-h-[108px] sm:grid-cols-[56px_minmax(0,1fr)_44px] sm:grid-rows-[auto_auto_auto] sm:px-4"
              data-tone={tone}
              data-live={run.state === "active" ? "true" : "false"}
              onClick={() => onSelect(run)}
              aria-label={`Open run ${run.title}, ${run.status}`}
            >
              <span className="status-icon-tile row-span-4 size-[52px] rounded-xl sm:row-span-3 sm:size-14">
                <RunStateIcon tone={tone} />
              </span>

              <span className="col-start-2 col-end-4 row-start-1 flex min-w-0 items-center gap-2 sm:col-end-3">
                <span className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.015em] text-foreground sm:text-base">
                  {run.title}
                </span>
                <span className="status-chip ml-auto hidden shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium capitalize sm:inline-flex">
                  {run.status || run.state}
                </span>
              </span>

              <span className="col-start-2 col-end-4 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:col-end-3">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Smartphone
                    className="size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="max-w-40 truncate">
                    {run.targetDeviceName ?? "Phone unavailable"}
                  </span>
                </span>
                <MetadataDivider />
                <span className="max-w-32 truncate font-mono" title={run.id}>
                  {run.id}
                </span>
                <MetadataDivider />
                <span className="tabular-nums">Sequence {run.sequence}</span>
                <MetadataDivider />
                <span className="tabular-nums">
                  Generation {run.generation}
                </span>
                <MetadataDivider />
                <span className="capitalize">{provider}</span>
                <MetadataDivider />
                <span>{phone.summary}</span>
                {response ? (
                  <>
                    <MetadataDivider />
                    <span className="capitalize">{response}</span>
                  </>
                ) : null}
              </span>

              <span className="col-start-2 col-end-3 row-start-3 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <time
                  className="shrink-0 tabular-nums"
                  dateTime={run.updatedAt ?? run.createdAt ?? undefined}
                >
                  {formatRunTime(run.updatedAt ?? run.createdAt)}
                </time>
                <MetadataDivider />
                <span className="min-w-0 truncate text-foreground/80">
                  {run.detail || run.status || "No run message"}
                </span>
              </span>

              <span className="status-chip col-start-2 row-start-4 inline-flex justify-self-start rounded-full border px-2 py-1 text-[11px] font-medium capitalize sm:hidden">
                {run.status || run.state}
              </span>
              <ChevronRight
                className="col-start-3 row-start-4 size-4 justify-self-end text-muted-foreground transition-transform group-hover:translate-x-0.5 sm:row-span-2 sm:row-start-2"
                aria-hidden="true"
              />
            </button>
          </SheetTrigger>
        )
      })}
    </div>
  )
}
