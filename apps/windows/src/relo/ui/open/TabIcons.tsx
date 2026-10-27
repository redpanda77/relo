// Stand-ins for the tab bar's SF Symbols (circle.hexagongrid.fill, gauge.with.dots.needle.50percent,
// music.note.house.fill, tray.fill) and the settings gear. 16-unit viewBox, currentColor.

import type { ReactNode } from "react"

function Svg({ size = 14, children }: { size?: number; children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="currentColor">
      {children}
    </svg>
  )
}

/** circle.hexagongrid.fill: a disc with a hexagon of dots knocked out. */
export const ReloTabIcon = (
  <Svg>
    <path fillRule="evenodd" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM8 3.4l1.9 1.1v2.2L8 7.8 6.1 6.7V4.5L8 3.4Zm-3.6 4.6 1.9 1.1v2.2l-1.9 1.1-1.9-1.1V9.1L4.4 8Zm7.2 0 1.9 1.1v2.2l-1.9 1.1-1.9-1.1V9.1L11.6 8Z" />
  </Svg>
)

/** gauge: a dial with a needle. */
export const SystemTabIcon = (
  <Svg>
    <path fillRule="evenodd" d="M8 2a7 7 0 0 0-7 7c0 1.3.35 2.5.97 3.5h12.06A6.96 6.96 0 0 0 15 9a7 7 0 0 0-7-7Zm.6 2.6.2 4.5a.9.9 0 1 1-1.5.1L8.6 4.6Z" />
  </Svg>
)

/** music.note.house.fill */
export const MusicTabIcon = (
  <Svg>
    <path d="M8 1.2 1.2 6.6v7.6c0 .4.3.7.7.7h12.2c.4 0 .7-.3.7-.7V6.6L8 1.2Zm1.7 4.3v4.2a1.5 1.5 0 1 1-1-1.4V6.3l-2.4.6v3.9a1.5 1.5 0 1 1-1-1.4V6.2c0-.2.2-.4.4-.5l3.4-.9c.3 0 .6.2.6.5Z" />
  </Svg>
)

/** tray.fill */
export const ShelfTabIcon = (
  <Svg>
    <path d="M3.2 2h9.6c.7 0 1.3.5 1.4 1.2L15 8.5V13c0 .6-.4 1-1 1H2c-.6 0-1-.4-1-1V8.5l.8-5.3C1.9 2.5 2.5 2 3.2 2Zm-.5 6.2h2.5a.8.8 0 0 1 .8.8 2 2 0 0 0 4 0c0-.5.4-.8.8-.8h2.5l-.5-3.8H3.2L2.7 8.2Z" />
  </Svg>
)

export const GearIcon = ({ size = 15 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="currentColor">
    <path fillRule="evenodd" d="M7 1h2l.4 1.7c.4.1.8.3 1.1.5l1.5-.9 1.4 1.4-.9 1.5c.2.3.4.7.5 1.1L15 7v2l-1.7.4c-.1.4-.3.8-.5 1.1l.9 1.5-1.4 1.4-1.5-.9c-.3.2-.7.4-1.1.5L9 15H7l-.4-1.7c-.4-.1-.8-.3-1.1-.5l-1.5.9-1.4-1.4.9-1.5c-.2-.3-.4-.7-.5-1.1L1 9V7l1.7-.4c.1-.4.3-.8.5-1.1l-.9-1.5 1.4-1.4 1.5.9c.3-.2.7-.4 1.1-.5L7 1Zm1 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" />
  </svg>
)

export const DEFAULT_TAB_ICONS: Record<string, ReactNode> = { relo: ReloTabIcon, system: SystemTabIcon, home: MusicTabIcon, shelf: ShelfTabIcon }
