import { Page } from "@/components/page"
import { DeliveryHistoryPage } from "@/features/inbox/delivery-history-page"
import { HistoryView } from "@/features/inbox/history-view"
import { InboxView } from "@/features/inbox/inbox-view"
import { detailTitle } from "@/features/inbox/activity-model"
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
      return <HistoryView history={bootstrap} service={service} />
    case "delivery-history":
      return <DeliveryHistoryPage initial={bootstrap} service={service} />
    case "notification-detail":
      return (
        // One title, the work's own; the trail names the kind of page ("History › Activity").
        <Page
          title={detailTitle(bootstrap)}
          back={{ href: bootstrap.route.backHref, label: "History" }}
          trail={bootstrap.activity ? "Activity" : "Message"}
        >
          <NotificationDetailBody detail={bootstrap} service={service} />
        </Page>
      )
  }
}
