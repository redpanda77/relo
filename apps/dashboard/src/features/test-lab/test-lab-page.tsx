import { AlertCircle, RefreshCw } from "lucide-react"
import * as React from "react"

import { RunMonitor } from "@/components/organisms/run-monitor"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { NewRunSheet } from "@/features/test-lab/new-run-sheet"
import { RunDetailsSheet } from "@/features/test-lab/run-details-sheet"
import {
  rememberLaunchReceipt,
  takeLaunchReceipt,
  type LaunchRunReceipt,
} from "@/features/test-lab/launch-receipt"
import type { BuilderDraft, TestLabBootstrap } from "@/features/test-lab/types"
import type { TestLabService } from "@/services/test-lab-service"
import { useBuilderDraft } from "@/state/use-builder-draft"
import {
  navigateDashboard,
  useDashboardRoute,
} from "@/state/use-dashboard-route"
import { useTestLabData } from "@/state/use-test-lab-data"
import { useSelectedRunPolling } from "@/state/use-selected-run-polling"

export function TestLabPage({
  initial,
  service,
  openRun = (runId) =>
    navigateDashboard(
      `/dashboard/testing/runs/${encodeURIComponent(runId)}#activity-session`
    ),
}: {
  initial: TestLabBootstrap
  service: TestLabService
  openRun?: (runId: string) => void
}) {
  const route = useDashboardRoute()
  const { snapshot, setSnapshot, pending, error, mutate } =
    useTestLabData(initial)
  const builder = useBuilderDraft(snapshot.composer.defaultPreset)
  const selectedRun =
    route.kind === "run"
      ? snapshot.runs.find((run) => run.id === route.runId)
      : undefined
  const [launchReceipt, setLaunchReceipt] =
    React.useState<LaunchRunReceipt | null>(() =>
      selectedRun
        ? takeLaunchReceipt(
            selectedRun.id,
            selectedRun.generation,
            selectedRun.sequence
          )
        : null
    )
  const launch = async (draft: BuilderDraft) => {
    const receipt = await mutate(async () => {
      const launched = await service.launchRun(draft)
      setSnapshot(await service.getSnapshot())
      return launched
    })
    rememberLaunchReceipt(receipt)
    setLaunchReceipt(receipt)
    return receipt
  }
  const finish = async (runId: string) => {
    await mutate(() => service.finishRun(runId))
  }
  const update = async (
    run: NonNullable<typeof selectedRun>,
    status: string,
    progress: number
  ) => {
    if (!run.presentation) return
    const presentation = {
      ...run.presentation,
      content: { ...run.presentation.content, status },
      components: run.presentation.components.map((component) =>
        component.type === "progress_bar"
          ? { ...component, value: progress / 100 }
          : component
      ),
    }
    await mutate(() =>
      service.updateRun(
        run.id,
        JSON.parse(JSON.stringify(presentation)) as Record<string, unknown>
      )
    )
  }
  const wait = async (
    runId: string,
    kind: "approval" | "yes_no",
    prompt: string
  ) => {
    await mutate(() => service.waitRun(runId, kind, prompt))
  }
  const finishAll = async () => {
    if (
      !window.confirm(
        `Finish all ${snapshot.summary.active} active Test Lab runs?`
      )
    )
      return
    await mutate(() => service.finishAll())
    window.location.reload()
  }
  const polled = useSelectedRunPolling({
    runId: selectedRun?.id,
    active: selectedRun?.state === "active",
    service,
    onStatus: (status) =>
      setSnapshot((current) => ({
        ...current,
        runs: current.runs.map((run) =>
          run.id !== status.id
            ? run
            : {
                ...run,
                title: status.title,
                status: status.status,
                state: status.state,
                progress: status.progress,
                generation: status.generation,
                sequence: status.sequence,
                ownerKind: status.ownerKind,
                presentation: status.presentation as typeof run.presentation,
                targetDeviceName:
                  status.targets.map((target) => target.name).join(", ") ||
                  run.targetDeviceName,
                evidence: {
                  provider: {
                    state: status.delivery?.state ?? null,
                    durableCommands:
                      status.delivery?.summary.durableCommands ?? 0,
                    apnsJobs: status.delivery?.summary.apnsJobs ?? 0,
                  },
                  phone: {
                    expected: status.currentCommandReceipts.length,
                    confirmed: status.currentCommandReceipts.filter(
                      (receipt) => receipt.receivedAt
                    ).length,
                  },
                  activityKit: status.activityKit ?? run.evidence.activityKit,
                  response: {
                    kind: status.interaction?.kind ?? null,
                    state: status.interaction?.state ?? null,
                    action: status.interaction?.action ?? null,
                    respondedAt: status.interaction?.respondedAt ?? null,
                  },
                },
              }
        ),
      })),
  })

  const summary = [
    ["Active", snapshot.summary.active, "active"],
    ["Provider waiting", snapshot.summary.awaitingProvider, "warning"],
    ["Phone waiting", snapshot.summary.awaitingPhone, "info"],
    ["Response waiting", snapshot.summary.awaitingResponse, "neutral"],
    ["Total", snapshot.summary.total, "neutral"],
  ] as const

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="canvas min-h-[100dvh] px-4 py-7 sm:px-6 lg:px-10 lg:py-10"
    >
      <div className="mx-auto max-w-[1500px]">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
              {snapshot.shell.title}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
              {snapshot.shell.description}
            </p>
          </div>
          <NewRunSheet
            open={route.kind === "new"}
            devices={snapshot.devices}
            presets={snapshot.composer.presets}
            draft={builder.draft}
            pending={pending}
            update={builder.update}
            reset={builder.reset}
            launch={launch}
            openRun={openRun}
          />
        </header>
        <section
          className="mt-6 grid grid-cols-2 gap-2 sm:flex sm:max-w-full"
          aria-label="Run summary"
        >
          {summary.map(([label, value, tone]) => (
            <div
              key={label}
              className="status-card flex min-h-11 min-w-0 items-center gap-2 rounded-xl border px-3 py-2 last:col-span-2 sm:shrink-0 sm:rounded-full sm:px-3.5 sm:last:col-span-1"
              data-tone={tone}
              data-live={label === "Active" && value > 0 ? "true" : "false"}
            >
              <span className="text-lg font-semibold text-foreground tabular-nums">
                {value}
              </span>
              <span className="text-xs text-muted-foreground">{label}</span>
            </div>
          ))}
        </section>
        <div className="mt-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-medium">Run monitor</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Each row keeps Server, Provider, Phone, ActivityKit, and Response
              evidence separate.
            </p>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            {snapshot.summary.active > 0 ? (
              <Button
                variant="destructive"
                className="min-h-11"
                data-workbench-action
                data-action="end-all-live-activities"
                disabled={pending}
                onClick={() => void finishAll()}
              >
                Finish {snapshot.summary.active} active
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="icon"
              className="size-11"
              onClick={() => window.location.reload()}
              aria-label="Refresh runs"
            >
              <RefreshCw />
            </Button>
          </div>
        </div>
        {error || polled.error ? (
          <div
            role="alert"
            className="my-4 flex items-start gap-3 rounded-[10px] border border-[#6a343d] bg-[#2b171d] p-4 text-sm text-[#ffb1ba]"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error ?? polled.error}</span>
          </div>
        ) : null}
        <div className="mt-4">
          <Sheet
            open={route.kind === "run"}
            onOpenChange={(next) =>
              !next && navigateDashboard("/dashboard/testing")
            }
          >
            <RunMonitor
              runs={snapshot.runs}
              onSelect={(run) =>
                navigateDashboard(
                  `/dashboard/testing/runs/${encodeURIComponent(run.id)}#activity-session`
                )
              }
            />
            <RunDetailsSheet
              key={selectedRun?.id ?? "missing"}
              run={selectedRun}
              launchReceipt={
                launchReceipt &&
                selectedRun &&
                launchReceipt.activityId === selectedRun.id &&
                launchReceipt.generation === selectedRun?.generation &&
                launchReceipt.sequence === selectedRun?.sequence
                  ? launchReceipt
                  : null
              }
              pending={pending}
              finish={finish}
              update={update}
              wait={wait}
            />
          </Sheet>
        </div>
        <footer className="mt-6 flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:justify-between">
          <span>{snapshot.shell.releaseIdentity}</span>
          <span>
            {polled.pending
              ? "Refreshing selected run"
              : selectedRun?.state === "active"
                ? "Selected run refreshes every 3 seconds"
                : "Select an active run for live evidence"}
          </span>
        </footer>
      </div>
    </main>
  )
}
