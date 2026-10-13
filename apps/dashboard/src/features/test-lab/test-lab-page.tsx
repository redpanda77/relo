import { AlertCircle, ArrowRight, FlaskConical, Smartphone } from "lucide-react"
import * as React from "react"

import { Page, Section } from "@/components/page"
import { RunMonitor } from "@/components/organisms/run-monitor"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { ConfirmationAction } from "@/features/connections/components"
import { NewRunSheet } from "@/features/test-lab/new-run-sheet"
import { RunDetailsSheet } from "@/features/test-lab/run-details-sheet"
import { CONNECTIONS_HREF, deviceBlocker } from "@/features/test-lab/devices"
import {
  rememberLaunchReceipt,
  takeLaunchReceipt,
  type LaunchRunReceipt,
} from "@/features/test-lab/launch-receipt"
import type {
  BuilderDraft,
  TestDevice,
  TestLabBootstrap,
} from "@/features/test-lab/types"
import type { TestLabService } from "@/services/test-lab-service"
import { useBuilderDraft } from "@/state/use-builder-draft"
import {
  navigateDashboard,
  useDashboardRoute,
} from "@/state/use-dashboard-route"
import { useTestLabData } from "@/state/use-test-lab-data"
import { useSelectedRunPolling } from "@/state/use-selected-run-polling"

const LIST_REFRESH_MS = 5_000

