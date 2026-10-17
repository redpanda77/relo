import * as React from "react"

/**
 * A value that saves as it is chosen: `commit` applies it first and puts the old value back if the server
 * refuses it; `preview` shows a value without saving it yet; `replace` takes one confirmed elsewhere.
 */
export type SavedStatus = { state: "idle" } | { state: "saving" } | { state: "saved"; message: string } | { state: "error"; message: string }

export type Saved<Value> = {
  value: Value
  status: SavedStatus
  /** Show the value now without saving it yet (a color being dragged). */
  preview(next: Value): void
  /** Show it now and save it; on a refusal the previous value comes back and the error shows. */
  commit(next: Value, message?: string): void
  /** Take a value the server confirmed elsewhere (after "Use account defaults"). */
  replace(next: Value): void
}

export function useSaved<Value>(initial: Value, save: (next: Value) => Promise<void>): Saved<Value> {
  const [value, setValue] = React.useState(initial)
  const [status, setStatus] = React.useState<SavedStatus>({ state: "idle" })
  const confirmed = React.useRef(initial)
  const latest = React.useRef(0)
  const saveRef = React.useRef(save)
  React.useEffect(() => {
    saveRef.current = save
  })
  const commit = React.useCallback((next: Value, message = "Saved") => {
    const run = ++latest.current
    setValue(next)
    setStatus({ state: "saving" })
    saveRef.current(next).then(
      () => {
        confirmed.current = next
        if (run === latest.current) setStatus({ state: "saved", message })
      },
      (cause) => {
        if (run !== latest.current) return
        setValue(confirmed.current)
        setStatus({ state: "error", message: cause instanceof Error ? cause.message : "Relo could not save this. Try again." })
      }
    )
  }, [])
  const preview = React.useCallback((next: Value) => setValue(next), [])
  const replace = React.useCallback((next: Value) => {
    latest.current += 1
    confirmed.current = next
    setValue(next)
    setStatus({ state: "idle" })
  }, [])
  return { value, status, preview, commit, replace }
}

