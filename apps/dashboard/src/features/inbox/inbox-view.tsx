import { Check, X } from "lucide-react"
import { useState } from "react"

import { fetchDashboardRoute } from "@/app/dashboard-route-loader"
import {
  Empty,
  List,
  Page,
  Row,
  Section,
  Status,
} from "@/components/page"
import { relativeTime } from "@/lib/format"
import { navigateDashboard } from "@/state/use-dashboard-route"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet"
import { InboxPager } from "@/features/inbox/components"
import { NotificationDetailBody } from "@/features/inbox/notification-detail"
import {
  notificationContext,
  notificationProject,
  notificationProjectOptions,
} from "@/features/inbox/notification-project"
import type {
  InboxOverview,
  NotificationDetail,
  NotificationHistory,
} from "@/features/inbox/types"
import { formatDashboardDate } from "@/features/inbox/utils"
import type { InboxService } from "@/services/inbox-service"
import { useInboxAction } from "@/state/use-inbox-action"

type Panel =
  | { state: "closed" }
  | { state: "loading"; context: string }
  | { state: "ready"; context: string; detail: NotificationDetail }
  | { state: "failed"; context: string; href: string }

function detailHref(id: string) {
  return `/dashboard/inbox/notifications/${encodeURIComponent(id)}`
}

