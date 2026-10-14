import { useEffect, useState } from "react"

/** One row of `GET /api/dashboard/pending-devices`: a phone waiting for approval. */
export type PendingDevice = {
  deviceId: string
  name: string
  model?: string | null
  /** "iPhone 17 Pro", or "Simulator". */
  modelName?: string | null
  isSimulator?: boolean
  registeredAt: string
  keyId: string
}

export const PENDING_DEVICES_PATH = "/api/dashboard/pending-devices"
export const PENDING_DEVICES_POLL_MS = 60_000

/** `null` means the list is unavailable for good (older server, or signed out): stop asking. */
export async function fetchPendingDevices(signal?: AbortSignal): Promise<PendingDevice[] | null> {
  const response = await fetch(PENDING_DEVICES_PATH, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
    signal,
  })
  if (response.status === 401 || response.status === 404) return null
  if (!response.ok) throw new Error(`Request failed (${response.status}).`)
  const payload = (await response.json()) as { devices?: unknown }
  if (!Array.isArray(payload?.devices)) return []
  return payload.devices.filter(
    (device): device is PendingDevice =>
      typeof device === "object" &&
      device !== null &&
      typeof (device as PendingDevice).deviceId === "string" &&
      typeof (device as PendingDevice).name === "string" &&
      typeof (device as PendingDevice).registeredAt === "string"
  )
}

/** Loads on mount, then every minute while the page is visible. Errors keep the last list. */
export function usePendingDevices(intervalMs = PENDING_DEVICES_POLL_MS) {
  const [devices, setDevices] = useState<PendingDevice[]>([])
  useEffect(() => {
    let active = true
    let stopped = false
    let inFlight: AbortController | null = null
    const refresh = async () => {
      if (stopped || inFlight || document.visibilityState === "hidden") return
      const controller = new AbortController()
      inFlight = controller
      try {
        const next = await fetchPendingDevices(controller.signal)
        if (!active) return
        if (next === null) {
          stopped = true
          setDevices([])
        } else {
          setDevices(next)
        }
      } catch {
        // Transient failure: keep what is shown and try again on the next tick.
      } finally {
        if (inFlight === controller) inFlight = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), intervalMs)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
      inFlight?.abort()
    }
  }, [intervalMs])
  return devices
}
