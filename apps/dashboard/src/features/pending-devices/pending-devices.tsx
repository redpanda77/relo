import { Smartphone } from "lucide-react"

import { Notice } from "@/components/molecules/notice"
import { PresenceList } from "@/components/molecules/presence-list"
import { relativeTime } from "@/lib/format"
import { usePendingDevices, type PendingDevice } from "@/features/pending-devices/pending-devices-data"

function PendingDeviceLines({ devices }: { devices: PendingDevice[] }) {
  return (
    <PresenceList label="Devices waiting" items={devices} getKey={(device) => device.deviceId} className="grid gap-2" itemClassName="text-sm leading-6">
      {(device) => (
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
              or in Relo on your iPhone → Settings → Devices.
            </span>
          </span>
      )}
    </PresenceList>
  )
}

/**
 * The Now page's notice; approving happens in Account → Devices (from a linked browser) or on a
 * trusted phone. It opens in place when a device starts waiting and closes when none is left.
 */
export function PendingDevicesNotice({ variant = "banner" }: { variant?: "banner" | "card" }) {
  const devices = usePendingDevices()
  return (
    <Notice
      show={devices.length > 0}
      role="status"
      aria-label="New devices waiting for approval"
      tone="orange"
      icon={<Smartphone />}
      title={variant === "card" ? "Devices waiting for approval" : undefined}
    >
      <PendingDeviceLines devices={devices} />
    </Notice>
  )
}
