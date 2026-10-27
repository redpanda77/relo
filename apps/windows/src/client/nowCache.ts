// The last Now this PC read from Relo on this PC, kept so the notch draws at once at the next launch (the Mac's NowCache,
// ReloNotchKit LocalMode.swift). Local mode only: its cards are never sealed, so the server's own answer is safe to keep. It is
// ignored when it is older than ten minutes (a card that stopped long ago is never shown as running) or dated in the future.
//
// Variant: the Mac keeps a 0600 file in Application Support; here it is a record in the app's own webview storage
// (%LOCALAPPDATA%\<app id>\EBWebView, readable only by this Windows user), which needs no extra Rust command.

import { nowSummarySchema, type NowSummary } from "@relo/notification-contracts"
import type { PrefsStore } from "@relo/owner-client"

export const NOW_CACHE_KEY = "relo.nowCache"
/** `NowCache.maxAge`: 600 s. */
export const NOW_CACHE_MAX_AGE_MS = 600_000
/** A cache dated more than a minute ahead of the clock is not trusted. */
const FUTURE_SLACK_MS = 60_000

export async function saveNowCache(prefs: PrefsStore, summary: NowSummary, now: number): Promise<void> {
  try {
    await prefs.set(NOW_CACHE_KEY, JSON.stringify({ at: now, summary }))
  } catch {
    // A full or blocked store only means the next launch waits for the server.
  }
}

/** The cached Now, or null when there is none, it is too old, from the future, or not a Now. */
export async function loadNowCache(prefs: PrefsStore, now: number): Promise<NowSummary | null> {
  try {
    const text = await prefs.get(NOW_CACHE_KEY)
    if (!text) return null
    const stored = JSON.parse(text) as { at?: unknown; summary?: unknown }
    if (typeof stored.at !== "number" || now - stored.at > NOW_CACHE_MAX_AGE_MS || stored.at > now + FUTURE_SLACK_MS) return null
    const parsed = nowSummarySchema.safeParse(stored.summary)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function clearNowCache(prefs: PrefsStore): Promise<void> {
  try {
    await prefs.delete(NOW_CACHE_KEY)
  } catch {
    // nothing to clear
  }
}
