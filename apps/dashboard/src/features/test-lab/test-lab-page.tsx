import { AlertCircle, ArrowRight, FlaskConical, Smartphone } from "lucide-react"
import * as React from "react"

import { StatusDot } from "@/components/atoms/status-dot"
import { Empty, Section } from "@/components/list"
import { ConfirmationAction } from "@/components/molecules/confirmation-action"
import { Notice } from "@/components/molecules/notice"
import { RunMonitor } from "@/components/organisms/run-monitor"
import { Page } from "@/components/page"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
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
    <Notice
      aria-label="iPhone setup"
      data-device-setup
      tone="orange"
      icon={<Smartphone />}
      title={
        devices.length
          ? "No iPhone is ready for tests"
          : "Connect an iPhone to start testing"
      }
      action={
        <Button variant="outline" size="sm" asChild>
          <a href={CONNECTIONS_HREF}>
            Open Connections
            <ArrowRight aria-hidden="true" />
          </a>
        </Button>
      }
    >
      {devices.length ? (
        <ul className="space-y-0.5">
          {devices.map((device) => (
            <li key={device.id}>
              <span className="text-foreground">{device.name}</span>
              {" · "}
              {deviceBlocker(device)}
            </li>
          ))}
        </ul>
      ) : (
        "Sign in to the Relo app on your iPhone and allow notifications and Live Activities. It appears here as soon as it can receive tests."
      )}
    </Notice>
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
  // Only End all's own button shows its work (the sheet's actions share `pending`).
  const [endingAll, setEndingAll] = React.useState<{ pending: boolean; failed: boolean }>({ pending: false, failed: false })
  const finishAll = async () => {
    setEndingAll({ pending: true, failed: false })
    try {
      await mutate(async () => {
        await service.finishAll()
        await refresh()
      })
      setEndingAll({ pending: false, failed: false })
    } catch {
      setEndingAll({ pending: false, failed: true })
    }
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
        <Notice
          role="alert"
          tone="red"
          icon={<AlertCircle />}
          title="That didn’t go through"
          action={
            <Button
              variant="ghost"
              size="sm"
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
          }
        >
          {shownError}
        </Notice>
      ) : null}

      {readyDevices.length === 0 ? (
        <DeviceSetup devices={snapshot.devices} />
      ) : null}

      <Section
        title="Tests"
        action={
          <div className="flex flex-wrap items-center gap-3">
            {summary ? (
              <span className="text-xs text-muted-foreground" role="status">
                <StatusDot tone={hasLive ? "cyan" : "neutral"} live={hasLive} label={summary} />
              </span>
            ) : null}
            {snapshot.summary.active > 1 ? (
              <ConfirmationAction
                label={`End all ${snapshot.summary.active}`}
                title={`End ${snapshot.summary.active} live tests?`}
                description="Every live test is removed from its iPhone’s Lock Screen. You can’t undo this."
                pending={endingAll.pending}
                failed={endingAll.failed}
                disabled={pending}
                pendingLabel="Ending…"
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
            <Empty
              icon={<FlaskConical />}
              title="No tests yet"
              description={
                readyDevices.length
                  ? "Send one to see exactly how a notification looks and travels."
                  : "Once an iPhone is connected, your tests show up here."
              }
              action={
                readyDevices.length ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      navigateDashboard(
                        "/dashboard/testing?compose=1#activity-builder-panel"
                      )
                    }
                  >
                    Send your first test
                  </Button>
                ) : null
              }
            />
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
