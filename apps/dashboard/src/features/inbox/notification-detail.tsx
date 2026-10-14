import { ArrowUpRight, Check, ChevronDown, Copy, Laptop, RotateCcw, Smartphone } from "lucide-react"
import { useEffect, useState } from "react"
import type * as React from "react"

import { EncryptedText } from "@/components/atoms/encrypted-text"

import {
  DeliveryChain,
  type DeliveryStage,
} from "@/components/molecules/delivery-chain"
import { Button } from "@/components/ui/button"
import { ConfirmationAction } from "@/features/connections/components"
import { OutcomeBadge } from "@/features/inbox/activity-card"
import {
  activityOutcome,
  clockLabel,
  originLabel,
  typeLabel,
} from "@/features/inbox/activity-model"
import type { NotificationDetail } from "@/features/inbox/types"
import { formatDashboardDate } from "@/features/inbox/utils"
import { displayName, displayNameOrNull } from "@/lib/encrypted"
import { relativeTime } from "@/lib/format"
import { useTicker } from "@/lib/ticker"
import { semanticStatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"
import type { InboxService } from "@/services/inbox-service"

type Tone = "success" | "active" | "warning" | "danger" | "neutral"

const toneClass: Record<Tone, string> = {
  success:
    "text-[var(--status-success)] bg-[color-mix(in_srgb,var(--status-success)_12%,transparent)]",
  active:
    "text-[var(--status-active)] bg-[color-mix(in_srgb,var(--status-active)_14%,transparent)]",
  warning:
    "text-[var(--status-warning)] bg-[color-mix(in_srgb,var(--status-warning)_12%,transparent)]",
  danger:
    "text-[var(--status-danger)] bg-[color-mix(in_srgb,var(--status-danger)_12%,transparent)]",
  neutral: "text-muted-foreground bg-white/[0.06]",
}

function clock(value: string | null) {
  if (!value) return ""
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return ""
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date)
}

function when(value: string | null) {
  return [clock(value), relativeTime(value)].filter(Boolean).join(" · ")
}

function words(value: string) {
  return value.replaceAll("_", " ")
}

/** Only facts that happened, in order. Apple acceptance is never called delivery. */
function deliveryFacts(detail: NotificationDetail): DeliveryStage[] {
  const facts: DeliveryStage[] = [
    {
      id: "sent",
      label: "Sent",
      state: "done",
      summary: when(detail.notification.createdAt),
    },
  ]
  const accepted = detail.deliveries
    .map((delivery) => delivery.acceptedAt)
    .filter((at): at is string => Boolean(at))
    .sort()[0]
  if (accepted) {
    facts.push({
      id: "apple",
      label: "Accepted by Apple",
      state: "done",
      summary: when(accepted),
    })
  } else {
    const failed = detail.deliveries.find(
      (delivery) => semanticStatusTone(delivery.state) === "danger"
    )
    if (failed)
      facts.push({
        id: "apple",
        label: "Apple didn’t accept it",
        state: "failed",
        summary:
          failed.error?.message ??
          (failed.error ? words(failed.error.code) : when(failed.updatedAt)),
      })
  }
  for (const kind of ["received", "opened"] as const) {
    const receipt = detail.receipts.find((item) => item.kind === kind)
    if (receipt)
      facts.push({
        id: kind,
        label: `${kind === "received" ? "Received" : "Opened"} on ${receipt.deviceName}`,
        state: "done",
        summary: when(receipt.createdAt),
      })
  }
  const interaction = detail.interaction
  if (interaction?.respondedAt)
    facts.push({
      id: "answered",
      label: `Answered${interaction.respondingDevice ? ` on ${interaction.respondingDevice.name}` : ""}`,
      state: "done",
      summary: when(interaction.respondedAt),
    })
  return facts
}

function isExpired(value: string | null) {
  return Boolean(value && new Date(value).valueOf() < Date.now())
}

