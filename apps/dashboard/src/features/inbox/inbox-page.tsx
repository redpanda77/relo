import { AlertCircle, FolderKanban, KeyRound } from "lucide-react"
import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  ApprovalIcon,
  EmptyInbox,
  InboxPageFrame,
  InboxPager,
  PendingResponseRow,
  SemanticCard,
  StateBadge,
  StatusIconTile,
} from "@/features/inbox/components"
import { FilterChip } from "@/features/inbox/filter-chip"
import { NotificationHierarchy } from "@/features/inbox/notification-hierarchy"
import {
  notificationProject,
  notificationProjectOptions,
} from "@/features/inbox/notification-project"
import type { InboxOverview } from "@/features/inbox/types"
import { formatDashboardDate } from "@/features/inbox/utils"
import type { InboxService } from "@/services/inbox-service"
import { useDashboardSnapshot } from "@/state/use-dashboard-snapshot"
import { useInboxAction } from "@/state/use-inbox-action"

export function InboxPage({
  initial,
  service,
  onApprovalSuccess,
}: {
  initial: InboxOverview
  service: InboxService
  onApprovalSuccess?: () => void
}) {
  const [projectFilter, setProjectFilter] = useState("")
  const actions = useInboxAction(service, onApprovalSuccess)
  const live = useDashboardSnapshot(service)
  const projectOptions = notificationProjectOptions(initial.recentNotifications)
  const recentNotifications = projectFilter
    ? initial.recentNotifications.filter(
        (notification) =>
          notificationProject(notification).key === projectFilter
      )
    : initial.recentNotifications
  const metrics = [
    ["Phone responses", initial.summary.pendingResponses],
    ["CLI approvals", initial.summary.pendingApprovals],
    [
      "Notifications",
      live.snapshot?.counts.notifications ?? initial.summary.notifications,
    ],
    [
      "Deliveries",
      live.snapshot?.counts.deliveries ?? initial.summary.deliveries,
    ],
  ] as const

  return (
    <InboxPageFrame bootstrap={initial}>
      {live.error ? (
        <p
          className="mt-4 flex items-start gap-2 text-xs text-muted-foreground"
          role="status"
        >
          <AlertCircle
            className="mt-0.5 size-3.5 shrink-0"
            aria-hidden="true"
          />
          {live.snapshot
            ? "Live totals paused. Showing the last-known refreshed totals."
            : "Live totals paused. Showing the initial server-rendered totals."}
        </p>
      ) : null}
      <section className="mt-6" aria-label="Inbox summary">
        <Card className="gap-0 rounded-2xl py-0">
          <CardContent className="p-0">
            <dl className="grid grid-cols-2 lg:grid-cols-4">
              {metrics.map(([label, value], index) => (
                <div
                  key={label}
                  className={`min-w-0 px-4 py-3.5 ${
                    index % 2 ? "border-l border-border" : ""
                  } ${index >= 2 ? "border-t border-border lg:border-t-0" : ""} ${
                    index > 0 ? "lg:border-l lg:border-border" : ""
                  }`}
                >
                  <dt className="truncate text-xs text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="mt-1 text-xl font-semibold tabular-nums">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </section>

      <section className="mt-6" aria-labelledby="pending-heading">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="pending-heading" className="text-lg font-medium">
              Pending decisions
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Phone interactions and CLI clients waiting for the owner.
            </p>
          </div>
          <Badge variant="secondary" className="self-start sm:self-auto">
            {initial.shell.counts.pending} pending
          </Badge>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <div className="min-w-0 space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground">
              Phone responses
            </h3>
            {initial.pendingResponses.length ? (
              initial.pendingResponses.map((response) => (
                <PendingResponseRow
                  key={response.notificationId}
                  response={response}
                />
              ))
            ) : (
              <EmptyInbox
                title="No phone responses pending"
                description="New approval, yes/no, and reply prompts will appear here."
              />
            )}
          </div>

          <div className="min-w-0 space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground">
              CLI connection requests
            </h3>
            {initial.approvalRequests.length ? (
              initial.approvalRequests.map((request) => {
                const pending = actions.pendingCodes.has(request.userCode)
                const error = actions.errorFor(request.userCode)
                return (
                  <SemanticCard
                    key={request.userCode}
                    state="pending"
                    live={false}
                    aria-busy={pending}
                  >
                    <CardContent className="p-3.5 sm:p-4">
                      <div className="grid min-w-0 grid-cols-[44px_minmax(0,1fr)] gap-3">
                        <StatusIconTile value="pending" />
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-start justify-between gap-2">
                            <div className="min-w-0">
                              <h4 className="truncate text-sm font-semibold sm:text-[15px]">
                                {request.clientName}
                              </h4>
                              <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                                {request.userCode}
                              </code>
                            </div>
                            <StateBadge value="pending" />
                          </div>
                          <p className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <KeyRound
                              className="size-3.5 shrink-0"
                              aria-hidden="true"
                            />
                            <span className="truncate">
                              {request.requestedScopes.join(", ") ||
                                "No scopes requested"}
                            </span>
                          </p>
                        </div>
                      </div>
                      <dl className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                        <div className="rounded-xl bg-background/35 px-3 py-2.5">
                          <dt>Approval expires</dt>
                          <dd className="mt-0.5 text-foreground">
                            {formatDashboardDate(request.approvalExpiresAt)}
                          </dd>
                        </div>
                        <div className="rounded-xl bg-background/35 px-3 py-2.5">
                          <dt>Credential expires</dt>
                          <dd className="mt-0.5 text-foreground">
                            {formatDashboardDate(request.credentialExpiresAt)}
                          </dd>
                        </div>
                      </dl>
                      {error ? (
                        <p
                          role="alert"
                          className="mt-3 flex items-start gap-2 text-sm text-destructive"
                        >
                          <AlertCircle
                            className="mt-0.5 size-4 shrink-0"
                            aria-hidden="true"
                          />
                          <span>{error}</span>
                        </p>
                      ) : null}
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          data-action="deny-approval"
                          data-code={request.userCode}
                          disabled={pending}
                          onClick={() =>
                            void actions.decide(request.userCode, "deny")
                          }
                        >
                          <ApprovalIcon decision="deny" /> Deny
                        </Button>
                        <Button
                          type="button"
                          className="min-h-11"
                          data-action="approve-approval"
                          data-code={request.userCode}
                          disabled={pending}
                          onClick={() =>
                            void actions.decide(request.userCode, "approve")
                          }
                        >
                          <ApprovalIcon decision="approve" /> Authorize
                        </Button>
                      </div>
                    </CardContent>
                  </SemanticCard>
                )
              })
            ) : (
              <EmptyInbox
                title="No clients waiting"
                description="A CLI connection request will remain here until it is approved, denied, or expires."
              />
            )}
            <InboxPager value={initial.approvalPagination} />
          </div>
        </div>
      </section>

      <section className="mt-8" aria-labelledby="recent-heading">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="recent-heading" className="text-lg font-medium">
              Recent notifications
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Newest durable events and canonical outcomes.
            </p>
          </div>
          <Button asChild variant="outline" className="min-h-11">
            <a href="/dashboard/inbox/notifications">View all</a>
          </Button>
        </div>
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          <FilterChip
            label="Project"
            name="recent-project"
            value={projectFilter}
            icon={FolderKanban}
            className="w-full sm:w-auto sm:max-w-[22rem]"
            onValueChange={setProjectFilter}
          >
            <option value="">All projects</option>
            {projectOptions.map((project) => (
              <option key={project.key} value={project.key}>
                {project.name}
              </option>
            ))}
          </FilterChip>
        </div>
        <div className="mt-4 space-y-2.5">
          {recentNotifications.length ? (
            <NotificationHierarchy notifications={recentNotifications} />
          ) : (
            <EmptyInbox
              title="No notifications yet"
              description="Durable notification events will appear after the first send."
            />
          )}
        </div>
      </section>
    </InboxPageFrame>
  )
}
