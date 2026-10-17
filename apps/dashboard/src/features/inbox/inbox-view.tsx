import { AnimatePresence, LayoutGroup, LazyMotion, m } from "motion/react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react"

import { Fold } from "@/components/molecules/fold"
import { NowDeck } from "@/components/organisms/now-deck"
import { PageTitle, SplitPage } from "@/components/page"
import {
  agentSecondsToday,
  agentTimeLabel,
  cardFor,
  nowMix,
  nowSentence,
  todayActivity,
} from "@/features/inbox/activity-model"
import { useDetailPanel } from "@/features/inbox/detail-panel"
import {
  ActivityStrip,
  NowAllClear,
  NowItemList,
  NowSection,
} from "@/features/inbox/now-all-clear"
import { ConnectionRequests } from "@/features/inbox/now-approvals"
import { NowStageContext, type NowStage } from "@/features/inbox/now-context"
import {
  catchUpEvents,
  nowArcs,
  nowEvents,
  nowItemsById,
  nowPlaces,
  type NowEventBatch,
} from "@/features/inbox/now-events"
import {
  FOLD_LABEL,
  nowBlocks,
  nowCounts,
  overviewNow,
  withoutUnreadable,
  type NowBlock,
  type NowItem,
} from "@/features/inbox/now-model"
import { notificationContext } from "@/features/inbox/notification-project"
import {
  SessionsSection,
  type SessionWorkLink,
} from "@/features/inbox/sessions-section"
import type { InboxOverview } from "@/features/inbox/types"
import { useNowRefresh } from "@/features/inbox/use-now-refresh"
import { ConnectEntry } from "@/features/onboarding/connect-entry"
import { LinkBrowserBanner } from "@/features/linked-browser/link-browser-card"
import { PendingDevicesNotice } from "@/features/pending-devices/pending-devices"
import { DUR, EASE_IN, EASE_OUT, SPRING, loadMotionFeatures } from "@/lib/motion"
import { orbMotion } from "@/lib/orb-theme"
import { displayNameOrNull } from "@/lib/encrypted"
import { isBrowserLinked, isSealedOpening, subscribeBrowserLinked, subscribeSealedOpening } from "@/lib/sealed-opening"
import { SIGNAL_CSS } from "@/lib/signal"
import type { WorkTone } from "@/lib/work-outcome"
import { SpectrumBar } from "@/components/molecules/spectrum-bar"
import type { InboxService } from "@/services/inbox-service"
import { useInboxAction } from "@/state/use-inbox-action"

/** A block's wrapper: present blocks fade in after the first paint, leave fast, and the rest close the gap. */
const BLOCK_IN = { opacity: 1, transition: { duration: DUR.base, ease: EASE_OUT } }
const BLOCK_OUT = { opacity: 0, transition: { duration: DUR.fast, ease: EASE_IN } }
const BLOCK_TRANSITION = { layout: SPRING }

type ShownBlock = NowBlock | { kind: "connections" }

/** How long a newly-needs-you card keeps its announce ring (one 700 ms ring, then the attribute goes). */
const ANNOUNCE_MS = 800

/**
 * Now's layout by the page's own width (the `split-page` container, so the sidebar counts):
 * - stacked (under 1100px): a compact deck above the work, Sessions after the folds, Today last;
 * - split (1100px+): the deck is a 360px column beside the work and carries today's strip;
 * - wide (1400px+): Sessions moves to a 320px rail on the right.
 * The breakpoints match now.css. Measured before paint, so the first frame is already right.
 */
export type NowLayout = "stacked" | "split" | "wide"
const SPLIT_AT = 1100
const RAIL_AT = 1400

function layoutFor(width: number): NowLayout {
  return width >= RAIL_AT ? "wide" : width >= SPLIT_AT ? "split" : "stacked"
}

/** Phone width: Since you looked shows one row (and "Show n more"), so the first live card is on screen. */
const PHONE_BELOW = 640