/** One status that says what is true now, in words. */
function headline(
  detail: NotificationDetail,
  withdrawn: boolean
): { tone: Tone; text: string } {
  const { interaction, activity, deliveries, receipts } = detail
  if (withdrawn) return { tone: "neutral", text: "Withdrawn" }
  if (interaction) {
    if (interaction.respondedAt || interaction.action)
      return {
        tone: "success",
        text: interaction.action
          ? `Answered · ${words(interaction.action)}`
          : "Answered",
      }
    if (isExpired(interaction.expiresAt))
      return { tone: "neutral", text: "Expired without an answer" }
    return { tone: "warning", text: "Waiting for your answer" }
  }
  if (
    !deliveries.some((delivery) => delivery.acceptedAt) &&
    deliveries.some((delivery) => semanticStatusTone(delivery.state) === "danger")
  )
    return { tone: "danger", text: "Not delivered" }
  if (activity?.state === "active") return { tone: "active", text: "Live on iPhone" }
  if (receipts.some((receipt) => receipt.kind === "opened"))
    return { tone: "success", text: "Opened" }
  if (receipts.some((receipt) => receipt.kind === "received"))
    return { tone: "success", text: "Delivered" }
  if (deliveries.some((delivery) => delivery.acceptedAt))
    return { tone: "active", text: "Sent to Apple" }
  const state = detail.notification.state
  if (state === "recorded") return { tone: "neutral", text: "In your inbox" }
  const text = words(state)
  return { tone: "neutral", text: text.charAt(0).toUpperCase() + text.slice(1) }
}

const stepWord = {
  done: "Done",
  current: "In progress",
  pending: "Pending",
  stopped: "Stopped",
} as const

type MissionState = keyof typeof stepWord

function missionState(
  state: string,
  index: number,
  all: Array<{ state: string }>,
  failed: boolean
): MissionState {
  if (state === "complete") return "done"
  if (state === "current") return failed ? "stopped" : "current"
  // A stopped task leaves its first unfinished step marked in red (failed).
  if (failed && !all.some((step) => step.state === "current")) {
    const first = all.findIndex((step) => step.state !== "complete")
    if (first === index) return "stopped"
  }
  return "pending"
}

function durationSeconds(from: string | null, to: string | null) {
  if (!from || !to) return null
  const value = (new Date(to).valueOf() - new Date(from).valueOf()) / 1000
  return Number.isFinite(value) && value >= 0 ? value : null
}

function StepMarker({ state, index }: { state: MissionState; index: number }) {
  const base = "relative z-10 grid size-6 shrink-0 place-items-center rounded-full text-[11px]"
  if (state === "done")
    return (
      <span className={base} style={{ backgroundImage: "linear-gradient(135deg,var(--neon-cyan),var(--neon-violet))", color: "#07090e" }}>
        <Check className="size-3.5" aria-hidden="true" />
      </span>
    )
  if (state === "current")
    return (
      <span className={cn(base, "mission-pulse border border-[var(--neon-violet)] bg-[color-mix(in_srgb,var(--neon-violet)_20%,transparent)] font-mono text-white")}>
        {index}
      </span>
    )
  if (state === "stopped")
    return (
      <span className={cn(base, "border border-[var(--neon-red)] bg-[color-mix(in_srgb,var(--neon-red)_16%,transparent)] font-mono text-[var(--neon-red)]")}>
        {index}
      </span>
    )
  return <span className={cn(base, "border border-white/20 font-mono text-muted-foreground")}>{index}</span>
}

function Telemetry({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="micro">{label}</dt>
      <dd className="numeral mt-1.5 truncate text-2xl">{value}</dd>
    </div>
  )
}

