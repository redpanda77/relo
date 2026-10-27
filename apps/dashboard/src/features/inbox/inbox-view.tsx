import { AnimatePresence, LayoutGroup, LazyMotion, m } from "motion/react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react"

import { NowDeck } from "@/components/organisms/now-deck"
import { PageTitle, SplitPage } from "@/components/page"
import { cardFor, nowMix } from "@/features/inbox/activity-model"
import { useDetailPanel } from "@/features/inbox/detail-panel"
import { NowFooter, NowItemList, NowSection } from "@/features/inbox/now-cards"
import { workActionsOf, canEndWork } from "@/features/inbox/end-work"
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
import { ParkedFold, SettledGroup, SettledList } from "@/features/inbox/settled-row"
import {
  SINCE_ROWS,
  isSealedItem,
  nowBlocks,
  nowCounts,
  overviewNow,
  withoutUnreadable,
  type NowBlock,
  type NowItem,
} from "@/features/inbox/now-model"
import {
  SessionsSection,
  type SessionWorkLink,
} from "@/features/inbox/sessions-section"
import type { InboxOverview } from "@/features/inbox/types"
import { useMomentCues } from "@/features/inbox/now-cues"
import { useNowRefresh } from "@/features/inbox/use-now-refresh"
import { ConnectEntry } from "@/features/onboarding/connect-entry"
import { LinkBrowserBanner } from "@/features/linked-browser/link-browser-card"
import { standbyMachines } from "@/features/inbox/sessions-model"
import { NowSystem } from "@/features/inbox/now-system"
import { useBackdropWash, washFor } from "@/lib/backdrop-wash"
import { DUR, EASE_IN, EASE_OUT, SPRING, loadMotionFeatures } from "@/lib/motion"
import { setLiveNeedsYou } from "@/lib/attention"
import { orbMotion } from "@/lib/orb-theme"
import { displayNameOrNull } from "@/lib/encrypted"
import { isBrowserLinked, isSealedOpening, subscribeBrowserLinked, subscribeSealedOpening } from "@/lib/sealed-opening"
import { SIGNAL_CSS } from "@/lib/signal"
import type { WorkTone } from "@/lib/work-outcome"
import type { InboxService } from "@/services/inbox-service"
import { useInboxAction } from "@/state/use-inbox-action"

/** A block's wrapper: present blocks fade in after the first paint, leave fast, and the rest close the gap. */
const BLOCK_IN = { opacity: 1, transition: { duration: DUR.base, ease: EASE_OUT } }
const BLOCK_OUT = { opacity: 0, transition: { duration: DUR.fast, ease: EASE_IN } }
const BLOCK_TRANSITION = { layout: SPRING }

type ShownBlock = NowBlock | { kind: "connections" }

/** How long a newly-needs-you card keeps its announce ring (one --dur-slow ring, then the attribute goes). */
const ANNOUNCE_MS = 500

/**
 * Now's layout by the page's own width (the `split-page` container, so the sidebar counts):
 * - stacked (under 1100px): a compact deck above the work, Sessions after the folds, View history last;
 * - split (1100px+): the deck is a 360px column beside the work;
 * - wide (1400px+): Sessions moves to a 320px rail on the right.
 * The breakpoints match now.css. Measured before paint, so the first frame is already right.
 */
export type NowLayout = "stacked" | "split" | "wide"
const SPLIT_AT = 1100
const RAIL_AT = 1400

function layoutFor(width: number): NowLayout {
  return width >= RAIL_AT ? "wide" : width >= SPLIT_AT ? "split" : "stacked"
}

