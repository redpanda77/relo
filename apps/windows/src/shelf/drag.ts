// What the page knows about a drag coming in: Rust (the OLE drop target) tells it, the page only highlights.
import type { DragZone, ShelfDragEvent } from "./types"

export interface DragState {
  over: boolean
  zone: DragZone | null
  /** Items taken by the last drop (the panel flashes it briefly). */
  lastAdded: number
}

export const IDLE_DRAG: DragState = { over: false, zone: null, lastAdded: 0 }

export function reduceDrag(s: DragState, e: ShelfDragEvent): DragState {
  switch (e.phase) {
    case "enter":
    case "over":
      return s.over && s.zone === e.zone ? s : { over: true, zone: e.zone, lastAdded: 0 }
    case "leave":
      return { ...IDLE_DRAG }
    case "drop":
      return { over: false, zone: null, lastAdded: e.added }
  }
}
