import { DeliveryHistoryPage } from "@/features/inbox/delivery-history-page"
import { InboxPage } from "@/features/inbox/inbox-page"
import { NotificationDetailPage } from "@/features/inbox/notification-detail-page"
import { NotificationHistoryPage } from "@/features/inbox/notification-history-page"
import type { InboxDashboardBootstrap } from "@/features/inbox/types"
import {
  createHttpInboxService,
  type InboxService,
} from "@/services/inbox-service"

const defaultInboxService = createHttpInboxService()

export function InboxFeature({
  bootstrap,
  service = defaultInboxService,
  onApprovalSuccess,
}: {
  bootstrap: InboxDashboardBootstrap
  service?: InboxService
  onApprovalSuccess?: () => void
}) {
  switch (bootstrap.kind) {
    case "inbox-overview":
      return (
        <InboxPage
          initial={bootstrap}
          service={service}
          onApprovalSuccess={onApprovalSuccess}
        />
      )
    case "notification-history":
      return <NotificationHistoryPage initial={bootstrap} service={service} />
    case "delivery-history":
      return <DeliveryHistoryPage initial={bootstrap} service={service} />
    case "notification-detail":
      return <NotificationDetailPage initial={bootstrap} service={service} />
  }
}
