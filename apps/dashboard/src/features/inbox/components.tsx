import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Minus,
  Send,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react"

import { EncryptedText } from "@/components/atoms/encrypted-text"
import { SignalGlyph } from "@/components/atoms/signal-glyph"
import { useState } from "react"

import { Badge } from "@/components/card"
import { Row } from "@/components/list"
import { ActionButton } from "@/components/molecules/action-button"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import type { DeliverySummary, InboxPagination } from "@/features/inbox/types"
import { formatDashboardDate } from "@/features/inbox/utils"
import { semanticStatusTone } from "@/lib/status-tone"

type DeliveryTone = "mint" | "cyan" | "orange" | "yellow" | "red" | "violet" | "neutral"

/** A delivery state in the meaning palette: done mint, running cyan, attention yellow, failed red. */
function deliveryTone(state: string, reconcile = false): DeliveryTone {
  if (reconcile) return "orange"
  switch (semanticStatusTone(state)) {
    case "success":
      return "mint"
    case "active":
      return "cyan"
    case "warning":
      return "yellow"
    case "danger":
      return "red"
    case "info":
      return "violet"
    default:
      return "neutral"
  }
}

const DELIVERY_ICON: Record<DeliveryTone, LucideIcon> = {
  mint: Check,
  cyan: Send,
  orange: TriangleAlert,
  yellow: Clock3,
  red: X,
  violet: Send,
  neutral: Minus,
}

const TONE_CSS: Record<DeliveryTone, string> = {
  mint: "var(--neon-mint)",
  cyan: "var(--neon-cyan)",
  orange: "var(--neon-orange)",
  yellow: "var(--neon-yellow)",
  red: "var(--neon-red)",
  violet: "var(--neon-violet)",
  neutral: "#8d93a8",
}

/** A state as a tone chip with its word; the accessible name says it is the status. A new state crossfades. */
export function StateBadge({ value, reconcile = false }: { value: string; reconcile?: boolean }) {
  const label = value.replaceAll("_", " ")
  return (
    <Badge tone={deliveryTone(value, reconcile)} icon={null} label={`Status: ${label}`} className="capitalize">
      {label}
    </Badge>
  )
}

/**
 * One delivery job as a log row: the glyph and chip in the state's meaning colour, the item, the
 * phone, attempts and transport, then the provider's evidence. A job that needs reconciliation is
 * not a link: its evidence and the allowed actions sit under the row.
 */
export function DeliveryRow({
  delivery,
  onReconcile,
  reconciling = false,
  failed = false,
}: {
  delivery: DeliverySummary
  onReconcile?: (action: "mark_accepted" | "retry" | "cancel") => void
  reconciling?: boolean
  /** Set as `reconciling` falls when the action did not go through. */
  failed?: boolean
}) {
  const [chosen, setChosen] = useState<"mark_accepted" | "retry" | "cancel" | null>(null)
  const reconcile = delivery.reconciliation.required
  const tone = deliveryTone(delivery.state, reconcile)
  const evidence = delivery.error
    ? `${delivery.error.code}${delivery.error.message ? `: ${delivery.error.message}` : ""}`
    : delivery.providerMessageId
      ? `Provider ID ${delivery.providerMessageId}`
      : "No provider identifier"
  const at = delivery.acceptedAt ?? delivery.updatedAt
  const meta = [
    delivery.deviceName,
    `${delivery.attemptCount} attempt${delivery.attemptCount === 1 ? "" : "s"}`,
    delivery.transport.replaceAll("_", " "),
    reconcile ? null : evidence,
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <Row
      href={reconcile ? undefined : `/dashboard/inbox/notifications/${encodeURIComponent(delivery.notificationId)}`}
      label={`Open delivery for ${delivery.encrypted ? "encrypted item" : delivery.title}, ${delivery.state}`}
      leading={<SignalGlyph icon={DELIVERY_ICON[tone]} color={TONE_CSS[tone]} />}
      title={
        <>
          <span className="text-muted-foreground">{delivery.source}</span>
          <span className="px-1.5 text-muted-foreground/60" aria-hidden="true">/</span>
          {delivery.encrypted ? <EncryptedText className="align-middle font-normal" /> : delivery.title}
        </>
      }
      meta={<span title={evidence}>{meta}</span>}
      trailing={
        <>
          <StateBadge value={delivery.state} reconcile={reconcile} />
          <time
            className="hidden tabular-nums sm:inline"
            title={formatDashboardDate(at)}
            dateTime={at ?? undefined}
          >
            {formatDashboardDate(at)}
          </time>
        </>
      }
    >
      {reconcile ? (
        <>
          <p className="delivery-evidence">{evidence}</p>
          {onReconcile ? (
            <div className="delivery-actions" role="group" aria-label="Delivery reconciliation actions">
              {delivery.reconciliation.allowedActions.map((action) => (
                <ActionButton
                  key={action}
                  type="button"
                  size="sm"
                  variant={action === "cancel" ? "destructive" : "outline"}
                  disabled={reconciling}
                  pending={reconciling && chosen === action}
                  failed={failed}
                  pendingLabel="Working…"
                  successLabel={null}
                  onClick={() => {
                    setChosen(action)
                    onReconcile(action)
                  }}
                >
                  {action === "mark_accepted"
                    ? "Mark accepted"
                    : action === "retry"
                      ? "Retry safe update"
                      : "Cancel delivery"}
                </ActionButton>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </Row>
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
