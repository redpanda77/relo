import { useState } from "react"

import {
  DeliveryRow,
  EmptyInbox,
  InboxPageFrame,
  InboxPager,
} from "@/features/inbox/components"
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

  return (
    <InboxPageFrame bootstrap={initial}>
      <section className="mt-6" aria-labelledby="delivery-heading">
        <h2 id="delivery-heading" className="text-lg font-medium">
          Delivery attempts
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {initial.pagination.total} durable target jobs with provider
          acceptance, retry, and terminal failure evidence.
        </p>
        {error ? <p className="mt-3 text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="mt-4 space-y-2.5">
          {deliveries.length ? (
            deliveries.map((delivery, index) => (
              <DeliveryRow
                key={`${delivery.id}-${index}`}
                delivery={delivery}
                reconciling={reconciling === delivery.id}
                onReconcile={(action) => void reconcile(delivery.id, action)}
              />
            ))
          ) : (
            <EmptyInbox
              title="No delivery attempts yet"
              description="Target-level transport evidence will appear after a notification is sent."
            />
          )}
        </div>
        <InboxPager value={initial.pagination} />
      </section>
    </InboxPageFrame>
  )
}