function DeviceSetup({ devices }: { devices: TestDevice[] }) {
  return (
    <section
      aria-labelledby="device-setup-heading"
      className="glass flex flex-col gap-5 rounded-2xl p-5 sm:flex-row sm:items-center sm:p-6"
      data-device-setup
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent text-primary">
        <Smartphone className="size-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="device-setup-heading" className="font-medium">
          {devices.length
            ? "No iPhone is ready for tests"
            : "Connect an iPhone to start testing"}
        </h2>
        {devices.length ? (
          <ul className="mt-1.5 space-y-1 text-sm text-muted-foreground">
            {devices.map((device) => (
              <li key={device.id}>
                <span className="text-foreground">{device.name}</span>
                {" · "}
                {deviceBlocker(device)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 max-w-[60ch] text-sm text-muted-foreground">
            Sign in to the Relo app on your iPhone and allow notifications and
            Live Activities. It appears here as soon as it can receive tests.
          </p>
        )}
      </div>
      <Button variant="outline" className="min-h-11 self-start sm:self-auto" asChild>
        <a href={CONNECTIONS_HREF}>
          Open Connections
          <ArrowRight aria-hidden="true" />
        </a>
      </Button>
    </section>
  )
}

/** Server errors arrive as codes; say what happened in words. */
function friendlyError(message: string | null): string | null {
  if (!message) return null
  if (/not[_ ]?found|\b404\b/i.test(message))
    return "This test no longer exists. It may have ended on another device."
  if (/unauthori[sz]ed|forbidden|\b40[13]\b/i.test(message))
    return "Your session expired. Reload the page and sign in again."
  if (/failed to fetch|network/i.test(message))
    return "Relo couldn’t be reached. Check your connection."
  if (/^[a-z_]+$/.test(message)) return "Something went wrong on the server."
  return message
}

function summaryLine(summary: TestLabBootstrap["summary"]) {
  const parts = [
    summary.active ? `${summary.active} live` : null,
    summary.awaitingProvider ? `${summary.awaitingProvider} waiting on Apple` : null,
    summary.awaitingPhone ? `${summary.awaitingPhone} waiting on iPhone` : null,
    summary.awaitingResponse
      ? `${summary.awaitingResponse} waiting for an answer`
      : null,
  ].filter(Boolean)
  return parts.join(" · ")
}

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
  const { snapshot, setSnapshot, pending, error, setError, mutate } =
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
  const refresh = React.useCallback(async () => {
    setSnapshot(await service.getSnapshot())
  }, [service, setSnapshot])

  const launch = async (draft: BuilderDraft) => {
    const receipt = await mutate(async () => {
      const launched = await service.launchRun(draft)
      await refresh()
      return launched
    })
    rememberLaunchReceipt(receipt)
    setLaunchReceipt(receipt)
    return receipt
  }
  const finish = async (runId: string) => {
    await mutate(async () => {
      await service.finishRun(runId)
      await refresh()
    })
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
    await mutate(async () => {
      await service.finishAll()
      await refresh()
    })
  }

  // Keep the list honest while anything is live; pause when the tab is hidden and while a
  // run sheet is open, where the lightweight run-status poll already keeps it current.
  const hasLive = snapshot.summary.active > 0
  const runOpen = route.kind === "run"
  React.useEffect(() => {
    if (!hasLive || runOpen) return
    let stopped = false
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden" || stopped) return
      service
        .getSnapshot()
        .then((next) => {
          if (!stopped) setSnapshot(next)
        })
        .catch(() => undefined)
    }, LIST_REFRESH_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [hasLive, runOpen, service, setSnapshot])

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

  const readyDevices = snapshot.devices.filter((device) => device.ready)
  const shownError = friendlyError(
    error ?? (selectedRun ? polled.error : null)
  )
  const summary = summaryLine(snapshot.summary)

  return (
    <Page
      title="Test Lab"
      actions={
        <NewRunSheet
          open={route.kind === "new"}
          devices={snapshot.devices}
          draft={builder.draft}
          pending={pending}
          update={builder.update}
          reset={builder.reset}
          launch={launch}
          openRun={openRun}
        />
      }
    >
      {shownError ? (
        <div
          role="alert"
          className="glass flex items-start gap-3 rounded-2xl border-[color-mix(in_srgb,var(--status-danger)_40%,var(--border))] p-4 text-sm"
        >
          <AlertCircle
            className="mt-0.5 size-4 shrink-0 text-[var(--status-danger)]"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="font-medium">That didn’t go through</p>
            <p className="mt-0.5 text-muted-foreground">{shownError}</p>
          </div>
          <Button
            variant="ghost"
            className="min-h-11 shrink-0"
            onClick={() => {
              setError(null)
              void refresh().catch((cause: unknown) =>
                setError(
                  cause instanceof Error ? cause.message : "Refresh failed."
                )
              )
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {readyDevices.length === 0 ? (
        <DeviceSetup devices={snapshot.devices} />
      ) : null}

      <Section
        title="Tests"
        action={
          <div className="flex flex-wrap items-center gap-3">
            {summary ? (
              <span
                className="flex items-center gap-2 text-xs text-muted-foreground"
                role="status"
              >
                {hasLive ? (
                  <span
                    className="size-1.5 rounded-full bg-[var(--status-active)] shadow-[0_0_8px_var(--status-active)]"
                    aria-hidden="true"
                  />
                ) : null}
                {summary}
              </span>
            ) : null}
            {snapshot.summary.active > 1 ? (
              <ConfirmationAction
                label={`End all ${snapshot.summary.active}`}
                title={`End ${snapshot.summary.active} live tests?`}
                description="Every live test is removed from its iPhone’s Lock Screen. You can’t undo this."
                pending={pending}
                variant="outline"
                onConfirm={() => void finishAll()}
              />
            ) : null}
          </div>
        }
      >
        <Sheet
          open={route.kind === "run"}
          onOpenChange={(next) =>
            !next && navigateDashboard("/dashboard/testing")
          }
        >
          {snapshot.runs.length ? (
            <RunMonitor
              runs={snapshot.runs}
              onSelect={(run) =>
                navigateDashboard(
                  `/dashboard/testing/runs/${encodeURIComponent(run.id)}#activity-session`
                )
              }
            />
          ) : (
            <div className="glass rounded-2xl px-6 py-12 text-center">
              <FlaskConical
                className="mx-auto size-5 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="mt-3 text-sm font-medium">No tests yet</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                {readyDevices.length
                  ? "Send one to see exactly how a notification looks and travels."
                  : "Once an iPhone is connected, your tests show up here."}
              </p>
              {readyDevices.length ? (
                <Button
                  variant="outline"
                  className="mt-5 min-h-11"
                  onClick={() =>
                    navigateDashboard(
                      "/dashboard/testing?compose=1#activity-builder-panel"
                    )
                  }
                >
                  Send your first test
                </Button>
              ) : null}
            </div>
          )}
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
      </Section>
    </Page>
  )
}
