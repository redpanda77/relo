// The System tab descriptor. Registration (one line, wherever the notch builds its tab list; with
// src/relo/tabs.ts that is `registerTab(systemTab)`):
//
//   import { systemTab } from "./system"
//
// The notch shows `systemTab.view` in its 640x250 content area while the tab is selected; the view samples only
// while mounted. The tab is a Mac extra, so a build that omits it just does not register it.

import type { ComponentType } from "react"
import { SystemView } from "./SystemView"

export interface TabDescriptor {
  id: string
  /** The tab bar glyph (16 px, `currentColor`). */
  icon: ComponentType
  view: ComponentType
}

/** The Mac's `cpu` symbol. */
function SystemIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
      <rect x="3.5" y="3.5" width="9" height="9" rx="2" />
      <rect x="6" y="6" width="4" height="4" rx="0.8" fill="currentColor" stroke="none" />
      <path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" />
    </svg>
  )
}

export const systemTab: TabDescriptor = { id: "system", icon: SystemIcon, view: SystemView }
export { SystemView }
