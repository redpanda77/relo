import { WifiOff } from "lucide-react"
import * as React from "react"

import { AnimatedHeight } from "@/components/atoms/animated-height"
import { SpinnerArc, SystemButton, SystemCard } from "@/components/molecules/system-card"
import { PendingDeviceCards, usePendingDeviceCards } from "@/features/pending-devices/pending-devices"
import { SECTION_CAPTION_CLASS } from "@/components/list"

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })

/** Holds `value` true for at least `ms` once it turns true, so a quick retry does not flicker. */
function useHeld(value: boolean, ms: number): boolean {
  const [held, setHeld] = React.useState(value)
  React.useEffect(() => {
    if (value) {
      setHeld(true)
      return
    }
    const timer = window.setTimeout(() => setHeld(false), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return value || held
}

/** The server cannot be reached: what the cards show is last known. Retry fetches again. */
export function OfflineCard({ since, onRetry }: { since?: number; onRetry: () => void }) {
  return (
    <SystemCard
      tone="yellow"
      edge
      role="status"
      icon={<WifiOff />}
      eyebrow={since ? `OFFLINE · SINCE ${CLOCK.format(new Date(since)).toUpperCase()}` : "OFFLINE"}
      title="Your server is out of reach"
      actions={
        <SystemButton primary onClick={onRetry}>
          Retry
        </SystemButton>
      }
    >
      Cards show what was last known. Answers wait and send when it&rsquo;s back.
    </SystemCard>
  )
}

/** A refetch is in flight after being offline. No queue is claimed: the dashboard has none. */
export function ReconnectingCard() {
  return (
    <SystemCard tone="cyan" role="status" icon={<SpinnerArc />} eyebrow="RECONNECTING" title="Catching up with your server">
      Trying your server again.
    </SystemCard>
  )
}

/**
 * SYSTEM, at the top of Now: what is wrong with Relo itself (the server is out of reach, a new device
 * asks to join), as system cards under a SYSTEM caption. It takes no room while nothing is wrong.
 */
export function NowSystem({ offline, syncing, syncedAt, onRetry }: { offline: boolean; syncing: boolean; syncedAt?: number; onRetry: () => void }) {
  const { shown, onDenied } = usePendingDeviceCards()
  const reconnecting = useHeld(offline && syncing, 900)
  const show = offline || shown.length > 0
  return (
    <AnimatedHeight show={show}>
      <section aria-labelledby="now-system" className="now-section space-y-2.5" data-now-system>
        <h2 id="now-system" className={SECTION_CAPTION_CLASS}>
          System
        </h2>
        <div className="grid gap-3">
          {offline ? reconnecting ? <ReconnectingCard /> : <OfflineCard since={syncedAt} onRetry={onRetry} /> : null}
          {shown.length ? (
            <div role="status" aria-label="New devices waiting for approval">
              <PendingDeviceCards devices={shown} onDenied={onDenied} />
            </div>
          ) : null}
        </div>
      </section>
    </AnimatedHeight>
  )
}
