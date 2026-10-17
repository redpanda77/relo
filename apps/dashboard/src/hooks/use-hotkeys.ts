import * as React from "react"

/** A chord ("g" then a key) must finish within this time. */
export const CHORD_TIMEOUT_MS = 1000

export type Hotkeys = {
  /** "g" then the key: the jumps. */
  chords?: Record<string, () => void>
  /** Single keys without modifiers ("?"). */
  keys?: Record<string, () => void>
  /** ⌘ on Apple devices, Ctrl elsewhere, plus the key ("k"). */
  mod?: Record<string, () => void>
}

/** Typing in a field, a select or an editable region never triggers a shortcut. */
export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return /^(input|textarea|select)$/iu.test(target.tagName)
}

/**
 * The dashboard's keyboard shortcuts. `g` starts a one-second chord (`g h` opens History), single
 * keys answer only without modifiers, and ⌘/Ctrl shortcuts work everywhere, fields included.
 */
export function useHotkeys(hotkeys: Hotkeys, enabled = true) {
  const latest = React.useRef(hotkeys)
  React.useEffect(() => {
    latest.current = hotkeys
  })

  React.useEffect(() => {
    if (!enabled) return
    let chordUntil = 0
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const { chords = {}, keys = {}, mod = {} } = latest.current
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key

      if (event.metaKey || event.ctrlKey) {
        const action = !event.altKey && !event.shiftKey ? mod[key] : undefined
        if (action) {
          event.preventDefault()
          action()
        }
        return
      }
      if (event.altKey || isTypingTarget(event.target)) return

      if (chordUntil > Date.now()) {
        chordUntil = 0
        const action = chords[key]
        if (action) {
          event.preventDefault()
          action()
        }
        return
      }
      if (key === "g" && !event.shiftKey && Object.keys(chords).length > 0) {
        chordUntil = Date.now() + CHORD_TIMEOUT_MS
        return
      }
      const action = keys[event.key]
      if (action) {
        event.preventDefault()
        action()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled])
}
