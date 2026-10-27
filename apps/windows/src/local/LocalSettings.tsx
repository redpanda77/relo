// Settings, Relo page: the "Relo on this PC" group (the Mac's local section): whether Relo is running and its version,
// Set up agents again, Use another Relo server…, Uninstall, Show details; and, for a PC signed in to a server, Run Relo
// on this PC instead….
import "./local.css"
import "./mock"
import { useEffect, useState } from "react"
import { broadcast, quitRelo } from "../settings/ipc"
import { initialProgress } from "../settings/onboarding/stages"
import type { ReloSettings, SettingsPatch } from "../settings/store"
import { invoke } from "@tauri-apps/api/core"
import { Btn, Check, Group, Row } from "../settings/ui"
import { inTauri } from "../settings/ipc"
import { localApi, localLeave, localRemoteHost, localRetryStart, localSetUpAgents, localShowLogs, localUninstall, useLocalState, type LocalAgent, type LocalState } from "./api"
import { LOCAL, SETTINGS, SETUP, replaceLoginConfirmation } from "./words"

/** What the first row says: whether Relo is running, and its version. */
export function runningLine(local: Pick<LocalState, "phase">): string {
  return local.phase === "running" ? SETTINGS.running : local.phase === "starting" ? SETTINGS.starting : SETTINGS.notRunning
}

/** Words of the two rows this file adds (the shared set is words.ts). */
const MORE = {
  tryAgain: "Try again",
  taskScheduler: "Open Task Scheduler",
  taskSchedulerDetail: "Relo starts with Windows from here",
  taskSchedulerManual: "Open Task Scheduler from the Start menu and look for Relo.",
} as const

/** "Try again" is offered whenever Relo is neither running nor starting (the Mac's "Try again" in Relo on this Mac). */
export function canTryAgain(local: Pick<LocalState, "phase" | "mode">): boolean {
  return local.mode && local.phase !== "running" && local.phase !== "starting"
}

/**
 * "Open Task Scheduler" (the Mac's "Open Login Items"): Relo's background service starts at sign-in from there. Asks the app to
 * open it (`open_task_scheduler`, owned by the Rust shell); resolves to a line to show when the app cannot.
 */
export async function openTaskScheduler(): Promise<string | null> {
  if (!inTauri) return MORE.taskSchedulerManual
  try {
    await invoke("open_task_scheduler")
    return null
  } catch {
    return MORE.taskSchedulerManual
  }
}

export function versionLine(local: Pick<LocalState, "version">): string | undefined {
  return local.version ? SETTINGS.version(local.version) : undefined
}

type Panel = null | "agents" | "leave" | "uninstall"
type PatchFn = (patch: SettingsPatch) => void

/** Leaves local mode for a server: the owner is asked for its address and signs in (the first screens again). */
export function startOverForServer(set: PatchFn): void {
  broadcast("local_sign_out")
  set({ serverOrigin: null, accountEmail: null, onboardingDone: false, onboarding: { ...initialProgress(), stage: "where", place: "server" } })
}

export function LocalGroup({ set, removed, onRemoved }: { s: ReloSettings; set: PatchFn; removed: boolean; onRemoved: () => void }) {
  const local = useLocalState()
  const [panel, setPanel] = useState<Panel>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [taskNote, setTaskNote] = useState<string | null>(null)

  const leave = async () => {
    setBusy(true)
    const e = await localLeave()
    setBusy(false)
    if (e) return setProblem(e)
    startOverForServer(set)
  }

  const uninstall = async (deleteData: boolean) => {
    setBusy(true)
    broadcast("local_sign_out")
    const e = await localUninstall(deleteData)
    setBusy(false)
    setPanel(null)
    onRemoved()
    if (e) setProblem(e)
  }

  // Quitting is the end of an uninstall: the next launch starts the onboarding over, not a sign-in screen.
  const quitAfterUninstall = () => {
    set({ serverOrigin: null, accountEmail: null, onboardingDone: false, onboarding: null })
    void quitRelo()
  }

  if (removed) {
    return (
      <Group title={SETTINGS.group}>
        <Row title={LOCAL.removed} detail={problem ?? undefined}>
          <Btn primary onClick={quitAfterUninstall}>
            Quit Relo
          </Btn>
        </Row>
      </Group>
    )
  }

  return (
    <Group title={SETTINGS.group}>
      <Row title={runningLine(local)} detail={versionLine(local) ?? (local.phase === "failed" || local.phase === "foreign" ? local.reason ?? undefined : undefined)}>
        {canTryAgain(local) && (
          <Btn
            primary
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void localRetryStart().then((e) => {
                setBusy(false)
                setProblem(e)
              })
            }}
          >
            {MORE.tryAgain}
          </Btn>
        )}
        <Btn onClick={() => void localShowLogs()}>{SETTINGS.showDetails}</Btn>
      </Row>
      {problem && panel !== "leave" && <div className="lconfirm warn">{problem}</div>}
      <Row title={MORE.taskScheduler} detail={taskNote ?? MORE.taskSchedulerDetail}>
        <Btn onClick={() => void openTaskScheduler().then(setTaskNote)}>{MORE.taskScheduler}</Btn>
      </Row>
      <Row title={SETTINGS.setUpAgents} detail={SETTINGS.setUpAgentsDetail}>
        <Btn onClick={() => setPanel(panel === "agents" ? null : "agents")}>{SETTINGS.setUp}</Btn>
      </Row>
      {panel === "agents" && <SetUpAgents onClose={() => setPanel(null)} />}
      <Row title={SETTINGS.useAnother} detail={SETTINGS.useAnotherDetail}>
        <Btn onClick={() => setPanel(panel === "leave" ? null : "leave")}>{SETTINGS.useAnother}</Btn>
      </Row>
      {panel === "leave" && (
        <div className="lconfirm">
          <div>{LOCAL.leaveConfirmation}</div>
          {problem && <div className="warn">{problem}</div>}
          <div className="lbuttons">
            <Btn onClick={() => { setPanel(null); setProblem(null) }}>{SETTINGS.cancel}</Btn>
            <Btn primary disabled={busy} onClick={() => void leave()}>
              {SETTINGS.useAnother}
            </Btn>
          </div>
        </div>
      )}
      <Row title={SETTINGS.uninstall} detail={SETTINGS.uninstallDetail}>
        <Btn onClick={() => setPanel(panel === "uninstall" ? null : "uninstall")}>{SETTINGS.uninstall}</Btn>
      </Row>
      {panel === "uninstall" && (
        <div className="lconfirm">
          <div>{SETTINGS.uninstallConfirm}</div>
          <div className="lbuttons">
            <Btn onClick={() => setPanel(null)}>{SETTINGS.cancel}</Btn>
            <Btn disabled={busy} onClick={() => void uninstall(false)}>
              {SETTINGS.keepData}
            </Btn>
            <Btn primary disabled={busy} onClick={() => void uninstall(true)}>
              {SETTINGS.deleteData}
            </Btn>
          </div>
        </div>
      )}
    </Group>
  )
}

