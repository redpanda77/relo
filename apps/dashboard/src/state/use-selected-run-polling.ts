import * as React from "react"

import type { LiveRunStatus, TestLabService } from "@/services/test-lab-service"

export function useSelectedRunPolling({ runId, active, service, onStatus }: { runId?: string; active: boolean; service: TestLabService; onStatus: (status: LiveRunStatus) => void }) {
  const [error, setError] = React.useState<string | null>(null)
  const [visible, setVisible] = React.useState(() => document.visibilityState !== "hidden")
  const onStatusRef = React.useRef(onStatus)
  React.useEffect(() => { onStatusRef.current = onStatus }, [onStatus])

  React.useEffect(() => {
    const handleVisibility = () => setVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", handleVisibility)
    return () => document.removeEventListener("visibilitychange", handleVisibility)
  }, [])

  React.useEffect(() => {
    if (!runId || !active || !visible) return
    let stopped = false
    let timer: number | undefined
    let controller: AbortController | undefined
    const poll = async () => {
      controller = new AbortController()
      try {
        const status = await service.getRunStatus(runId, controller.signal)
        if (stopped) return
        onStatusRef.current(status)
        setError(null)
        if (status.state !== "active") return
      } catch (cause) {
        if (stopped || (cause instanceof DOMException && cause.name === "AbortError")) return
        setError(cause instanceof Error ? cause.message : "Could not refresh this run.")
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), 3_000)
    }
    void poll()
    return () => {
      stopped = true
      controller?.abort()
      if (timer) window.clearTimeout(timer)
    }
  }, [active, runId, service, visible])

  return { error }
}
