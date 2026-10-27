// Local mode's recovery in the notch (the Mac's ReloLocalProblemView and closed-notch hovers): when Relo on this PC did
// not start, or the app lost its link to it, the notch says so in one line with one button. There is no account, no
// server address and no sign-in to offer: the button does the work itself.
import { useLayoutEffect, useRef, useState } from "react"
import { COLORS } from "../relo/ui/theme"
import { localRepair, localRetryStart, localShowLogs, type LocalState } from "./api"
import { LOCAL } from "./words"

export type Problem = "starting" | "startFailed" | "notAnswering" | "needsRepair"

/**
 * What the notch says when it has no work to show in local mode. `connection` is the app's own link (the owner
 * client's state); `local` is the server's (Rust's `local_state`).
 */
export function problemOf(local: Pick<LocalState, "phase">, connection: string): Problem {
  if (local.phase === "failed" || local.phase === "foreign") return "startFailed"
  if (local.phase === "starting") return "starting"
  if (local.phase === "stopped") return "notAnswering"
  if (connection === "starting" || connection === "signingIn" || connection === "connecting") return "starting"
  return "needsRepair"
}

export const titleOf = (p: Problem): string =>
  p === "startFailed" ? LOCAL.startFailedTitle : p === "starting" ? LOCAL.starting : p === "notAnswering" ? LOCAL.notAnswering : LOCAL.needsRepair

/** The one button: nothing while it starts, Try again when it did not start or stopped answering, else Repair. */
export const buttonOf = (p: Problem): string | null => (p === "starting" ? null : p === "startFailed" || p === "notAnswering" ? LOCAL.tryAgain : LOCAL.repair)

/** The closed notch's line (shown only when it has nothing else to show). */
export function closedLine(p: Problem): string {
  switch (p) {
    case "starting":
      return LOCAL.starting
    case "startFailed":
      return LOCAL.hoverStartFailed
    case "notAnswering":
      return LOCAL.notAnsweringShort
    case "needsRepair":
      return LOCAL.hoverToRepair
  }
}

export function LocalClosed({ problem }: { problem: Problem }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-[10.5px] font-medium" style={{ color: COLORS.secondaryText }}>
      <span className="size-1.5 rounded-full" style={{ background: problem === "starting" ? COLORS.info : COLORS.yellow }} />
      {closedLine(problem)}
    </span>
  )
}

const PAD = 14

export function LocalPanel({ local, connection, onFit }: { local: LocalState; connection: string; onFit: (height: number) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [working, setWorking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useLayoutEffect(() => {
    const measure = () => onFit(Math.ceil((box.current?.offsetHeight ?? 0) + PAD * 2))
    measure()
    const ro = new ResizeObserver(measure)
    if (box.current) ro.observe(box.current)
    return () => ro.disconnect()
  }, [onFit])

  const problem = problemOf(local, connection)
  const button = buttonOf(problem)
  const detail = failure ?? (problem === "startFailed" || problem === "notAnswering" ? local.reason : null)

  const act = () => {
    setWorking(true)
    setFailure(null)
    void (problem === "startFailed" || problem === "notAnswering" ? localRetryStart() : localRepair()).then((e) => {
      setFailure(e)
      setWorking(false)
    })
  }

  return (
    <div style={{ padding: `${PAD}px 0` }}>
      <div ref={box} className="flex flex-col items-center gap-2 text-center">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <span className="size-2 rounded-full" style={{ background: problem === "starting" ? COLORS.info : COLORS.yellow }} />
          {titleOf(problem)}
        </div>
        {detail && (
          <>
            <div className="max-w-[460px] text-[11px]" style={{ color: COLORS.yellow }}>{detail}</div>
            <button type="button" className="text-[11px] underline-offset-2 hover:underline" style={{ color: COLORS.secondaryText }} onClick={() => void localShowLogs()}>
              {LOCAL.showDetails}
            </button>
          </>
        )}
        <div className="flex items-center gap-2" style={{ ["--tone" as string]: COLORS.cyan }}>
          {button && (
            <button type="button" className="pill" data-prominent="" disabled={working} onClick={act}>
              {working ? LOCAL.working : button}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
