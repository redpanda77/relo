// The plan as the Mac draws it. Ports apps/ios/Sources/ReloCore/PlanProgress.swift (PlanProgress.lineParts, PlanBar)
// and PlanOutline.swift (rounds, nested steps, folds, windowing). Pure display: it arranges what the server declared
// and decides nothing (which step is current, whether a round is delivered all come from the server's plan).

import type { PlanDigestRound, PlanDigestStep } from "@relo/notification-contracts"

export type StepState = "complete" | "current" | "skipped" | "pending"

// MARK: Plan line and bar

/** How the work stands as far as the plan line is concerned. */
export type Standing = "moving" | "paused" | "done" | "stopped"

/** "Step 3 of 5 · Run the gates", "Paused at 2 of 5", "5 of 5 done", "Stopped at 3 of 5" (rule U2). Null without steps. */
export function planLine(done: number, total: number, label: string | null | undefined, standing: Standing): string | null {
  const d = Math.max(0, done)
  const t = Math.max(0, total)
  if (t <= 0) return null
  switch (standing) {
    case "paused":
      return `Paused at ${d} of ${t}`
    case "done":
      return `${d} of ${t} done`
    case "stopped":
      return `Stopped at ${d} of ${t}`
    case "moving": {
      if (d >= t) return `${d} of ${t} done`
      const clean = label?.trim() ? label.trim() : null
      // A current step without its position is the one after the done ones: still "Step N of M", never a bare count.
      const position = clean === null ? null : Math.min(d + 1, t)
      const lead = position === null ? `${d} of ${t}` : `Step ${position} of ${t}`
      return [lead, clean].filter((part) => part !== null).join(" · ")
    }
  }
}

export interface BarSegment {
  state: "done" | "current" | "open"
  /** 1 for a finished step, 0 for one not started, the step's fraction for the current one. */
  fill: number
}

/**
 * The plan bar from the server's counts alone: one segment per top-level step, `done` finished ones filling the
 * segments around the current one, the rest not started. Nothing is invented without a position from the server.
 */
export function planBar(done: number, total: number, current: number | null | undefined, fill: number | null | undefined): BarSegment[] {
  const n = Math.max(0, total)
  const currentIndex = (current ?? 0) - 1
  let remaining = Math.max(0, done)
  return Array.from({ length: n }, (_, index): BarSegment => {
    if (done >= n) return { state: "done", fill: 1 }
    if (index === currentIndex) return { state: "current", fill: fill ?? 0 }
    if (remaining > 0) {
      remaining -= 1
      return { state: "done", fill: 1 }
    }
    return { state: "open", fill: 0 }
  })
}

// MARK: Outline

export interface PlanNode {
  id: string
  label: string
  /** False when the label is sealed or private: it reads "Not readable", never "Step n". */
  readable: boolean
  state: StepState
  detail: string | null
  depth: number
  round: number
  parent: string | null
  childIds: string[]
  descendantCount: number
  branchFinished: boolean
  startedAt: number | null
  doneAt: number | null
  carriedFrom: number | null
}

export interface PlanRoundOutline {
  n: number
  title: string | null
  outcome: string | null
  closed: boolean
  openedAt: number | null
  closedAt: number | null
  nodes: PlanNode[]
}

export interface PlanOutline {
  rounds: PlanRoundOutline[]
}

export const UNREADABLE_LABEL = "Not readable here"

export function roundHeading(round: PlanRoundOutline): string {
  return round.title ? `Round ${round.n} · ${round.title}` : `Round ${round.n}`
}

export function nodeShownLabel(node: PlanNode): string {
  return node.readable ? node.label : UNREADABLE_LABEL
}

export const hasRoundSections = (outline: PlanOutline): boolean => outline.rounds.length >= 2
export const outlineNodes = (outline: PlanOutline): PlanNode[] => outline.rounds.flatMap((round) => round.nodes)
/** The round shown open: the last open one, else the last. */
export function currentRound(outline: PlanOutline): PlanRoundOutline | undefined {
  return [...outline.rounds].reverse().find((round) => !round.closed) ?? outline.rounds.at(-1)
}
/** The last round is closed: the work waits for the owner (display only; the server decides attention). */
export const isDelivered = (outline: PlanOutline): boolean => outline.rounds.at(-1)?.closed === true
/** Closed rounds fold to one row; the open (or last) round is expanded. */
export function startsFolded(outline: PlanOutline, round: PlanRoundOutline): boolean {
  return hasRoundSections(outline) && round.n !== currentRound(outline)?.n
}
/** The step the work is on, anywhere in the plan. */
export function currentLeaf(outline: PlanOutline): PlanNode | undefined {
  const round = currentRound(outline)
  if (!round) return undefined
  return [...round.nodes].reverse().find((node) => node.state === "current" && node.childIds.length === 0)
    ?? round.nodes.find((node) => node.state === "current")
}

