// The open notch's header row (components/Notch/BoringHeader.swift + Tabs/TabSelectionView.swift + TabButton.swift):
// the tabs on the left (each an icon, 15 pt either side, 26 pt tall; the selected one on a capsule that slides between
// tabs, a matched-geometry move on `.smooth`), the notch's own width in the middle (the Mac's hardware notch; clear on a
// PC), and the settings gear on the right (a 30 pt black capsule).

import { motion } from "motion/react"
import { useSyncExternalStore } from "react"
import { CLOSED } from "../../../geometry"
import { showsTabs } from "../../notchState"
import { subscribeVisibleTabs, visibleTabs, visibleTabsKey, type TabEntry } from "../../tabs"
import { COLORS } from "../theme"
import { GearIcon, DEFAULT_TAB_ICONS } from "./TabIcons"
import { SPRINGS } from "./tokens"

/** `Color(nsColor: .secondarySystemFill)` in dark mode. */
export const TAB_FILL = "rgb(120 120 128 / 0.32)"

export interface HeaderProps {
  current: string
  onSelect: (id: string) => void
  onSettings?: () => void
  /** Reduce Motion: the capsule jumps instead of sliding. */
  reduceMotion?: boolean
  /** "Always show tabs" off: the tab row shows only when there is more than one tab (relo/notchState.showsTabs). */
  alwaysShowTabs?: boolean
}

export function useTabs() {
  useSyncExternalStore(subscribeVisibleTabs, visibleTabsKey)
  return visibleTabs()
}

export function Header(props: HeaderProps) {
  return <HeaderView {...props} list={useTabs()} />
}

/** The header for a given list of tabs (no store: the part the tests draw). */
export function HeaderView({ current, onSelect, onSettings, reduceMotion = false, alwaysShowTabs = true, list }: HeaderProps & { list: TabEntry[] }) {
  const tabsShown = showsTabs({ alwaysShowTabs, tabCount: list.length })
  return (
    <div className="ro-header" style={{ gridTemplateColumns: `1fr ${CLOSED.w}px 1fr` }}>
      <div className="ro-tabs" role="tablist">
        {(tabsShown ? list : []).map((tab) => {
          const selected = tab.id === current
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={tab.label}
              title={tab.label}
              className="ro-tab"
              style={{ color: selected ? "#fff" : "rgb(142 142 147)" }}
              onClick={() => onSelect(tab.id)}
            >
              {selected && (
                <motion.span layoutId="ro-tab-capsule" className="ro-tab-capsule" style={{ background: TAB_FILL }} transition={reduceMotion ? { duration: 0 } : SPRINGS.tab} />
              )}
              <span className="ro-tab-icon">{tab.icon ?? DEFAULT_TAB_ICONS[tab.id] ?? <span className="text-[10px]">{tab.label.slice(0, 1)}</span>}</span>
            </button>
          )
        })}
      </div>
      <div aria-hidden />
      <div className="ro-header-right">
        {onSettings && (
          <button type="button" className="ro-gear" aria-label="Settings" title="Settings" onClick={onSettings} style={{ color: COLORS.secondaryText }}>
            <GearIcon />
          </button>
        )}
      </div>
    </div>
  )
}
