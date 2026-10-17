import { ChevronLeft, Clock, Search, Send, X } from "lucide-react"
import { AnimatePresence, LazyMotion, m } from "motion/react"
import { useEffect, useId, useState } from "react"

import { SelectionIndicator } from "@/components/atoms/selection-indicator"
import { Empty } from "@/components/list"
import { Page } from "@/components/page"
import { WorkList, WorkListItem } from "@/components/organisms/work-card"
import { HistoryWorkCard } from "@/features/inbox/activity-card"
import {
  cardFor,
  daySummary,
  groupByDay,
  historySegments,
  type ActivityCard,
} from "@/features/inbox/activity-model"
import { useDetailPanel } from "@/features/inbox/detail-panel"
import type { NotificationHistory } from "@/features/inbox/types"
import { displayName } from "@/lib/encrypted"
import { DUR, EASE_IN, EASE_OUT, loadMotionFeatures, usePrefersReducedMotion } from "@/lib/motion"
import type { InboxService } from "@/services/inbox-service"
import { navigateDashboard } from "@/state/use-dashboard-route"

type Filters = NotificationHistory["route"]["filters"]
type Kind = NonNullable<Filters["kind"]>
type State = NonNullable<Filters["state"]>

/** The iPhone's kinds (ReloHistoryFilter): messages, decisions, work cards, your answers. */
const KINDS: ReadonlyArray<readonly [Kind | "", string]> = [
  ["", "All"],
  ["message", "Messages"],
  ["decision", "Decisions"],
  ["live_activity", "Live Activities"],
  ["response", "Responses"],
]

/** States in the owner's words; the server maps each onto what is stored. */
const STATES: ReadonlyArray<readonly [State, string]> = [
  ["running", "Running"],
  ["done", "Done"],
  ["failed", "Failed"],
  ["stopped", "Stopped"],
  ["answered", "Answered"],
  ["missed", "Missed"],
]

const HISTORY = "/dashboard/inbox/notifications"

/** History filters on the server across every page: each choice is a navigation (back to page 1). */
function hrefWith(filters: Filters, patch: Partial<Record<keyof Filters, string | null>>) {
  const next = { ...filters, ...patch }
  const query = new URLSearchParams()
  for (const key of ["q", "kind", "state", "source", "project", "computer"] as const) {
    const value = next[key]
    if (value) query.set(key, value)
  }
  const search = query.toString()
  return `${HISTORY}${search ? `?${search}` : ""}`
}

function navigateWith(filters: Filters, patch: Partial<Record<keyof Filters, string | null>>) {
  navigateDashboard(hrefWith(filters, patch))
}

function isFiltered(filters: Filters) {
  return Boolean(filters.q || filters.kind || filters.state || filters.project || filters.source || filters.computer)
}

/**
 * The kind last chosen, across navigations: if History mounts again for the new filter, its capsule
 * starts under the pill that was lit and slides to the new one instead of appearing there.
 */
let lastKind: string | null = null

/** The kind pills: one lit capsule that slides to the choice (a navigation) as soon as it is made. */
function KindPills({ filters }: { filters: Filters }) {
  const current = filters.kind ?? ""
  const [lit, setLit] = useState(() => lastKind ?? current)
  useEffect(() => {
    lastKind = current
    if (lit === current) return
    // One frame at the old pill, then the slide.
    const frame = requestAnimationFrame(() => setLit(current))
    return () => cancelAnimationFrame(frame)
    // Only a new filter from the server moves it; a click moves it at once below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <div role="group" aria-label="Kind" className="flex shrink-0 gap-2" data-glide-pills>
        {KINDS.map(([value, label]) => (
          <button
            key={value || "all"}
            type="button"
            className="pill"
            aria-pressed={current === value}
            onClick={() => {
              setLit(value)
              lastKind = value
              navigateWith(filters, { kind: value || null })
            }}
          >
            {lit === value ? <SelectionIndicator layoutId="history-kind" /> : null}
            {label}
          </button>
        ))}
      </div>
    </LazyMotion>
  )
}

/** A menu pill: shown only when there is a choice (or one is made, so it can be undone). */
function MenuPill({
  label,
  all,
  value,
  options,
  onChange,
}: {
  label: string
  all: string
  value: string | null
  options: ReadonlyArray<readonly [string, string]>
  onChange: (value: string | null) => void
}) {
  if (options.length < 2 && !value) return null
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      data-active={value ? "true" : undefined}
      onChange={(event) => onChange(event.target.value || null)}
      className="pill"
    >
      <option value="">{all}</option>
      {options.map(([key, name]) => (
        <option key={key} value={key}>
          {name}
        </option>
      ))}
    </select>
  )
}

