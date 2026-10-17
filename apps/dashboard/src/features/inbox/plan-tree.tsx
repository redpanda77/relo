import { Check, ChevronRight, Ellipsis, X } from "lucide-react"
import { useId, useMemo, useState } from "react"

import { timeOfDay } from "@/features/inbox/activity-model"
import {
  UNREADABLE_LABEL,
  durationLabel,
  itemsIn,
  makeOutline,
  nodeDuration,
  planHeader,
  progressOf,
  roundDuration,
  roundHeading,
  roundSlots,
  rowsOf,
  startsFolded,
  unskipped,
  type PlanBranch,
  type PlanEntry,
  type PlanFold,
  type PlanItem,
  type PlanNode,
  type PlanUnreadableRun,
  type PlanOutline,
  type PlanRound,
  type PlanRoundInput,
  type PlanStanding,
} from "@/features/inbox/plan-outline"
import { cn } from "@/lib/utils"

type Mark = "done" | "current" | "stopped" | "open" | "skipped"
const markWord: Record<Mark, string> = { done: "done", current: "current", stopped: "stopped", open: "not started", skipped: "skipped" }

/** Shape carries the state, never color alone (§7): filled check, ring with dot, cross, empty ring, dashed ring. */
function PlanMark({ mark, round = false }: { mark: Mark | "fold"; round?: boolean }) {
  return (
    <span className={cn("plan-mark", mark === "current" && "mission-pulse")} data-mark={mark} data-round={round || undefined} aria-hidden="true">
      {mark === "done" ? <Check className="size-3" strokeWidth={3} /> : null}
      {mark === "stopped" ? <X className="size-3" strokeWidth={2.5} /> : null}
      {mark === "fold" ? <Ellipsis className="size-3" /> : null}
    </span>
  )
}

type Context = {
  outline: PlanOutline
  standing: PlanStanding
  folds: ReadonlySet<string>
  steps: ReadonlySet<string>
  infos: ReadonlySet<string>
  toggle: (kind: "folds" | "steps" | "infos" | "rounds", id: string) => void
  expandEarlier: () => void
  toggledRounds: ReadonlySet<number>
  idPrefix: string
}

const markOf = (node: PlanNode, standing: PlanStanding): Mark =>
  node.state === "done" ? "done" : node.state === "skipped" ? "skipped" : node.state === "current" ? (standing === "stopped" ? "stopped" : "current") : "open"

/** A time line for a step's panel: "Started 2:41 PM · Done 2:59 PM · 18 min". */
function timeLine(node: PlanNode): string | null {
  const started = timeOfDay(node.startedAt ?? null)
  const done = timeOfDay(node.doneAt ?? null)
  const took = durationLabel(nodeDuration(node))
  const parts = [started ? `Started ${started}` : null, done ? `Done ${done}` : null, took].filter(Boolean)
  return parts.length ? parts.join(" · ") : null
}

function Label({ id, text, state, unreadable, round, expandable, open, onToggle, panelId }: {
  id: string
  text: string
  state: PlanNode["state"] | "round"
  unreadable?: boolean
  round?: boolean
  expandable: boolean
  open: boolean
  onToggle: () => void
  panelId: string
}) {
  const shared = { "data-state": state, "data-unreadable": unreadable || undefined, "data-round": round || undefined, "data-open": open || undefined, "data-label-for": id }
  if (!expandable) return <span className="plan-label" {...shared}>{text}</span>
  return (
    <button type="button" className="plan-label" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle} {...shared}>
      {text}
    </button>
  )
}

function FoldItem({ fold, ctx }: { fold: PlanFold; ctx: Context }) {
  const spoken = `${fold.count} steps ${fold.foldKind === "toGo" ? "to go" : fold.foldKind === "done" ? "done" : "skipped"}, hidden`
  return (
    <li className="plan-item" data-plan-fold={fold.foldKind}>
      <div className="plan-row">
        <PlanMark mark="fold" />
        <div className="plan-body">
          <button type="button" className="plan-fold" aria-label={`${spoken}. Show them`} onClick={() => ctx.toggle("folds", fold.id)}>
            <span aria-hidden="true">{fold.text}</span>
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      </div>
    </li>
  )
}

function UnreadableItem({ run }: { run: PlanUnreadableRun }) {
  return (
    <li className="plan-item" data-plan-unreadable={run.state} data-tinted={run.state === "done" || undefined}>
      <div className="plan-row">
        <PlanMark mark={run.state === "done" ? "done" : "open"} />
        <div className="plan-body">
          <span className="plan-label" data-state={run.state === "done" ? "done" : "open"} data-unreadable="true">{run.text}</span>
        </div>
      </div>
    </li>
  )
}

