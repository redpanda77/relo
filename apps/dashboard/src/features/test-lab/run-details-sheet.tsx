import { ArrowUpRight, Send } from "lucide-react"
import * as React from "react"

import { DeliveryChain } from "@/components/molecules/delivery-chain"
import { NotificationPreview } from "@/components/organisms/notification-preview"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ConfirmationAction } from "@/features/connections/components"
import {
  deliveryHeadline,
  deliveryStages,
} from "@/features/test-lab/delivery-chain"
import type { BuilderDraft, TestRun } from "@/features/test-lab/types"
import type { LaunchRunReceipt } from "@/features/test-lab/launch-receipt"
import { relativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"
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
          ? presentation.appearance.progressDisplay === "ring"
            ? "progress_ring"
            : "progress_bar"
          : "none",
    progress:
      measured?.type === "progress_bar"
        ? Math.round(measured.value * 100)
        : Math.round((run.progress ?? 0) * 100),
    progressLabel:
      measured?.type === "progress_bar" ? (measured.label ?? "") : "",
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

const headlineClass = {
  danger: "text-[var(--status-danger)] bg-[color-mix(in_srgb,var(--status-danger)_12%,transparent)]",
  warning: "text-[var(--status-warning)] bg-[color-mix(in_srgb,var(--status-warning)_12%,transparent)]",
  active: "text-[var(--status-active)] bg-[color-mix(in_srgb,var(--status-active)_14%,transparent)]",
  neutral: "text-muted-foreground bg-white/[0.06]",
} as const

function receiptNote(receipt: LaunchRunReceipt) {
  if (receipt.reused) return "Sent as an update to the test already on this iPhone."
  if (receipt.resumed) return "Sent as a fresh Live Activity, replacing the one that ended."
  return "Sent as a new Live Activity."
}

function Panel({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-4 rounded-2xl border border-border bg-white/[0.03] p-4 sm:p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm break-words">{children}</dd>
    </div>
  )
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
  const stages = run ? deliveryStages(run) : []
  const headline = run ? deliveryHeadline(run, stages) : null
  const appleFailed = stages.some(
    (stage) => stage.id === "apple" && stage.state === "failed"
  )
  const time = run ? relativeTime(run.updatedAt ?? run.createdAt) : ""

  return (
    <SheetContent
      className="w-full gap-0 overflow-y-auto p-0 outline-none sm:max-w-[720px]! sm:rounded-l-[20px]"
      aria-describedby="run-detail-description"
    >
      <SheetHeader className="gap-2 border-b border-border px-6 py-5 pr-16">
        {headline ? (
          <span
            className={cn(
              "inline-flex w-fit items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium",
              headlineClass[headline.tone]
            )}
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
            {headline.text}
          </span>
        ) : null}
        <SheetTitle className="text-xl">{run?.title ?? "Test not found"}</SheetTitle>
        <SheetDescription id="run-detail-description">
          {run
            ? [run.targetDeviceName, time].filter(Boolean).join(" · ") ||
              run.status
            : "This test is no longer in the list. Close this panel and pick another."}
        </SheetDescription>
        {launchReceipt ? (
          <p className="text-xs text-muted-foreground">{receiptNote(launchReceipt)}</p>
        ) : null}
      </SheetHeader>

      {run ? (
        <div
          className="flex-1 space-y-8 px-6 py-6"
          id="activity-session"
          data-activity-id={run.id}
          data-state={run.state}
        >
          <section aria-labelledby="delivery-heading" className="space-y-4">
            <h3 id="delivery-heading" className="text-sm font-semibold">
              Delivery
            </h3>
            <DeliveryChain stages={stages} />
            {appleFailed ? (
              <p className="text-xs leading-5 text-muted-foreground">
                Apple rejects pushes when Relo’s push credentials have expired.
                Check{" "}
                <a
                  href="/dashboard/connections"
                  className="text-foreground underline underline-offset-4"
                >
                  Connections
                </a>
                , then send the test again.
              </p>
            ) : null}
          </section>

          <section aria-labelledby="preview-heading" className="space-y-4">
            <h3 id="preview-heading" className="text-sm font-semibold">
              On the iPhone
            </h3>
            <NotificationPreview
              draft={previewDraft(run)}
              secondaryColor={run.presentation?.identity.thread?.color}
            />
          </section>

          {canMutate && behavior === "progress" ? (
            <Panel title="Send an update">
              <div className="space-y-2">
                <Label htmlFor="activity-progress">Progress</Label>
                <div className="flex min-h-11 items-center gap-3">
                  <input
                    id="activity-progress"
                    type="range"
                    min="0"
                    max="100"
                    value={progress}
                    aria-valuetext={`${progress}%`}
                    onChange={(event) => setProgress(Number(event.target.value))}
                    className="h-1.5 flex-1 cursor-pointer accent-[var(--primary)]"
                  />
                  <output
                    htmlFor="activity-progress"
                    className="w-10 text-right text-sm tabular-nums"
                  >
                    {progress}%
                  </output>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="activity-status">Status line</Label>
                <Input
                  id="activity-status"
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  className="min-h-11"
                />
              </div>
              <Button
                className="min-h-11"
                data-action="update-live-activity"
                disabled={pending || !status.trim()}
                onClick={() => void update(run, status, progress)}
              >
                <Send aria-hidden="true" />
                Send update
              </Button>
            </Panel>
          ) : null}

          {canMutate && (behavior === "approval" || behavior === "yes_no") ? (
            <Panel title="Ask for an answer">
              <div className="space-y-2">
                <Label htmlFor="activity-prompt">Question</Label>
                <Input
                  id="activity-prompt"
                  value={prompt}
                  placeholder={
                    behavior === "approval" ? "Ship build 214?" : "Is the deploy done?"
                  }
                  onChange={(event) => setPrompt(event.target.value)}
                  className="min-h-11"
                />
              </div>
              <Button
                className="min-h-11"
                data-action="wait-live-activity"
                data-kind={behavior}
                disabled={pending || !prompt.trim()}
                onClick={() => void wait(run.id, behavior, prompt)}
              >
                <Send aria-hidden="true" />
                {behavior === "approval" ? "Ask for approval" : "Ask yes or no"}
              </Button>
            </Panel>
          ) : null}

          <details className="group rounded-2xl border border-border bg-white/[0.02]">
            <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium text-muted-foreground hover:text-foreground">
              Technical details
            </summary>
            <dl className="grid gap-4 border-t border-border p-4 sm:grid-cols-2">
              <Fact label="Test ID">
                <span className="font-mono text-xs break-all">{run.id}</span>
              </Fact>
              <Fact label="Requested by">{run.requesterLabel}</Fact>
              <Fact label="Update number">
                {run.sequence} (Live Activity {run.generation})
              </Fact>
              <Fact label="Apple jobs">
                {run.evidence.provider.apnsJobs} push
                {run.evidence.provider.apnsJobs === 1 ? "" : "es"},{" "}
                {run.evidence.provider.durableCommands} queued
              </Fact>
              {run.detail ? (
                <div className="sm:col-span-2">
                  <Fact label="Note">{run.detail}</Fact>
                </div>
              ) : null}
            </dl>
          </details>
        </div>
      ) : null}

      {run ? (
        <div className="glass-strong sticky bottom-0 z-10 flex items-center gap-3 border-x-0 border-b-0 px-6 py-4">
          <span
            id="workbench-operation"
            role="status"
            className="mr-auto flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground"
          >
            {run.state === "active" ? (
              <span
                className="size-1.5 rounded-full bg-[var(--status-active)] shadow-[0_0_8px_var(--status-active)]"
                aria-hidden="true"
              />
            ) : null}
            {/* Background refreshes stay silent: only owner actions change this text. */}
            {pending ? "Working…" : run.state === "active" ? "Live" : "Ended"}
          </span>
          <Button variant="ghost" className="min-h-11" asChild>
            <a
              href={`/dashboard/testing/runs/${encodeURIComponent(run.id)}/history`}
            >
              Timeline
              <ArrowUpRight aria-hidden="true" />
            </a>
          </Button>
          {canMutate ? (
            <ConfirmationAction
              label="End test"
              title="End this test?"
              description={`“${run.title}” is removed from ${run.targetDeviceName ?? "the iPhone"}’s Lock Screen. You can’t undo this.`}
              pending={pending}
              onConfirm={() => void finish(run.id)}
            />
          ) : null}
        </div>
      ) : null}
    </SheetContent>
  )
}
