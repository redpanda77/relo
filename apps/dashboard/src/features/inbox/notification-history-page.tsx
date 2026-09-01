import { Activity, CheckCheck, FolderKanban, Layers3, X } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  EmptyInbox,
  InboxPageFrame,
  InboxPager,
} from "@/features/inbox/components"
import { FilterChip } from "@/features/inbox/filter-chip"
import { NotificationHierarchy } from "@/features/inbox/notification-hierarchy"
import type { NotificationHistory } from "@/features/inbox/types"
import type { InboxService } from "@/services/inbox-service"

const kinds = ["notification", "approval", "question", "live_activity"] as const
const states = [
  "active",
  "recorded",
  "ended",
  "responded",
  "expired",
  "replaced",
  "canceled",
] as const

const kindLabels = {
  notification: "Notifications",
  approval: "Approvals",
  question: "Questions",
  live_activity: "Live Activities",
} as const

const stateLabels = {
  active: "Running",
  recorded: "Recorded",
  ended: "Ended",
  responded: "Responded",
  expired: "Expired",
  replaced: "Replaced",
  canceled: "Canceled",
} as const

export function NotificationHistoryPage({
  initial,
  service,
}: {
  initial: NotificationHistory
  service: InboxService
}) {
  const [unread, setUnread] = useState(
    initial.unread ?? { total: 0, byProject: [] }
  )
  const [readState, setReadState] = useState<"idle" | "pending" | "failed">("idle")
  const markAllRead = async () => {
    if (!service.markAllNotificationsRead || readState === "pending") return
    setReadState("pending")
    try {
      await service.markAllNotificationsRead()
      setUnread({ total: 0, byProject: [] })
      setReadState("idle")
    } catch {
      setReadState("failed")
    }
  }
  return (
    <InboxPageFrame bootstrap={initial}>
      <section className="mt-6" aria-labelledby="history-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 id="history-heading" className="text-lg font-medium">
              Notification history
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {initial.pagination.total} persistent records · {unread.total} unread. Live Activity rows
              use the activity's current canonical state; the originating event
              remains available for delivery diagnostics.
            </p>
            {unread.byProject.length ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {unread.byProject.map(({ project, count }) => `${project} ${count}`).join(" · ")}
              </p>
            ) : null}
          </div>
          {unread.total ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 self-start"
              disabled={readState === "pending"}
              onClick={() => void markAllRead()}
            >
              <CheckCheck aria-hidden="true" />
              {readState === "pending" ? "Marking read…" : "Mark all read"}
            </Button>
          ) : null}
        </div>
        {readState === "failed" ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            Read state was not changed. Try again.
          </p>
        ) : null}
        <form
          method="get"
          action="/dashboard/inbox/notifications"
          aria-label="Filter notification history"
          className="mt-4 flex min-w-0 flex-wrap items-center gap-2"
        >
          <FilterChip
            label="Project"
            name="project"
            value={initial.route.filters.project ?? ""}
            icon={FolderKanban}
            className="w-full sm:w-auto sm:max-w-[22rem]"
          >
            <option value="">All projects</option>
            {initial.filterOptions.projects.map((project) => (
              <option key={project} value={project}>
                {project}
              </option>
            ))}
          </FilterChip>
          <FilterChip
            label="Kind"
            name="kind"
            value={initial.route.filters.kind ?? ""}
            icon={Layers3}
          >
            <option value="">All kinds</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabels[kind]}
              </option>
            ))}
          </FilterChip>
          <FilterChip
            label="State"
            name="state"
            value={initial.route.filters.state ?? ""}
            icon={Activity}
          >
            <option value="">All states</option>
            {states.map((state) => (
              <option key={state} value={state}>
                {stateLabels[state]}
              </option>
            ))}
          </FilterChip>
          <button type="submit" className="sr-only">
            Apply filters
          </button>
          {initial.route.filters.kind ||
          initial.route.filters.state ||
          initial.route.filters.project ? (
            <Button
              asChild
              variant="ghost"
              className="min-h-11 rounded-full px-3"
            >
              <a href="/dashboard/inbox/notifications">
                <X aria-hidden="true" />
                Clear
              </a>
            </Button>
          ) : null}
        </form>
        <div className="mt-4 space-y-5">
          {initial.notifications.length ? (
            <NotificationHierarchy notifications={initial.notifications} />
          ) : (
            <EmptyInbox
              title="No matching notifications"
              description="Clear or change the filters to review other events."
            />
          )}
        </div>
        <InboxPager value={initial.pagination} />
      </section>
    </InboxPageFrame>
  )
}
