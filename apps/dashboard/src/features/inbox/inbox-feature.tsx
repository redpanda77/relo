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
        <Page title="Notification" eyebrow="Activity detail" actions={<a href={bootstrap.route.backHref} className="micro inline-flex min-h-11 items-center hover:text-foreground">← Back to History</a>}>
          <div className="max-w-2xl">
            <NotificationDetailBody detail={bootstrap} service={service} />
          </div>
        </Page>
      )
  }
}
