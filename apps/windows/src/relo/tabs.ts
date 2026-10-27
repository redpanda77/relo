// The open notch's tabs (components/Tabs/TabSelectionView.swift: Relo, System, Music, Shelf). Relo is built here; the
// others are registered by `registerBuiltinTabs` (./builtinTabs.ts) or by anything else that calls `registerTab`:
//
//   registerTab({ id: "system", icon: <GaugeIcon />, view: SystemView })
//
// A view is a React component; `height` is the open notch's height for that tab (System 250, the others 190 on the Mac).
// A tab can hide itself (the Shelf when it is switched off: `boringShelf`) with `visible`, and say when that changes
// with `subscribeVisible`.

import { createElement, type ComponentType, type ReactNode } from "react"
import { TAB_HEIGHT } from "../geometry"

/** What a tab's view may be given; a view that takes no props is fine. */
export interface TabViewProps {
  /** The tab is the one on screen. */
  active?: boolean
  /** The height the tab asks for (CSS px), like the Relo tab's list. */
  onFit?: (height: number) => void
}

export interface TabDefinition {
  /** `relo`, `system`, `home` (Music) or `shelf`; other ids append to the bar. */
  id: string
  /** The tab button's glyph (an SVG that uses currentColor); omitted keeps the built-in one. */
  icon?: ReactNode
  view: ComponentType<TabViewProps>
  label?: string
  /** The notch's open height for this tab, in CSS px. */
  height?: number
  /** False hides the tab from the bar (and from `tabToOpen`); omitted = always shown. */
  visible?: () => boolean
  /** Calls back when `visible()` may have changed; returns the unsubscribe. */
  subscribeVisible?: (cb: () => void) => () => void
}

/** The shape the Shelf's descriptor (shelf/tab.ts) has: `View`, `title`, an SVG path. Accepted by `registerTab` as is. */
export interface DescriptorTab {
  id: string
  View: ComponentType<TabViewProps>
  title?: string
  iconPath?: string
  height?: number
  visible?: (...args: never[]) => boolean
  subscribeVisible?: (cb: () => void) => () => void
}

export interface TabEntry {
  id: string
  label: string
  icon: ReactNode | null
  view: ComponentType<TabViewProps> | null
  height: number
  visible: () => boolean
  subscribeVisible: ((cb: () => void) => () => void) | null
}

/** The Mac's tab order and names (TabSelectionView.tabs). */
export const BUILTIN_TABS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "relo", label: "Relo" },
  { id: "system", label: "System" },
  { id: "home", label: "Music" },
  { id: "shelf", label: "Shelf" },
]

const registry = new Map<string, TabDefinition>()
const listeners = new Set<() => void>()
let version = 0

function pathIcon(d: string): ReactNode {
  return createElement(
    "svg",
    { viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
    createElement("path", { d }),
  )
}

function normalize(tab: TabDefinition | DescriptorTab): TabDefinition {
  if ("view" in tab) return tab
  return {
    id: tab.id,
    view: tab.View,
    ...(tab.title ? { label: tab.title } : {}),
    ...(tab.iconPath ? { icon: pathIcon(tab.iconPath) } : {}),
    ...(tab.height !== undefined ? { height: tab.height } : {}),
    // A descriptor's `visible(settings)` needs the shelf's settings; only a no-argument one is a plain `visible()`.
    ...(tab.visible && tab.visible.length === 0 ? { visible: tab.visible as () => boolean } : {}),
    ...(tab.subscribeVisible ? { subscribeVisible: tab.subscribeVisible } : {}),
  }
}

export function registerTab(input: TabDefinition | DescriptorTab): () => void {
  const tab = normalize(input)
  registry.set(tab.id, tab)
  emit()
  return () => {
    if (registry.get(tab.id) === tab) {
      registry.delete(tab.id)
      emit()
    }
  }
}

function emit(): void {
  version += 1
  tabsCache = null
  listeners.forEach((l) => l())
}

let tabsCache: TabEntry[] | null = null

const ALWAYS = (): boolean => true

/** Built-in tabs in the Mac's order, then any other registered ids in registration order (hidden ones included). */
export function tabs(): TabEntry[] {
  if (tabsCache) return tabsCache
  const entry = (id: string, fallbackLabel: string): TabEntry => {
    const def = registry.get(id)
    return {
      id,
      label: def?.label ?? fallbackLabel,
      icon: def?.icon ?? null,
      view: def?.view ?? null,
      height: def?.height ?? TAB_HEIGHT[id] ?? 190,
      visible: def?.visible ?? ALWAYS,
      subscribeVisible: def?.subscribeVisible ?? null,
    }
  }
  const builtin = BUILTIN_TABS.map((t) => entry(t.id, t.label))
  const extra = [...registry.keys()].filter((id) => !BUILTIN_TABS.some((t) => t.id === id)).map((id) => entry(id, id))
  tabsCache = [...builtin, ...extra]
  return tabsCache
}

/** The tabs the bar shows: `tabs()` without the ones that hide themselves (TabSelectionView: `$0.view != .shelf || boringShelf`). */
export const visibleTabs = (): TabEntry[] => tabs().filter((t) => t.visible())

export const getTab = (id: string): TabEntry | undefined => tabs().find((t) => t.id === id)
export const isTabId = (id: string | null | undefined): id is string => !!id && tabs().some((t) => t.id === id)
export const isTabVisible = (id: string | null | undefined): id is string => !!id && visibleTabs().some((t) => t.id === id)

export function subscribeTabs(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}
export const tabsVersion = (): number => version

/** Calls back when the registry changes or any tab says its visibility did. */
export function subscribeVisibleTabs(cb: () => void): () => void {
  let inner: Array<() => void> = []
  const resubscribe = () => {
    inner.forEach((off) => off())
    inner = tabs().flatMap((t) => (t.subscribeVisible ? [t.subscribeVisible(cb)] : []))
  }
  resubscribe()
  const off = subscribeTabs(() => {
    resubscribe()
    cb()
  })
  return () => {
    off()
    inner.forEach((o) => o())
  }
}

/** A string that changes when the bar's contents do: the snapshot for `useSyncExternalStore`. */
export const visibleTabsKey = (): string => `${version}:${visibleTabs().map((t) => t.id).join(",")}`

/** Test hook. */
export function resetTabs(): void {
  registry.clear()
  emit()
}

/**
 * Which tab opens: the last one when "remember last tab" is on (and it still exists), else Relo
 * (BoringViewModel.close: `if !openLastTabByDefault { currentView = .relo }`).
 */
export function tabToOpen(current: string, remember: boolean, last: string | null): string {
  if (remember && isTabVisible(last)) return last
  return remember && isTabVisible(current) ? current : "relo"
}

/**
 * The tab the notch lands on when it opens or closes (BoringViewModel.close): the Shelf when "open shelf by default" is on
 * and it holds items, even over a remembered tab; else the remembered one; else Relo.
 */
export function tabOnOpen(o: { current: string; remember: boolean; last: string | null; shelfByDefault: boolean }): string {
  if (o.shelfByDefault && isTabVisible("shelf")) return "shelf"
  return tabToOpen(o.current, o.remember, o.last)
}
