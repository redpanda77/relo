import { useEffect, useMemo, useSyncExternalStore } from "react"

import { browserLinkFor, type BrowserLink, type BrowserLinkState } from "@/lib/e2ee/browser-link"

const UNAVAILABLE: BrowserLinkState = { status: "unavailable" }
const noop = () => () => undefined

/** This tab's browser link for the account (or the one given, in tests) and its live state. */
export function useBrowserLink(accountId: string, link?: BrowserLink | null) {
  const resolved = useMemo(() => (link === undefined ? browserLinkFor(accountId) : link), [accountId, link])
  const state = useSyncExternalStore(resolved?.subscribe ?? noop, resolved?.getState ?? (() => UNAVAILABLE))
  useEffect(() => {
    void resolved?.start()
  }, [resolved])
  return { link: resolved, state }
}