function BranchItem({ branch, ctx }: { branch: PlanBranch; ctx: Context }) {
  const { node } = branch
  const mark = markOf(node, ctx.standing)
  const autoOpen = node.state === "current"
  const owned = ctx.steps.has(node.id)
  const time = node.state === "done" ? durationLabel(nodeDuration(node)) : null
  const panelId = `${ctx.idPrefix}-${node.id}-info`
  const info = ctx.infos.has(node.id)
  const note = node.detail
  const times = timeLine(node)
  // A label is always shown whole; the disclosure is only for a detail or times.
  const expandable = Boolean(note || times)
  const shown = node.readable ? node.label : UNREADABLE_LABEL
  const spokenParts = [
    branch.position !== null ? `Step ${branch.position} of ${branch.siblings}` : null,
    node.depth > 0 ? `level ${node.depth + 1}` : null,
  ].filter(Boolean)
  return (
    <li className="plan-item" data-plan-step={node.id} data-state={node.state} data-depth={node.depth} data-tinted={node.state === "done" || undefined}>
      <div className="plan-row">
        <PlanMark mark={mark} />
        <div className="plan-body">
          <span className="sr-only">{spokenParts.join(", ")}{spokenParts.length ? ". " : ""}</span>
          <Label
            id={node.id} text={shown} state={node.state} unreadable={!node.readable} expandable={expandable} open={info}
            onToggle={() => ctx.toggle("infos", node.id)} panelId={panelId}
          />
          <span className="sr-only">
            {`. ${markWord[mark]}`}
            {branch.count ? `, ${branch.count.done} of ${branch.count.total} substeps done` : ""}
            {time ? `, took ${time}` : ""}
          </span>
          {info ? (
            <div className="plan-info" id={panelId}>
              {note ? <p>{note}</p> : null}
              {times ? <p>{times}</p> : null}
            </div>
          ) : null}
        </div>
        <div className="plan-meta">
          {branch.count ? <span aria-hidden="true">{`${branch.count.done}/${branch.count.total}`}</span> : null}
          {time ? <span aria-hidden="true">{time}</span> : null}
          {node.childIds.length > 0 && !autoOpen ? (
            <button
              type="button" className="plan-toggle" aria-expanded={owned}
              aria-label={`${owned ? "Hide" : "Show"} substeps of ${shown}`}
              onClick={() => ctx.toggle("steps", node.id)}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      {branch.opened && branch.children.length ? <PlanItems items={branch.children} ctx={ctx} nested /> : null}
    </li>
  )
}

function PlanItems({ items, ctx, nested = false }: { items: PlanItem[]; ctx: Context; nested?: boolean }) {
  return (
    <ol className={cn("plan-list", nested && "plan-sub")}>
      {rowsOf(items).map((item) =>
        item.kind === "fold" ? <FoldItem key={item.id} fold={item} ctx={ctx} /> : item.kind === "unreadable" ? <UnreadableItem key={item.id} run={item} /> : <BranchItem key={item.id} branch={item} ctx={ctx} />
      )}
    </ol>
  )
}

function RoundItem({ round, ctx }: { round: PlanRound; ctx: Context }) {
  const inPlay = round.n === ctx.outline.currentRound?.n && !round.closed
  const folded = startsFolded(ctx.outline, round) !== ctx.toggledRounds.has(round.n)
  const total = ctx.outline.rounds.length
  const took = durationLabel(roundDuration(round))
  const panelId = `${ctx.idPrefix}-round-${round.n}`
  const spoken = [`Round ${round.n} of ${total}`, round.title, round.closed ? "delivered" : "in progress", round.outcome].filter(Boolean).join(", ")
  const items = folded ? [] : itemsIn(round, { folds: ctx.folds, steps: ctx.steps })
  return (
    <li className="plan-item" data-plan-round={round.n} data-state={round.closed ? "done" : "current"} data-tinted={round.closed || undefined}>
      <div className="plan-row">
        <PlanMark mark={round.closed ? "done" : "current"} round />
        <div className="plan-body">
          {inPlay ? (
            <span className="plan-label" data-state="current" data-round="true"><span className="sr-only">{spoken}</span><span aria-hidden="true">{roundHeading(round)}</span></span>
          ) : (
            <button
              type="button" className="plan-label" data-state="done" data-round="true" aria-expanded={!folded} aria-controls={panelId}
              aria-label={`${spoken}, ${folded ? "collapsed" : "expanded"}`} onClick={() => ctx.toggle("rounds", String(round.n))}
            >
              {roundHeading(round)}
            </button>
          )}
          {round.closed && round.outcome ? <p className="plan-outcome" aria-hidden="true">{round.outcome}</p> : null}
        </div>
        <div className="plan-meta">
          {took ? <span aria-hidden="true">{took}</span> : null}
          {!inPlay ? (
            <button type="button" className="plan-toggle" aria-expanded={!folded} aria-controls={panelId} aria-label={`${folded ? "Show" : "Hide"} the steps of round ${round.n}`} onClick={() => ctx.toggle("rounds", String(round.n))}>
              <ChevronRight aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      <div id={panelId}>{!folded && items.length ? <PlanItems items={items} ctx={ctx} nested /> : null}</div>
    </li>
  )
}

/**
 * The work's plan as an outline, the same tree the iPhone shows (plan 12b): rounds, steps and substeps up to
 * three levels. Only the current step opens (U7); the rest show a count and a chevron. Long plans fold into
 * "5 done" and "6 to go" (4.7), skipped steps hide behind "2 skipped" (U8). Labels take the row's width and wrap
 * (U12); a label this browser cannot open reads "Not readable in this browser", never "Step n".
 *
 * The count is the contracts' plan engine (U1); this component arranges and draws what the server declared.
 */
export function PlanTree({
  entries,
  rounds,
  standing = "moving",
  headingId,
  className,
  serverSteps,
}: {
  /** The count the server computed for this card (top-level steps, current position); counted here only when absent. */
  serverSteps?: { done: number; total: number; currentIndex?: number | undefined } | null | undefined
  entries: PlanEntry[]
  rounds?: PlanRoundInput[] | undefined
  standing?: PlanStanding
  headingId?: string
  className?: string
}) {
  const idPrefix = useId().replaceAll(":", "")
  const [open, setOpen] = useState(() => ({
    folds: new Set<string>(),
    steps: new Set<string>(),
    infos: new Set<string>(),
    rounds: new Set<number>(),
    earlier: false,
  }))
  const shown = useMemo(() => (standing === "stopped" ? unskipped(entries) : entries), [entries, standing])
  const outline = useMemo(() => makeOutline(shown, rounds), [shown, rounds])
  const counted = useMemo(() => progressOf(entries, rounds, standing), [entries, rounds, standing])
  const progress = serverSteps && serverSteps.total > 0 && serverSteps.currentIndex
    ? { ...counted, done: serverSteps.done, total: serverSteps.total, current: serverSteps.currentIndex ?? null,
        currentId: serverSteps.currentIndex ? (counted.currentId ?? "current") : null }
    : counted
  const header = planHeader(progress, standing)

  const ctx: Context = {
    outline,
    standing,
    folds: open.folds,
    steps: open.steps,
    infos: open.infos,
    toggledRounds: open.rounds,
    idPrefix,
    expandEarlier: () => setOpen((state) => ({ ...state, earlier: true })),
    toggle: (kind, id) =>
      setOpen((state) => {
        if (kind === "rounds") {
          const next = new Set(state.rounds)
          const n = Number(id)
          if (next.has(n)) next.delete(n)
          else next.add(n)
          return { ...state, rounds: next }
        }
        const next = new Set(state[kind])
        // A fold only opens: it stands for steps that are not listed.
        if (next.has(id) && kind !== "folds") next.delete(id)
        else next.add(id)
        return { ...state, [kind]: next }
      }),
  }

  if (!outline.currentRound) return null
  const finished = standing === "done"
  return (
    <section aria-labelledby={headingId} className={cn("detail-section plan-tree", className)} data-plan-tree data-flat={outline.isFlat || undefined} data-finished={finished || undefined}>
      <div className="plan-head">
        <h3 id={headingId} className="micro">Plan</h3>
        {header ? <span className="plan-count" data-plan-count>{header}</span> : null}
      </div>
      {outline.hasRoundSections ? (
        <ol className="plan-list">
          {roundSlots(outline, open.earlier).map((slot) =>
            slot.kind === "earlier" ? (
              <li key="earlier" className="plan-item" data-tinted="true" data-plan-earlier>
                <div className="plan-row">
                  <PlanMark mark="fold" />
                  <div className="plan-body">
                    <button type="button" className="plan-fold" aria-label={`${slot.count} earlier rounds, collapsed. Show them`} onClick={ctx.expandEarlier}>
                      <span aria-hidden="true">{`${slot.count} earlier rounds`}</span>
                      <ChevronRight aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </li>
            ) : (
              <RoundItem key={slot.round.n} round={slot.round} ctx={ctx} />
            )
          )}
        </ol>
      ) : (
        <PlanItems items={itemsIn(outline.currentRound, { folds: open.folds, steps: open.steps })} ctx={ctx} />
      )}
    </section>
  )
}