function useNowLayout(probe: RefObject<HTMLElement | null>): { layout: NowLayout; phone: boolean } {
  const [layout, setLayout] = useState<{ layout: NowLayout; phone: boolean }>({ layout: "stacked", phone: false })
  useLayoutEffect(() => {
    const page = probe.current?.closest<HTMLElement>(".split-page")
    if (!page) return
    const measure = () => {
      const width = page.getBoundingClientRect().width
      const next = { layout: layoutFor(width), phone: width > 0 && width < PHONE_BELOW }
      setLayout((current) => (current.layout === next.layout && current.phone === next.phone ? current : next))
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(page)
    return () => observer.disconnect()
  }, [probe])
  return layout
}

/** Since you looked: the server's line, then up to three rows and "Show n more" under them. */
function SinceYouLooked({
  block,
  onOpen,
  phone,
}: {
  block: Extract<NowBlock, { kind: "sinceYouLooked" }>
  onOpen: (item: NowItem) => void
  /** On a phone one row shows, so the first live card is above the fold. */
  phone: boolean
}) {
  const [all, setAll] = useState(false)
  const every = [...block.recent, ...block.more]
  const cap = phone ? 1 : block.recent.length
  const items = all ? every : every.slice(0, cap)
  const hidden = every.length - items.length
  return (
    <section aria-label="Since you looked" className="space-y-3" data-now-block="since-you-looked">
      <p className={block.muted ? "text-sm text-pretty text-muted-foreground" : "text-sm font-medium text-pretty text-foreground"}>
        {block.text}
      </p>
      {items.length ? <NowItemList variant="rows" label="Since you looked" items={items} onOpen={onOpen} /> : null}
      {every.length > cap ? (
        <button type="button" className="now-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? "Show fewer" : `Show ${hidden} more`}
        </button>
      ) : null}
    </section>
  )
}

/** Now: the living deck beside the live work (the iPhone's landscape layout), from the server's summary. */
export function InboxView({
  overview,
  service,
  onApprovalSuccess,
}: {
  overview: InboxOverview
  service: InboxService
  onApprovalSuccess?: () => void
}) {
  const actions = useInboxAction(service, onApprovalSuccess)
  const { open, sheet } = useDetailPanel(service)
  const notifications = overview.recentNotifications
  const probe = useRef<HTMLDivElement>(null)
  const { layout, phone } = useNowLayout(probe)

  // Display only (Today strip, agent time): the page-load instant formats dates.
  const [now] = useState(() => Date.now())
  // A linked browser hides what it still cannot open once opening settles: it was sealed before the
  // link and only the iPhone reads it (now-model `withoutUnreadable`).
  const linked = useSyncExternalStore(subscribeBrowserLinked, isBrowserLinked, () => false)
  const opening = useSyncExternalStore(subscribeSealedOpening, isSealedOpening, () => false)
  const hideUnreadable = linked && !opening
  const allCards = notifications
    .map((notification) => ({
      notification,
      card: cardFor(notification, now),
    }))
    .filter(({ card }) => !(hideUnreadable && card.encrypted))
  // Now is the server's: sections, folds and counts come from its summary, refetched every 60 s.
  const initialNow = useMemo(() => overviewNow(overview), [overview])
  const refreshed = useNowRefresh(overview.shell.account.id, initialNow)
  const { offline, syncing } = refreshed
  const summary = useMemo(
    () => (refreshed.summary && hideUnreadable ? withoutUnreadable(refreshed.summary) : refreshed.summary),
    [refreshed.summary, hideUnreadable]
  )

  // Moments between the previous summary and this one (a comet, a ring), never state. The first
  // summary has no previous one, so the first paint fires nothing. Adjusted while rendering.
  const [moments, setMoments] = useState<{ summary: typeof summary; batch: NowEventBatch }>(() => ({
    summary,
    batch: { key: 0, events: [] },
  }))
  if (moments.summary !== summary) {
    setMoments({
      summary,
      batch: { key: moments.batch.key + 1, events: nowEvents(moments.summary, summary) },
    })
  }
  const batch = moments.batch
  // The page-open catch-up (what happened since the owner looked), from the first summary only.
  const [catchUp] = useState(() => catchUpEvents(summary))
  const [announceSpent, setAnnounceSpent] = useState(0)
  useEffect(() => {
    if (!batch.events.some((event) => event.kind === "needsYou")) return
    const timer = window.setTimeout(() => setAnnounceSpent(batch.key), ANNOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [batch])
  const announce = useMemo(
    () =>
      new Set(
        announceSpent === batch.key
          ? []
          : batch.events.filter((event) => event.kind === "needsYou").map((event) => event.id)
      ),
    [batch, announceSpent]
  )

  // Ready after the first paint: what mounts later animates in, the first paint stays still.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setReady(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])

  // Which folds are open, read when a card leaves (into a closed fold it drops toward the summary).
  const foldsOpen = useRef<Record<string, boolean>>({})
  const isFoldOpen = useCallback((fold: string) => foldsOpen.current[fold] ?? false, [])
  const onFold = useCallback((fold: string, value: boolean) => {
    foldsOpen.current[fold] = value
  }, [])
  // The tone each card last showed (display only): a card moved between lists crossfades from it.
  const [tones] = useState(() => new Map<string, WorkTone>())

  // The item whose detail is open keeps a ring while its sheet is.
  const [openedId, setOpenedId] = useState<string | null>(null)
  const sheetOpen = Boolean((sheet.props as { open?: boolean }).open)
  // Not memoized: Now re-renders only on a refresh or the sheet (lists no longer tick), and the
  // cards' memo then re-renders them once.
  const openItem = (item: NowItem) => {
    setOpenedId(item.id)
    void open(
      item.notificationId ?? item.id,
      [item.sourceName, item.project].filter(Boolean).join(" · ")
    )
  }

  const items = useMemo(() => nowItemsById(summary), [summary])
  const places = useMemo(() => nowPlaces(summary), [summary])
  const openId = sheetOpen ? openedId : null
  const sessionByWork = useMemo(
    () => new Map((summary?.sessions.sessions ?? []).flatMap((row) => (row.workId ? [[row.workId, { id: row.id, computer: displayNameOrNull(row.computer) }] as const] : []))),
    [summary]
  )
  const stage = useMemo<NowStage>(
    () => ({ ready, items, places, isFoldOpen, announce, openId, tones, offline, sessionByWork }),
    [ready, items, places, isFoldOpen, announce, openId, tones, offline, sessionByWork]
  )

  // When the server derived the Now on screen: the page load, then each refetch.
  const syncedAt = summary ? Date.parse(summary.serverTime) : undefined
  const blocks = summary ? nowBlocks(summary, { offline }) : []
  const approvals = overview.approvalRequests ?? []
  // The deck's readouts are the server's live counts (plus connection requests, which need you too).
  const counts = summary ? nowCounts(summary) : { needsYou: 0, running: 0, sessionsWorking: 0, waitingOnYou: 0 }
  const needsYou = counts.needsYou + approvals.length
  // The core's steady motion and arcs: from the server's summary only, never a client clock.
  const motion = useMemo(() => orbMotion(summary, offline, approvals.length), [summary, offline, approvals.length])
  const arcs = useMemo(() => nowArcs(summary), [summary])
  const cards = allCards.map(({ card }) => card)
  // Today is one set of rows: the Today caption, the strip's key and the deck's Today count.
  const activity = todayActivity(cards, new Date(now))
  const mix = nowMix({ cards, running: counts.running, needsYou, now: new Date(now) })
  const agentSeconds = agentSecondsToday(cards, new Date(now))
  const agentTime = agentSeconds > 0 ? agentTimeLabel(agentSeconds) : null
  const works = new Map<string, SessionWorkLink>(
    summary
      ? [...summary.needsYou, ...summary.waitingOnYou, ...summary.running].map(
          (item) => [item.id, { title: item.title, open: () => openItem(item) }]
        )
      : []
  )
  const split = layout !== "stacked"
  const sessionsBlock = blocks.find((block) => block.kind === "sessions")

  // "Needs you" renders in one place: the server's block, or (connection requests only) the same
  // first slot, so it never remounts when work joins the requests. Sessions sit in
  // the rail on wide pages.
  const shown: ShownBlock[] = blocks.filter(
    (block) =>
      block.kind !== "allClear" &&
      !(layout === "wide" && block.kind === "sessions") &&
      // "Nothing new" is absence, which Now already shows by being quiet: no line, no gap.
      !(block.kind === "sinceYouLooked" && block.muted && !block.recent.length && !block.more.length)
  )
  if (approvals.length && !blocks.some((block) => block.kind === "needsYou")) {
    shown.unshift({ kind: "connections" })
  }

  const needsYouSection = (
    <NowSection title="Needs you" count={needsYou} color={SIGNAL_CSS.needsYou}>
      {summary?.needsYou.length ? (
        <NowItemList label="Needs you" items={summary.needsYou} onOpen={openItem} />
      ) : null}
      {approvals.length ? <ConnectionRequests approvals={approvals} actions={actions} /> : null}
    </NowSection>
  )

  const renderBlock = (block: ShownBlock) => {
    switch (block.kind) {
      case "sinceYouLooked":
        return <SinceYouLooked block={block} onOpen={openItem} phone={phone} />
      case "needsYou":
      case "connections":
        return needsYouSection
      case "waitingOnYou":
        return (
          <NowSection title="Waiting on you" count={block.items.length} color={SIGNAL_CSS.attention}>
            <NowItemList label="Waiting on you" items={block.items} onOpen={openItem} />
          </NowSection>
        )
      case "fold":
        return (
          <Fold
            name={block.fold}
            label={FOLD_LABEL[block.fold]}
            count={block.count}
            className="now-fold"
            onOpenChange={(value) => onFold(block.fold, value)}
          >
            <NowItemList variant="rows" label={FOLD_LABEL[block.fold]} items={block.items} onOpen={openItem} />
          </Fold>
        )
      case "running":
        return (
          <NowSection title={block.title} count={block.items.length} color={SIGNAL_CSS.running} className="now-running">
            <NowItemList label={block.title} items={block.items} onOpen={openItem} />
          </NowSection>
        )
      case "sessions":
        return <SessionsSection sessions={block.sessions} works={works} />
      case "allClear":
        return null
    }
  }
  const blockKey = (block: ShownBlock) =>
    block.kind === "fold" ? block.fold : block.kind === "connections" ? "needsYou" : block.kind

  const spectrum = Object.keys(mix).length ? <SpectrumBar mix={mix} /> : null

  return (
    <SplitPage
      aside={
        <NowDeck
          heading={<PageTitle title="Now" />}
          today={activity.rows.length}
          sessions={counts.sessionsWorking}
          waiting={counts.waitingOnYou}
          running={counts.running}
          needsYou={needsYou}
          motion={motion}
          arcs={arcs}
          events={batch}
          catchUp={catchUp}
          sentence={nowSentence({ running: counts.running, needsYou, today: activity.rows.length })}
          mix={mix}
          agentTime={agentTime}
          syncedAt={syncedAt}
          syncing={syncing}
          offline={offline}
          layout={split ? "split" : "stacked"}
          todayStrip={split && activity.rows.length ? <ActivityStrip activity={activity} /> : null}
        />
      }
    >
      <PendingDevicesNotice />
      <ConnectEntry />
      <LinkBrowserBanner accountId={overview.shell.account.id} />
      <NowStageContext.Provider value={stage}>
        {/* One layout group: an item the server moves between sections travels there. Blocks are
            the page stack's own children: each fades in when it appears after the first paint,
            fades out fast when it goes (keeping its last items while it does), and the blocks
            around it close the gap on the spring. */}
        <LayoutGroup>
          <LazyMotion features={loadMotionFeatures} strict>
            <AnimatePresence initial={false}>
              {shown.map((block) => (
                <m.div
                  key={blockKey(block)}
                  layout="position"
                  className="now-block"
                  data-now-slot={block.kind === "connections" ? "needsYou" : block.kind}
                  initial={{ opacity: 0 }}
                  animate={BLOCK_IN}
                  exit={BLOCK_OUT}
                  transition={BLOCK_TRANSITION}
                >
                  {renderBlock(block)}
                </m.div>
              ))}
            </AnimatePresence>
          </LazyMotion>
        </LayoutGroup>
        <NowAllClear
          allClear={blocks.some((block) => block.kind === "allClear") && approvals.length === 0}
          activity={activity}
          strip={!split}
          instruments={split ? null : { agentTime, spectrum }}
          onOpen={(id) => {
            const found = notifications.find((item) => item.id === id)
            void open(id, found ? notificationContext(found) : "")
          }}
        />
        {layout === "wide" && sessionsBlock?.kind === "sessions" ? (
          <aside className="now-rail" aria-label="Sessions">
            <div className="now-rail-inner">
              <SessionsSection sessions={sessionsBlock.sessions} works={works} />
            </div>
          </aside>
        ) : null}
      </NowStageContext.Provider>
      <div ref={probe} className="now-probe" hidden />
      {sheet}
    </SplitPage>
  )
}
