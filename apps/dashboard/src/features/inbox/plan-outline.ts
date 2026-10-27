/**
 * A work's plan as the detail page reads it: rounds, each with its steps in pre-order and their depth
 * (plan 12b). Pure display, the Dashboard's copy of the iPhone's PlanOutline: it never decides what is
 * current or delivered, it arranges what the server declared, folds what is long (4.7), hides what is
 * skipped (U8) and opens only the current step (U7). The count (U1) is the contracts' `planProgress`.
 */
import { isPlaceholderLabel } from "@relo/owner-crypto"
import { planProgress, type PlanProgress, type WorkPlan } from "@relo/notification-contracts"

export type PlanStepState = "open" | "current" | "done" | "skipped"

/** One plan step as the server returns it (`activity.plan`), with its label opened when it was sealed. */
export type PlanEntry = {
  id: string
  state: PlanStepState
  label?: string | undefined
  parent?: string | undefined
  round?: number | undefined
  detail?: string | undefined
  startedAt?: string | undefined
  doneAt?: string | undefined
}

export type PlanRoundInput = {
  n: number
  state: "open" | "closed"
  title?: string | undefined
  outcome?: string | undefined
  openedAt?: string | undefined
  closedAt?: string | undefined
}

export type PlanNode = {
  id: string
  /** Empty when this browser could not open the label: it reads `UNREADABLE_LABEL`, never "Step n". */
  label: string
  readable: boolean
  /** A parent's state is derived: it reads as current when the current step is inside it. */
  state: PlanStepState
  detail: string | undefined
  depth: number
  round: number
  childIds: string[]
  startedAt: string | undefined
  doneAt: string | undefined
}

export type PlanRound = {
  n: number
  title: string | undefined
  outcome: string | undefined
  closed: boolean
  openedAt: string | undefined
  closedAt: string | undefined
  nodes: PlanNode[]
}

export const UNREADABLE_LABEL = "Not readable in this browser"

/** More than this many steps in one list are windowed (4.7). */
export const WINDOW_LIMIT = 7
export const WINDOW_BEFORE = 2
export const WINDOW_AFTER = 3

export type PlanOutline = {
  rounds: PlanRound[]
  /** The round shown open: the open one, else the last. */
  currentRound: PlanRound | undefined
  /** The last round is closed: the work waits for the owner (display only). */
  delivered: boolean
  hasRoundSections: boolean
  /** One round, no nesting: the plain list, no round header, no indentation. */
  isFlat: boolean
}

const text = (value: string | undefined) => (value?.trim() ? value : undefined)

function nodesOf(entries: PlanEntry[], round: number): PlanNode[] {
  const depth = new Map<string, number>()
  const children = new Map<string, string[]>()
  for (const entry of entries) {
    // A parent counts only when it appeared earlier in this round (pre-order); else the step stands alone.
    if (entry.parent !== undefined && depth.has(entry.parent)) {
      depth.set(entry.id, depth.get(entry.parent)! + 1)
      children.set(entry.parent, [...(children.get(entry.parent) ?? []), entry.id])
    } else depth.set(entry.id, 0)
  }
  const states = new Map(entries.map((entry) => [entry.id, entry.state] as const))
  const below = (id: string): string[] => (children.get(id) ?? []).flatMap((child) => [child, ...below(child)])
  return entries.map((entry) => {
    const states_ = below(entry.id).map((id) => states.get(id))
    const label = text(entry.label)
    const readable = label !== undefined && !isPlaceholderLabel(label)
    return {
      id: entry.id,
      label: readable ? label : "",
      readable,
      state: states_.includes("current") ? "current" : entry.state,
      detail: text(entry.detail),
      depth: depth.get(entry.id) ?? 0,
      round,
      childIds: children.get(entry.id) ?? [],
      startedAt: entry.startedAt,
      doneAt: entry.doneAt,
    }
  })
}

