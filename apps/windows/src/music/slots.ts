// Slot configuration (MusicSlotConfigurationView.swift, MusicControlButton.swift): five slots, each a control or empty.
// Dropping a palette control onto a slot clears that control's other slot; dragging a slot onto another swaps them;
// dropping a slot on the trash clears it.

import { CONTROLS, DEFAULT_SLOTS, SLOT_COUNT, type MusicControl } from "./types"

export const MIN_SLOTS = 3
export const MAX_SLOTS = 5

/** What the palette offers (MusicControlButton.pickerOptions). */
export const PICKER_OPTIONS: MusicControl[] = ["shuffle", "previous", "playPause", "next", "repeatMode", "favorite", "volume", "goBackward", "goForward"]

export const LABELS: Record<MusicControl, string> = {
  shuffle: "Shuffle",
  previous: "Previous",
  playPause: "Play/Pause",
  next: "Next",
  repeatMode: "Repeat",
  volume: "Volume",
  favorite: "Favorite",
  goBackward: "Backward 15s",
  goForward: "Forward 15s",
  none: "Empty slot",
}

export function isControl(v: string): v is MusicControl {
  return (CONTROLS as readonly string[]).includes(v)
}

/** Exactly `limit` slots (3..5): padded with empty slots, or cut. */
export function activeSlots(slots: readonly MusicControl[], limit: number = SLOT_COUNT): MusicControl[] {
  const n = Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, Math.round(limit)))
  const out = slots.slice(0, n)
  while (out.length < n) out.push("none")
  return out
}

function ensure(slots: readonly MusicControl[]): MusicControl[] {
  return activeSlots(slots, SLOT_COUNT)
}

/** Put `control` into slot `index`; if it sits in another slot, that one is cleared. */
export function placeControl(slots: readonly MusicControl[], control: MusicControl, index: number): MusicControl[] {
  const out = ensure(slots)
  if (index < 0 || index >= out.length) return out
  if (control !== "none") {
    const at = out.indexOf(control)
    if (at >= 0 && at !== index) out[at] = "none"
  }
  out[index] = control
  return out
}

export function swapSlots(slots: readonly MusicControl[], from: number, to: number): MusicControl[] {
  const out = ensure(slots)
  if (from < 0 || to < 0 || from >= out.length || to >= out.length) return out
  ;[out[from], out[to]] = [out[to], out[from]]
  return out
}

export function clearSlot(slots: readonly MusicControl[], index: number): MusicControl[] {
  const out = ensure(slots)
  if (index >= 0 && index < out.length) out[index] = "none"
  return out
}

/** Tapping a palette control fills the first empty slot, or replaces slot 0 when all are full (as the Mac does). */
export function addControl(slots: readonly MusicControl[], control: MusicControl): MusicControl[] {
  const out = ensure(slots)
  const empty = out.indexOf("none")
  return placeControl(out, control, empty >= 0 ? empty : 0)
}

export type DropPayload = { kind: "slot"; index: number } | { kind: "control"; control: MusicControl }

/** The drag payload strings the Mac uses: `slot:<index>` and `control:<rawValue>`. */
export function encodeDrop(p: DropPayload): string {
  return p.kind === "slot" ? `slot:${p.index}` : `control:${p.control}`
}

export function decodeDrop(raw: string): DropPayload | null {
  if (raw.startsWith("slot:")) {
    const i = Number(raw.slice(5))
    return Number.isInteger(i) && i >= 0 && i < SLOT_COUNT ? { kind: "slot", index: i } : null
  }
  if (raw.startsWith("control:")) {
    const c = raw.slice(8)
    return isControl(c) ? { kind: "control", control: c } : null
  }
  return null
}

export function applyDrop(slots: readonly MusicControl[], raw: string, toIndex: number): MusicControl[] {
  const p = decodeDrop(raw)
  if (!p) return ensure(slots)
  return p.kind === "slot" ? swapSlots(slots, p.index, toIndex) : placeControl(slots, p.control, toIndex)
}

export function applyTrashDrop(slots: readonly MusicControl[], raw: string): MusicControl[] {
  const p = decodeDrop(raw)
  return p?.kind === "slot" ? clearSlot(slots, p.index) : ensure(slots)
}

export const resetSlots = (): MusicControl[] => [...DEFAULT_SLOTS]
