import { Page } from "@/components/page"
import { DeliveryHistoryPage } from "@/features/inbox/delivery-history-page"
import { InboxView } from "@/features/inbox/inbox-view"
import { NotificationDetailBody } from "@/features/inbox/notification-detail"
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
      return <InboxView overview={bootstrap} service={service} onApprovalSuccess={onApprovalSuccess} />
    case "notification-history":
      return <InboxView history={bootstrap} service={service} />
    case "delivery-history":
      return <DeliveryHistoryPage initial={bootstrap} service={service} />
    case "notification-detail":
      return (
        <Page title="Notification" actions={<a href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">Back to Inbox</a>}>
          <div className="max-w-2xl">
            <NotificationDetailBody detail={bootstrap} service={service} />
          </div>
        </Page>
      )
  }
}