const toState = (state: PlanDigestStep["state"]): StepState =>
  state === "done" ? "complete" : state === "current" ? "current" : state === "skipped" ? "skipped" : "pending"

const time = (value: string | undefined): number | null => {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function buildNodes(entries: Array<Omit<PlanNode, "depth" | "childIds" | "descendantCount" | "branchFinished" | "parent"> & { parent: string | null }>): PlanNode[] {
  const depth = new Map<string, number>()
  const children = new Map<string, string[]>()
  for (const entry of entries) {
    // A parent counts only when it appeared earlier in this round (pre-order); else the step stands alone.
    if (entry.parent !== null && depth.has(entry.parent)) {
      depth.set(entry.id, depth.get(entry.parent)! + 1)
      children.set(entry.parent, [...(children.get(entry.parent) ?? []), entry.id])
    } else {
      depth.set(entry.id, 0)
    }
  }
  const states = new Map(entries.map((entry) => [entry.id, entry.state] as const))
  const descendants = (id: string): string[] => (children.get(id) ?? []).flatMap((child) => [child, ...descendants(child)])
  return entries.map((entry) => {
    const below = descendants(entry.id)
    const belowStates = below.flatMap((id) => (states.has(id) ? [states.get(id)!] : []))
    const state: StepState = belowStates.includes("current") ? "current" : entry.state
    const finished = below.length > 0 && belowStates.every((s) => s === "complete" || s === "skipped")
    const hasParent = entry.parent !== null && depth.has(entry.parent)
    return {
      ...entry,
      state,
      depth: depth.get(entry.id) ?? 0,
      parent: hasParent ? entry.parent : null,
      childIds: children.get(entry.id) ?? [],
      descendantCount: below.length,
      branchFinished: finished,
    }
  })
}

/**
 * A Now item's plan as rounds and nested steps: states and structure from the server's `plan` and `rounds`; labels
 * from the server for a readable work (null when sealed or private). Null without steps.
 */
export function makeOutline(plan: readonly PlanDigestStep[] | undefined, rounds: readonly PlanDigestRound[] | undefined): PlanOutline | null {
  if (!plan || plan.length === 0) return null
  const entries = plan.map((step, index) => {
    const label = step.label && !/^Step \d+$/.test(step.label) ? step.label : null
    return {
      id: step.id,
      label: label ?? `Step ${index + 1}`,
      readable: label !== null,
      state: toState(step.state),
      detail: step.detail ?? null,
      parent: step.parent ?? null,
      round: step.round ?? 1,
      startedAt: time(step.startedAt),
      doneAt: time(step.doneAt),
      carriedFrom: step.carriedFrom ?? null,
    }
  })
  const declared = new Map((rounds ?? []).map((round) => [round.n, round] as const))
  const numbers = new Set<number>(rounds ? rounds.map((round) => round.n) : [1])
  for (const entry of entries) numbers.add(entry.round)
  return {
    rounds: [...numbers].sort((a, b) => a - b).map((n): PlanRoundOutline => {
      const info = declared.get(n)
      return {
        n,
        title: info?.title ?? null,
        outcome: info?.outcome ?? null,
        closed: info?.state === "closed",
        openedAt: time(info?.openedAt),
        closedAt: time(info?.closedAt),
        nodes: buildNodes(entries.filter((entry) => entry.round === n)),
      }
    }),
  }
}

// MARK: Structure to draw (U6, U7, U8, 4.7)

export interface Branch {
  kind: "branch"
  node: PlanNode
  /** Its children are listed (the current step, or opened by the owner). */
  opened: boolean
  /** Done of total over its direct children, skipped left out; null without children. */
  count: { done: number; total: number } | null
  children: PlanItem[]
  /** Its place among its siblings, skipped ones left out. */
  position: number | null
  siblings: number
}

/** "5 done", "6 to go" or "2 skipped": one quiet row standing for steps not listed. */
export interface Fold {
  kind: "fold"
  id: string
  foldKind: "done" | "toGo" | "skipped"
  count: number
}

export type PlanItem = Branch | Fold

export const foldText = (fold: Fold): string => (fold.foldKind === "toGo" ? `${fold.count} to go` : `${fold.count} ${fold.foldKind === "done" ? "done" : "skipped"}`)
export const itemId = (item: PlanItem): string => (item.kind === "branch" ? item.node.id : item.id)

/** More than this many steps in one list are windowed. */
export const WINDOW_LIMIT = 7
/** How many finished steps stay listed before the current one, and how many upcoming ones after it. */
export const WINDOW_BEFORE = 2
export const WINDOW_AFTER = 3

export interface ItemOptions {
  /** Fold ids the owner opened. */
  expandedFolds?: ReadonlySet<string>
  /** Steps the owner opened on top of the current one. */
  openedSteps?: ReadonlySet<string>
}

/** The items of `round` (its top-level steps), folded as 4.7 says. */
export function itemsIn(round: PlanRoundOutline, options: ItemOptions = {}): PlanItem[] {
  const byId = new Map(round.nodes.map((node) => [node.id, node] as const))
  return itemsOf(round.nodes.filter((node) => node.depth === 0), `r${round.n}`, byId, options.expandedFolds ?? new Set(), options.openedSteps ?? new Set())
}

function itemsOf(siblings: PlanNode[], key: string, byId: Map<string, PlanNode>, expandedFolds: ReadonlySet<string>, openedSteps: ReadonlySet<string>): PlanItem[] {
  const liveSiblings = siblings.filter((node) => node.state !== "skipped")
  const branch = (node: PlanNode): Branch => {
    const place = liveSiblings.findIndex((s) => s.id === node.id)
    const kids = node.childIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
    const live = kids.filter((kid) => kid.state !== "skipped")
    const opened = node.state === "current" || openedSteps.has(node.id)
    return {
      kind: "branch",
      node,
      opened: opened && kids.length > 0,
      count: live.length === 0 ? null : { done: live.filter((kid) => kid.state === "complete").length, total: live.length },
      children: opened ? itemsOf(kids, node.id, byId, expandedFolds, openedSteps) : [],
      position: place >= 0 ? place + 1 : null,
      siblings: liveSiblings.length,
    }
  }
  const skipped = siblings.filter((node) => node.state === "skipped")
  let result: PlanItem[] = []
  if (liveSiblings.length > WINDOW_LIMIT) {
    const focusAt = liveSiblings.findIndex((n) => n.state === "current")
    const pendingAt = liveSiblings.findIndex((n) => n.state === "pending")
    const focus = focusAt >= 0 ? focusAt : pendingAt >= 0 ? pendingAt : liveSiblings.length - 1
    let start = Math.max(0, focus - WINDOW_BEFORE)
    let end = Math.min(liveSiblings.length, focus + 1 + WINDOW_AFTER)
    if (start < 2) start = 0 // never fold a single step
    if (liveSiblings.length - end < 2) end = liveSiblings.length
    if (start > 0) {
      const fold: Fold = { kind: "fold", id: `${key}:done`, foldKind: "done", count: start }
      if (expandedFolds.has(fold.id)) start = 0
      else result.push(fold)
    }
    const tail: Fold | null = end < liveSiblings.length ? { kind: "fold", id: `${key}:toGo`, foldKind: "toGo", count: liveSiblings.length - end } : null
    if (tail && expandedFolds.has(tail.id)) end = liveSiblings.length
    result = [...result, ...liveSiblings.slice(start, end).map(branch)]
    if (tail && end < liveSiblings.length) result.push(tail)
  } else {
    result = liveSiblings.map(branch)
  }
  if (skipped.length > 0) {
    const fold: Fold = { kind: "fold", id: `${key}:skipped`, foldKind: "skipped", count: skipped.length }
    if (expandedFolds.has(fold.id)) result = [...result, ...skipped.map(branch)]
    else result.push(fold)
  }
  return result
}

/** More than three rounds: the last two stay as rows, the earlier ones fold into "n earlier rounds". */
export type RoundSlot = { kind: "earlier"; count: number } | { kind: "round"; round: PlanRoundOutline }
export function roundSlots(outline: PlanOutline, earlierExpanded: boolean): RoundSlot[] {
  if (outline.rounds.length <= 3 || earlierExpanded) return outline.rounds.map((round) => ({ kind: "round", round }))
  return [{ kind: "earlier", count: outline.rounds.length - 2 }, ...outline.rounds.slice(-2).map((round): RoundSlot => ({ kind: "round", round }))]
}

/** "4 min", "1 h 5 min", "2 h": a duration as a row's trailing meta. Null under a minute. */
export function durationLabel(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || seconds < 60) return null
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours >= 24) return `${Math.floor(hours / 24)} d` + (hours % 24 > 0 ? ` ${hours % 24} h` : "")
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}
