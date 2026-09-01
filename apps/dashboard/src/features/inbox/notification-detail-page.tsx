import { Activity, ArrowLeft, GitBranch, Link2, MessageSquareText, RotateCcw, Smartphone, Trash2 } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DeliveryRow,
  EmptyInbox,
  ExternalLinkIcon,
  InboxPageFrame,
  SemanticCard,
  StateBadge,
  StatusIconTile,
} from "@/features/inbox/components"
import type { NotificationDetail } from "@/features/inbox/types"
import { formatDashboardDate } from "@/features/inbox/utils"
import type { InboxService } from "@/services/inbox-service"

function Detail({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-border/80 bg-background/35 p-3">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="mt-1 text-sm break-words">{children}</dd>
    </div>
  )
}

function words(value: string): string {
  return value.replaceAll("_", " ")
}

export function NotificationDetailPage({
  initial,
  service,
}: {
  initial: NotificationDetail
  service: InboxService
}) {
  const event = initial.notification
  const activity = initial.activity
  const context = activity?.context
  const destinationHostname =
    event.destination.state === "safe"
      ? new URL(event.destination.href).hostname
      : null
  const providerAccepted = initial.deliveries.some(
    (delivery) => delivery.acceptedAt || delivery.state === "accepted"
  )
  const canReactivate = activity?.state === "active" &&
    activity.presentationLeases.some((lease) => lease.state === "not_presented")
  const [reactivation, setReactivation] = useState<
    "idle" | "pending" | "requested" | "failed"
  >("idle")
  const [withdrawal, setWithdrawal] = useState<"idle" | "pending" | "withdrawn" | "failed">(
    event.withdrawnAt ? "withdrawn" : "idle"
  )
  useEffect(() => {
    if (!event.readAt) {
      void service.markNotificationRead?.(event.id).catch(() => undefined)
    }
  }, [event.id, event.readAt, service])
  const reactivate = async () => {
    if (!activity || !service.reactivateActivity) return
    setReactivation("pending")
    try {
      await service.reactivateActivity(activity.id)
      setReactivation("requested")
    } catch {
      setReactivation("failed")
    }
  }
  const withdraw = async () => {
    if (!service.withdrawNotification || withdrawal !== "idle") return
    setWithdrawal("pending")
    try {
      await service.withdrawNotification(event.id)
      setWithdrawal("withdrawn")
    } catch {
      setWithdrawal("failed")
    }
  }
  return (
    <InboxPageFrame
      bootstrap={initial}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" className="min-h-11">
            <a href={initial.route.backHref}>
              <ArrowLeft aria-hidden="true" /> Back to history
            </a>
          </Button>
          {event.destination.state === "safe" ? (
            <Button asChild variant="secondary" className="min-h-11">
              <a
                href={event.destination.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open attached link · {destinationHostname} <ExternalLinkIcon />
              </a>
            </Button>
          ) : null}
          {canReactivate && reactivation !== "requested" ? (
            <Button
              type="button"
              className="min-h-11"
              disabled={reactivation === "pending"}
              onClick={() => void reactivate()}
            >
              <RotateCcw aria-hidden="true" />
              {reactivation === "pending" ? "Showing again…" : "Show Live Activity again"}
            </Button>
          ) : null}
          {!activity && withdrawal !== "withdrawn" ? (
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={withdrawal === "pending"}
              onClick={() => void withdraw()}
            >
              <Trash2 aria-hidden="true" />
              {withdrawal === "pending" ? "Withdrawing…" : "Withdraw notification"}
            </Button>
          ) : null}
        </div>
      }
    >
      <SemanticCard state={event.state} className="mt-6">
        <CardHeader className="p-4 pb-0 sm:p-5 sm:pb-0">
          <div className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-3">
            <StatusIconTile value={event.state || event.kind} />
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <CardTitle className="min-w-0 text-lg leading-6 [overflow-wrap:anywhere]">
                  <span className="text-muted-foreground">{event.source}</span>
                  <span
                    className="px-2 text-muted-foreground/60"
                    aria-hidden="true"
                  >
                    /
                  </span>
                  {context?.taskTitle ?? event.title}
                </CardTitle>
                <StateBadge value={withdrawal === "withdrawn" ? "withdrawn" : event.state} />
              </div>
              <CardDescription className="mt-1">
                {activity
                  ? [context?.project, context?.threadName]
                      .filter(Boolean)
                      .join(" · ") || "Origin context unavailable"
                  : `${event.kind.replaceAll("_", " ")}${
                      event.serviceTitle ? ` · ${event.serviceTitle}` : ""
                    }`}
              </CardDescription>
              {event.destination.state === "safe" ? (
                <div
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-foreground/80"
                  aria-label="Link attached"
                >
                  <Link2 className="size-3.5" aria-hidden="true" />
                  Link attached · {destinationHostname}
                </div>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-4 sm:p-5 sm:pt-4">
          <p className="max-w-4xl text-sm leading-6 break-words whitespace-pre-wrap text-foreground/90">
            {activity?.detail || event.body || activity?.status || "No message body."}
          </p>
          {!activity ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {event.bodyFormat === "markdown" ? "Markdown source · safe inert rendering" : "Plain text"}
              {withdrawal === "failed" ? " · Withdrawal failed; nothing was assumed" : ""}
            </p>
          ) : null}
          {activity ? (
            <>
              <h3 className="mt-6 text-sm font-semibold">Activity context</h3>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Detail term="Activity ID">
                  <code className="font-mono text-xs break-all" title={activity.id}>
                    {activity.id}
                  </code>
                </Detail>
                <Detail term="Codex task ID">
                  {context?.providerThreadId ? (
                    <code className="font-mono text-xs break-all" title={context.providerThreadId}>
                      {context.providerThreadId}
                    </code>
                  ) : (
                    "Unavailable"
                  )}
                </Detail>
                <Detail term="Relo correlation ID">
                  {activity.originThreadId ? (
                    <code
                      className="font-mono text-xs break-all"
                      title={activity.originThreadId}
                    >
                      {activity.originThreadId}
                    </code>
                  ) : (
                    "Unavailable"
                  )}
                </Detail>
                <Detail term="Thread name">
                  {context?.threadName ?? "Unnamed thread"}
                </Detail>
                <Detail term="Project">{context?.project ?? "Unavailable"}</Detail>
                <Detail term="Work item">
                  {context?.taskTitle ?? "Work description not provided"}
                </Detail>
                <Detail term="Instruction ID">
                  {context?.providerWorkItemId ? (
                    <code className="font-mono text-xs break-all">
                      {context.providerWorkItemId}
                    </code>
                  ) : (
                    "Unavailable"
                  )}
                </Detail>
                <Detail term="Lifecycle provider">
                  {activity.lifecycle?.provider ?? context?.providerName ?? "Unavailable"}
                </Detail>
                <Detail term="Lifecycle run">
                  {activity.lifecycle?.runId ? (
                    <code className="font-mono text-xs break-all">
                      {activity.lifecycle.runId}
                    </code>
                  ) : (
                    "Unavailable"
                  )}
                </Detail>
                <Detail term="Computer">{context?.computer ?? "Unavailable"}</Detail>
                <Detail term="Generation">{activity.generation}</Detail>
                <Detail term="Current sequence">{activity.sequence}</Detail>
                <Detail term="Lifecycle state">
                  <span className="capitalize">{activity.state.replaceAll("_", " ")}</span>
                </Detail>
                <Detail term="Terminal reason">
                  {activity.terminalReason
                    ? activity.terminalReason.replaceAll("_", " ")
                    : "Not terminal"}
                </Detail>
                <Detail term="Terminal actor">
                  {activity.terminalActor?.replaceAll("_", " ") ?? "Not terminal"}
                </Detail>
                <Detail term="Terminal policy">
                  {activity.terminalPolicy?.replaceAll("_", " ") ?? "Not terminal"}
                </Detail>
                <Detail term="Status">{activity.status}</Detail>
                <Detail term="Presentation preset">
                  {activity.presentationPresetId ? (
                    <span>
                      {activity.presentationPresetId}
                      {activity.presentationPresetRevision
                        ? ` · revision ${activity.presentationPresetRevision}`
                        : ""}
                    </span>
                  ) : (
                    "Legacy or unresolved"
                  )}
                </Detail>
                <Detail term="Policy source">
                  {activity.presentationPolicySource ?? "Unavailable"}
                </Detail>
                <Detail term="Started">
                  <time dateTime={activity.createdAt ?? undefined}>
                    {formatDashboardDate(activity.createdAt)}
                  </time>
                </Detail>
                <Detail term="Last updated">
                  <time dateTime={activity.updatedAt ?? undefined}>
                    {formatDashboardDate(activity.updatedAt)}
                  </time>
                </Detail>
                <Detail term="Stale after">
                  <time dateTime={activity.staleAt ?? undefined}>
                    {formatDashboardDate(activity.staleAt)}
                  </time>
                </Detail>
                <Detail term="Ended">
                  {activity.endedAt ? (
                    <time dateTime={activity.endedAt}>
                      {formatDashboardDate(activity.endedAt)}
                    </time>
                  ) : (
                    "Still active"
                  )}
                </Detail>
              </dl>

              <h3 className="mt-6 text-sm font-semibold">Event diagnostics</h3>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Detail term="Notification event ID">
                  <code className="font-mono text-xs break-all" title={event.id}>
                    {event.id}
                  </code>
                </Detail>
                <Detail term="Event operation">
                  <span className="capitalize">
                    {activity.operation.replaceAll("_", " ")}
                  </span>
                </Detail>
                <Detail term="Event sequence">{activity.eventSequence}</Detail>
                <Detail term="Targeting">{event.targetMode}</Detail>
                <Detail term="Destination">
                  {event.destination.state === "safe"
                    ? `Validated HTTPS · ${destinationHostname}`
                    : event.destination.state === "unsafe"
                      ? "Unavailable: unsafe URL"
                      : "Not set"}
                </Detail>
              </dl>
            </>
          ) : (
            <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Detail term="Event ID">
                <code className="font-mono text-xs break-all" title={event.id}>
                  {event.id}
                </code>
              </Detail>
              <Detail term="Targeting">{event.targetMode}</Detail>
              <Detail term="Destination">
                {event.destination.state === "safe"
                  ? `Validated HTTPS · ${destinationHostname}`
                  : event.destination.state === "unsafe"
                    ? "Unavailable: unsafe URL"
                    : "Not set"}
              </Detail>
              <Detail term="Created">
                <time dateTime={event.createdAt ?? undefined}>
                  {formatDashboardDate(event.createdAt)}
                </time>
              </Detail>
              <Detail term="Updated">
                <time dateTime={event.updatedAt ?? undefined}>
                  {formatDashboardDate(event.updatedAt)}
                </time>
              </Detail>
              <Detail term="Expires">
                <time dateTime={event.expiresAt ?? undefined}>
                  {formatDashboardDate(event.expiresAt)}
                </time>
              </Detail>
            </dl>
          )}
        </CardContent>
      </SemanticCard>

      {activity ? (
        <section className="mt-6" aria-labelledby="thread-history-heading">
          <div className="flex items-center gap-2">
            <Activity className="size-5 text-muted-foreground" aria-hidden="true" />
            <h2 id="thread-history-heading" className="text-lg font-medium">
              Task instructions and activity generations
            </h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Each instruction is retained under the same provider task with its own lifecycle evidence.
          </p>
          <ol className="mt-4 space-y-2.5">
            {activity.threadHistory.map((related) => (
              <li key={related.id}>
                <SemanticCard state={related.state} live={false}>
                  <CardContent className="flex min-w-0 items-center gap-3 p-3.5 sm:p-4">
                    <StatusIconTile value={related.state} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">
                          {related.taskTitle ?? related.title}
                        </span>
                        <StateBadge value={related.state} />
                        {related.current ? (
                          <span className="text-xs font-medium text-foreground">
                            Selected
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          Generation {related.generation} · {related.status}
                          {related.terminalReason
                            ? ` · ${related.terminalReason.replaceAll("_", " ")}`
                            : ""}
                        </span>
                        <time dateTime={related.updatedAt ?? undefined}>
                          {formatDashboardDate(related.updatedAt)}
                        </time>
                      </div>
                    </div>
                  </CardContent>
                </SemanticCard>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {activity ? (
        <section className="mt-6" aria-labelledby="lifecycle-heading">
          <div className="flex items-center gap-2">
            <Activity className="size-5 text-muted-foreground" aria-hidden="true" />
            <h2 id="lifecycle-heading" className="text-lg font-medium">
              Lifecycle timeline
            </h2>
          </div>
          <ol className="mt-4 space-y-2.5">
            {activity.timeline.map((transition) => (
              <li key={`${transition.sequence}-${transition.operation}`}>
                <SemanticCard state={transition.state ?? transition.operation} live={false}>
                  <CardContent className="flex min-w-0 items-center gap-3 p-3.5 sm:p-4">
                    <StatusIconTile value={transition.state ?? transition.operation} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold capitalize">
                          {transition.operation.replaceAll("_", " ")}
                        </span>
                        {transition.state ? <StateBadge value={transition.state} /> : null}
                        <span className="text-xs text-muted-foreground">
                          Sequence {transition.sequence}
                        </span>
                      </div>
                      <div className="mt-1 flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>{transition.status ?? "No semantic status recorded"}</span>
                        <time dateTime={transition.createdAt ?? undefined}>
                          {formatDashboardDate(transition.createdAt)}
                        </time>
                      </div>
                    </div>
                  </CardContent>
                </SemanticCard>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {activity ? (
        <section className="mt-6" aria-labelledby="relationship-evidence-heading">
          <div className="flex items-center gap-2">
            <GitBranch className="size-5 text-muted-foreground" aria-hidden="true" />
            <h2 id="relationship-evidence-heading" className="text-lg font-medium">
              Relationship and correlation evidence
            </h2>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Exact lifecycle facts only. Similar labels or content are never treated as proof of a relationship.
          </p>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="space-y-2.5">
              <h3 className="text-sm font-semibold">Linked activities</h3>
              {activity.relationships.length ? (
                activity.relationships.map((relationship) => (
                  <a
                    key={relationship.id}
                    href={`/dashboard/testing/runs/${encodeURIComponent(relationship.relatedActivity.id)}/history`}
                    className="block no-underline"
                  >
                    <SemanticCard state={relationship.relatedActivity.state} live={false}>
                      <CardContent className="p-3.5 sm:p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold capitalize">
                            {words(relationship.kind)} {relationship.direction}
                          </span>
                          <StateBadge value={relationship.relatedActivity.state} />
                          <span className="text-xs text-muted-foreground">
                            Generation {relationship.relatedActivity.generation}
                          </span>
                        </div>
                        <p className="mt-1 truncate text-sm text-muted-foreground">
                          {relationship.relatedActivity.title}
                        </p>
                        <p className="mt-2 text-xs capitalize text-muted-foreground">
                          {words(relationship.reason)} · {relationship.actor} · {words(relationship.provenance)}
                        </p>
                      </CardContent>
                    </SemanticCard>
                  </a>
                ))
              ) : (
                <EmptyInbox
                  title="No exact relationship"
                  description="No predecessor, successor, supersession, or companion edge is recorded."
                />
              )}
            </div>
            <div className="space-y-2.5">
              <h3 className="text-sm font-semibold">Selection decisions</h3>
              {activity.correlationDecisions.length ? (
                activity.correlationDecisions.map((decision) => (
                  <SemanticCard key={decision.id} state={decision.outcome} live={false}>
                    <CardContent className="p-3.5 sm:p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold capitalize">
                          {words(decision.outcome)}
                        </span>
                        <StateBadge value={decision.matchedBy} />
                      </div>
                      <p className="mt-2 text-xs capitalize text-muted-foreground">
                        {words(decision.reason)} · {decision.actor} · {words(decision.provenance)}
                      </p>
                      <time className="mt-2 block text-xs text-muted-foreground" dateTime={decision.createdAt ?? undefined}>
                        {formatDashboardDate(decision.createdAt)}
                      </time>
                    </CardContent>
                  </SemanticCard>
                ))
              ) : (
                <EmptyInbox
                  title="No exact decision"
                  description="No categorical selection decision is retained for this activity."
                />
              )}
            </div>
          </div>
        </section>
      ) : null}

      {activity ? (
        <section className="mt-6" aria-labelledby="presentation-heading">
          <div className="flex items-center gap-2">
            <Smartphone className="size-5 text-muted-foreground" aria-hidden="true" />
            <h2 id="presentation-heading" className="text-lg font-medium">
              Phone presentation
            </h2>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            The server selects a foreground candidate per phone. iOS retains final control
            over what is visible in the Dynamic Island and Lock Screen. Provider acceptance
            and app confirmation are separate evidence.
          </p>
          {providerAccepted ? (
            <p className="mt-2 text-sm text-foreground/85">
              APNs accepted for at least one target · iOS display unconfirmed
            </p>
          ) : null}
          {reactivation === "requested" ? (
            <p role="status" className="mt-2 text-sm text-foreground/85">
              A fresh Live Activity presentation was queued for the dismissed phone.
            </p>
          ) : reactivation === "failed" ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              Relo could not show this activity again. Refresh the evidence and retry.
            </p>
          ) : null}
          <div className="mt-4 space-y-2.5">
            {activity.presentationLeases.length ? (
              activity.presentationLeases.map((lease) => (
                <SemanticCard key={lease.deviceId} state={lease.state} live={false}>
                  <CardContent className="grid min-w-0 gap-3 p-3.5 sm:grid-cols-[44px_minmax(0,1fr)_auto] sm:items-center sm:p-4">
                    <StatusIconTile value={lease.state} />
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold">{lease.deviceName}</span>
                        <StateBadge value={lease.state} />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {lease.reason.replaceAll("_", " ")} · relevance {Math.round(lease.relevanceScore * 100)}
                        {lease.lastCommandSequence == null
                          ? ""
                          : ` · command sequence ${lease.lastCommandSequence}`}
                      </p>
                    </div>
                    <div className="text-xs text-muted-foreground sm:text-end">
                      {lease.lastAppliedAt
                        ? `Applied ${formatDashboardDate(lease.lastAppliedAt)}`
                        : "No app confirmation yet"}
                    </div>
                  </CardContent>
                </SemanticCard>
              ))
            ) : (
              <EmptyInbox
                title="No presentation lease"
                description="No phone presentation decision was retained for this activity."
              />
            )}
          </div>
        </section>
      ) : null}

      <section className="mt-6" aria-labelledby="interaction-heading">
        <div className="flex items-center gap-2">
          <MessageSquareText
            className="size-5 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 id="interaction-heading" className="text-lg font-medium">
            Interaction
          </h2>
        </div>
        <div className="mt-4">
          {initial.interaction ? (
            <SemanticCard state={initial.interaction.state} live={false}>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>{initial.interaction.prompt}</CardTitle>
                  <StateBadge value={initial.interaction.state} />
                </div>
                <CardDescription>{initial.interaction.kind}</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Detail term="Action">
                    {initial.interaction.action ?? "No response"}
                  </Detail>
                  <Detail term="Response">
                    {initial.interaction.responseText ?? "No response text"}
                  </Detail>
                  <Detail term="Responding device">
                    {initial.interaction.respondingDevice ? (
                      <span title={initial.interaction.respondingDevice.id}>
                        {initial.interaction.respondingDevice.name}
                      </span>
                    ) : (
                      "Not recorded"
                    )}
                  </Detail>
                  <Detail term="Responded">
                    {formatDashboardDate(initial.interaction.respondedAt)}
                  </Detail>
                </dl>
              </CardContent>
            </SemanticCard>
          ) : (
            <EmptyInbox
              title="No interaction requested"
              description="This notification did not ask the phone for a response."
            />
          )}
        </div>
      </section>

      <section className="mt-6" aria-labelledby="delivery-evidence-heading">
        <div className="flex items-center gap-2">
          <Activity className="size-5 text-muted-foreground" aria-hidden="true" />
          <h2 id="delivery-evidence-heading" className="text-lg font-medium">
            Delivery evidence
          </h2>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          One ordered vocabulary from server acceptance through provider, device,
          interaction, withdrawal, and reconciliation evidence.
        </p>
        <ol className="mt-4 space-y-2.5">
          {initial.evidenceTimeline.length ? (
            initial.evidenceTimeline.map((evidence) => (
              <li key={evidence.id}>
                <SemanticCard state={evidence.state} live={false}>
                  <CardContent className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-3 p-3.5 sm:grid-cols-[44px_minmax(0,1fr)_auto] sm:items-center sm:p-4">
                    <StatusIconTile value={evidence.state} />
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold capitalize">
                          {words(evidence.stage)}
                        </span>
                        <StateBadge value={evidence.state} />
                        <span className="text-xs text-muted-foreground">
                          Stage {evidence.stageOrder}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {[
                          evidence.detailCode ? words(evidence.detailCode) : null,
                          evidence.deviceId,
                          evidence.deliveryId,
                          evidence.serialization ? "serialization pinned" : null,
                        ].filter(Boolean).join(" · ") || "Canonical event evidence"}
                      </p>
                    </div>
                    <time
                      className="col-start-2 text-xs whitespace-nowrap text-muted-foreground sm:col-start-3 sm:text-end"
                      dateTime={evidence.occurredAt}
                    >
                      {formatDashboardDate(evidence.occurredAt)}
                    </time>
                  </CardContent>
                </SemanticCard>
              </li>
            ))
          ) : (
            <EmptyInbox
              title="No evidence recorded"
              description="The account has no canonical delivery stages for this event."
            />
          )}
        </ol>
      </section>

      <section className="mt-6" aria-labelledby="attempts-heading">
        <h2 id="attempts-heading" className="text-lg font-medium">
          Delivery attempts
        </h2>
        <div className="mt-4 space-y-2.5">
          {initial.deliveries.length ? (
            initial.deliveries.map((delivery, index) => (
              <DeliveryRow
                key={`${delivery.deviceName}-${index}`}
                delivery={delivery}
                variant="detail"
              />
            ))
          ) : (
            <EmptyInbox
              title="No delivery attempts"
              description="This event has no target-level provider attempts."
            />
          )}
        </div>
      </section>

      <section className="mt-6" aria-labelledby="receipts-heading">
        <div className="flex items-center gap-2">
          <Smartphone
            className="size-5 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 id="receipts-heading" className="text-lg font-medium">
            Device receipts and responses
          </h2>
        </div>
        <div className="mt-4 space-y-2">
          {initial.receipts.length ? (
            initial.receipts.map((receipt, index) => (
              <SemanticCard
                key={`${receipt.kind}-${receipt.deviceName}-${index}`}
                state={receipt.kind}
                live={false}
              >
                <CardContent className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-3 p-3.5 sm:p-4">
                  <StatusIconTile value={receipt.kind} />
                  <div className="flex min-w-0 flex-col justify-center gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {receipt.deviceName}
                      </span>
                      <StateBadge value={receipt.kind} />
                    </div>
                    <time
                      className="text-xs whitespace-nowrap text-muted-foreground"
                      dateTime={receipt.createdAt ?? undefined}
                    >
                      {formatDashboardDate(receipt.createdAt)}
                    </time>
                  </div>
                </CardContent>
              </SemanticCard>
            ))
          ) : (
            <EmptyInbox
              title="No device receipts"
              description="The server has no app-reported confirmation for this event. APNs acceptance only confirms that Apple accepted the push; iOS may update ActivityKit without launching Relo."
            />
          )}
        </div>
      </section>
    </InboxPageFrame>
  )
}
