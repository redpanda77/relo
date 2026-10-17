import * as React from "react"

/**
 * One hover highlight per frosted list that glides from row to row instead of each row lighting
 * up on its own (`GlideHighlight` draws it). Only a fine hovering pointer gets it: touch keeps the
 * rows' own pressed state. A list calls `useGlideList()` and shares it with `GlideProvider`; each
 * row calls `useGlideRow()`.
 */
export type Glide = {
  id: string
  row: string | null
  visible: boolean
  /** The highlight is appearing (fade in) rather than moving from another row. */
  fresh: boolean
  enter(row: string): void
}

export const GlideContext = React.createContext<Glide | null>(null)

const FINE_POINTER = "(hover: hover) and (pointer: fine)"

function useFinePointer() {
  const [fine, setFine] = React.useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia(FINE_POINTER).matches : false
  )
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const media = window.matchMedia(FINE_POINTER)
    const update = () => setFine(media.matches)
    media.addEventListener?.("change", update)
    return () => media.removeEventListener?.("change", update)
  }, [])
  return fine
}

/** A list's glide: share `value` with `GlideProvider` and put `onPointerLeave` on the list. */
export function useGlideList() {
  const id = React.useId()
  const fine = useFinePointer()
  const [state, setState] = React.useState<{ row: string | null; visible: boolean; fresh: boolean }>({
    row: null,
    visible: false,
    fresh: true,
  })
  const timer = React.useRef<number | undefined>(undefined)
  React.useEffect(() => () => window.clearTimeout(timer.current), [])
  const enter = React.useCallback((row: string) => {
    window.clearTimeout(timer.current)
    setState((current) =>
      current.row === row && current.visible
        ? current
        : { row, visible: true, fresh: current.row === null || !current.visible }
    )
  }, [])
  // The highlight fades out in 120 ms, then lets go of its row so the next entry fades in in place.
  const onPointerLeave = React.useCallback(() => {
    setState((current) => (current.row ? { ...current, visible: false } : current))
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState({ row: null, visible: false, fresh: true }), 140)
  }, [])
  const value = React.useMemo<Glide | null>(
    () => (fine ? { id, ...state, enter } : null),
    [fine, id, state, enter]
  )
  return { value, onPointerLeave }
}

/**
 * A row's part of the glide: spread `onPointerEnter` on its interactive element (which must be
 * `relative isolate`) and render `<GlideHighlight row={row} />` inside it. Inert outside a gliding list.
 */
export function useGlideRow() {
  const glide = React.useContext(GlideContext)
  const row = React.useId()
  const onPointerEnter = React.useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType === "mouse") glide?.enter(row)
    },
    [glide, row]
  )
  return { row, gliding: Boolean(glide), onPointerEnter: glide ? onPointerEnter : undefined }
}
