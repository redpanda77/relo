import { ArrowUpRight, ChevronDown, Laptop, RotateCcw, Smartphone } from "lucide-react"
import { useEffect, useState } from "react"
import type * as React from "react"

import { EncryptedText } from "@/components/atoms/encrypted-text"
import { ProgressBar } from "@/components/atoms/progress-bar"
import { Badge, Card, CardActions, CardCorner, CardFooter, CardHit, CardList, CardListItem, CardMeta, CardHeader, Countdown, Origin, RunningFor, Strip } from "@/components/card"
import { ActionButton, type ActionPhase } from "@/components/molecules/action-button"
import { AnswerControls } from "@/components/molecules/answer-controls"
import { CopyButton } from "@/components/molecules/copy-button"
import { OperationStatus } from "@/components/molecules/operation-status"
import {
  DeliveryChain,
  type DeliveryStage,
} from "@/components/molecules/delivery-chain"
import { Button } from "@/components/ui/button"
import { ConfirmationAction } from "@/components/molecules/confirmation-action"
import { EndWorkButton, type WorkActions } from "@/features/inbox/end-work"
import { OUTCOME_ICON } from "@/features/inbox/outcome-icons"
import { planEntries, type PlanStanding } from "@/features/inbox/plan-outline"
import { PlanTree } from "@/features/inbox/plan-tree"
import {
  activityOutcome,
  elapsedLabel,
  knownName,
  originLabel,
  projectColor,
  hashSlot,
  timeOfDay,
  typeLabel,
} from "@/features/inbox/activity-model"
import type { NotificationDetail } from "@/features/inbox/types"
import { formatDashboardDate } from "@/features/inbox/utils"
import { displayName } from "@/lib/encrypted"
import { relativeTime } from "@/lib/format"
import { isOpenQuestion, useAnswerableQuestion } from "@/hooks/use-answerable-question"
import { semanticStatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"
import type { InboxService } from "@/services/inbox-service"

type Tone = "success" | "active" | "warning" | "danger" | "neutral"

/**
 * Where a notification came from, when the list that opened it knew more than the detail carries
 * (a message's detail has no context): the History row's project, session and computer.
 */
export type DetailOrigin = {
  source?: string | null
  project?: { name: string; slot: number | null } | null
  topic?: string | null
  computer?: string | null
}

/** The headline's meaning colour: done mint, live cyan, waiting on you orange, failed red. */
const toneChip = {
  success: "mint",
  active: "cyan",
  warning: "orange",
  danger: "red",
  neutral: "neutral",
} as const satisfies Record<Tone, string>

/** A one-off action's state as an ActionButton phase. */
const phaseOf = { idle: "idle", pending: "pending", done: "success", failed: "error" } as const satisfies Record<
  "idle" | "pending" | "done" | "failed",
  ActionPhase
>

const clock = timeOfDay

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

function durationSeconds(from: string | null, to: string | null) {
  if (!from || !to) return null
  const value = (new Date(to).valueOf() - new Date(from).valueOf()) / 1000
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * The pending question's answer from this browser (AnswerControls), once the question's signing
 * facts load; until then, or when it cannot be answered here, the line pointing to the iPhone. Answered
 * elsewhere while open: a quiet line instead of buttons.
 */
function BrowserAnswer({ interactionId, fallback }: { interactionId: string; fallback: React.ReactNode }) {
  const question = useAnswerableQuestion(interactionId)
  // Answered on the phone or the notch (or no longer asked) while this page is open: no buttons left.
  if (question && !isOpenQuestion(question)) return <p className="text-sm text-muted-foreground" data-answered-elsewhere>No longer waiting for an answer.</p>
  return question ? <AnswerControls question={question} showPrompt={false} countdown={false} /> : <>{fallback}</>
}

/** One label and its value, a row of the Details list (iOS ReloAboutRows). */
function DetailFact({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="detail-fact">
      <dt>{label}</dt>
      <dd className={cn(mono && "tabular-nums")}>{children}</dd>
    </div>
  )
}

/** The Now work a detail was opened from, when the owner may end it (quiet, paused or their turn): End work at the foot. */
export type DetailWork = {
  /** The card (`act_…`) the server ends. */
  id: string
  goal: string
  /** Sealed: the goal is a placeholder, so the confirmation does not quote it. */
  encrypted: boolean
  end: WorkActions["end"]
}

export function NotificationDetailBody({
  detail,
  origin: listOrigin,
  work,
  service,
  heading,
  variant = "page",
}: {
  detail: NotificationDetail
  /** What the list that opened it knew about where it came from. */
  origin?: DetailOrigin
  work?: DetailWork
  service: InboxService
  heading?: (title: React.ReactNode) => React.ReactNode
  /** "page": the title is the page's own h1, Details sit in a side column on wide pages. "panel": one column in the side sheet. */
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
  // The plan as the iPhone shows it (plan 12b): the server's plan and rounds, else an older card's flat steps.
  const planSteps = activity ? planEntries(activity) : []
  const planStanding: PlanStanding = activity?.state === "active" ? "moving" : activity?.outcome === "completed" ? "done" : "stopped"
  const running = activity?.state === "active" && !activity.endedAt

  // Where it came from: the work's own context first, then what the list knew.
  const context = activity?.context
  const source = event.source
  const projectName = knownName(context?.project) ?? listOrigin?.project?.name ?? null
  const project = projectName ? { name: projectName, slot: listOrigin?.project?.slot ?? null } : null
  const topic = knownName(context?.threadName) ?? listOrigin?.topic ?? null
  const computer = (context ? originLabel(context) : null) ?? listOrigin?.computer ?? null
  const task = knownName(context?.taskTitle)

  const kindLabel = typeLabel(event.kind, interaction?.kind ?? null)
  const body = event.body.trim()
  const showBody = !encrypted && Boolean(body) && body !== interaction?.prompt.trim() && body !== title
  const showPrompt = promptEncrypted
    ? !encrypted
    : Boolean(interaction?.prompt.trim()) && interaction!.prompt.trim() !== title
  const pendingAnswer = Boolean(
    interaction && !interaction.respondedAt && !interaction.action && !isExpired(interaction.expiresAt)
  ) && withdrawal !== "done"
  const message = activity ? (encrypted ? null : activity.detail) : showBody ? body : null

  const canWithdraw = !activity && withdrawal !== "done" && Boolean(service.withdrawNotification)
  // After a reactivation the button stays to say so (a drawn check, then rest), with a line under it.
  const showReactivate = canReactivate && Boolean(service.reactivateActivity)
  const hasActions = event.destination.state === "safe" || showReactivate || canWithdraw

  const started = activity?.createdAt ?? event.createdAt
  const took = activity && activity.state !== "active" ? durationSeconds(activity.createdAt, activity.endedAt) : null
  const updates = activity ? (activity.updates ?? activity.sequence + 1) : null

  const prompt = interaction && showPrompt ? (
    <p className="detail-prompt">
      {promptEncrypted ? <EncryptedText className="text-muted-foreground" /> : interaction.prompt}
    </p>
  ) : null

  const CardOutcomeIcon = cardOutcome ? OUTCOME_ICON[cardOutcome.kind] : null
  // Three rows at most: where it came from (the computer in the corner), the title, how it stands.
  const header = (
    <header className="detail-header">
      <CardHeader
        origin={<Origin source={source} project={project?.name} projectColor={project ? projectColor(project.slot ?? hashSlot(project.name)) : null} topic={topic} />}
        trailing={
          computer ? (
            <CardCorner title="Computer and agent account" data-part="origin">
              <Laptop aria-hidden="true" />
              {computer}
            </CardCorner>
          ) : null
        }
      />
      {panel && heading ? heading(titleNode) : null}
      {!panel && encrypted ? <p className="detail-sealed"><EncryptedText className="text-muted-foreground" /></p> : null}
      <div className="detail-standing">
        <span data-detail-status className="inline-flex">
          {cardOutcome && CardOutcomeIcon ? (
            <Badge tone={cardOutcome.tone} icon={<CardOutcomeIcon aria-hidden="true" />}>{cardOutcome.label}</Badge>
          ) : (
            <Badge tone={toneChip[status.tone]}>{status.text}</Badge>
          )}
        </span>
        {running && activity?.createdAt ? <span className="card-corner"><RunningFor since={activity.createdAt} prefix="running " /></span> : null}
        {activity?.status && !encrypted ? <p className="detail-status">{activity.status}</p> : null}
      </div>
    </header>
  )

  const question = pendingAnswer && interaction ? (
    <Strip
      role="region"
      aria-labelledby="question-heading"
      variant="bordered"
      tone="orange"
      label={<span id="question-heading">{kindLabel === "Approval" ? "Asks for your approval" : "Asks you"}</span>}
    >
      {prompt}
    </Strip>
  ) : null

  const plan = activity && planSteps.length ? (
    <PlanTree headingId="plan-heading" entries={planSteps} rounds={activity.rounds} standing={planStanding} serverSteps={activity.steps} />
  ) : activity && typeof activity.progress === "number" ? (
    <section aria-label="Progress" className={cn("flex items-center gap-3", cardOutcome ? `tone-${cardOutcome.tone}` : "tone-cyan")}>
      <ProgressBar
        value={activity.progress}
        tone="neutral"
        color={cardOutcome?.tone === "neutral" ? undefined : `var(--neon-${cardOutcome?.tone ?? "cyan"})`}
        label="Progress"
        className="h-1 flex-1 bg-white/10"
      />
      <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">
        {Math.round(activity.progress * 100)}%
      </span>
    </section>
  ) : null

  const messageSection = message ? <p className="detail-message">{message}</p> : null

  // A question already settled: what became of it, after the work (iOS ResponseControls, settled).
  const answered = interaction && !pendingAnswer ? (
    <section aria-labelledby="answer-heading" className="detail-section">
      <h3 id="answer-heading" className="micro">
        Your answer
      </h3>
      {prompt}
      {interaction.respondedAt || interaction.action ? (
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
  ) : null

  const facts = (
    <section aria-labelledby="details-heading" className="detail-section">
      <h3 id="details-heading" className="micro">Details</h3>
      <dl className="detail-facts">
        {pendingAnswer && interaction?.expiresAt ? (
          <DetailFact label="Respond by" mono>
            <time dateTime={interaction.expiresAt} title={formatDashboardDate(interaction.expiresAt)}>
              {clock(interaction.expiresAt)}
            </time>{" "}
            <span className="text-muted-foreground">({relativeTime(interaction.expiresAt)})</span>
          </DetailFact>
        ) : null}
        {task && task !== title ? <DetailFact label="Task">{task}</DetailFact> : null}
        <DetailFact label="Source">{source}</DetailFact>
        {project ? <DetailFact label="Project">{project.name}</DetailFact> : null}
        {computer ? <DetailFact label="Computer">{computer}</DetailFact> : null}
        <DetailFact label="Started">
          <time dateTime={started ?? undefined}>{formatDashboardDate(started)}</time>
        </DetailFact>
        {took != null ? <DetailFact label="Took" mono>{took < 60 ? "under a minute" : elapsedLabel(took)}</DetailFact> : null}
        {updates != null && updates > 1 ? <DetailFact label="Updates" mono>{updates}</DetailFact> : null}
        {activity ? null : <DetailFact label="Type">{kindLabel}</DetailFact>}
      </dl>
    </section>
  )

  // How it reached the phone, then the technical record: its ID and each device's delivery.
  const technical = (
    <div className="space-y-3">
      <CopyButton value={activity?.id ?? event.id} label="Copy ID" size="sm" className="text-xs" />
      {detail.deliveries.length ? (
        <CardList label="Delivery per device">
          {detail.deliveries.map((delivery) => (
            <CardListItem key={delivery.id}>
              <Card variant="row">
                <CardHit>
                  <div className="card-row-text">
                    <div className="card-row-top">
                      <span className="card-row-title">{delivery.deviceName}</span>
                      <span className="capitalize card-corner">{words(delivery.state)}</span>
                    </div>
                    <CardMeta
                      parts={[
                        `${delivery.attemptCount} attempt${delivery.attemptCount === 1 ? "" : "s"}`,
                        delivery.error ? delivery.error.code : null,
                      ]}
                    />
                    {delivery.reconciliation.required && service.reconcileDelivery ? (
                      <CardActions className="justify-start">
                        {delivery.reconciliation.allowedActions.map((action) => (
                          <Button key={action} size="sm" variant="secondary" disabled={reconciling === delivery.id}
                            onClick={async () => {
                              setReconciling(delivery.id)
                              try { await service.reconcileDelivery!(delivery.id, action) } finally { setReconciling(null) }
                            }}>
                            {action === "mark_accepted" ? "Mark accepted" : action === "retry" ? "Retry" : "Cancel"}
                          </Button>
                        ))}
                      </CardActions>
                    ) : null}
                  </div>
                </CardHit>
              </Card>
            </CardListItem>
          ))}
        </CardList>
      ) : null}
    </div>
  )

  const fold = (summary: string, children: React.ReactNode) => (
    <details className="detail-fold group">
      <summary>
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" />
        {summary}
      </summary>
      <div className="detail-fold-body">{children}</div>
    </details>
  )

  // A message shows how it travelled (iOS); a work card is the work itself, with no delivery record here.
  const delivery = activity ? null : (
    <section aria-labelledby="delivery-heading" className="detail-section">
      <h3 id="delivery-heading" className="micro">Delivery</h3>
      <DeliveryChain stages={deliveryFacts(detail)} orientation="vertical" />
      {fold("Technical details", technical)}
    </section>
  )

  // ANSWER SLOT: the pending question's answer controls (components/molecules/answer-controls.tsx),
  // signed by this browser. Without the question's id, or until it loads, the owner answers on the
  // iPhone and this line says so.
  const onIphone = interaction ? (
    <p className="flex items-start gap-2.5 text-sm text-muted-foreground">
      <Smartphone className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>Answer from the notification on your iPhone.</span>
    </p>
  ) : null
  const answerSlot = pendingAnswer && interaction ? (
    <div className="detail-answer" data-answer-slot>
      {interaction.id ? <BrowserAnswer interactionId={interaction.id} fallback={onIphone} /> : onIphone}
    </div>
  ) : null

  // One row while it fits: the time left and Withdraw leading, the answer and the actions trailing.
  const footer = answerSlot || hasActions ? (
    <footer className="detail-footer">
      <CardFooter
        meta={
          <div className="flex flex-wrap items-center gap-3">
            {pendingAnswer && interaction?.expiresAt ? <Countdown deadline={interaction.expiresAt} /> : null}
            {canWithdraw ? (
              <ConfirmationAction
                label="Withdraw"
                title="Withdraw this notification?"
                description="It’s removed from your iPhone and marked withdrawn here. You can’t undo this."
                pending={withdrawal === "pending"}
                failed={withdrawal === "failed"}
                pendingLabel="Withdrawing…"
                onConfirm={async () => {
                  setWithdrawal("pending")
                  try { await service.withdrawNotification!(event.id); setWithdrawal("done") }
                  catch { setWithdrawal("failed") }
                }}
              />
            ) : null}
          </div>
        }
        actions={
          <>
            {answerSlot}
            {showReactivate ? (
              <ActionButton
                variant="outline"
                phase={phaseOf[reactivation]}
                pendingLabel="Showing on iPhone…"
                successLabel="Shown"
                onClick={async () => {
                  setReactivation("pending")
                  try { await service.reactivateActivity!(activity!.id); setReactivation("done") }
                  catch { setReactivation("failed") }
                }}
              >
                <RotateCcw aria-hidden="true" /> Show on iPhone again
              </ActionButton>
            ) : null}
            {event.destination.state === "safe" ? (
              <Button asChild>
                <a href={event.destination.href} target="_blank" rel="noopener noreferrer">
                  Open link <ArrowUpRight aria-hidden="true" />
                </a>
              </Button>
            ) : null}
          </>
        }
      />
    </footer>
  ) : null

  const operation = (
    <OperationStatus
      error={withdrawal === "failed" || reactivation === "failed" ? "That didn’t go through. Try again." : null}
      success={reactivation === "done" ? "It’s back on your iPhone." : null}
    />
  )

  return (
    <div className="detail" data-variant={variant}>
      {header}
      <div className="detail-columns">
        <div className="detail-main">
          {/* A question leads with the question; the work it belongs to follows (iOS). */}
          {question}
          {plan}
          {messageSection}
          {answered}
          {operation}
          {work ? (
            <div className="detail-end flex flex-wrap items-center gap-2" data-end-work-section>
              <EndWorkButton variant="detail" workId={work.id} goal={work.encrypted ? "this work" : work.goal} end={work.end} />
            </div>
          ) : null}
          {panel ? null : footer}
        </div>
        <aside className="detail-side" aria-label="About">
          {facts}
          {delivery}
        </aside>
      </div>
      {panel ? footer : null}
    </div>
  )
}
