// "Run Relo on this PC": its five steps with live state, the agents to tick, and what to do when one fails (the Mac's
// ReloOnboardingLocalView). The screen draws `LocalProgress` and calls the setup's actions; it holds no state.
import "./local.css"
import { COLORS } from "../relo/ui/theme"
import { PlasmaOrb } from "../relo/visual/PlasmaOrb"
import { Check } from "../settings/ui"
import { localShowLogs } from "./api"
import { agentsSummary, buttonsFor, LOCAL_STEPS, rowState, stepTitle, type LocalProgress, type LocalStep, type RowState } from "./setup"
import { SETUP } from "./words"

export interface LocalSetupActions {
  tryAgain(): void
  chooseAgents(): void
  skipAgents(): void
  toggleAgent(id: string): void
  back(): void
  next(): void
}

function StateIcon({ state }: { state: RowState }) {
  switch (state) {
    case "done":
      return (
        <svg viewBox="0 0 18 18" fill="none" aria-label="Done" role="img">
          <circle cx="9" cy="9" r="8" fill={COLORS.done} />
          <path d="M5.2 9.4l2.6 2.6 5-5.6" stroke="#0b0b12" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case "failed":
      return (
        <svg viewBox="0 0 18 18" fill="none" aria-label="Failed" role="img">
          <circle cx="9" cy="9" r="8" fill={COLORS.warning} />
          <path d="M9 4.8v4.8M9 12.4v.01" stroke="#0b0b12" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case "active":
      return <span className="lspin" role="img" aria-label="Working" />
    case "waiting":
      return (
        <svg viewBox="0 0 18 18" fill="none" aria-label="Waiting for you" role="img">
          <circle cx="9" cy="9" r="7.4" stroke="rgb(255 255 255 / 0.8)" strokeWidth="1.6" strokeDasharray="1.5 3.2" strokeLinecap="round" />
        </svg>
      )
    case "pending":
      return (
        <svg viewBox="0 0 18 18" fill="none" aria-label="Waiting" role="img">
          <circle cx="9" cy="9" r="7.4" stroke="rgb(255 255 255 / 0.25)" strokeWidth="1.6" />
        </svg>
      )
  }
}

function Step({ step, l, actions }: { step: LocalStep; l: LocalProgress; actions: LocalSetupActions }) {
  const state = rowState(l, step)
  return (
    <div className="lstep" data-state={state} data-step={step}>
      <div className="lstep-head">
        <span className="lstep-icon">
          <StateIcon state={state} />
        </span>
        {stepTitle(step)}
      </div>
      {step === "agents" && l.waitingForAgents && (
        <div className="lstep-agents">
          {l.agents.map((a) => {
            const on = l.selected.includes(a.id)
            return (
              <div className="lstep-agent" key={a.id}>
                <Check checked={on} label={a.name} onChange={() => actions.toggleAgent(a.id)} />
                {a.name}
              </div>
            )
          })}
          <div className="lstep-note" style={{ padding: 0 }}>{SETUP.agentsNote}</div>
        </div>
      )}
      {step === "agents" && state === "done" && <div className="lstep-note">{agentsSummary(l)}</div>}
    </div>
  )
}

export function LocalSetupView({ l, actions }: { l: LocalProgress; actions: LocalSetupActions }) {
  const done = l.step === "done"
  const buttons = buttonsFor(l)
  return (
    <>
      <PlasmaOrb size={84} mood={done ? "clear" : "running"} />
      <h1>{done ? SETUP.titleDone : SETUP.title}</h1>
      <div className="lsteps">
        {LOCAL_STEPS.map((step) => (
          <Step key={step} step={step} l={l} actions={actions} />
        ))}
      </div>
      {done && (
        <div className="ldone">
          <div>{SETUP.runsHere}</div>
          <div>{SETUP.testCard}</div>
          {l.launcherNote && <div>{l.launcherNote}</div>}
          <div className="ob-caption">{SETUP.restartAgents}</div>
        </div>
      )}
      {l.failure !== null && (
        <div className="lfail" role="alert">
          <div className="warn" style={{ fontSize: 12.5 }}>
            {l.failure}
          </div>
          <button type="button" className="link" onClick={() => void localShowLogs()}>
            {SETUP.showDetails}
          </button>
        </div>
      )}
      <div className="lbuttons">
        {buttons === "failed" && (
          <>
            <button type="button" className="link" onClick={actions.back}>
              {SETUP.back}
            </button>
            <button type="button" className="btn" data-primary="" onClick={actions.tryAgain}>
              {SETUP.tryAgain}
            </button>
          </>
        )}
        {buttons === "done" && (
          <button type="button" className="btn" data-primary="" onClick={actions.next}>
            {SETUP.continue}
          </button>
        )}
        {buttons === "agents" && (
          <>
            <button type="button" className="link" onClick={actions.back}>
              {SETUP.back}
            </button>
            <button type="button" className="btn" onClick={actions.skipAgents}>
              {SETUP.skipAgents}
            </button>
            <button type="button" className="btn" data-primary="" disabled={l.selected.length === 0} onClick={actions.chooseAgents}>
              {SETUP.continue}
            </button>
          </>
        )}
        {buttons === "working" && (
          <button type="button" className="link" disabled={l.running} onClick={actions.back}>
            {SETUP.back}
          </button>
        )}
      </div>
    </>
  )
}
