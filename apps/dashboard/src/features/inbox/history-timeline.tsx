import { Bell, Check, CircleHelp, Clock, Laptop, Link, Repeat2, Square } from "lucide-react"

import { openLabel } from "@/features/inbox/activity-model"
import {
  clockTime,
  historyEndingLabel,
  hourAxis,
  type HistoryDay,
  type HistoryGlyph,
  type HistoryRowModel,
  type TodayPanel,
} from "@/features/inbox/history-model"
import type { HistoryEnding } from "@relo/notification-contracts"
import { SIGNAL_CSS } from "@/lib/signal"

const GLYPHS = { check: Check, clock: Clock, stop: Square, replaced: Repeat2, message: Bell, question: CircleHelp } as const

function Glyph({ glyph }: { glyph: HistoryGlyph }) {
  // Failed work carries the iPhone's exclamation mark; lucide has no bare one.
  if (glyph === "alert") return <span className="history-dot-mark">!</span>
  const Icon = GLYPHS[glyph]
  return <Icon className="history-dot-glyph" strokeWidth={3} aria-hidden="true" />
}

/**
 * One row on the day's timeline (the iPhone's HistoryRowView): the time, a dot on the rail that says how
 * it went (a symbol as well as a colour), then what it was, what came of it and where it ran. No plan bar:
 * History is what is over.
 */
export function HistoryTimelineRow({
  row,
  dayHalf,
  continues,
  open,
  onOpen,
}: {
  row: HistoryRowModel
  dayHalf: string | null
  /** The rail runs on below the dot, to the next row of the day. */
  continues: boolean
  open: boolean
  onOpen: () => void
}) {
  const { card } = row
  return (
    <button
      type="button"
      className="history-tl-row"
      aria-label={openLabel(card)}
      aria-current={open || undefined}
      data-signal={row.signal}
      data-continues={continues || undefined}
      style={{ "--signal": SIGNAL_CSS[row.signal] } as React.CSSProperties}
      onClick={onOpen}
    >
      <span className="history-tl-time">
        <time dateTime={card.at ?? undefined}>{clockTime(row.at)}</time>
        {dayHalf ? <span className="history-tl-half">{dayHalf}</span> : null}
      </span>
      <span className="history-tl-rail" aria-hidden="true">
        <span className="history-dot">
          <Glyph glyph={row.glyph} />
        </span>
      </span>
      <span className="history-tl-body">
        <span className="history-tl-state">
          <span className="history-tl-label">{row.label}</span>
          {row.context ? <span className="history-tl-context"> · {row.context}</span> : null}
          {card.link ? <Link className="history-tl-link" aria-label="Has a link" /> : null}
        </span>
        <span className="history-tl-headline" data-unread={row.unreadMessage || undefined}>
          {card.title}
        </span>
        {card.summary ? <span className="history-tl-summary">{card.summary}</span> : null}
        {row.pill ? (
          <span className="history-tl-pill" data-tone={row.pill.tone}>
            {row.pill.text}
          </span>
        ) : null}
        {row.facts.length ? (
          <span className="history-tl-facts">
            {card.origin ? <Laptop className="size-3" aria-hidden="true" /> : null}
            {row.facts.join(" · ")}
          </span>
        ) : null}
      </span>
    </button>
  )
}

/** A pause of an hour or more between two rows, on a dotted stretch of the rail: "3h 45m quiet". */
export function HistoryQuietGap({ text }: { text: string }) {
  return (
    <li className="history-gap" aria-label={text}>
      <span className="history-gap-rail" aria-hidden="true" />
      <span className="history-gap-text">{text}</span>
    </li>
  )
}

/** An earlier day's band, pinned while its rows scroll: its name and date, and how it went. */
export function HistoryDayBand({ day, headingId }: { day: HistoryDay; headingId: string }) {
  return (
    <div className="history-band">
      <h2 id={headingId} className="history-band-title">
        {day.title}
        {day.date && day.date !== day.title ? <span className="history-band-date">{day.date}</span> : null}
      </h2>
      {day.counts ? <p className="history-band-counts">{day.counts}</p> : null}
    </div>
  )
}

/**
 * The day at a glance (the iPhone's HistorySummaryPanel): how many things settled today, by hour and
 * meaning, and one chip per meaning that narrows the list to it; while one is picked the other bars step
 * back. Chips are links, because History filters on the server.
 */
export function HistoryTodayPanel({
  panel,
  selected,
  hrefFor,
}: {
  panel: TodayPanel
  selected: HistoryEnding | null
  /** Where a chip leads: the list narrowed to its meaning, or everything again when it is the one picked. */
  hrefFor: (signal: HistoryEnding | null) => string
}) {
  const height = 46
  const unit = (height - 4) / Math.max(panel.maxTotal, 1)
  return (
    <section className="history-today" aria-label="Today">
      <div className="history-today-top">
        <div className="history-today-count">
          <span className="history-today-title">Today</span>
          <span className="history-today-total">{panel.total}</span>
        </div>
        <div className="history-today-chart">
          <div
            className="history-today-bars"
            role="img"
            aria-label="Activity by hour"
            aria-description={`${panel.total} items, busiest hour has ${panel.maxTotal}`}
            style={{ height }}
          >
            {panel.hours.map((mix, hour) => (
              <div key={hour} className="history-today-hour">
                {(["message", "failed", "attention", "done"] as const).map((signal) =>
                  (mix[signal] ?? 0) > 0 ? (
                    <span
                      key={signal}
                      className="history-today-seg"
                      data-dimmed={(selected && selected !== signal) || undefined}
                      style={{ height: (mix[signal] ?? 0) * unit, background: SIGNAL_CSS[signal] }}
                    />
                  ) : null
                )}
                <span
                  className="history-today-base"
                  data-now={hour === panel.currentHour || undefined}
                  data-future={hour > panel.currentHour || undefined}
                />
              </div>
            ))}
          </div>
          <div className="history-today-axis" aria-hidden="true">
            {hourAxis().map((mark) => (
              <span key={mark}>{mark}</span>
            ))}
          </div>
        </div>
      </div>
      {panel.counts.length ? (
        <div className="history-today-chips" role="group" aria-label="How it ended">
          {panel.counts.map(({ signal, count }) => {
            const picked = selected === signal
            const label = historyEndingLabel(signal, count)
            return (
              <a
                key={signal}
                href={hrefFor(picked ? null : signal)}
                className="history-chip"
                aria-pressed={picked}
                aria-label={`${count} ${label}`}
                title={picked ? "Show everything again" : "Show only these"}
                style={{ "--signal": SIGNAL_CSS[signal] } as React.CSSProperties}
              >
                <span className="history-chip-dot" aria-hidden="true" />
                <span className="history-chip-count">{count}</span>
                <span className="history-chip-label">{label}</span>
              </a>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
