import { Lock } from "lucide-react"
import type * as React from "react"

import { ENCRYPTED_TEXT } from "@/lib/encrypted"
import { cn } from "@/lib/utils"

/** A lock and "End-to-end encrypted · open on iPhone to read": shown where sealed text would be. */
export function EncryptedText({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} data-encrypted="true">
      <Lock className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{ENCRYPTED_TEXT}</span>
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
