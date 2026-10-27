// What the account needs from the owner or tells them, in the open notch above the Relo tab: a sign-in or update that
// failed, a waiting update (Restart now / Later), the moment after an update, computers waiting for approval
// (Approve / Decline) and notices that just arrived. It reports the height it takes, like the panels do.

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { COLORS } from "../relo/ui/theme"
import { bannerText } from "./updatePolicy"
import type { Owner } from "./useOwner"

const NOTICE_SHOWN_MS = 8_000

export function OwnerBar({ owner, onFit }: { owner: Owner; onFit: (height: number) => void }) {
  const { view } = owner
  const box = useRef<HTMLDivElement>(null)
  const [noticeSerial, setNoticeSerial] = useState<number | null>(null)

  // A notice that just arrived is shown for a few seconds, then leaves (it stays in the toast and the server's inbox).
  const arrival = view.peek?.kind === "notice" ? view.peek.serial : null
  useEffect(() => {
    if (arrival === null) return
    setNoticeSerial(arrival)
    const timer = setTimeout(() => setNoticeSerial(null), NOTICE_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [arrival])

  const showNotices = noticeSerial !== null && view.arrivals.length > 0
  // The Connect panel already says why a sign-in failed and offers Sign in again.
  const failure = view.failure && view.connection !== "signedOut" && view.connection !== "needsSignIn" ? view.failure : null
  const nothing = !failure && !view.update && !view.updatedLine && view.waitingComputers.length === 0 && !showNotices

  useLayoutEffect(() => {
    if (nothing) return onFit(0)
    const measure = () => onFit(Math.ceil(box.current?.offsetHeight ?? 0))
    measure()
    const ro = new ResizeObserver(measure)
    if (box.current) ro.observe(box.current)
    return () => ro.disconnect()
  }, [nothing, onFit])

  if (nothing) return null
  return (
    <div ref={box} className="flex flex-col gap-1.5 px-1 pb-2 pt-3 text-[11px]">
      {failure && (
        <Row tone={COLORS.warning} text={failure}>
          <button type="button" className="pill" onClick={() => owner.dismissFailure()}>Dismiss</button>
        </Row>
      )}
      {view.update && (
        <Row tone={COLORS.cyan} text={bannerText(view.update.version, view.update.ready)}>
          <button type="button" className="pill" onClick={owner.later}>Later</button>
          <button type="button" className="pill" data-prominent="" onClick={owner.installUpdate}>{view.update.ready ? "Restart now" : "Update"}</button>
        </Row>
      )}
      {view.updatedLine && <Row tone={COLORS.mint} text={view.updatedLine} />}
      {view.waitingComputers.map((computer) => (
        <Row key={computer.id} tone={COLORS.yellow} text={`${computer.name} wants to show its cards here`}>
          <button type="button" className="pill" onClick={() => owner.declineComputer(computer.id)}>Decline</button>
          <button type="button" className="pill" data-prominent="" onClick={() => owner.approveComputer(computer.id)}>Approve</button>
        </Row>
      ))}
      {showNotices && view.arrivals.map((notice) => <Row key={notice.id} tone={COLORS.info} title={notice.title} text={notice.summary ?? notice.source} />)}
    </div>
  )
}

function Row({ tone, title, text, children }: { tone: string; title?: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-[10px] px-2.5 py-1.5" style={{ background: `${tone}1a`, ["--tone" as string]: tone }}>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: tone }} />
      <div className="min-w-0 flex-1 truncate" style={{ color: tone === COLORS.info ? "white" : tone }}>
        {title && <span className="font-medium text-white">{title} </span>}
        {text}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </div>
  )
}
