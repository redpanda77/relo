// What the open notch's views need to know about where Relo runs: on this PC (local: no account, no server, no iPhone) or
// against a server. The Mac reads `store.isLocal` and `store.dashboardURL` from its store (ReloNotchView.swift); here
// the notch provides them once and the cards, the panel and the answer bar read them. The words that depend on it are
// pure functions (relo/ui/words.ts).

import { createContext, useContext } from "react"

export interface ReloMode {
  /** Relo runs on this PC (local mode). */
  local: boolean
  /** Opens the server's Dashboard; null in local mode or when no server is known (the link is then not drawn). */
  openDashboard: (() => void) | null
  /** Opens Relo's Home window ("+N more" in local mode, "Open Relo" on the sign-in panel). */
  openHome: () => void
}

export const SERVER_MODE: ReloMode = { local: false, openDashboard: null, openHome: () => {} }

export const ReloModeContext = createContext<ReloMode>(SERVER_MODE)
export const useReloMode = (): ReloMode => useContext(ReloModeContext)

/** The server's Dashboard page for an origin (S15: `<origin>/dashboard`), or null without one. */
export function dashboardUrl(origin: string | null | undefined): string | null {
  if (!origin) return null
  return `${origin.replace(/\/+$/, "")}/dashboard`
}
