import { Check, Send, X } from "lucide-react"
import { useMemo, useState } from "react"

import { fetchDashboardRoute } from "@/app/dashboard-route-loader"
import { NowHud } from "@/components/organisms/now-hud"
import { Empty, Page, Section } from "@/components/page"
import { displayName } from "@/lib/encrypted"
import { SIGNAL_CSS } from "@/lib/signal"
import { NowAllClear, NowItemList, NowSection } from "@/features/inbox/now-all-clear"
import { SessionsSection, type SessionWorkLink } from "@/features/inbox/sessions-section"
import { FOLD_LABEL, nowBlocks, nowCounts, overviewNow, type NowItem } from "@/features/inbox/now-model"
import { useNowRefresh } from "@/features/inbox/use-now-refresh"
import { ActivityCardRow } from "@/features/inbox/activity-card"
import { LinkBrowserBanner } from "@/features/linked-browser/link-browser-card"
import { PendingDevicesNotice } from "@/features/pending-devices/pending-devices"
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

  // History display only (Today strip, Activity list): the page-load instant formats dates.
  const [now] = useState(() => Date.now())
  const allCards = shown.map((notification) => ({ notification, card: cardFor(notification, now) }))
  // Now is the server's: sections, folds and counts come from its summary, refetched every 60 s.
  const initialNow = useMemo(() => overviewNow(overview), [overview])
  const { summary, offline } = useNowRefresh(overview?.shell.account.id, initialNow)
  const blocks = summary ? nowBlocks(summary, { offline }) : []
  const openItem = (item: NowItem) => void open(item.notificationId ?? item.id, [item.sourceName, item.project].filter(Boolean).join(" · "))
  const nowIds = new Set(
    summary ? [...summary.needsYou, ...summary.running, ...summary.waitingOnYou, ...summary.quiet, ...summary.paused].map((item) => item.id) : []
  )
  const cards = allCards.filter(({ card }) => !nowIds.has(card.id))
  const approvals = overview?.approvalRequests ?? []
  const needsYou = (summary?.needsYou.length ?? 0) + approvals.length
  const running = summary?.running.length ?? 0
  // Done is the server's "finished since you looked", not a count of the notification page's cards
  // (finished work is not a notification row, so counting cards showed DONE 0 beside "2 finished").
  const cardMetrics = nowMetrics({ cards: allCards.map(({ card }) => card), running, needsYou })
  const metrics = summary ? { ...cardMetrics, done: nowCounts(summary).done } : cardMetrics
  const mix = nowMix({ cards: allCards.map(({ card }) => card), running, needsYou, now: new Date(now) })
  const agentSeconds = agentSecondsToday(allCards.map(({ card }) => card), new Date(now))
  const works = new Map<string, SessionWorkLink>(
    summary
      ? [...summary.needsYou, ...summary.waitingOnYou, ...summary.running].map((item) => [item.id, { title: item.title, open: () => openItem(item) }])
      : []
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
        data-active={selectedProject ? "true" : undefined}
        onChange={(event) => chooseProject(event.target.value)}
        className="pill"
      >
        <option value="">All projects</option>
        {projectOptions.map((option) => (
          <option key={option.key} value={option.key}>{option.name}</option>
        ))}
      </select>
    ) : null

  const kinds = [
    ["", "All"],
    ["live_activity", "Live Activities"],
    ["approval", "Approvals"],
    ["question", "Questions"],
    ["notification", "Messages"],
  ] as const
  const filtered = Boolean(filters?.kind || filters?.state || filters?.project)

  const historyFilters = history ? (
    <div className="flex w-full flex-col gap-2.5">
      <div role="group" aria-label="Kind" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        {kinds.map(([value, label]) => (
          <button
            key={value || "all"}
            type="button"
            className="pill"
            aria-pressed={(filters?.kind ?? "") === value}
            onClick={() => chooseFilter("kind", value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {projectSelect}
        <select
          aria-label="State"
          value={filters?.state ?? ""}
          data-active={filters?.state ? "true" : undefined}
          onChange={(event) => chooseFilter("state", event.target.value)}
          className="pill"
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
        {filtered ? (
          <a href="/dashboard/inbox/notifications" className="pill" aria-label="Clear filters">
            <X className="size-3.5" aria-hidden="true" />
            Clear
          </a>
        ) : null}
      </div>
    </div>
  ) : (
    projectSelect
  )

  const needsYouSection = overview && needsYou > 0 ? (
        <NowSection title="Needs you" count={needsYou} color={SIGNAL_CSS.needsYou}>
          {summary?.needsYou.length ? <NowItemList label="Needs you" items={summary.needsYou} onOpen={openItem} /> : null}
          {approvals.length ? (
          <ul aria-label="Connection requests" className="space-y-2.5">
            {approvals.map((request) => {
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
          ) : null}
        </NowSection>
      ) : null

  return (
    <Page
      title={history ? "History" : "Now"}
      eyebrow={history ? "Every notification and Live Activity, newest first." : undefined}
      actions={history ? <a href="/dashboard/inbox/delivery" className="pill"><Send className="size-3.5" aria-hidden="true" />Delivery log</a> : undefined}
    >
      {overview ? (
        <NowHud
          today={metrics.today}
          done={metrics.done}
          running={metrics.running}
          needsYou={metrics.needsYou}
          arcs={(summary?.running ?? []).map((item) => ({
            progress: item.steps ? item.steps.done / item.steps.total : null,
          }))}
          sentence={nowSentence(metrics)}
          mix={mix}
          agentTime={agentTime}
          syncing={offline}
        />
      ) : null}

      {overview ? <PendingDevicesNotice /> : null}

      {overview ? <LinkBrowserBanner accountId={overview.shell.account.id} /> : null}

      {/* Connection requests need the owner even when no work does. */}
      {!blocks.some((block) => block.kind === "needsYou") ? needsYouSection : null}

      {blocks.map((block) => {
        switch (block.kind) {
          case "sinceYouLooked":
            return (
              <section key="since" aria-label="Since you looked" className="space-y-3" data-now-block="since-you-looked">
                <p className={block.muted ? "text-sm text-muted-foreground" : "text-sm font-medium text-foreground"}>{block.text}</p>
                {block.recent.length ? <NowItemList label="Since you looked" items={block.recent} onOpen={openItem} /> : null}
                {block.more.length ? (
                  <details data-fold="recent">
                    <summary className="micro cursor-pointer select-none">{`Show ${block.more.length} more`}</summary>
                    <div className="mt-2.5"><NowItemList label="More since you looked" items={block.more} onOpen={openItem} /></div>
                  </details>
                ) : null}
              </section>
            )
          case "needsYou":
            return <div key="needs-you">{needsYouSection}</div>
          case "fold":
            return (
              <details key={block.fold} data-fold={block.fold} className="space-y-2.5">
                <summary
                  className="micro cursor-pointer select-none font-semibold"
                  style={{ color: block.fold === "waitingOnYou" ? SIGNAL_CSS.attention : undefined }}
                >
                  {`${FOLD_LABEL[block.fold]} (${block.count})`}
                </summary>
                <div className="mt-2.5"><NowItemList label={FOLD_LABEL[block.fold]} items={block.items} onOpen={openItem} /></div>
              </details>
            )
          case "running":
            return (
              <NowSection key="running" title={block.title} count={block.items.length} color={SIGNAL_CSS.running}>
                <NowItemList label={block.title} items={block.items} onOpen={openItem} />
              </NowSection>
            )
          case "sessions":
            return <SessionsSection key="sessions" sessions={block.sessions} works={works} />
          case "allClear":
            return null
        }
      })}

      {overview ? (
        <NowAllClear
          allClear={blocks.some((block) => block.kind === "allClear") && approvals.length === 0}
          activity={todayActivity(allCards.map(({ card }) => card), new Date(now))}
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