/** "Set up agents again": the agents found on this PC to tick, and Set up for the ticked ones. */
function SetUpAgents({ onClose }: { onClose: () => void }) {
  const [agents, setAgents] = useState<LocalAgent[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<{ text: string; failed: boolean } | null>(null)

  useEffect(() => {
    let live = true
    void localApi.detectAgents().then((found) => {
      if (!live) return
      setAgents(found)
      setSelected(found.map((a) => a.id))
    })
    return () => void (live = false)
  }, [])

  const run = async () => {
    setWorking(true)
    const e = await localSetUpAgents(selected)
    setWorking(false)
    setResult(e ? { text: e, failed: true } : { text: SETTINGS.setUpDone, failed: false })
  }

  return (
    <div className="lconfirm">
      {agents === null && <div className="lspin" role="img" aria-label="Working" />}
      {agents !== null && agents.length === 0 && <div>{SETUP.noAgents}</div>}
      {agents !== null && agents.length > 0 && (
        <>
          <div className="lstep-agents" style={{ paddingLeft: 0 }}>
            {agents.map((a) => {
              const on = selected.includes(a.id)
              return (
                <div className="lstep-agent" key={a.id}>
                  <Check checked={on} label={a.name} onChange={() => setSelected(on ? selected.filter((s) => s !== a.id) : [...selected, a.id])} />
                  {a.name}
                </div>
              )
            })}
          </div>
          <div className="row-detail">{SETUP.agentsNote}</div>
        </>
      )}
      {result && <div className={result.failed ? "warn" : "row-detail"}>{result.text}</div>}
      <div className="lbuttons">
        <Btn onClick={onClose}>{result && !result.failed ? "Done" : SETTINGS.cancel}</Btn>
        {(!result || result.failed) && (
          <Btn primary disabled={working || selected.length === 0} onClick={() => void run()}>
            {working ? "Setting up…" : SETTINGS.setUp}
          </Btn>
        )}
      </div>
    </div>
  )
}

/** For a PC signed in to a server: move back to Relo on this PC. Shown only where this build carries the server. */
export function RunHereGroup({ s, set }: { s: ReloSettings; set: PatchFn }) {
  const local = useLocalState()
  const [open, setOpen] = useState(false)
  const [host, setHost] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void localRemoteHost().then((h) => live && setHost(h))
    return () => void (live = false)
  }, [])
  if (!local.bundled || local.mode) return null
  const named = s.serverOrigin ? safeHost(s.serverOrigin) : host
  const go = () => {
    // The onboarding opens on the local steps; its first act signs the app out of the server it was signed in to.
    set({ onboardingDone: false, onboarding: { ...initialProgress(), stage: "local", place: "local" } })
  }
  return (
    <Group title={SETTINGS.group}>
      <Row title={SETTINGS.runHere} detail={SETTINGS.runHereDetail}>
        <Btn onClick={() => setOpen(!open)}>{SETTINGS.runHere}</Btn>
      </Row>
      {open && (
        <div className="lconfirm">
          <div>{named ? replaceLoginConfirmation(named) : SETTINGS.runHereConfirm}</div>
          <div className="lbuttons">
            <Btn onClick={() => setOpen(false)}>{SETTINGS.cancel}</Btn>
            <Btn primary onClick={go}>
              {SETUP.place}
            </Btn>
          </div>
        </div>
      )}
    </Group>
  )
}

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).host
  } catch {
    return null
  }
}
