import { ExternalLink, Send, Square } from "lucide-react"
import * as React from "react"

import { StatusDot } from "@/components/atoms/status-dot"
import { EvidenceState } from "@/components/molecules/evidence-state"
import { NotificationPreview } from "@/components/organisms/notification-preview"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { BuilderDraft, TestRun } from "@/features/test-lab/types"
import type { LaunchRunReceipt } from "@/features/test-lab/launch-receipt"
import { DEFAULT_BUILDER_DRAFT } from "@/state/use-builder-draft"

function previewDraft(run: TestRun): BuilderDraft {
  const presentation = run.presentation
  if (!presentation)
    return {
      ...DEFAULT_BUILDER_DRAFT,
      title: run.title,
      status: run.status,
      progress: Math.round((run.progress ?? 0) * 100),
    }
  const steps = presentation.components.find(
      (component) => component.type === "steps"
    )
    const measured = presentation.components.find(
      (component) => component.type === "progress_bar"
    )
    const currentStep =
      steps?.type === "steps"
        ? Math.max(
            1,
            steps.items.findIndex((item) => item.state === "current") + 1
          )
        : 1
  return {
      ...DEFAULT_BUILDER_DRAFT,
      title: presentation.content.title,
      status: presentation.content.status,
      header:
        presentation.identity.project?.label ??
        presentation.content.header ??
        "Direct",
      subtitle: presentation.content.subtitle ?? "",
      behavior: presentation.behavior.type,
      visual:
        steps?.type === "steps"
          ? "steps"
          : measured?.type === "progress_bar"
            ? "progress_bar"
            : "none",
      progress:
        measured?.type === "progress_bar"
          ? Math.round(measured.value * 100)
          : Math.round((run.progress ?? 0) * 100),
      progressLabel:
        measured?.type === "progress_bar"
          ? (measured.label ?? "")
          : "",
      stepLabels:
        steps?.type === "steps"
          ? steps.items.map((item) => item.label).join(", ")
          : DEFAULT_BUILDER_DRAFT.stepLabels,
      stepCurrent: currentStep,
      accentColor:
        presentation.identity.project?.color ??
        presentation.identity.thread?.color ??
        DEFAULT_BUILDER_DRAFT.accentColor,
      theme: presentation.appearance.theme,
      symbol: presentation.state.icon,
  }
}

type Props = {
  run?: TestRun
  launchReceipt: LaunchRunReceipt | null
  pending: boolean
  finish: (runId: string) => Promise<void>
  update: (run: TestRun, status: string, progress: number) => Promise<void>
  wait: (
    runId: string,
    kind: "approval" | "yes_no",
    prompt: string
  ) => Promise<void>
}

