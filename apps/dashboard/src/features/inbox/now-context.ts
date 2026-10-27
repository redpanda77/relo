import * as React from "react"

import type { WorkActions } from "@/features/inbox/end-work"
import type { NowItem } from "@/features/inbox/now-model"
import type { NowPlace } from "@/features/inbox/now-events"
import type { WorkTone } from "@/lib/work-outcome"

/**
 * What Now's lists share while the page lives, all display only (the server's summary stays the
 * one source of what is where):
 * - ready: false for the page's first paint, true after it, so a section or item that mounts later
 *   animates in and the first paint stays still;
 * - items/places: the latest copy of every item and the list it is in, so a card that is already
 *   leaving can show what became of it (finished, moved into a fold) and leave accordingly;
 * - announce: items that just came to need the owner (one ring each, then gone);
 * - openId: the item whose detail sheet is open, ringed while it is;
 * - tones: the tone each card last showed, so a card the server moves to another list (Running to
 *   Needs you) arrives in its old tone and crossfades in place (written by the cards, display only);
 * - offline: the last refetch failed, so live work is the last known state ("Unconfirmed", as on
 *   the iPhone), not a claim that it is still running;
 * - links: the notifications that carry a link (a small mark on their card, "Has a link");
 * - actions: the owner's End and Dismiss on a card; null where the page offers none.
 */
export type NowStage = {
  ready: boolean
  items: ReadonlyMap<string, NowItem>
  places: ReadonlyMap<string, NowPlace>
  isFoldOpen: (fold: string) => boolean
  announce: ReadonlySet<string>
  openId: string | null
  tones: Map<string, WorkTone>
  offline: boolean
  /** Work id → the session that holds it, so a card names the session it runs in (iOS sessionsByWork). */
  sessionByWork: ReadonlyMap<string, { id: string; computer: string | null }>
  links: ReadonlySet<string>
  actions: WorkActions | null
}

const EMPTY_ITEMS: ReadonlyMap<string, NowItem> = new Map()
const EMPTY_PLACES: ReadonlyMap<string, NowPlace> = new Map()
const EMPTY_IDS: ReadonlySet<string> = new Set()

export const NOW_STAGE_DEFAULT: NowStage = {
  ready: false,
  items: EMPTY_ITEMS,
  places: EMPTY_PLACES,
  isFoldOpen: () => false,
  announce: EMPTY_IDS,
  openId: null,
  tones: new Map(),
  offline: false,
  sessionByWork: new Map(),
  links: EMPTY_IDS,
  actions: null,
}

export const NowStageContext = React.createContext<NowStage>(NOW_STAGE_DEFAULT)

export function useNowStage() {
  return React.useContext(NowStageContext)
}
