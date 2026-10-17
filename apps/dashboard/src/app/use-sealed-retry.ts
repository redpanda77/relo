import * as React from "react"

import type { DashboardBootstrap } from "@/app/bootstrap"
import { accountIdOf, openSealedBootstrap } from "@/app/sealed-bootstrap"
import { currentBrowserLink } from "@/lib/e2ee/browser-link"
import { hasLockedItems } from "@/lib/e2ee/open-sealed"
import { setSealedOpening } from "@/lib/sealed-opening"

/**
 * The page opens its sealed text in place, never by reloading. The moment this browser becomes
 * linked (a phone scanned its QR code) the page on screen opens what it can: sealed text shows
 * "Opening" and then fades into the real words, like WhatsApp Web filling in once linked. Computers
 * start sealing for a newly linked browser at their next command, so a page that still holds sealed
 * items tries again a few times soon after, and when the tab becomes visible. Bounded, so items sealed
 * before the link (readable only on the iPhone) never keep the page polling.
 */
export const SEALED_RETRY_MS = [4_000, 12_000, 30_000]
const VISIBLE_RETRY_GAP_MS = 15_000

export function useSealedRetry(bootstrap: DashboardBootstrap, apply: (opened: DashboardBootstrap) => void) {
  React.useEffect(() => {
    const link = currentBrowserLink()
    if (!link || link.accountId !== accountIdOf(bootstrap)) return
    let cancelled = false
    let running = false
    let attempt = 0
    let lastRun = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      const delay = SEALED_RETRY_MS[attempt++]
      if (delay !== undefined) timer = setTimeout(() => void run(), delay)
    }
    const run = async (rescheduling = true, announce = false) => {
      clearTimeout(timer)
      if (cancelled || running) return
      if (document.visibilityState === "hidden" || !link.isLinked()) {
        if (rescheduling) schedule()
        return
      }
      running = true
      lastRun = Date.now()
      if (announce) setSealedOpening(true)
      try {
        const opened = await openSealedBootstrap(bootstrap)
        if (cancelled) return
        if (opened !== bootstrap) return apply(opened)
      } finally {
        running = false
        if (announce) setSealedOpening(false)
      }
      if (rescheduling) schedule()
    }
    // Linked while this page is open: open it now (the page may hold sealed names with no flag).
    let wasLinked = link.isLinked()
    const unsubscribe = link.subscribe(() => {
      const linked = link.isLinked()
      if (linked && !wasLinked) {
        attempt = 0
        void run(true, true)
      }
      wasLinked = linked
    })
    const locked = hasLockedItems(bootstrap)
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRun >= VISIBLE_RETRY_GAP_MS) void run(false)
    }
    if (locked) {
      document.addEventListener("visibilitychange", onVisible)
      schedule()
    }
    return () => {
      cancelled = true
      clearTimeout(timer)
      unsubscribe()
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [bootstrap, apply])
}
