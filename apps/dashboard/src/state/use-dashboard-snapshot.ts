import * as React from "react"

import type { InboxService, InboxSnapshot } from "@/services/inbox-service"

export function useDashboardSnapshot(
  service: InboxService,
  intervalMs = 15_000
) {
  const [snapshot, setSnapshot] = React.useState<InboxSnapshot | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const request = React.useRef<AbortController | null>(null)

  React.useEffect(() => {
    let mounted = true
    const refresh = async () => {
      if (document.visibilityState !== "visible" || request.current) return
      const controller = new AbortController()
      request.current = controller
      try {
        const next = await service.getSnapshot(controller.signal)
        if (mounted) {
          setSnapshot((current) =>
            !current || next.revision >= current.revision ? next : current
          )
          setError(null)
        }
      } catch (cause) {
        if (mounted && !controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Dashboard totals could not be refreshed."
          )
        }
      } finally {
        if (request.current === controller) request.current = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    const timer = window.setInterval(() => void refresh(), intervalMs)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      mounted = false
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
      request.current?.abort()
    }
  }, [intervalMs, service])

  return { snapshot, error }
}