export function InboxView({
  overview,
  history,
  service,
  onApprovalSuccess,
}: {
  overview?: InboxOverview
  history?: NotificationHistory
  service: InboxService
  onApprovalSuccess?: () => void
}) {
  const actions = useInboxAction(service, onApprovalSuccess)
  const [project, setProject] = useState("")
  const [panel, setPanel] = useState<Panel>({ state: "closed" })
  const notifications = history?.notifications ?? overview?.recentNotifications ?? []
  // History filters on the server across every page; the recent list filters what it shows.
  const shown = history || !project
    ? notifications
    : notifications.filter((item) => notificationProject(item).key === project)
  const projectOptions = history
    ? history.filterOptions.projects.map((name) => ({ key: name, name }))
    : notificationProjectOptions(notifications)
  const selectedProject = history ? (history.route.filters.project ?? "") : project
  const chooseProject = (value: string) => {
    if (!history) return setProject(value)
    const query = new URLSearchParams()
    if (value) query.set("project", value)
    if (history.route.filters.kind) query.set("kind", history.route.filters.kind)
    if (history.route.filters.state) query.set("state", history.route.filters.state)
    const search = query.toString()
    navigateDashboard(`/dashboard/inbox/notifications${search ? `?${search}` : ""}`)
  }

  const open = async (id: string, context: string) => {
    setPanel({ state: "loading", context })
    try {
      const route = await fetchDashboardRoute(detailHref(id))
      if (route.kind === "dashboard" && route.bootstrap.kind === "notification-detail") {
        setPanel({ state: "ready", context, detail: route.bootstrap })
      } else {
        setPanel({ state: "failed", context, href: detailHref(id) })
      }
    } catch {
      setPanel({ state: "failed", context, href: detailHref(id) })
    }
  }

  const needsYou =
    (overview?.pendingResponses.length ?? 0) + (overview?.approvalRequests.length ?? 0)

  return (
    <Page title="Inbox">
      {overview && needsYou > 0 ? (
        <Section title="Needs you">
          <List label="Needs you">
            {overview.pendingResponses.map((response) => (
              <Row
                key={response.notificationId}
                onClick={() => void open(response.notificationId, response.source)}
                label={`Open ${response.title}`}
                leading={<span className="brand-gradient block size-2 rounded-full" aria-hidden="true" />}
                title={response.title}
                meta={`${response.source} · ${response.prompt}`}
                trailing={response.expiresAt ? (
                  <time className="hidden sm:inline" dateTime={response.expiresAt} title={formatDashboardDate(response.expiresAt)}>
                    Respond {relativeTime(response.expiresAt)}
                  </time>
                ) : null}
              />
            ))}
            {overview.approvalRequests.map((request) => {
              const pending = actions.pendingCodes.has(request.userCode)
              const error = actions.errorFor(request.userCode)
              return (
                <Row
                  key={request.userCode}
                  leading={<span className="brand-gradient block size-2 rounded-full" aria-hidden="true" />}
                  title={`Connect ${request.clientName}`}
                  meta={`Code ${request.userCode} · ${request.requestedScopes.join(", ") || "no permissions"} · access until ${formatDashboardDate(request.credentialExpiresAt)}`}
                  trailing={
                    <>
                      <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" data-action="deny-approval" data-code={request.userCode}
                        disabled={pending} onClick={() => void actions.decide(request.userCode, "deny")}>
                        <X aria-hidden="true" /> Deny
                      </Button>
                      <Button size="sm" className="min-h-11 sm:min-h-8" data-action="approve-approval" data-code={request.userCode}
                        disabled={pending} onClick={() => void actions.decide(request.userCode, "approve")}>
                        <Check aria-hidden="true" /> Approve
                      </Button>
                    </>
                  }
                >
                  {error ? <p role="alert" className="px-4 pb-3 text-xs text-destructive">{error}</p> : null}
                </Row>
              )
            })}
          </List>
        </Section>
      ) : null}

      <Section
        title="Activity"
        action={
          projectOptions.length > 1 ? (
            <select
              aria-label="Project"
              value={selectedProject}
              onChange={(event) => chooseProject(event.target.value)}
              className="glass h-9 rounded-xl px-3 text-sm text-foreground outline-none"
            >
              <option value="">All projects</option>
              {projectOptions.map((option) => (
                <option key={option.key} value={option.key}>{option.name}</option>
              ))}
            </select>
          ) : null
        }
      >
        {shown.length ? (
          <List label="Activity">
            {shown.map((notification) => {
              const context = notificationContext(notification)
              const title =
                (notification.activity?.context ?? notification.context).taskTitle ?? notification.title
              return (
                <Row
                  key={notification.id}
                  onClick={() => void open(notification.id, context)}
                  label={`Open ${title}`}
                  title={title}
                  meta={context}
                  trailing={
                    <>
                      <span className="hidden sm:inline"><Status value={notification.state} /></span>
                      <time dateTime={notification.createdAt ?? undefined} title={formatDashboardDate(notification.createdAt)}>
                        {relativeTime(notification.createdAt)}
                      </time>
                    </>
                  }
                />
              )
            })}
          </List>
        ) : (
          <Empty title="Nothing yet" description="Notifications from your CLI, agents, and webhooks appear here." />
        )}
        {history ? (
          <InboxPager value={history.pagination} />
        ) : overview && overview.summary.notifications > notifications.length ? (
          <div className="mt-4 text-center">
            <Button asChild variant="ghost" size="sm">
              <a href="/dashboard/inbox/notifications?page=2">Show older</a>
            </Button>
          </div>
        ) : null}
      </Section>

      <Sheet open={panel.state !== "closed"} onOpenChange={(value) => { if (!value) setPanel({ state: "closed" }) }}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto border-l p-0 outline-none sm:max-w-lg">
          {panel.state === "ready" ? (
            <NotificationDetailBody
              variant="panel"
              detail={panel.detail}
              context={panel.context}
              service={service}
              heading={(title) => <SheetTitle className="pr-8 text-xl font-semibold tracking-tight">{title}</SheetTitle>}
            />
          ) : (
            <>
              <SheetTitle className="sr-only">Notification</SheetTitle>
              <SheetDescription className="px-6 pt-16 text-center">
                {panel.state === "failed" ? (
                  <>Couldn't load this notification. <a className="underline" href={panel.href}>Open it in full</a>.</>
                ) : "Loading…"}
              </SheetDescription>
            </>
          )}
        </SheetContent>
      </Sheet>
    </Page>
  )
}