export function RunDetailsSheet({
  run,
  launchReceipt,
  pending,
  finish,
  update,
  wait,
}: Props) {
  const [status, setStatus] = React.useState(run?.status ?? "")
  const [progress, setProgress] = React.useState(
    Math.round((run?.progress ?? 0) * 100)
  )
  const [prompt, setPrompt] = React.useState("")
  const behavior = run?.presentation?.behavior.type
  const canMutate = Boolean(run?.ownerControlled && run.state === "active")

  return (
    <SheetContent
      className="w-full overflow-y-auto border-[#403343] bg-popover p-0 sm:max-w-[680px]! sm:rounded-l-[20px]"
      aria-describedby="run-detail-description"
    >
      <SheetHeader className="border-b border-border px-6 py-5 pr-16">
        <div className="flex items-center gap-2">
          <StatusDot
            state={run?.state ?? "inactive"}
            active={run?.state === "active"}
          />
          <Badge
            variant="outline"
            className="rounded-md border-border font-normal capitalize"
          >
            {run?.state ?? "Unavailable"}
          </Badge>
        </div>
        <SheetTitle className="mt-3 text-xl">
          {run?.title ?? "Run not found"}
        </SheetTitle>
        <SheetDescription
          id="run-detail-description"
          className="font-mono text-xs break-all"
        >
          {run?.id ?? "This run is no longer present in the monitor."}
        </SheetDescription>
        {run ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge
              variant="outline"
              className="rounded-md font-mono font-normal"
            >
              Generation {run.generation}
            </Badge>
            <Badge
              variant="outline"
              className="rounded-md font-mono font-normal"
            >
              Sequence {run.sequence}
            </Badge>
            <Badge variant="outline" className="rounded-md font-normal">
              Owner: {run.ownerKind.replaceAll("_", " ")}
            </Badge>
            {launchReceipt ? (
              <Badge variant="secondary" className="rounded-md font-normal">
                {launchReceipt.reused
                  ? "Reused active generation"
                  : launchReceipt.resumed
                    ? "Resumed with next generation"
                    : "Created new generation"}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </SheetHeader>
      {run ? (
        <div
          className="space-y-7 p-6"
          id="activity-session"
          data-activity-id={run.id}
          data-state={run.state}
        >
          <NotificationPreview draft={previewDraft(run)} />
          <Separator />
          <section>
            <h2 className="text-sm font-medium">Delivery evidence</h2>
            <div className="mt-4 grid gap-5 sm:grid-cols-2">
              <EvidenceState
                label="Server"
                state="confirmed"
                summary={`${run.evidence.provider.durableCommands} durable commands, generation ${run.generation}, sequence ${run.sequence}`}
              />
              <EvidenceState
                label="Provider"
                state={run.evidence.provider.state ?? "waiting"}
                animated={
                  run.state === "active" && !run.evidence.provider.state
                }
                summary={`${run.evidence.provider.apnsJobs} APNs jobs`}
              />
              <EvidenceState
                label="Phone"
                state={
                  run.evidence.phone.expected === 0
                    ? "inactive"
                    : run.evidence.phone.confirmed >=
                        run.evidence.phone.expected
                      ? "confirmed"
                      : "waiting"
                }
                animated={
                  run.state === "active" &&
                  run.evidence.phone.expected > run.evidence.phone.confirmed
                }
                summary={
                  run.evidence.phone.expected === 0
                    ? "Confirmation not expected"
                    : `${run.evidence.phone.confirmed} of ${run.evidence.phone.expected} confirmed`
                }
              />
              <EvidenceState
                label="ActivityKit"
                state={run.evidence.activityKit.state ?? "inactive"}
                animated={
                  run.state === "active" &&
                  run.evidence.activityKit.state === "waiting"
                }
                summary={
                  run.evidence.activityKit.summary ?? "No native state reported"
                }
              />
              <EvidenceState
                label="Response"
                state={run.evidence.response.state ?? "inactive"}
                animated={
                  run.state === "active" &&
                  run.evidence.response.state === "pending"
                }
                summary={
                  run.evidence.response.action ??
                  run.evidence.response.kind ??
                  "No response expected"
                }
              />
            </div>
            <p className="mt-5 rounded-[10px] border border-border bg-[#171118] p-3 text-xs leading-5 text-muted-foreground">
              Provider credentials can expire without changing the stored run.
              Refresh delivery evidence before retrying a stalled notification.
            </p>
          </section>
          {canMutate && behavior === "progress" ? (
            <section className="space-y-4 rounded-xl border border-border bg-[#171118] p-4">
              <h2 className="text-sm font-medium">Update progress</h2>
              <div>
                <div className="flex justify-between">
                  <Label htmlFor="activity-progress">Progress</Label>
                  <output
                    id="activity-progress-output"
                    htmlFor="activity-progress"
                    className="text-xs text-muted-foreground tabular-nums"
                  >
                    {progress}%
                  </output>
                </div>
                <Input
                  id="activity-progress"
                  type="range"
                  min="0"
                  max="100"
                  value={progress}
                  onChange={(event) => setProgress(Number(event.target.value))}
                  className="mt-2 min-h-11"
                />
              </div>
              <div>
                <Label htmlFor="activity-status">Status</Label>
                <Input
                  id="activity-status"
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  className="mt-2 min-h-11"
                />
              </div>
              <Button
                className="min-h-11"
                data-workbench-action
                data-action="update-live-activity"
                disabled={pending || !status.trim()}
                onClick={() => void update(run, status, progress)}
              >
                <Send />
                Commit update
              </Button>
            </section>
          ) : null}
          {canMutate && (behavior === "approval" || behavior === "yes_no") ? (
            <section className="space-y-4 rounded-xl border border-border bg-[#171118] p-4">
              <h2 className="text-sm font-medium">Request a response</h2>
              <div>
                <Label htmlFor="activity-prompt">Phone prompt</Label>
                <Input
                  id="activity-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  className="mt-2 min-h-11"
                />
              </div>
              <Button
                className="min-h-11"
                data-workbench-action
                data-action="wait-live-activity"
                data-kind={behavior}
                disabled={pending || !prompt.trim()}
                onClick={() => void wait(run.id, behavior, prompt)}
              >
                <Send />
                {behavior === "approval" ? "Request approval" : "Ask yes or no"}
              </Button>
            </section>
          ) : null}
          <Separator />
          <section className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <span className="text-xs tracking-[0.12em] text-muted-foreground uppercase">
                Requested by
              </span>
              <p className="mt-1">{run.requesterLabel}</p>
            </div>
            <div>
              <span className="text-xs tracking-[0.12em] text-muted-foreground uppercase">
                Style
              </span>
              <p className="mt-1 capitalize">{run.style}</p>
            </div>
            <div className="sm:col-span-2">
              <span className="text-xs tracking-[0.12em] text-muted-foreground uppercase">
                Detail
              </span>
              <p className="mt-1 leading-6">
                {run.detail ?? "No additional detail"}
              </p>
            </div>
          </section>
          <div
            id="workbench-operation"
            role="status"
            className="text-xs text-muted-foreground"
          >
            {pending
              ? "Updating run..."
              : "Selected active runs refresh every 3 seconds."}
          </div>
          <div id="live-activity-feed" className="sr-only" aria-live="polite" />
          <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row">
            <Button variant="outline" className="min-h-11" asChild>
              <a
                href={`/dashboard/testing/runs/${encodeURIComponent(run.id)}/history`}
              >
                <ExternalLink />
                View history
              </a>
            </Button>
            {canMutate ? (
              <Button
                variant="destructive"
                className="min-h-11 sm:ml-auto"
                data-workbench-action
                data-action="end-live-activity"
                onClick={() => void finish(run.id)}
                disabled={pending}
              >
                <Square />
                Finish run
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="p-6 text-sm text-muted-foreground">
          Close this panel and select an available run.
        </div>
      )}
    </SheetContent>
  )
}
