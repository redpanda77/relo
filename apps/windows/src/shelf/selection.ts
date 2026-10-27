// Selection, as ShelfSelectionModel.swift: click selects one, Ctrl toggles, Shift selects a range from the anchor.

export interface Selection {
  ids: ReadonlySet<string>
  anchor: string | null
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null }

export const selectSingle = (id: string): Selection => ({ ids: new Set([id]), anchor: id })

export function toggle(sel: Selection, id: string): Selection {
  const ids = new Set(sel.ids)
  if (ids.has(id)) ids.delete(id)
  else ids.add(id)
  return { ids, anchor: id }
}

/** Everything between the anchor and `id` in shelf order; without a usable anchor it is a single selection. */
export function selectRange(sel: Selection, id: string, order: readonly string[]): Selection {
  const anchor = sel.anchor ?? [...sel.ids][0] ?? id
  const a = order.indexOf(anchor)
  const b = order.indexOf(id)
  if (a < 0 || b < 0) return selectSingle(id)
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return { ids: new Set(order.slice(lo, hi + 1)), anchor }
}

export function selectAll(order: readonly string[]): Selection {
  return { ids: new Set(order), anchor: order[0] ?? null }
}

/** Forget ids that left the shelf. */
export function prune(sel: Selection, order: readonly string[]): Selection {
  const live = new Set(order)
  const ids = new Set([...sel.ids].filter((i) => live.has(i)))
  if (ids.size === sel.ids.size && (sel.anchor === null || live.has(sel.anchor))) return sel
  return { ids, anchor: sel.anchor && live.has(sel.anchor) ? sel.anchor : ([...ids][0] ?? null) }
}

export interface ClickModifiers {
  shift: boolean
  /** Ctrl, or Cmd on a Mac keyboard. */
  toggle: boolean
}

/** A click on an item. A plain click on a selected item keeps the selection (it may start dragging all of it). */
export function click(sel: Selection, id: string, order: readonly string[], m: ClickModifiers): Selection {
  if (m.shift) return selectRange(sel, id, order)
  if (m.toggle) return toggle(sel, id)
  return sel.ids.has(id) ? sel : selectSingle(id)
}

/** What a drag from `id` carries: the whole selection when `id` is in it, else just `id` (in shelf order). */
export function dragIds(sel: Selection, id: string, order: readonly string[]): string[] {
  if (sel.ids.size > 1 && sel.ids.has(id)) return order.filter((i) => sel.ids.has(i))
  return [id]
}