/**
 * Arranges `entries` (plan order, parents before children) into rounds. `rounds` is the plan's own list
 * (absent: one open round 1).
 */
export function makeOutline(entries: PlanEntry[], rounds?: PlanRoundInput[]): PlanOutline {
  const numbers = new Set<number>(rounds?.map((round) => round.n) ?? [1])
  for (const entry of entries) numbers.add(entry.round ?? 1)
  const declared = new Map((rounds ?? []).map((round) => [round.n, round] as const))
  const built: PlanRound[] = [...numbers].sort((a, b) => a - b).map((n) => {
    const info = declared.get(n)
    return {
      n,
      title: text(info?.title),
      outcome: text(info?.outcome),
      closed: info?.state === "closed",
      openedAt: info?.openedAt,
      closedAt: info?.closedAt,
      nodes: nodesOf(entries.filter((entry) => (entry.round ?? 1) === n), n),
    }
  })
  const currentRound = [...built].reverse().find((round) => !round.closed) ?? built[built.length - 1]
  const hasRoundSections = built.length >= 2
  return {
    rounds: built,
    currentRound,
    delivered: built[built.length - 1]?.closed === true,
    hasRoundSections,
    isFlat: !hasRoundSections && !built.some((round) => round.nodes.some((node) => node.depth > 0)),
  }
}

/** "Round 2 · Fix the login" or "Round 2". */
export const roundHeading = (round: PlanRound) => (round.title ? `Round ${round.n} · ${round.title}` : `Round ${round.n}`)

/** Whether a round starts folded: from two rounds on, every round but the one in play. */
export const startsFolded = (outline: PlanOutline, round: PlanRound) =>
  outline.hasRoundSections && round.n !== outline.currentRound?.n

/** The plan of a work that stopped: steps it never reached are not done and not skipped, so they read as open. */
export function unskipped(entries: PlanEntry[]): PlanEntry[] {
  return entries.map((entry) => (entry.state === "skipped" ? { ...entry, state: "open" as const } : entry))
}

// ---- The one count (U1) ----------------------------------------------------------------------

export type PlanStanding = "moving" | "paused" | "done" | "stopped"

/** The contracts' plan engine over what the page holds: the one counting rule. */
export function progressOf(entries: PlanEntry[], rounds: PlanRoundInput[] | undefined, standing: PlanStanding): PlanProgress {
  const plan: WorkPlan = {
    v: 1,
    next: entries.length + 1,
    steps: entries.map((entry) => ({
      id: entry.id,
      state: entry.state,
      addedIn: 0,
      ...(entry.parent !== undefined ? { parent: entry.parent } : {}),
      ...(entry.round !== undefined ? { round: entry.round } : {}),
      ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
      ...(entry.doneAt !== undefined ? { doneAt: entry.doneAt } : {}),
    })),
    ...(rounds
      ? { rounds: rounds.map((round) => ({ n: round.n, state: round.state, ...(round.openedAt ? { openedAt: round.openedAt } : {}), ...(round.closedAt ? { closedAt: round.closedAt } : {}) })) }
      : {}),
  }
  return planProgress(plan, { stopped: standing === "stopped" })
}

/** The plan card's header (U3): the count while moving; the state's own words otherwise. Empty without steps. */
export function planHeader(progress: PlanProgress, standing: PlanStanding = "moving"): string {
  if (progress.state === "empty") return ""
  const count = `${progress.done} of ${progress.total}`
  if (standing === "paused") return `Paused at ${count}`
  if (standing === "done") return `${count} done`
  if (standing === "stopped") return `Stopped at ${count}`
  if (progress.delivered) return `Round ${progress.round} delivered`
  const moving = progress.current !== null && progress.currentId !== null ? `Step ${progress.current} of ${progress.total}` : count
  return progress.rounds >= 2 ? `Round ${progress.round} · ${moving}` : moving
}

// ---- Structure to draw (U6, U7, U8, 4.7) --------------------------------------------------------

