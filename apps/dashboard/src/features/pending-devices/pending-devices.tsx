import { Smartphone } from "lucide-react"
import { useState } from "react"

import { AnimatedHeight } from "@/components/atoms/animated-height"
import { PresenceList } from "@/components/molecules/presence-list"
import { SystemButton, SystemCard } from "@/components/molecules/system-card"
import { createHttpDevicesService } from "@/features/devices/devices-service"
import { usePendingDevices, type PendingDevice } from "@/features/pending-devices/pending-devices-data"

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })

const eyebrowOf = (device: PendingDevice) => (/ipad/i.test(`${device.modelName ?? ""} ${device.model ?? ""}`) ? "NEW DEVICE" : "NEW PHONE")

/**
 * One device asking to read the owner's cards, as a system card (the iPhone's new-computer card):
 * Review opens Account → Devices, where approving happens (a linked browser or a trusted phone signs
 * it); Deny declines it right here.
 */
function PendingDeviceCard({ device, onDenied }: { device: PendingDevice; onDenied: (deviceId: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const asked = Number.isNaN(Date.parse(device.registeredAt)) ? null : CLOCK.format(new Date(device.registeredAt))
  const deny = () => {
    setBusy(true)
    setError(null)
    createHttpDevicesService()
      .remove({ id: device.deviceId, kind: "phone" })
      .then(() => onDenied(device.deviceId))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not decline it."))
      .finally(() => setBusy(false))
  }
  return (
    <SystemCard
      tone="orange"
      edge
      icon={<Smartphone />}
      eyebrow={eyebrowOf(device)}
      title={`${device.name} wants to join`}
      actions={
        <>
          <SystemButton primary href="/dashboard/account#devices">
            Review
          </SystemButton>
          <SystemButton disabled={busy} onClick={deny}>
            {busy ? "Denying…" : "Deny"}
          </SystemButton>
        </>
      }
    >
      {asked ? <>Asked at <time dateTime={device.registeredAt}>{asked}</time>.</> : null}
      {error ? <span className="block text-destructive">{error}</span> : null}
    </SystemCard>
  )
}

/** The new-device cards for the devices given; `onDenied` is told which one was declined. */
export function PendingDeviceCards({ devices, onDenied }: { devices: PendingDevice[]; onDenied: (deviceId: string) => void }) {
  return (
    <PresenceList label="Devices waiting" items={devices} getKey={(device) => device.deviceId} className="grid gap-3">
      {(device) => <PendingDeviceCard device={device} onDenied={onDenied} />}
    </PresenceList>
  )
}

/** The pending devices not yet declined here, and the way to decline one. */
export function usePendingDeviceCards() {
  const devices = usePendingDevices()
  const [denied, setDenied] = useState<ReadonlySet<string>>(new Set())
  const shown = devices.filter((device) => !denied.has(device.deviceId))
  return { shown, onDenied: (id: string) => setDenied((prev) => new Set(prev).add(id)) }
}

/**
 * The new-device cards on their own (approving happens in Account → Devices from a linked browser,
 * or on a trusted phone). They open in place when a device starts waiting and close when none is left.
 */
export function PendingDevicesNotice(_props: { variant?: "banner" | "card" }) {
  const { shown, onDenied } = usePendingDeviceCards()
  return (
    <AnimatedHeight show={shown.length > 0}>
      <div role="status" aria-label="New devices waiting for approval">
        <PendingDeviceCards devices={shown} onDenied={onDenied} />
      </div>
    </AnimatedHeight>
  )
}
