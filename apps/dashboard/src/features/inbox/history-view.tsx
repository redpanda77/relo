import { ArrowUp, ChevronLeft, Search, Send, X } from "lucide-react"
import { AnimatePresence, LazyMotion, m } from "motion/react"
import { useEffect, useId, useState } from "react"

import { HISTORY_ENDINGS, HISTORY_KINDS, historyEndingLabel } from "@relo/notification-contracts"
import { SelectionIndicator } from "@/components/atoms/selection-indicator"
import { Empty } from "@/components/list"
import { Page } from "@/components/page"
import { historyDays, historyRow, todayPanel } from "@/features/inbox/history-model"
import { HistoryDayBand, HistoryQuietGap, HistoryTimelineRow, HistoryTodayPanel } from "@/features/inbox/history-timeline"
import { useDetailPanel } from "@/features/inbox/detail-panel"
import type { NotificationHistory } from "@/features/inbox/types"
import { displayName } from "@/lib/encrypted"
import { DUR, EASE_IN, EASE_OUT, loadMotionFeatures, usePrefersReducedMotion } from "@/lib/motion"
import type { InboxService } from "@/services/inbox-service"
import { navigateDashboard } from "@/state/use-dashboard-route"

type Filters = NotificationHistory["route"]["filters"]
type Kind = NonNullable<Filters["kind"]>

/** The iPhone's Show filter: everything, work, messages, decisions. */
const KINDS: ReadonlyArray<readonly [Kind | "", string]> = [["", "All"], ...HISTORY_KINDS]

/** How it ended, in the iPhone's words (Done, Ended, Stopped, Messages). */
const ENDINGS = HISTORY_ENDINGS.map((ending) => [ending, historyEndingLabel(ending, 2)] as const)

const HISTORY = "/dashboard/inbox/notifications"

/** History filters on the server across every page: each choice is a navigation (back to page 1). */
function hrefWith(filters: Filters, patch: Partial<Record<keyof Filters, string | null>>) {
  const next = { ...filters, ...patch }
  const query = new URLSearchParams()
  for (const key of ["q", "kind", "ending", "source", "project", "computer"] as const) {
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
  return Boolean(filters.ending || isNarrowed(filters))
}

/** Narrowed past a meaning: the Today panel steps aside for the filters that are on (the iPhone's `narrowed`). */
function isNarrowed(filters: Filters) {
  return Boolean(filters.q || filters.kind || filters.project || filters.source || filters.computer)
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
          label="How it ended"
          all="Any ending"
          value={filters.ending}
          options={ENDINGS}
          onChange={(ending) => navigateWith(filters, { ending })}
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

/** Past this far down, a "Today ↑" button brings the top back (the iPhone's ScrolledAwayTracker). */
const SCROLLED_AWAY = 900

function useScrolledAway() {
  const [away, setAway] = useState(false)
  useEffect(() => {
    const update = () => setAway(window.scrollY > SCROLLED_AWAY)
    update()
    window.addEventListener("scroll", update, { passive: true })
    return () => window.removeEventListener("scroll", update)
  }, [])
  return away
}

/**
 * History: what is over, newest first, filtered on the server; the iPhone's timeline. Today's panel heads it
 * (its chips narrow the list to one meaning), each earlier day has a pinned band, and an hour or more between
 * two rows shows as a quiet stretch of the rail.
 */
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
  const rows = history.notifications.map((notification) => historyRow(notification, now))
  const days = historyDays(rows, now)
  const openRow = (card: (typeof rows)[number]["card"]) =>
    void open(card.id, { source: card.source, project: card.project, topic: card.topic, computer: card.origin })
  // A new page or filter: the old list fades out (120 ms) and the new one rises 8 px (180 ms).
  const reduced = usePrefersReducedMotion()
  const f = history.route.filters
  const filtered = isFiltered(f)
  const narrowed = isNarrowed(f)
  const total = history.pagination.total
  const today = todayPanel(history.recent, now)
  const away = useScrolledAway()
  const pageKey = [history.pagination.page, f.kind, f.ending, f.project, f.source, f.computer, f.q].join("|")
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
        {!narrowed && today.total ? (
          <HistoryTodayPanel panel={today} selected={f.ending} hrefFor={(ending) => hrefWith(f, { ending })} />
        ) : null}
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
              {rows.length ? (
                <div aria-label="Activity" role="list" className="history-days">
                  {days.map((day) => {
                    const headingId = `history-day-${Number.isNaN(day.start) ? "earlier" : day.start}`
                    // Today needs no band: the Today panel above already names it and counts it.
                    const band = !day.isToday || narrowed || !today.total
                    return (
                      <section
                        key={headingId}
                        role="listitem"
                        className="history-day"
                        aria-labelledby={band ? headingId : undefined}
                        aria-label={band ? undefined : "Today"}
                      >
                        {band ? <HistoryDayBand day={day} headingId={headingId} /> : null}
                        <ul className="history-tl" aria-label={day.title}>
                          {day.rows.map((row, index) => (
                            <HistoryRowItem
                              key={row.card.id}
                              row={row}
                              continues={index + 1 < day.rows.length}
                              open={openId === row.card.id}
                              onOpen={() => openRow(row.card)}
                            />
                          ))}
                        </ul>
                      </section>
                    )
                  })}
                </div>
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
                  eyebrow="History"
                  title="No history yet"
                  description="Notifications and finished work from your sessions and scripts collect here."
                />
              )}
            </m.div>
          </AnimatePresence>
        </LazyMotion>
        <HistoryFooter history={history} />
      </div>
      {away ? (
        <button
          type="button"
          className="history-back-today"
          aria-label="Back to today"
          onClick={() => window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" })}
        >
          <ArrowUp className="size-4" aria-hidden="true" />
          Today
        </button>
      ) : null}
      {sheet}
    </Page>
  )
}

function HistoryRowItem({
  row,
  continues,
  open,
  onOpen,
}: {
  row: ReturnType<typeof historyDays>[number]["rows"][number]
  continues: boolean
  open: boolean
  onOpen: () => void
}) {
  return (
    <>
      <li>
        <HistoryTimelineRow row={row} dayHalf={row.dayHalf} continues={continues} open={open} onOpen={onOpen} />
      </li>
      {row.gapAfter ? <HistoryQuietGap text={row.gapAfter} /> : null}
    </>
  )
}
