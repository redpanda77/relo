import { useState } from "react"

import { Empty, List } from "@/components/list"
import { OperationStatus } from "@/components/molecules/operation-status"
import { Page } from "@/components/page"
import { DeliveryRow, InboxPager } from "@/features/inbox/components"
import type { DeliveryHistory } from "@/features/inbox/types"
import { createHttpInboxService, type InboxService } from "@/services/inbox-service"

export function DeliveryHistoryPage({
  initial,
  service = createHttpInboxService(),
}: {
  initial: DeliveryHistory
  service?: InboxService
}) {
  const [deliveries, setDeliveries] = useState(initial.deliveries)
  const [reconciling, setReconciling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reconcile(
    deliveryId: string,
    action: "mark_accepted" | "retry" | "cancel"
  ) {
    if (!service.reconcileDelivery) {
      setError("Delivery reconciliation is unavailable in this dashboard build.")
      return
    }
    const label = action === "mark_accepted" ? "record known APNs acceptance"
      : action === "retry" ? "retry this sequence-safe Live Activity command"
        : "cancel this ambiguous delivery"
    if (!window.confirm(`Confirm: ${label}?`)) return
    setReconciling(deliveryId)
    setError(null)
    try {
      const result = await service.reconcileDelivery(deliveryId, action)
      setDeliveries((current) => current.map((delivery) => delivery.id === deliveryId
        ? { ...delivery,state: result.state,reconciliation: {
          ...delivery.reconciliation,required: false,resolvedAction: action,allowedActions: [],
        } }
        : delivery))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reconciliation failed.")
    } finally {
      setReconciling(null)
    }
  }

  const total = initial.pagination.total
  return (
    <Page
      title={initial.shell.title}
      eyebrow={`${total} job${total === 1 ? "" : "s"} · what Apple accepted, retried or refused.`}
      back={{ href: "/dashboard/inbox/notifications", label: "History" }}
    >
      <section aria-label="Delivery attempts">
        <OperationStatus error={error} className="mb-3" />
        <List
          label="Delivery attempts"
          items={deliveries.map((delivery, index) => ({ delivery, key: `${delivery.id}-${index}` }))}
          getKey={(item) => item.key}
          empty={
            <Empty
              title="No delivery attempts yet"
              description="Each phone a notification goes to gets a delivery job here, with Apple's answer."
            />
          }
        >
          {({ delivery }) => (
            <DeliveryRow
              delivery={delivery}
              reconciling={reconciling === delivery.id}
              failed={Boolean(error)}
              onReconcile={(action) => void reconcile(delivery.id, action)}
            />
          )}
        </List>
        <InboxPager value={initial.pagination} />
      </section>
    </Page>
  )
}
