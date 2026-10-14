import { Smartphone } from "lucide-react"

import { relativeTime } from "@/lib/format"
import { usePendingDevices, type PendingDevice } from "@/features/pending-devices/pending-devices-data"

function PendingDeviceLines({ devices }: { devices: PendingDevice[] }) {
  return (
    <ul className="grid gap-2">
      {devices.map((device) => (
        <li key={device.deviceId} className="flex items-start gap-2 text-sm leading-6">
          <Smartphone className="mt-1 size-4 shrink-0 text-[var(--status-warning)]" aria-hidden="true" />
          <span>
            <span className="font-medium text-foreground">
              {device.name}
              {device.modelName && device.modelName !== device.name ? ` (${device.modelName})` : ""} wants to read your Relo cards
            </span>
            <span className="text-muted-foreground">
              , signed in <time dateTime={device.registeredAt}>{relativeTime(device.registeredAt)}</time>.{" "}
              <a href="/dashboard/account#devices" className="text-primary underline-offset-4 hover:underline">
                Approve or decline it in Devices
              </a>{" "}
              or in Relo on your iPhone → Settings → Security.
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The Now page's notice; approving happens in Account → Devices (from a linked browser) or on a trusted phone. */
export function PendingDevicesNotice({ variant = "banner" }: { variant?: "banner" | "card" }) {
  const devices = usePendingDevices()
  if (devices.length === 0) return null
  return (
    <section
      aria-label="New devices waiting for approval"
      role="status"
      className={variant === "banner" ? "glass mb-6 rounded-2xl p-4" : "rounded-2xl border bg-card p-5"}
    >
      {variant === "card" ? <h2 className="mb-3 text-base font-semibold">Devices waiting for approval</h2> : null}
      <PendingDeviceLines devices={devices} />
    </section>
  )
}
