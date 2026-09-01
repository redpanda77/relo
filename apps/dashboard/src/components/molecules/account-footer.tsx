import { LogOut } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import type { TestLabBootstrap } from "@/features/test-lab/types"

export function AccountFooter({ account }: { account: TestLabBootstrap["shell"]["account"] }) {
  const [pending, setPending] = React.useState(false)
  const signOut = async () => {
    setPending(true)
    try {
      const response = await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      if (!response.ok) throw new Error("Sign out failed")
      window.location.assign("/")
    } finally { setPending(false) }
  }
  return (
    <div className="flex min-w-0 items-center gap-3 border-t border-border p-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[#ff6b5e] text-sm font-semibold text-[#1b0d0d]">
        {account.initial}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{account.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{account.email}</span>
      </span>
      <Button id="sign-out" variant="ghost" size="icon" className="size-11 shrink-0" aria-label="Sign out" title="Sign out" disabled={pending} onClick={() => void signOut()}>
        <LogOut />
      </Button>
    </div>
  )
}
