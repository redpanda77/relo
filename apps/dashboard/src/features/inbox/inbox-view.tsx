import { ArrowRight, Check, X } from "lucide-react"
import { useEffect, useState } from "react"

import { fetchDashboardRoute } from "@/app/dashboard-route-loader"
import { NowHud } from "@/components/organisms/now-hud"
import { Empty, Page, Section } from "@/components/page"
import { EncryptedText } from "@/components/atoms/encrypted-text"
import { displayName } from "@/lib/encrypted"
import { SIGNAL_CSS } from "@/lib/signal"
import { LiveNowList, NowAllClear, NowSection } from "@/features/inbox/now-all-clear"
import { AgentsSection } from "@/features/inbox/agents-section"
import { quietSessionsByCard } from "@/features/inbox/sessions-model"
import { ActivityCardRow } from "@/features/inbox/activity-card"
import { LinkBrowserBanner } from "@/features/linked-browser/link-browser-card"
import {
  agentSecondsToday,
  agentTimeLabel,
  cardFor,
  daySummary,
  groupByDay,
  nowMetrics,
  nowMix,
  nowSentence,
  todayActivity,
} from "@/features/inbox/activity-model"
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
    ? history.filterOptions.projects.map((name) => ({ key: name, name: displayName(name) }))
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

  const [now] = useState(() => Date.now())
  const [syncedAt] = useState(() => Date.now())
  const [clockNow, setClockNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const allCards = shown.map((notification) => ({ notification, card: cardFor(notification, now) }))
  const runningCards = (overview?.runningActivities ?? notifications)
    .map((notification) => ({ notification, card: cardFor(notification, now) }))
    .filter(({ card }) => card.outcome.kind === "running")
  // On Now, running tasks already have their own section above.
  const runningIds = new Set(overview ? runningCards.map(({ card }) => card.id) : [])
  const cards = allCards.filter(({ card }) => !runningIds.has(card.id))
  const needsList = overview ? overview.pendingResponses.length + overview.approvalRequests.length : 0
  const needsYou = overview
    ? Math.max(
        overview.pendingResponses.length + overview.approvalRequests.length,
        overview.summary.pendingResponses + overview.summary.pendingApprovals
      )
    : 0
  const metrics = nowMetrics({
    cards: [...new Map([...allCards, ...runningCards].map(({ card }) => [card.id, card])).values()],
    running: runningCards.length,
    needsYou,
  })

  const mix = nowMix({
    cards: [...new Map([...allCards, ...runningCards].map(({ card }) => [card.id, card])).values()],
    running: runningCards.length,
    needsYou,
    now: new Date(clockNow),
  })

  const agentSeconds = agentSecondsToday(
    [...new Map([...allCards, ...runningCards].map(({ card }) => [card.id, card])).values()],
    new Date(clockNow)
  )
  const agentTime = agentSeconds > 0 ? agentTimeLabel(agentSeconds) : null

  const filters = history?.route.filters
  const chooseFilter = (name: "kind" | "state", value: string) => {
    if (!history || !filters) return
    const query = new URLSearchParams()
    if (filters.project) query.set("project", filters.project)
    const next = { kind: filters.kind, state: filters.state, [name]: value || null }
    if (next.kind) query.set("kind", next.kind)
    if (next.state) query.set("state", next.state)
    const search = query.toString()
    navigateDashboard(`/dashboard/inbox/notifications${search ? `?${search}` : ""}`)
  }

  const activityList = cards.length ? (
    <ul aria-label="Activity" className="space-y-2.5">
      {groupByDay(cards.map(({ card }) => card)).flatMap((group) => {
        const byId = new Map(cards.map(({ notification, card }) => [card.id, notification]))
        return [
          <li key={`day-${group.key}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pt-4 first:pt-0">
            <h3 className="text-sm font-medium text-foreground">{group.label}</h3>
            <span className="micro">{daySummary(group.cards)}</span>
          </li>,
          ...group.cards.map((card) => {
            const notification = byId.get(card.id)!
            return (
              <ActivityCardRow
                key={card.id}
                card={card}
                now={now}
                onOpen={() => void open(card.id, notificationContext(notification))}
              />
            )
          }),
        ]
      })}
    </ul>
  ) : (
    <Empty title="Nothing yet" description="Notifications from your CLI, agents, and webhooks appear here." />
  )

  const projectSelect =
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

  const historyFilters = history ? (
    <div className="flex flex-wrap items-center gap-2">
      {projectSelect}
      <select
        aria-label="Kind"
        value={filters?.kind ?? ""}
        onChange={(event) => chooseFilter("kind", event.target.value)}
        className="glass h-9 rounded-xl px-3 text-sm text-foreground outline-none"
      >
        <option value="">All kinds</option>
        <option value="live_activity">Live Activities</option>
        <option value="approval">Approvals</option>
        <option value="question">Questions</option>
        <option value="notification">Messages</option>
      </select>
      <select
        aria-label="State"
        value={filters?.state ?? ""}
        onChange={(event) => chooseFilter("state", event.target.value)}
        className="glass h-9 rounded-xl px-3 text-sm text-foreground outline-none"
      >
        <option value="">Any state</option>
        <option value="active">Running</option>
        <option value="ended">Ended</option>
        <option value="responded">Answered</option>
        <option value="expired">Expired</option>
        <option value="recorded">Recorded</option>
        <option value="canceled">Canceled</option>
        <option value="replaced">Replaced</option>
      </select>
    </div>
  ) : (
    projectSelect
  )

  return (
    <Page title={history ? "History" : "Now"} eyebrow={history ? "Every card, newest first" : "Live"}>
      {overview ? (
        <NowHud
          today={metrics.today}
          done={metrics.done}
          running={metrics.running}
          needsYou={metrics.needsYou}
          arcs={runningCards.map(({ card }) => ({
            progress: card.steps ? card.steps.done / card.steps.total : card.progress,
          }))}
          sentence={nowSentence(metrics)}
          mix={mix}
          agentTime={agentTime}
          syncedAt={syncedAt}
          now={clockNow}
        />
      ) : null}

      {overview ? <LinkBrowserBanner accountId={overview.shell.account.id} /> : null}

      {overview && needsList > 0 ? (
        <NowSection title="Needs you" count={needsYou} color={SIGNAL_CSS.needsYou}>
          <ul aria-label="Needs you" className="space-y-2.5">
            {overview.pendingResponses.map((response) => (
              <li key={response.notificationId}>
                <div className="holo-card tone-orange p-4" data-live="true">
                  <div className="flex items-center justify-between gap-3">
                    <span className="micro tone-orange truncate" style={{ color: SIGNAL_CSS.needsYou }}>{response.source}</span>
                    {response.expiresAt ? (
                      <time className="micro shrink-0" dateTime={response.expiresAt} title={formatDashboardDate(response.expiresAt)}>
                        Respond {relativeTime(response.expiresAt)}
                      </time>
                    ) : null}
                  </div>
                  {response.encrypted ? (
                    <h3 className="mt-2 text-[15px] font-medium text-muted-foreground">
                      <EncryptedText />
                    </h3>
                  ) : (
                    <>
                      <h3 className="mt-2 text-[15px] font-medium text-foreground">{response.title}</h3>
                      <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{response.prompt}</p>
                    </>
                  )}
                  <div className="mt-3 flex justify-end">
                    <Button
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      aria-label={response.encrypted ? "Open encrypted item" : `Open ${response.title}`}
                      onClick={() => void open(response.notificationId, response.source)}
                    >
                      Open <ArrowRight aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
            {overview.approvalRequests.map((request) => {
              const pending = actions.pendingCodes.has(request.userCode)
              const error = actions.errorFor(request.userCode)
              return (
                <li key={request.userCode}>
                  <div className="holo-card tone-orange p-4" data-live="true">
                    <span className="micro" style={{ color: SIGNAL_CSS.needsYou }}>Connection request</span>
                    <h3 className="mt-2 text-[15px] font-medium text-foreground">{`Connect ${request.clientName}`}</h3>
                    <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
                      {`Code ${request.userCode} · ${request.requestedScopes.join(", ") || "no permissions"} · access until ${formatDashboardDate(request.credentialExpiresAt)}`}
                    </p>
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                      <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" data-action="deny-approval" data-code={request.userCode}
                        disabled={pending} onClick={() => void actions.decide(request.userCode, "deny")}>
                        <X aria-hidden="true" /> Deny
                      </Button>
                      <Button size="sm" className="min-h-11 sm:min-h-8" data-action="approve-approval" data-code={request.userCode}
                        disabled={pending} onClick={() => void actions.decide(request.userCode, "approve")}>
                        <Check aria-hidden="true" /> Approve
                      </Button>
                    </div>
                    {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </NowSection>
      ) : null}

      {overview ? (
        <AgentsSection
          sessions={overview.sessions}
          syncedAt={syncedAt}
          cards={
            new Map(
              [...allCards, ...runningCards].map(({ notification, card }) => [
                card.id,
                { title: card.title, encrypted: card.encrypted, open: () => void open(card.id, notificationContext(notification)) },
              ])
            )
          }
        />
      ) : null}

      {overview && runningCards.length > 0 ? (
        <NowSection title="Live now" count={runningCards.length} color={SIGNAL_CSS.running}>
          <LiveNowList
            now={clockNow}
            syncedAt={syncedAt}
            quietSessions={quietSessionsByCard(overview.sessions)}
            items={runningCards.map(({ notification, card }) => ({
              card,
              open: () => void open(card.id, notificationContext(notification)),
            }))}
          />
        </NowSection>
      ) : null}

      {overview ? (
        <NowAllClear
          allClear={needsYou === 0 && runningCards.length === 0}
          activity={todayActivity(
            [...new Map([...allCards, ...runningCards].map(({ card }) => [card.id, card])).values()],
            new Date(clockNow)
          )}
          onOpen={(id) => {
            const found = notifications.find((item) => item.id === id)
            void open(id, found ? notificationContext(found) : "")
          }}
        />
      ) : null}

      <Section title="Activity" action={historyFilters}>
        {activityList}
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