/**
 * The search field. History searches on the server, so a search is a navigation made on Enter; it
 * reads only what the server can read, and says so: sealed items match by their source alone.
 */
function SearchField({ filters, hintId }: { filters: Filters; hintId: string }) {
  // Keyed by the server's query (below), so a new page starts from what it searched.
  const [draft, setDraft] = useState(filters.q ?? "")
  return (
    <form
      role="search"
      className="history-search"
      onSubmit={(event) => {
        event.preventDefault()
        const q = draft.trim()
        if (q !== (filters.q ?? "")) navigateWith(filters, { q: q || null })
      }}
    >
      <Search className="history-search-icon" aria-hidden="true" />
      <input
        type="search"
        name="q"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Search history"
        aria-label="Search history"
        aria-describedby={hintId}
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        maxLength={120}
      />
    </form>
  )
}

/**
 * One toolbar: search, the kind pills, then Source, Project and Computer (each only when there is a
 * choice), the state, and a ✕ that clears everything. It wraps under the search on phones.
 */
function HistoryToolbar({ history }: { history: NotificationHistory }) {
  const filters = history.route.filters
  const options = history.filterOptions
  const filtered = isFiltered(filters)
  const hintId = useId()
  const named = (values: readonly string[]) => values.map((value) => [value, displayName(value)] as const)
  return (
    <div className="history-toolbar">
      <div className="history-toolbar-search">
        <SearchField key={filters.q ?? ""} filters={filters} hintId={hintId} />
        <p id={hintId} className="history-search-hint">
          Searches readable titles and text. Encrypted items match by their source only.
        </p>
      </div>
      <div className="history-toolbar-filters no-scrollbar" role="group" aria-label="Filters">
        {filtered ? (
          <a href={HISTORY} className="pill history-clear" aria-label="Clear all filters" title="Clear all filters">
            <X className="size-3.5" aria-hidden="true" />
          </a>
        ) : null}
        <KindPills filters={filters} />
        <span className="history-toolbar-rule" aria-hidden="true" />
        <MenuPill
          label="Source"
          all="All sources"
          value={filters.source}
          options={named(options.sources ?? [])}
          onChange={(source) => navigateWith(filters, { source })}
        />
        <MenuPill
          label="Project"
          all="All projects"
          value={filters.project}
          options={named(options.projects)}
          onChange={(project) => navigateWith(filters, { project })}
        />
        <MenuPill
          label="Computer"
          all="All computers"
          value={filters.computer}
          options={named(options.computers ?? [])}
          onChange={(computer) => navigateWith(filters, { computer })}
        />
        <MenuPill
          label="State"
          all="Any state"
          value={filters.state}
          options={STATES}
          onChange={(state) => navigateWith(filters, { state })}
        />
      </div>
    </div>
  )
}

/** What the loaded page covers, as the iPhone says it under its list (HistoryView.coverage). */
function coverage(history: NotificationHistory): string {
  const { page, pageSize, total, pageCount } = history.pagination
  const shown = history.notifications.length
  const word = (count: number) => (count === 1 ? "notification" : "notifications")
  if (pageCount <= 1) return `${total} ${word(total)}`
  if (page === 1) return `Showing the latest ${shown} of ${total} ${word(total)}`
  const first = (page - 1) * pageSize + 1
  return `Showing ${first}–${first + shown - 1} of ${total} ${word(total)}`
}

/** Under the list: back to newer pages, Load older (the next page) and what the list covers. */
function HistoryFooter({ history }: { history: NotificationHistory }) {
  const { previousHref, nextHref } = history.pagination
  return (
    <div className="history-footer">
      {previousHref || nextHref ? (
        <div className="history-pages">
          {previousHref ? (
            <a href={previousHref} className="history-page-link" rel="prev">
              <ChevronLeft className="size-4" aria-hidden="true" />
              Newer
            </a>
          ) : null}
          {nextHref ? (
            <a href={nextHref} className="history-page-link history-load-older" rel="next">
              Load older notifications
            </a>
          ) : null}
        </div>
      ) : null}
      {history.notifications.length ? <p className="history-coverage">{coverage(history)}</p> : null}
    </div>
  )
}