function useNowLayout(probe: RefObject<HTMLElement | null>): { layout: NowLayout } {
  const [layout, setLayout] = useState<{ layout: NowLayout }>({ layout: "stacked" })
  useLayoutEffect(() => {
    const page = probe.current?.closest<HTMLElement>(".split-page")
    if (!page) return
    const measure = () => {
      const width = page.getBoundingClientRect().width
      const next = { layout: layoutFor(width) }
      setLayout((current) => (current.layout === next.layout ? current : next))
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(page)
    return () => observer.disconnect()
  }, [probe])
  return layout
}

/** Since you looked: a caption with the count, then compact rows in one glass group and "Show n more" inside it. */
function SinceYouLooked({
  block,
  onOpen,
}: {
  block: Extract<NowBlock, { kind: "sinceYouLooked" }>
  onOpen: (item: NowItem) => void
}) {
  const [all, setAll] = useState(false)
  const every = [...block.recent, ...block.more]
  const items = all ? every : every.slice(0, SINCE_ROWS)
  const hidden = every.length - items.length
  return (
    <NowSection title="Since you looked" count={every.length} color="#eef1f7" className="now-since">
      {/* The server's sentence ("Since 4:10 PM: 2 finished, 1 failed") is spoken, not shown (iPhone). */}
      <p className="sr-only">{block.text}</p>
      {items.length ? (
        <SettledGroup>
          <SettledList label="Since you looked" items={items} onOpen={onOpen} />
          {every.length > SINCE_ROWS ? (
            <button type="button" className="settled-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
              <span>{all ? "Show fewer" : `Show ${hidden} more`}</span>
              <span className="settled-more-end">{all ? "Hide" : "Show \u203a"}</span>
            </button>
          ) : null}
        </SettledGroup>
      ) : null}
    </NowSection>
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
  const { layout } = useNowLayout(probe)

  // Display only (the orb's colours): the page-load instant formats dates.
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
  const { offline, syncing, retry } = refreshed
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
  useMomentCues(batch, catchUp)
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
      [item.sourceName, item.project].filter(Boolean).join(" · "),
      // The detail offers End work for the states the iPhone does (never a moving work).
      workActions && canEndWork(item.owner.state) ? { id: item.id, goal: item.title, encrypted: isSealedItem(item), end: workActions.end } : undefined
    )
  }

  // The owner's End and Dismiss, each followed by a Now refetch (the server's live hint would come too).
  const workActions = useMemo(() => workActionsOf(service, retry), [service, retry])
  // The notifications that carry a link: their cards show the small mark.
  const links = useMemo(
    () =>
      new Set(
        [...notifications, ...(overview.runningActivities ?? [])]
          .filter((notification) => notification.destination.state === "safe")
          .map((notification) => notification.id)
      ),
    [notifications, overview.runningActivities]
  )
  const items = useMemo(() => nowItemsById(summary), [summary])
  const places = useMemo(() => nowPlaces(summary), [summary])
  const openId = sheetOpen ? openedId : null
  const sessionByWork = useMemo(
    () => new Map((summary?.sessions.sessions ?? []).flatMap((row) => (row.workId ? [[row.workId, { id: row.id, computer: displayNameOrNull(row.computer) }] as const] : []))),
    [summary]
  )
  const stage = useMemo<NowStage>(
    () => ({ ready, items, places, isFoldOpen, announce, openId, tones, offline, sessionByWork, links, actions: workActions }),
    [ready, items, places, isFoldOpen, announce, openId, tones, offline, sessionByWork, links, workActions]
  )

  // When the server derived the Now on screen: the page load, then each refetch.
  const syncedAt = summary ? Date.parse(summary.serverTime) : undefined
  const blocks = summary ? nowBlocks(summary, { offline }) : []
  const approvals = overview.approvalRequests ?? []
  // The deck's readouts are the server's live counts (plus connection requests, which need you too).
  const counts = summary ? nowCounts(summary) : { needsYou: 0, running: 0, sessionsWorking: 0, waitingOnYou: 0 }
  const needsYou = counts.needsYou + approvals.length
  // The page backdrop takes the state's colour and keeps it on the other pages.
  useBackdropWash(washFor({ needsYou, waitingOnYou: counts.waitingOnYou, running: counts.running }, !summary))
  // The tab title and icon follow Now's live count (the router reads it), not the page-load bootstrap's.
  useEffect(() => {
    setLiveNeedsYou(needsYou)
    return () => setLiveNeedsYou(null)
  }, [needsYou])
  // The core's steady motion and arcs: from the server's summary only, never a client clock.
  const motion = useMemo(() => orbMotion(summary, offline, approvals.length), [summary, offline, approvals.length])
  const arcs = useMemo(() => nowArcs(summary), [summary])
  const cards = allCards.map(({ card }) => card)
  const mix = nowMix({ cards, running: counts.running, needsYou, now: new Date(now) })
  const works = new Map<string, SessionWorkLink>(
    summary
      ? [...summary.needsYou, ...summary.waitingOnYou, ...summary.running].map(
          (item) => [item.id, { title: item.title, open: () => openItem(item) }]
        )
      : []
  )
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
        return <SinceYouLooked block={block} onOpen={openItem} />
      case "needsYou":
      case "connections":
        return needsYouSection
      case "waitingOnYou":
        return (
          <NowSection title="Your turn" count={block.items.length} color={SIGNAL_CSS.attention}>
            <NowItemList label="Your turn" items={block.items} onOpen={openItem} />
          </NowSection>
        )
      case "parked":
        return (
          <ParkedFold
            quiet={block.quiet}
            paused={block.paused}
            onOpen={openItem}
            onOpenChange={(value) => {
              onFold("quiet", value)
              onFold("paused", value)
            }}
          />
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
  const blockKey = (block: ShownBlock) => (block.kind === "connections" ? "needsYou" : block.kind)

  return (
    <SplitPage
      aside={
        <NowDeck
          heading={<PageTitle title="Now" />}
          sessions={counts.sessionsWorking}
          sessionRows={summary?.sessions.sessions}
          connecting={!summary}
          waiting={counts.waitingOnYou}
          running={counts.running}
          needsYou={needsYou}
          motion={motion}
          arcs={arcs}
          events={batch}
          catchUp={catchUp}
          mix={mix}
          syncedAt={syncedAt}
          syncing={syncing}
          offline={offline}
        />
      }
    >
      <NowSystem offline={offline} syncing={syncing} syncedAt={syncedAt} onRetry={retry} />
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
        <NowFooter
          machines={standbyMachines(summary?.sessions.sessions ?? [], syncedAt ?? now)}
          allClear={blocks.some((block) => block.kind === "allClear") && approvals.length === 0}
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
