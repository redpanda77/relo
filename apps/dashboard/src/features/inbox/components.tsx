import {
  Activity,
  ArrowUpRight,
  BellRing,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleSlash2,
  CircleX,
  Clock3,
  HelpCircle,
  Inbox,
  Link2,
  MessageCircle,
  Send,
  Smartphone,
  X,
} from "lucide-react"
import type * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import type {
  DeliverySummary,
  InboxDashboardBootstrap,
  InboxOverview,
  InboxPagination,
  NotificationSummary,
} from "@/features/inbox/types"
import { Page } from "@/components/page"
import { formatDashboardDate } from "@/features/inbox/utils"
import { semanticStatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

function StatusGlyph({ value }: { value: string }) {
  const iconProps = { className: "size-5", strokeWidth: 1.8 }
  const tone = semanticStatusTone(value)
  if (tone === "success") return <CheckCircle2 {...iconProps} />
  if (tone === "active") return <Activity {...iconProps} />
  if (tone === "warning") return <Clock3 {...iconProps} />
  if (tone === "danger")
    return ["canceled", "cancelled", "expired"].includes(
      value.toLowerCase()
    ) ? (
      <CircleSlash2 {...iconProps} />
    ) : (
      <CircleX {...iconProps} />
    )
  if (["approval", "question"].includes(value.toLowerCase()))
    return <HelpCircle {...iconProps} />
  if (["answer", "reply", "responded"].includes(value.toLowerCase()))
    return <MessageCircle {...iconProps} />
  return <BellRing {...iconProps} />
}

function stateVariant(
  state: string
): "default" | "secondary" | "destructive" | "outline" {
  const tone = semanticStatusTone(state)
  if (tone === "active" || tone === "success") return "default"
  if (tone === "danger") return "destructive"
  if (tone === "warning") return "secondary"
  return "outline"
}

export function StateBadge({ value }: { value: string }) {
  const label = value.replaceAll("_", " ")
  return (
    <Badge
      variant={stateVariant(value)}
      className="status-chip max-w-full capitalize"
      data-tone={semanticStatusTone(value)}
      aria-label={`Status: ${label}`}
    >
      {label}
    </Badge>
  )
}

export function SemanticCard({
  state,
  live = state.toLowerCase() === "active",
  className,
  ...props
}: React.ComponentProps<typeof Card> & { state: string; live?: boolean }) {
  return (
    <Card
      className={cn(
        "status-card gap-0 rounded-2xl border py-0 ring-0",
        className
      )}
      data-tone={semanticStatusTone(state)}
      data-live={live ? "true" : undefined}
      {...props}
    />
  )
}

export function StatusIconTile({ value }: { value: string }) {
  return (
    <span
      className="status-icon-tile grid size-11 shrink-0 place-items-center rounded-xl"
      aria-hidden="true"
    >
      <StatusGlyph value={value} />
    </span>
  )
}

export function InboxPageFrame({
  bootstrap,
  actions,
  children,
}: {
  bootstrap: InboxDashboardBootstrap
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Page title={bootstrap.shell.title} actions={actions}>
      {children}
    </Page>
  )
}

export function NotificationRow({
  notification,
}: {
  notification: NotificationSummary
}) {
  const activity = notification.activity
  const context = activity?.context ?? notification.context
  const title = context.taskTitle ?? notification.title
  const hasAttachedLink = notification.destination.state === "safe"
  return (
    <a
      href={`/dashboard/inbox/notifications/${encodeURIComponent(notification.id)}`}
      className="group block min-w-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Open ${title}, ${notification.state}${hasAttachedLink ? ", link attached" : ""}`}
      data-slot="notification-card-link"
    >
      <SemanticCard state={notification.state} data-slot="notification-card">
        <CardContent className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-3 p-3.5 sm:p-4">
          <StatusIconTile value={notification.state || notification.kind} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <p className="min-w-0 text-sm leading-5 font-semibold break-words text-foreground sm:text-[15px]">
                <span>{title}</span>
              </p>
              <StateBadge value={notification.state} />
            </div>

            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Smartphone className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {notification.targetDeviceNames.join(", ") ||
                    "No active device"}
                </span>
              </span>
              <span className="capitalize">
                {notification.kind.replaceAll("_", " ")}
              </span>
              {activity ? (
                <span className="whitespace-nowrap">
                  Generation {activity.generation}
                </span>
              ) : null}
              {notification.response ? (
                <span className="inline-flex items-center gap-1.5 capitalize">
                  <MessageCircle className="size-3.5" aria-hidden="true" />
                  {notification.response.action}
                </span>
              ) : null}
              {hasAttachedLink ? (
                <span
                  className="inline-flex items-center gap-1.5 text-foreground/85"
                  aria-label="Link attached"
                >
                  <Link2 className="size-3.5" aria-hidden="true" />
                  Link attached
                </span>
              ) : null}
            </div>

            <div className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-xs">
              <time
                className="block max-w-32 truncate whitespace-nowrap text-muted-foreground sm:max-w-none"
                title={formatDashboardDate(notification.createdAt)}
                dateTime={notification.createdAt ?? undefined}
              >
                {formatDashboardDate(notification.createdAt)}
              </time>
              <p className="min-w-0 truncate text-foreground/85">
                {activity ? (
                  <>
                    <span>{activity.status}</span>
                    <span className="text-muted-foreground">
                      {" "}· {activity.operation.replaceAll("_", " ")} event ·
                      sequence {activity.eventSequence} of {activity.sequence}
                    </span>
                  </>
                ) : (
                  notification.body || "No message body."
                )}
              </p>
              <ChevronRight
                className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </div>
          </div>
        </CardContent>
      </SemanticCard>
    </a>
  )
}

export function PendingResponseRow({
  response,
}: {
  response: InboxOverview["pendingResponses"][number]
}) {
  return (
    <a
      href={`/dashboard/inbox/notifications/${encodeURIComponent(response.notificationId)}`}
      className="group block min-w-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Open pending response for ${response.title}`}
      data-slot="pending-response-link"
    >
      <SemanticCard state={response.state} live={false}>
        <CardContent className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-3 p-3.5 sm:p-4">
          <StatusIconTile value={response.kind} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <h3 className="min-w-0 text-sm leading-5 font-semibold break-words sm:text-[15px]">
                <span className="text-muted-foreground">{response.source}</span>
                <span
                  className="px-1.5 text-muted-foreground/60"
                  aria-hidden="true"
                >
                  /
                </span>
                {response.title}
              </h3>
              <StateBadge value={response.state} />
            </div>
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Smartphone className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {response.targetDeviceNames.join(", ") || "No active device"}
                </span>
              </span>
              <span className="capitalize">
                {response.kind.replaceAll("_", " ")}
              </span>
            </div>
            <div className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-xs">
              <time
                className="block max-w-32 truncate whitespace-nowrap text-muted-foreground sm:max-w-none"
                title={`Expires ${formatDashboardDate(response.expiresAt)}`}
                dateTime={response.expiresAt ?? undefined}
              >
                Expires {formatDashboardDate(response.expiresAt)}
              </time>
              <p className="truncate text-foreground/85">{response.prompt}</p>
              <ChevronRight
                className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </div>
          </div>
        </CardContent>
      </SemanticCard>
    </a>
  )
}

export function DeliveryRow({
  delivery,
  variant = "history",
  onReconcile,
  reconciling = false,
}: {
  delivery: DeliverySummary
  variant?: "history" | "detail"
  onReconcile?: (action: "mark_accepted" | "retry" | "cancel") => void
  reconciling?: boolean
}) {
  const evidence = delivery.error
    ? `${delivery.error.code}${delivery.error.message ? `: ${delivery.error.message}` : ""}`
    : delivery.providerMessageId
      ? `Provider ID ${delivery.providerMessageId}`
      : "No provider identifier"
  const content = (
    <SemanticCard
      state={delivery.reconciliation.required ? "waiting" : delivery.state}
      live={false}
      data-slot="delivery-card"
    >
      <CardContent className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-3 p-3.5 sm:p-4">
        <StatusIconTile value={delivery.state} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <h3 className="min-w-0 text-sm leading-5 font-semibold break-words sm:text-[15px]">
              <span className="text-muted-foreground">{delivery.source}</span>
              <span
                className="px-1.5 text-muted-foreground/60"
                aria-hidden="true"
              >
                /
              </span>
              {delivery.title}
            </h3>
            <StateBadge value={delivery.state} />
          </div>

          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Smartphone className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{delivery.deviceName}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Send className="size-3.5" aria-hidden="true" />
              {delivery.attemptCount} attempt
              {delivery.attemptCount === 1 ? "" : "s"}
            </span>
            <span className="uppercase">{delivery.transport}</span>
          </div>

          <div className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-xs">
            <time
              className="block max-w-32 truncate whitespace-nowrap text-muted-foreground sm:max-w-none"
              title={formatDashboardDate(
                delivery.acceptedAt ?? delivery.updatedAt
              )}
              dateTime={delivery.acceptedAt ?? delivery.updatedAt ?? undefined}
            >
              {formatDashboardDate(delivery.acceptedAt ?? delivery.updatedAt)}
            </time>
            <p className="truncate font-mono text-[11px] text-foreground/80">
              {evidence}
            </p>
            {variant === "history" ? (
              <ChevronRight
                className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            ) : null}
          </div>
          {variant === "detail" && delivery.serialization ? (
            <p className="mt-2 break-words font-mono text-[10px] leading-4 text-muted-foreground">
              {delivery.serialization.canonicalIntent ? `Intent ${delivery.serialization.canonicalIntent}` : "Serialization pinned"}
              {delivery.serialization.deviceProjection ? ` · projection ${delivery.serialization.deviceProjection}` : ""}
              {delivery.serialization.providerBytes ? ` · bytes ${delivery.serialization.providerBytes}` : ""}
            </p>
          ) : null}
          {delivery.reconciliation.required && onReconcile ? (
            <div className="mt-3 flex flex-wrap gap-2" aria-label="Delivery reconciliation actions">
              {delivery.reconciliation.allowedActions.map((action) => (
                <Button
                  key={action}
                  type="button"
                  size="sm"
                  variant={action === "cancel" ? "destructive" : "outline"}
                  disabled={reconciling}
                  onClick={() => onReconcile(action)}
                >
                  {action === "mark_accepted"
                    ? "Mark accepted"
                    : action === "retry"
                      ? "Retry safe update"
                      : "Cancel delivery"}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </CardContent>
    </SemanticCard>
  )
  if (variant === "detail" || delivery.reconciliation.required)
    return <div data-slot="delivery-detail-row">{content}</div>
  return (
    <a
      href={`/dashboard/inbox/notifications/${encodeURIComponent(delivery.notificationId)}`}
      className="group block min-w-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Open delivery for ${delivery.title}, ${delivery.state}`}
    >
      {content}
    </a>
  )
}

export function EmptyInbox({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <Card className="rounded-2xl border-dashed bg-card/70">
      <CardContent className="flex min-h-40 flex-col items-center justify-center px-6 text-center">
        <Inbox className="size-5 text-muted-foreground" aria-hidden="true" />
        <h3 className="mt-3 font-medium">{title}</h3>
        <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </CardContent>
    </Card>
  )
}

export function InboxPager({ value }: { value: InboxPagination }) {
  if (value.pageCount <= 1) return null
  return (
    <Pagination
      className="mt-5 justify-between"
      aria-label={`Page ${value.page} of ${value.pageCount}`}
    >
      <PaginationContent className="w-full justify-between">
        <PaginationItem>
          {value.previousHref ? (
            <PaginationPrevious
              href={value.previousHref}
              className="min-h-11 min-w-11"
            />
          ) : (
            <span className="inline-flex min-h-11 items-center gap-1.5 px-2.5 text-sm text-muted-foreground">
              <ChevronLeft className="size-4" /> Previous
            </span>
          )}
        </PaginationItem>
        <li className="text-xs text-muted-foreground">
          Page {value.page} of {value.pageCount}
        </li>
        <PaginationItem>
          {value.nextHref ? (
            <PaginationNext
              href={value.nextHref}
              className="min-h-11 min-w-11"
            />
          ) : (
            <span className="inline-flex min-h-11 items-center gap-1.5 px-2.5 text-sm text-muted-foreground">
              Next <ChevronRight className="size-4" />
            </span>
          )}
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  )
}

export function ApprovalIcon({ decision }: { decision: "approve" | "deny" }) {
  return decision === "approve" ? (
    <Check aria-hidden="true" />
  ) : (
    <X aria-hidden="true" />
  )
}

export function ExternalLinkIcon() {
  return <ArrowUpRight aria-hidden="true" />
}
