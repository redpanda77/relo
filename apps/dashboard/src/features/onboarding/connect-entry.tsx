import { Rocket } from "lucide-react"
import { useEffect, useState } from "react"

import { Notice } from "@/components/molecules/notice"
import { Button } from "@/components/ui/button"
import { ConnectComputerDialog } from "@/features/onboarding/connect-computer"
import { createHttpConnectService, lastInvite, madeInvite, type ConnectService } from "@/features/onboarding/connect-service"

const httpService = createHttpConnectService()
const REFRESH_MS = 30_000

function asked(): boolean {
  try { return new URLSearchParams(window.location.search).get("connect") === "computer" } catch { return false }
}

/**
 * The Now page's way into Connect a computer: a compact card shown only while the account has no computer, and the
 * wizard itself when signup (or a link) asked for it. Nothing else is shown once a computer exists.
 */
export function ConnectEntry({ service = httpService }: { service?: ConnectService }) {
  const [hasComputer, setHasComputer] = useState<boolean | null>(null)
  const [open, setOpen] = useState(asked)
  const [resumeId, setResumeId] = useState<string | null>(null)
  // A command made in this tab and not run yet: Resume reopens on it.
  const resumable = hasComputer === false ? madeInvite(lastInvite()) : null

  useEffect(() => {
    if (!asked()) return
    const url = new URL(window.location.href)
    url.searchParams.delete("connect")
    window.history.replaceState(window.history.state, "", url)
  }, [])

  useEffect(() => {
    let active = true
    const refresh = () => { void service.hasComputer().then((next) => { if (active) setHasComputer(next) }, () => undefined) }
    refresh()
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") refresh() }, REFRESH_MS)
    return () => { active = false; window.clearInterval(timer) }
  }, [service])

  return (
    <>
      {hasComputer === false ? (
        <Notice
          aria-label="Connect a computer"
          tone="violet"
          icon={<Rocket />}
          title="Connect a computer"
          action={
            <div className="flex flex-wrap gap-2">
              {resumable ? <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => { setResumeId(resumable.invite.inviteId); setOpen(true) }}>Resume</Button> : null}
              <Button size="sm" className="min-h-11 sm:min-h-8" onClick={() => { setResumeId(null); setOpen(true) }}>Connect a computer</Button>
            </div>
          }
        >
          Your agents report here once a computer is connected. It takes one command.
        </Notice>
      ) : null}
      <ConnectComputerDialog open={open} onOpenChange={setOpen} service={service} resumeId={resumeId} onFinished={() => setHasComputer(true)} />
    </>
  )
}