/** The page of results last shown, so a page that mounts for the next page rises in. */
let lastPage: string | null = null

/** History: every notification and Live Activity, newest first, filtered on the server. */
export function HistoryView({
  history,
  service,
}: {
  history: NotificationHistory
  service: InboxService
}) {
  const { open, sheet, openId } = useDetailPanel(service)
  // Display only: the page-load instant formats dates.
  const [now] = useState(() => Date.now())
  const cards = history.notifications.map((notification) => cardFor(notification, now))
  const openCard = (card: ActivityCard) =>
    void open(card.id, { source: card.source, project: card.project, topic: card.topic, computer: card.origin })
  // A new page or filter: the old list fades out (120 ms) and the new one rises 8 px (180 ms).
  const reduced = usePrefersReducedMotion()
  const f = history.route.filters
  const filtered = isFiltered(f)
  const total = history.pagination.total
  const pageKey = [history.pagination.page, f.kind, f.state, f.project, f.source, f.computer, f.q].join("|")
  const [arrives] = useState(() => lastPage !== null && lastPage !== pageKey)
  useEffect(() => {
    lastPage = pageKey
  }, [pageKey])

  return (
    <Page
      title="History"
      actions={
        <a href="/dashboard/inbox/delivery" className="history-secondary-link">
          <Send className="size-3.5" aria-hidden="true" />
          Delivery log
        </a>
      }
    >
      <div className="history">
        <HistoryToolbar history={history} />
        {filtered ? (
          <p className="history-matches" aria-live="polite">
            {total === 1 ? "1 match" : `${total} matches`}
          </p>
        ) : null}
        <LazyMotion features={loadMotionFeatures} strict>
          <AnimatePresence mode="wait" initial={arrives}>
            <m.div
              key={pageKey}
              initial={{ opacity: 0, y: reduced ? 0 : 8 }}
              animate={{ opacity: 1, y: 0, transition: { duration: DUR.fast, ease: EASE_OUT } }}
              exit={{ opacity: 0, transition: { duration: DUR.micro, ease: EASE_IN } }}
            >
              {cards.length ? (
                <ul aria-label="Activity" className="history-days">
                  {groupByDay(cards, new Date(now)).map((group) => {
                    const headingId = `history-day-${group.key}`
                    const summary = daySummary(group.cards)
                    return (
                      <li key={group.key} className="history-day" aria-labelledby={headingId}>
                        <div className="history-day-head">
                          <h2 id={headingId} className="history-day-title">{group.label}</h2>
                          {summary ? (
                            <p className="history-day-counts">
                              {summary.split(" · ").map((count) => (
                                <span key={count}>{count}</span>
                              ))}
                            </p>
                          ) : null}
                        </div>
                        <div className="history-day-body">
                          {historySegments(group.cards).map((segment) =>
                            segment.kind === "live" ? (
                              <HistoryWorkCard
                                key={segment.card.id}
                                card={segment.card}
                                onOpen={() => openCard(segment.card)}
                                open={openId === segment.card.id}
                                showSource={!f.source}
                                showProject={!f.project}
                              />
                            ) : (
                              <WorkList key={segment.cards[0]!.id} label={group.label}>
                                {segment.cards.map((card) => (
                                  <WorkListItem key={card.id}>
                                    <HistoryWorkCard
                                      card={card}
                                      onOpen={() => openCard(card)}
                                      open={openId === card.id}
                                      showSource={!f.source}
                                      showProject={!f.project}
                                    />
                                  </WorkListItem>
                                ))}
                              </WorkList>
                            )
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              ) : filtered ? (
                <Empty
                  icon={<Search />}
                  title="No matches"
                  description="Try another search, or clear the filters."
                  action={
                    <a href={HISTORY} className="pill">
                      Clear filters
                    </a>
                  }
                />
              ) : (
                <Empty
                  icon={<Clock />}
                  title="No history yet"
                  description="Notifications and finished work from your sessions and scripts collect here."
                />
              )}
            </m.div>
          </AnimatePresence>
        </LazyMotion>
        <HistoryFooter history={history} />
      </div>
      {sheet}
    </Page>
  )
}
