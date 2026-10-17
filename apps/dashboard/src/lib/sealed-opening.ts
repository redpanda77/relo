/**
 * Whether this browser is still opening the page's sealed text. A linked browser opens it a moment
 * after the page appears: until then (and for at most a few seconds) sealed text is "opening", not
 * "open on iPhone", which would be untrue for a browser that can read it. `app/sealed-bootstrap.ts`
 * sets it; an unlinked browser never enters it.
 */
let opening = false
const listeners = new Set<() => void>()

export function setSealedOpening(value: boolean) {
  if (opening === value) return
  opening = value
  for (const listener of listeners) listener()
}

export function isSealedOpening() {
  return opening
}

export function subscribeSealedOpening(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}



/**
 * Whether this browser is linked (a hint set by `app/sealed-bootstrap.ts`). Sealed text a linked
 * browser could not open was sealed before it was linked, so it says that instead of sending the
 * owner to the iPhone as if the browser were never linked.
 */
let linkedBrowser = false
const linkedListeners = new Set<() => void>()

export function setBrowserLinked(value: boolean) {
  if (linkedBrowser === value) return
  linkedBrowser = value
  for (const listener of linkedListeners) listener()
}

export function isBrowserLinked() {
  return linkedBrowser
}

export function subscribeBrowserLinked(listener: () => void) {
  linkedListeners.add(listener)
  return () => {
    linkedListeners.delete(listener)
  }
}
