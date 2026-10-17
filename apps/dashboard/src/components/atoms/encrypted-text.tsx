import { Lock } from "lucide-react"
import * as React from "react"

import { ENCRYPTED_TEXT, SEALED_BEFORE_LINK_TEXT } from "@/lib/encrypted"
import { isBrowserLinked, isSealedOpening, subscribeBrowserLinked, subscribeSealedOpening } from "@/lib/sealed-opening"
import { cn } from "@/lib/utils"

/**
 * A lock and "End-to-end encrypted · open on iPhone to read": shown where sealed text would be.
 * While a linked browser is opening it, a placeholder line with the lock instead, saying "Opening on
 * this device" once the wait is noticeable (loading.css times the words).
 */
export function EncryptedText({ className }: { className?: string }) {
  const isOpening = React.useSyncExternalStore(subscribeSealedOpening, isSealedOpening, () => false)
  const linked = React.useSyncExternalStore(subscribeBrowserLinked, isBrowserLinked, () => false)
  if (isOpening)
    return (
      <span
        className={cn("sealed-opening inline-flex min-w-0 items-center gap-1.5", className)}
        data-encrypted="opening"
      >
        <Lock className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="sealed-opening-slot">
          <span className="sealed-opening-line skeleton" aria-hidden="true" />
          <span className="sealed-opening-words min-w-0">Opening on this device</span>
        </span>
      </span>
    )
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} data-encrypted="true">
      <Lock className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{linked ? SEALED_BEFORE_LINK_TEXT : ENCRYPTED_TEXT}</span>
    </span>
  )
}

/** The sealed placeholder or the readable text, whichever applies. */
export function MaybeEncrypted({
  encrypted,
  children,
  className,
}: {
  encrypted: boolean | undefined
  children: React.ReactNode
  className?: string
}) {
  return encrypted ? <EncryptedText className={className} /> : <>{children}</>
}