export type PlanCount = { done: number; total: number }

/** A step with the steps it opens onto. A branch draws its own rail through its opened children (U11). */
export type PlanBranch = {
  kind: "branch"
  id: string
  node: PlanNode
  /** Its children are listed (the current step, or opened by the owner). */
  opened: boolean
  /** Done of total over its direct children, skipped left out; null without children. */
  count: PlanCount | null
  children: PlanItem[]
  /** Its place among its siblings ("step 2 of 4"), skipped ones left out; null for a skipped step. */
  position: number | null
  siblings: number
}

export type FoldKind = "done" | "toGo" | "skipped"
/** "5 done", "6 to go" or "2 skipped": one quiet row standing for steps not listed. */
export type PlanFold = { kind: "fold"; id: string; foldKind: FoldKind; count: number; text: string }
export type PlanItem = PlanBranch | PlanFold

export const foldText = (foldKind: FoldKind, count: number) =>
  foldKind === "toGo" ? `${count} to go` : `${count} ${foldKind === "done" ? "done" : "skipped"}`

export type PlanOpenState = {
  /** Fold ids the owner opened. */
  folds?: ReadonlySet<string>
  /** Steps the owner opened on top of the current one. */
  steps?: ReadonlySet<string>
}

/** The items of `round` (its top-level steps), folded as 4.7 says. */
export function itemsIn(round: PlanRound, open: PlanOpenState = {}): PlanItem[] {
  const byId = new Map(round.nodes.map((node) => [node.id, node] as const))
  return itemsOf(round.nodes.filter((node) => node.depth === 0), `r${round.n}`, byId, open)
}

function itemsOf(siblings: PlanNode[], key: string, byId: Map<string, PlanNode>, open: PlanOpenState): PlanItem[] {
  const live = siblings.filter((node) => node.state !== "skipped")
  const skipped = siblings.filter((node) => node.state === "skipped")
  const branch = (node: PlanNode): PlanBranch => {
    const kids = node.childIds.flatMap((id) => byId.get(id) ?? [])
    const liveKids = kids.filter((kid) => kid.state !== "skipped")
    const opened = node.state === "current" || (open.steps?.has(node.id) ?? false)
    const place = live.findIndex((sibling) => sibling.id === node.id)
    return {
      kind: "branch",
      id: node.id,
      node,
      opened: opened && kids.length > 0,
      count: liveKids.length ? { done: liveKids.filter((kid) => kid.state === "done").length, total: liveKids.length } : null,
      children: opened ? itemsOf(kids, node.id, byId, open) : [],
      position: place >= 0 ? place + 1 : null,
      siblings: live.length,
    }
  }
  const result: PlanItem[] = []
  if (live.length > WINDOW_LIMIT) {
    const focus = Math.max(0, live.findIndex((node) => node.state === "current") >= 0
      ? live.findIndex((node) => node.state === "current")
      : live.findIndex((node) => node.state === "open") >= 0 ? live.findIndex((node) => node.state === "open") : live.length - 1)
    let start = Math.max(0, focus - WINDOW_BEFORE)
    let end = Math.min(live.length, focus + 1 + WINDOW_AFTER)
    if (start < 2) start = 0 // never fold a single step
    if (live.length - end < 2) end = live.length
    if (start > 0) {
      const id = `${key}:done`
      if (open.folds?.has(id)) start = 0
      else result.push({ kind: "fold", id, foldKind: "done", count: start, text: foldText("done", start) })
    }
    const tailId = `${key}:toGo`
    const tailOpen = open.folds?.has(tailId) ?? false
    if (tailOpen) end = live.length
    result.push(...live.slice(start, end).map(branch))
    if (end < live.length) result.push({ kind: "fold", id: tailId, foldKind: "toGo", count: live.length - end, text: foldText("toGo", live.length - end) })
  } else result.push(...live.map(branch))
  if (skipped.length) {
    const id = `${key}:skipped`
    if (open.folds?.has(id)) result.push(...skipped.map(branch))
    else result.push({ kind: "fold", id, foldKind: "skipped", count: skipped.length, text: foldText("skipped", skipped.length) })
  }
  return result
}