export function NotificationDetailBody({
  detail,
  context,
  service,
  heading,
  variant = "page",
}: {
  detail: NotificationDetail
  context?: string
  service: InboxService
  heading?: (title: React.ReactNode) => React.ReactNode
  /** "panel" draws its own padded header, body, and pinned footer. */
  variant?: "page" | "panel"
}) {
  const event = detail.notification
  const activity = detail.activity
  const interaction = detail.interaction
  const [withdrawal, setWithdrawal] = useState<"idle" | "pending" | "done" | "failed">(
    event.withdrawnAt ? "done" : "idle"
  )
  const [reactivation, setReactivation] = useState<"idle" | "pending" | "done" | "failed">("idle")
  const [reconciling, setReconciling] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!event.readAt) void service.markNotificationRead?.(event.id).catch(() => undefined)
  }, [event.id, event.readAt, service])

  const panel = variant === "panel"
  const canReactivate =
    activity?.state === "active" &&
    activity.presentationLeases.some((lease) => lease.state === "not_presented")
  // Sealed end to end (ADR 0005): the Dashboard has no key, so it points to the iPhone instead.
  const encrypted = event.encrypted === true || activity?.encrypted === true
  const promptEncrypted = encrypted || interaction?.encrypted === true
  const title = encrypted ? "" : displayName(activity?.context.taskTitle ?? event.title)
  const titleNode = encrypted ? <EncryptedText className="text-muted-foreground" /> : title
  const status = headline(detail, withdrawal === "done")
  const cardOutcome =
    activity && !interaction && withdrawal !== "done"
      ? activityOutcome(activity.state, activity.outcome)
      : null
  const stepItems = (activity?.stepItems ?? []).map((step, index, all) => ({
    label: step.label,
    state: missionState(step.state, index, all, activity?.outcome === "failed"),
  }))
  const tickNow = useTicker(Boolean(activity && !activity.endedAt))
  const elapsedSeconds = activity
    ? durationSeconds(
        activity.createdAt,
        activity.endedAt ?? new Date(tickNow).toISOString()
      )
    : null
  const elapsed = elapsedSeconds == null ? null : clockLabel(elapsedSeconds)
  const origin = activity ? originLabel(activity.context) : null
  const identity = context
    ? context.split(" › ")
    : [event.source, displayNameOrNull(activity?.context.project), displayNameOrNull(activity?.context.threadName)]
  const chips = [
    ...identity.filter((part): part is string => Boolean(part)).map((text, index) => ({
      key: `id-${index}`, text, label: ["Source", "Project", "Topic"][index] ?? "Context",
    })),
    { key: "type", text: typeLabel(event.kind, interaction?.kind ?? null), label: "Type" },
    { key: "created", text: formatDashboardDate(event.createdAt), label: "Created" },
  ]
  const body = event.body.trim()
  const showBody = !encrypted && Boolean(body) && body !== interaction?.prompt.trim() && body !== title
  const showPrompt = promptEncrypted
    ? !encrypted
    : Boolean(interaction?.prompt.trim()) && interaction!.prompt.trim() !== title
  const pendingAnswer =
    interaction && !interaction.respondedAt && !interaction.action && !isExpired(interaction.expiresAt)

  const canWithdraw = !activity && withdrawal !== "done" && Boolean(service.withdrawNotification)
  const showReactivate = canReactivate && reactivation !== "done" && Boolean(service.reactivateActivity)
  const hasActions = event.destination.state === "safe" || showReactivate || canWithdraw

  const pad = panel ? "px-6" : ""

  return (
    <div className={cn(panel ? "flex min-h-full flex-col" : "space-y-8")}>
      <header className={cn(panel && "border-b border-border pt-6 pb-5", pad, "space-y-3")}>
        <div className="flex flex-wrap gap-1.5" data-identity-chips>
          {chips.map((chip) => (
            <span key={chip.key} className="hairline-chip" title={chip.label}>
              <span className="truncate">{chip.text}</span>
            </span>
          ))}
          {origin ? (
            <span className="hairline-chip gap-1" title="Computer and agent account" data-part="origin">
              <Laptop className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{origin}</span>
            </span>
          ) : null}
        </div>
        {heading ? (
          heading(titleNode)
        ) : (
          <h2 className="text-2xl font-light tracking-tight sm:text-3xl [overflow-wrap:anywhere]">{titleNode}</h2>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {cardOutcome ? (
            <span data-detail-status className="inline-flex">
              <OutcomeBadge outcome={cardOutcome} />
            </span>
          ) : (
            <span
              className={cn(
                "inline-flex w-fit items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium",
                toneClass[status.tone]
              )}
              data-detail-status
            >
              <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
              {status.text}
            </span>
          )}
          {activity?.status && !encrypted ? (
            <span className="text-sm text-muted-foreground">{activity.status}</span>
          ) : null}
        </div>
      </header>

      <div className={cn("space-y-8", panel && "flex-1 py-6", pad)}>
        {activity ? (
          <>
            {activity.detail && !encrypted ? (
              <p className="text-sm leading-6 text-muted-foreground">{activity.detail}</p>
            ) : null}
            {stepItems.length ? (
              <section aria-labelledby="mission-heading" className="space-y-4">
                <h3 id="mission-heading" className="micro">Mission</h3>
                <ol className="space-y-0">
                  {stepItems.map((step, index) => (
                    <li key={index} className="relative flex gap-3 pb-4 last:pb-0" data-step-state={step.state}>
                      {index < stepItems.length - 1 ? (
                        <span
                          aria-hidden="true"
                          className="absolute top-7 bottom-0 left-[11px] w-px"
                          style={{ background: step.state === "done" ? "linear-gradient(180deg,var(--neon-cyan),var(--neon-violet))" : "var(--hairline)" }}
                        />
                      ) : null}
                      <StepMarker state={step.state} index={index + 1} />
                      <span className="min-w-0 pt-0.5">
                        <span
                          className={cn(
                            "block text-sm [overflow-wrap:anywhere]",
                            step.state === "pending" ? "text-muted-foreground" : "text-foreground"
                          )}
                        >
                          {step.label}
                        </span>
                        <span className="micro">{stepWord[step.state]}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            ) : typeof activity.progress === "number" ? (
              <div className="flex items-center gap-3">
                <div
                  className="h-1 flex-1 overflow-hidden rounded-full bg-white/10"
                  role="progressbar"
                  aria-label="Progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(activity.progress * 100)}
                >
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.round(activity.progress * 100)}%`, backgroundImage: "var(--ramp)" }}
                  />
                </div>
                <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">
                  {Math.round(activity.progress * 100)}%
                </span>
              </div>
            ) : null}
            <dl className="grid grid-cols-3 gap-4 border-t border-white/[0.07] pt-5" aria-label="Telemetry">
              <Telemetry label="Elapsed" value={elapsed ?? "—"} />
              <Telemetry label="Updates" value={String(activity.updates ?? activity.sequence + 1)} />
              <Telemetry label="Started" value={clock(activity.createdAt) || "—"} />
            </dl>
          </>
        ) : showBody ? (
          <p className="text-[15px] leading-7 whitespace-pre-wrap [overflow-wrap:anywhere]">{body}</p>
        ) : null}

        {interaction ? (
          <section aria-labelledby="answer-heading" className="space-y-3">
            <h3 id="answer-heading" className="micro">
              Your answer
            </h3>
            {showPrompt ? (
              <p className="text-[15px] leading-7">
                {promptEncrypted ? <EncryptedText className="text-muted-foreground" /> : interaction.prompt}
              </p>
            ) : null}
            {pendingAnswer ? (
              <p className="flex items-start gap-2.5 text-sm text-muted-foreground">
                <Smartphone className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  Answer from the notification on your iPhone
                  {interaction.expiresAt ? (
                    <>
                      {" "}before{" "}
                      <time
                        dateTime={interaction.expiresAt}
                        title={formatDashboardDate(interaction.expiresAt)}
                        className="text-foreground"
                      >
                        {clock(interaction.expiresAt)}
                      </time>{" "}
                      ({relativeTime(interaction.expiresAt)})
                    </>
                  ) : null}
                  .
                </span>
              </p>
            ) : interaction.respondedAt || interaction.action ? (
              <p className="text-sm">
                <span className="text-muted-foreground">You chose </span>
                <span className="font-medium capitalize">
                  {interaction.action ? words(interaction.action) : "an answer"}
                </span>
                {interaction.respondingDevice ? (
                  <span className="text-muted-foreground"> on {interaction.respondingDevice.name}</span>
                ) : null}
                .
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No answer arrived before it expired
                {interaction.expiresAt ? ` at ${clock(interaction.expiresAt)}` : ""}.
              </p>
            )}
            {interaction.responseText ? (
              <blockquote className="rounded-xl border border-border bg-white/[0.03] px-4 py-3 text-sm leading-6 whitespace-pre-wrap">
                {interaction.responseText}
              </blockquote>
            ) : null}
          </section>
        ) : null}

        {activity ? null : (
          <section aria-labelledby="delivery-heading" className="space-y-4">
            <h3 id="delivery-heading" className="micro">
              Delivery
            </h3>
            <DeliveryChain stages={deliveryFacts(detail)} orientation="vertical" />
          </section>
        )}

        <details className="group rounded-2xl border border-border bg-white/[0.02] text-sm">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 font-medium text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronDown
              className="size-4 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
            Technical details
          </summary>
          <div className="space-y-4 border-t border-border p-4">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-xs">
              <dt className="text-muted-foreground">{activity ? "ID" : "Event"}</dt>
              <dd>
                {activity ? (
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(activity.id).then(() => setCopied(true)).catch(() => undefined)
                    }}
                    className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border px-2 text-xs hover:bg-accent"
                  >
                    {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
                    {copied ? "Copied" : "Copy ID"}
                  </button>
                ) : (
                  <span className="font-mono break-all">{event.id}</span>
                )}
              </dd>
              <dt className="text-muted-foreground">Kind</dt>
              <dd className="capitalize">{words(event.kind)}</dd>
              <dt className="text-muted-foreground">Privacy</dt>
              <dd className="capitalize">{event.privacy}</dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd>{formatDashboardDate(event.createdAt)}</dd>
              {activity ? (
                <>
                  <dt className="text-muted-foreground">Activity</dt>
                  <dd>Generation {activity.generation} · update {activity.sequence}</dd>
                </>
              ) : null}
            </dl>
            {activity ? (
              <DeliveryChain stages={deliveryFacts(detail)} orientation="vertical" />
            ) : null}
            {detail.deliveries.length ? (
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                {detail.deliveries.map((delivery) => (
                  <li key={delivery.id} className="px-3 py-2.5 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{delivery.deviceName}</span>
                      <span className="capitalize text-muted-foreground">{words(delivery.state)}</span>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      {delivery.attemptCount} attempt{delivery.attemptCount === 1 ? "" : "s"}
                      {delivery.error ? ` · ${delivery.error.code}` : ""}
                    </p>
                    {delivery.reconciliation.required && service.reconcileDelivery ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {delivery.reconciliation.allowedActions.map((action) => (
                          <Button key={action} size="sm" variant="secondary" disabled={reconciling === delivery.id}
                            onClick={async () => {
                              setReconciling(delivery.id)
                              try { await service.reconcileDelivery!(delivery.id, action) } finally { setReconciling(null) }
                            }}>
                            {action === "mark_accepted" ? "Mark accepted" : action === "retry" ? "Retry" : "Cancel"}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </details>

        {withdrawal === "failed" || reactivation === "failed" ? (
          <p role="alert" className="text-sm text-destructive">
            That didn’t go through. Try again.
          </p>
        ) : null}
      </div>

      {hasActions ? (
        <footer
          className={cn(
            "flex flex-wrap items-center gap-2",
            panel &&
              "sticky bottom-0 z-10 border-t border-border bg-popover px-6 py-4"
          )}
        >
          {canWithdraw ? (
            <ConfirmationAction
              label="Withdraw"
              title="Withdraw this notification?"
              description="It’s removed from your iPhone and marked withdrawn here. You can’t undo this."
              pending={withdrawal === "pending"}
              onConfirm={async () => {
                setWithdrawal("pending")
                try { await service.withdrawNotification!(event.id); setWithdrawal("done") }
                catch { setWithdrawal("failed") }
              }}
            />
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {showReactivate ? (
              <Button
                variant="outline"
                className="min-h-11"
                disabled={reactivation === "pending"}
                onClick={async () => {
                  setReactivation("pending")
                  try { await service.reactivateActivity!(activity!.id); setReactivation("done") }
                  catch { setReactivation("failed") }
                }}
              >
                <RotateCcw aria-hidden="true" /> Show on iPhone again
              </Button>
            ) : null}
            {event.destination.state === "safe" ? (
              <Button asChild className="min-h-11">
                <a href={event.destination.href} target="_blank" rel="noopener noreferrer">
                  Open link <ArrowUpRight aria-hidden="true" />
                </a>
              </Button>
            ) : null}
          </div>
        </footer>
      ) : null}
    </div>
  )
}