/** A run of sibling steps whose names this browser cannot open (U8): one quiet row, not one placeholder each. */
export type PlanUnreadableRun = { kind: "unreadable"; id: string; state: "done" | "open"; count: number; text: string }
export type PlanRow = PlanItem | PlanUnreadableRun

/**
 * Two or more consecutive sibling steps that are unreadable, have no children and share the state done or open
 * read as one row ("2 done · names not readable in this browser"); a single unreadable step stays its own row.
 */
export function rowsOf(items: PlanItem[]): PlanRow[] {
  const rows: PlanRow[] = []
  let run: PlanBranch[] = []
  const flush = () => {
    const first = run[0]
    if (run.length >= 2 && first) {
      const state = first.node.state === "done" ? "done" : "open"
      rows.push({ kind: "unreadable", id: `unreadable-${first.id}`, state, count: run.length, text: `${run.length} ${state === "done" ? "done" : "to go"} · names ${UNREADABLE_LABEL.replace("Not readable", "not readable")}` })
    } else rows.push(...run)
    run = []
  }
  for (const item of items) {
    if (item.kind === "branch" && !item.node.readable && item.node.childIds.length === 0 && (item.node.state === "done" || item.node.state === "open")) {
      if (run.length && run[run.length - 1]!.node.state !== item.node.state) flush()
      run.push(item)
    } else {
      flush()
      rows.push(item)
    }
  }
  flush()
  return rows
}

// ---- Rounds to draw (4.7) ----------------------------------------------------------------------

export type RoundSlot = { kind: "earlier"; count: number } | { kind: "round"; round: PlanRound }

/** More than three rounds: the last two stay as rows, the earlier ones fold into "n earlier rounds". */
export function roundSlots(outline: PlanOutline, earlierExpanded: boolean): RoundSlot[] {
  const rows = (rounds: PlanRound[]): RoundSlot[] => rounds.map((round) => ({ kind: "round", round }))
  if (outline.rounds.length <= 3 || earlierExpanded) return rows(outline.rounds)
  return [{ kind: "earlier", count: outline.rounds.length - 2 }, ...rows(outline.rounds.slice(-2))]
}

// ---- Words ------------------------------------------------------------------------------------

/** "4 min", "1 h 5 min", "2 h", "1 d 3 h": a duration as a row's trailing meta. Null under a minute. */
export function durationLabel(seconds: number | null | undefined): string | null {
  if (seconds == null || !(seconds >= 60)) return null
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours >= 24) return `${Math.floor(hours / 24)} d${hours % 24 > 0 ? ` ${hours % 24} h` : ""}`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

export function secondsBetween(from: string | undefined, to: string | undefined): number | null {
  if (!from || !to) return null
  const value = (new Date(to).valueOf() - new Date(from).valueOf()) / 1000
  return Number.isFinite(value) && value >= 0 ? value : null
}

export const nodeDuration = (node: PlanNode) => secondsBetween(node.startedAt, node.doneAt)
export const roundDuration = (round: PlanRound) => secondsBetween(round.openedAt, round.closedAt)

/** The page's plan: the server's `plan` and `rounds`, else the flat `stepItems` of an older card. */
export function planEntries(activity: {
  plan?: PlanEntry[] | undefined
  stepItems?: Array<{ label: string; state: string }> | undefined
}): PlanEntry[] {
  if (activity.plan?.length) return activity.plan
  return (activity.stepItems ?? []).map((item, index) => ({
    id: `s${index + 1}`,
    label: item.label,
    state: item.state === "complete" || item.state === "done" ? "done" : item.state === "current" || item.state === "active" ? "current" : item.state === "skipped" ? "skipped" : "open",
  }))
}
