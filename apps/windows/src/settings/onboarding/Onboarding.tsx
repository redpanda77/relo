// First-run onboarding (the Mac's OnboardingView / ReloOnboardingScreens): Hello, Sound, Where, Server sign-in, Agents,
// Setup, Ready. Progress lives in settings.json (`onboarding`), so closing the window or restarting resumes it.
import { useEffect, useRef, useState } from "react"
import { autostartGet, autostartSet, launchArgs } from "../../bridge"
import { cuePlayer, uiCue } from "../../sound"
import { download as downloadVoice } from "../../voice/ipc"
import { broadcast, detectAgents, hideSettings, installSource, onOwnerState, provisionReloCommand, runSetupAgent } from "../ipc"
import { VOICE_SAMPLES, WELCOME_LINE, speak, speakWelcome, stopSpeaking, useSpeaking } from "../voiceSpeak"
import { settingsStore, useSettings, speaks, type VoiceDetail } from "../store"
import { Check, Segmented, Switch } from "../ui"
import { localApi, useLocalState } from "../../local/api"
import { ONBOARDING_STAGE_EVENT, clearPayload, samePayload, stagePayload, readyLine, type OnboardingStagePayload } from "./notchStage"
import "./aurora.css"
import { Aurora } from "../../home/Aurora"
import { PlasmaOrb } from "../../relo/visual/PlasmaOrb"
import { cascade, collapseToNotch, ripple } from "./motion"
import { LocalStage } from "../../local/LocalStage"
import type { LocalProgress } from "../../local/setup"
import { SETUP } from "../../local/words"
import { canContinue, initialProgress, nextPending, normalizeOrigin, originFromInstaller, reduce, RELO_ROW, route, setupFinished, stepIndex, type Event, type Progress, type RowStatus } from "./stages"

/** Apply an event to the saved progress (always the latest, so async results never overwrite each other). */
function dispatch(e: Event): void {
  const cur = settingsStore.get().onboarding ?? initialProgress()
  const next = reduce(cur, e)
  if (next !== cur) settingsStore.update({ onboarding: next })
}

/** The local route's progress as it is now (always the latest) and the way to change it. */
const getLocal = (): LocalProgress => (settingsStore.get().onboarding ?? initialProgress()).local
const patchLocal = (patch: Partial<LocalProgress>): void => dispatch({ type: "local", patch })

const STATUS_LABEL: Record<RowStatus, string> = { pending: "Waiting", running: "Setting up…", done: "Done", failed: "Failed", skipped: "Skipped" }

export function Onboarding() {
  const { settings, update } = useSettings()
  const p: Progress = settings.onboarding ?? initialProgress()

  // The notch reports the account's state; the server screen advances on sign-in.
  useEffect(() => onOwnerState((state) => dispatch({ type: "ownerState", state })), [])

  // Agents: read once when the screen opens.
  useEffect(() => {
    if (p.stage !== "agents") return
    let live = true
    void detectAgents().then((agents) => live && dispatch({ type: "agentsDetected", agents }))
    return () => void (live = false)
  }, [p.stage])

  // Setup: one agent at a time, in order.
  const inFlight = useRef(new Set<string>())
  const row = nextPending(p)
  useEffect(() => {
    if (!row || inFlight.current.has(row.id)) return
    inFlight.current.add(row.id)
    dispatch({ type: "rowStarted", id: row.id })
    // The relo command is the first row: the launcher, the Path and the CLI's own sign-in to this server; the agents call it.
    const work: Promise<{ ok: boolean; message?: string }> =
      row.id === RELO_ROW
        ? provisionReloCommand(normalizeOrigin(p.origin) ?? p.origin).then((r) => (r.ok ? { ok: true } : { ok: false, message: r.message }))
        : runSetupAgent(row.id)
    void work.then((r) => {
      inFlight.current.delete(row.id)
      dispatch({ type: "rowFinished", id: row.id, ok: r.ok, message: r.message })
    })
  }, [row])
  const finished = p.stage === "setup" && setupFinished(p)
  useEffect(() => {
    if (!finished) return
    const t = window.setTimeout(() => dispatch({ type: "continue" }), 700)
    return () => window.clearTimeout(t)
  }, [finished])

  // The notch shows the onboarding as one staged work (O02); the notch listens for `onboarding_stage`.
  const startedAt = useRef(Date.now())
  const sent = useRef<OnboardingStagePayload | null>(null)
  useEffect(() => {
    const next = stagePayload(p, startedAt.current)
    if (samePayload(sent.current, next)) return
    if (sent.current === null) startedAt.current = Date.now()
    sent.current = next
    broadcast(ONBOARDING_STAGE_EVENT, next ?? clearPayload())
  }, [p])

  // A page turn: `turn`, and the screen's elements rise in one after another (O01, A09). Not on the first screen shown.
  const body = useRef<HTMLDivElement>(null)
  const shown = useRef<string | null>(null)
  useEffect(() => {
    if (shown.current !== null && shown.current !== p.stage) {
      uiCue("turn")
      if (body.current && !settings.reduceMotion) cascade(body.current)
    }
    shown.current = p.stage
  }, [p.stage, settings.reduceMotion])

  return (
    <div className="ob" style={{ position: "relative", isolation: "isolate" }}>
      <div aria-hidden style={{ position: "absolute", inset: 0, zIndex: -1 }}>
        <Aurora />
      </div>
      <div className="ob-dots" aria-label={`Step ${stepIndex(p.stage, p.place) + 1} of ${route(p.place).length}`}>
        {route(p.place).map((s, i) => (
          <span key={s} data-on={i <= stepIndex(p.stage, p.place) ? "" : undefined} />
        ))}
      </div>
      <div className="ob-body" ref={body}>
        {p.stage === "hello" && <Hello />}
        {p.stage === "sound" && <Sound />}
        {p.stage === "where" && <Where p={p} />}
        {p.stage === "server" && <Server p={p} />}
        {p.stage === "agents" && <Agents p={p} />}
        {p.stage === "setup" && <Setup p={p} />}
        {p.stage === "local" && (
          <LocalStage
            l={p.local}
            get={getLocal}
            patch={patchLocal}
            onBack={() => {
              dispatch({ type: "back" })
              dispatch({ type: "localReset" })
            }}
            onNext={() => dispatch({ type: "continue" })}
          />
        )}
        {p.stage === "ready" && <Ready place={p.place} finish={() => update({ onboardingDone: true, onboarding: null })} />}
      </div>
      <Foot p={p} />
    </div>
  )
}

function Foot({ p }: { p: Progress }) {
  const back = ["where", "server", "agents"].includes(p.stage)
  const label =
    p.stage === "hello" ? "Begin" : p.stage === "agents" ? (p.selected.length ? "Set up" : "Skip agents for now") : "Continue"
  const hidden = p.stage === "ready" || p.stage === "server" || p.stage === "setup" || p.stage === "local"
  return (
    <div className="ob-foot" style={{ minHeight: 34 }}>
      {back && (
        <button type="button" className="link" onClick={() => dispatch({ type: "back" })}>
          Back
        </button>
      )}
      {!hidden && (
        <button type="button" className="btn" data-primary="" disabled={!canContinue(p)} onClick={() => dispatch({ type: "continue" })}>
          {label}
        </button>
      )}
    </div>
  )
}

/** The orb; `touch` (a counter) sends one ring of light over it, as the Mac's ReloTouchRipple. */
const Orb = ({ size = 84, touch = 0 }: { size?: number; touch?: number }) => {
  const ring = useRef<HTMLSpanElement>(null)
  const { settings } = useSettings()
  useEffect(() => {
    if (touch > 0 && !settings.reduceMotion) ripple(ring.current)
  }, [touch, settings.reduceMotion])
  return (
    <div style={{ position: "relative", display: "grid", placeItems: "center" }}>
      <PlasmaOrb size={size} paused={settings.reduceMotion} />
      <span
        ref={ring}
        aria-hidden
        style={{ position: "absolute", width: size, height: size, borderRadius: "50%", border: "2px solid rgb(200 230 255 / 0.9)", opacity: 0, pointerEvents: "none" }}
      />
    </div>
  )
}

/** Five bars that move only while the voice speaks (ReloVoiceWave, 30 fps). */
function VoiceWave({ speaking }: { speaking: boolean }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([])
  const { settings } = useSettings()
  useEffect(() => {
    const still = !speaking || settings.reduceMotion
    const draw = () => {
      const t = Date.now() / 1000
      bars.current.forEach((b, i) => b && (b.style.height = `${still ? 6 : 5 + 15 * Math.abs(Math.sin(t * 3.5 + i * 0.8))}px`))
    }
    draw()
    if (still) return
    const id = window.setInterval(draw, 1000 / 30)
    return () => window.clearInterval(id)
  }, [speaking, settings.reduceMotion])
  return (
    <div aria-hidden style={{ display: "flex", gap: 3, alignItems: "center", justifyContent: "center", height: 22 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} ref={(el) => void (bars.current[i] = el)} style={{ width: 3, height: 6, borderRadius: 2, background: "var(--tone, #7aa7ff)", opacity: 0.85 }} />
      ))}
    </div>
  )
}

/** Hello's one-time work (once per window): the voice starts downloading (unmetered networks only) and local setup looks for a problem early. */
let helloDone = false
function useHelloWork(): void {
  useEffect(() => {
    if (helloDone) return
    helloDone = true
    void downloadVoice(true)
    void localApi.check().catch(() => null)
  }, [])
}

let welcomed = false
function Hello() {
  useHelloWork()
  const [caption, setCaption] = useState("")
  // The Mac's beat: a moment of quiet, then the caption and the spoken welcome, once.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setCaption(WELCOME_LINE)
      if (welcomed) return
      welcomed = true
      void speakWelcome()
    }, 1200)
    return () => {
      window.clearTimeout(t)
      stopSpeaking()
    }
  }, [])
  return (
    <>
      <Orb size={120} />
      <h1>Relo</h1>
      <p className="ob-caption" style={{ minHeight: "1.4em" }}>{caption}</p>
    </>
  )
}

type Mode = "silent" | "sounds" | "voice"

function Sound() {
  const { settings: s, update } = useSettings()
  const mode: Mode = !s.sounds ? "silent" : speaks(s.voiceMode) ? "voice" : "sounds"
  // The onboarding's default is Voice at Full; the owner hears it before choosing.
  useEffect(() => {
    const cur = settingsStore.get()
    if (cur.sounds && cur.voiceMode === "soundOnly") update({ voiceMode: "soundThenVoice", voiceDetail: "full" })
  }, [update])
  const [touch, setTouch] = useState(0)
  const [caption, setCaption] = useState("When something happens")
  const speaking = useSpeaking()
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  /** Says the sample at `detail` after `delay` ms; the caption shows it at once. */
  const say = (detail: VoiceDetail, delay: number) => {
    const line = VOICE_SAMPLES[detail]
    setCaption(line)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => speak(line), delay)
  }
  const pick = (m: Mode) => {
    if (m === "silent") {
      update({ sounds: false })
      window.clearTimeout(timer.current)
      stopSpeaking()
      return setCaption("No sound")
    }
    setTouch((t) => t + 1)
    void cuePlayer.preload().then(() => cuePlayer.preview("finished"))
    if (m === "sounds") {
      update({ sounds: true, voiceMode: "soundOnly" })
      stopSpeaking()
      setCaption("A sound for each moment")
    } else {
      update({ sounds: true, voiceMode: s.voiceMode === "soundOnly" ? "soundThenVoice" : s.voiceMode })
      // The done sound first, then the sample (O04: 0.45 s).
      say(s.voiceDetail, 450)
    }
  }
  const tile = (m: Mode, label: string, hint: string) => (
    <button type="button" className="choice" aria-pressed={mode === m} onClick={() => pick(m)}>
      {label}
      <small>{hint}</small>
    </button>
  )
  return (
    <>
      <Orb touch={touch} />
      <p className="ob-caption">{caption}</p>
      <div className="choices">
        {tile("silent", "Silent", "Only the notch")}
        {tile("sounds", "Sounds", "A short cue")}
        {tile("voice", "Voice", "Says what happened")}
      </div>
      {mode === "voice" && (
        <>
          <Segmented<"brief" | "full" | "verbose">
            label="How much it says"
            value={s.voiceDetail}
            options={[
              { value: "brief", label: "Brief" },
              { value: "full", label: "Full" },
              { value: "verbose", label: "Every step" },
            ]}
            onChange={(voiceDetail) => {
              update({ voiceDetail })
              say(voiceDetail, 0)
            }}
          />
          <VoiceWave speaking={speaking} />
        </>
      )}
    </>
  )
}

function Where({ p }: { p: Progress }) {
  // A build without the server (a dev build) cannot run Relo itself: a server is the only choice.
  const bundled = useLocalState().bundled
  useEffect(() => {
    if (!bundled && p.place === "local") dispatch({ type: "choosePlace", place: "server" })
  }, [bundled, p.place])
  // The installer's hand-off (`--relo-origin`) fills the address and picks the server, once, when nothing was typed yet.
  // Without the flag (a later launch from the Start menu) the installer's own record of where it came from does the same.
  useEffect(() => {
    if (p.origin !== "") return
    let live = true
    void originFromInstaller(launchArgs, installSource).then((origin) => {
      if (!live || !origin || (settingsStore.get().onboarding?.origin ?? "") !== "") return
      dispatch({ type: "choosePlace", place: "server" })
      dispatch({ type: "setOrigin", origin })
    })
    return () => void (live = false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <>
      <h1>How do you want to run Relo?</h1>
      <div className="choices">
        <button type="button" className="choice" disabled={!bundled} aria-pressed={p.place === "local"} onClick={() => dispatch({ type: "choosePlace", place: "local" })}>
          {SETUP.place}
          <small>{bundled ? SETUP.placeHint : SETUP.notBundled}</small>
        </button>
        <button type="button" className="choice" aria-pressed={p.place === "server"} onClick={() => dispatch({ type: "choosePlace", place: "server" })}>
          Connect to a server
          <small>Reach it from your iPhone</small>
        </button>
      </div>
      {p.place === "server" && (
        <div style={{ width: "100%", textAlign: "left" }}>
          <input
            className="input"
            aria-label="Server address"
            placeholder="relo.example.com"
            spellCheck={false}
            autoFocus
            value={p.origin}
            onChange={(e) => dispatch({ type: "setOrigin", origin: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && dispatch({ type: "continue" })}
          />
          {p.origin.trim() !== "" && normalizeOrigin(p.origin) === null && <p className="warn" style={{ margin: "6px 4px 0" }}>That isn't a server address. Try relo.example.com.</p>}
          {bundled && (
            <button type="button" className="link" style={{ margin: "8px 4px 0" }} onClick={() => dispatch({ type: "choosePlace", place: "local" })}>
              Later
            </button>
          )}
        </div>
      )}
      <p className="ob-caption">{p.place === "local" ? SETUP.placeHint : "Your server reaches your iPhone, encrypted"}</p>
    </>
  )
}

function Server({ p }: { p: Progress }) {
  const origin = normalizeOrigin(p.origin)
  const signedIn = p.signIn === "signedIn"
  const waiting = p.signIn === "waiting"
  const start = () => {
    if (!origin) return
    settingsStore.update({ serverOrigin: origin })
    dispatch({ type: "signInStarted" })
    broadcast("onboarding_sign_in", { origin })
  }
  return (
    <>
      <Orb size={72} />
      <h1>{signedIn ? "Connected" : "Sign in"}</h1>
      <p className="mono">{origin ?? p.origin}</p>
      <p className="ob-caption">{waiting ? "Finish in your browser, then approve this PC on your iPhone" : signedIn ? "Signed in" : "Sign in to your Relo account in the browser."}</p>
      <div className="ob-foot">
        {!signedIn && (
          <button type="button" className="btn" data-primary="" disabled={waiting || !origin} onClick={start}>
            {waiting ? "Signing in…" : "Sign in"}
          </button>
        )}
        {waiting && (
          <button type="button" className="link" onClick={() => dispatch({ type: "signInCancelled" })}>
            Cancel
          </button>
        )}
        {signedIn && (
          <button type="button" className="btn" data-primary="" onClick={() => dispatch({ type: "continue" })}>
            Continue
          </button>
        )}
      </div>
    </>
  )
}

function Agents({ p }: { p: Progress }) {
  return (
    <>
      <h1>Your agents</h1>
      <p className="ob-caption">{p.agents.length ? "Found on this PC. Relo adds a few lines to their instructions so they report here." : "No agents yet: add one later in Settings"}</p>
      {p.agents.length > 0 && (
        <div className="sheet agent-list">
          {p.agents.map((a) => {
            const on = p.selected.includes(a.id)
            return (
              <div className="row" key={a.id}>
                <div className="row-text row-title">{a.name}</div>
                <Check checked={on} label={a.name} onChange={() => dispatch({ type: "toggleAgent", id: a.id })} />
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function Setup({ p }: { p: Progress }) {
  return (
    <>
      <h1>Setting up</h1>
      <div className="sheet setup-list">
        {p.rows.map((r) => (
          <div key={r.id}>
            <div className="row">
              <div className="row-text">
                <div className="row-title">{r.name}</div>
                {r.message && <div className="row-detail warn">{r.message}</div>}
              </div>
              {r.status === "failed" && (
                <>
                  <button type="button" className="btn" data-primary="" onClick={() => dispatch({ type: "retry", id: r.id })}>
                    Retry
                  </button>
                  <button type="button" className="btn" onClick={() => dispatch({ type: "skip", id: r.id })}>
                    Skip
                  </button>
                </>
              )}
              {r.status === "pending" && (
                <button type="button" className="link" onClick={() => dispatch({ type: "skip", id: r.id })}>
                  Skip
                </button>
              )}
              <span className="badge" data-s={r.status}>
                {STATUS_LABEL[r.status]}
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function Ready({ finish, place }: { finish: () => void; place: Progress["place"] }) {
  const { settings: s, update } = useSettings()
  // Open at start is on unless the owner turns it off here: Relo is a notch app that should be there.
  const [openAtStart, setOpenAtStart] = useState(true)
  useEffect(() => void autostartGet().then(setOpenAtStart).catch(() => {}), [])
  const names = s.onboarding?.rows.filter((r) => r.status === "done" && r.id !== RELO_ROW).map((r) => r.name) ?? []
  const caption = place === "local" ? SETUP.runsHere : names.length === 0 ? "Connected to your server" : readyLine(s.onboarding ?? { rows: [] })
  return (
    <>
      <Orb size={110} />
      <h1>Ready</h1>
      <p className="ob-caption">{caption}</p>
      <div className="sheet" style={{ width: 360, textAlign: "left" }}>
        <div className="row">
          <div className="row-text row-title">Install updates automatically</div>
          <Switch checked={s.autoInstallUpdates} onChange={(autoInstallUpdates) => update({ autoInstallUpdates })} label="Install updates automatically" />
        </div>
        <div className="row">
          <div className="row-text row-title">Open Relo when this PC starts</div>
          <Switch checked={openAtStart} onChange={setOpenAtStart} label="Open Relo when this PC starts" />
        </div>
      </div>
      <button
        type="button"
        className="btn"
        data-primary=""
        onClick={() => {
          void autostartSet(openAtStart).catch(() => {})
          uiCue("close")
          // The window shrinks up toward the notch, then hides; the staged work leaves the notch with it (O12).
          void (s.reduceMotion ? Promise.resolve(() => {}) : collapseToNotch()).then(async (undo) => {
            finish()
            broadcast(ONBOARDING_STAGE_EVENT, clearPayload())
            await hideSettings()
            undo()
          })
        }}
      >
        Start
      </button>
    </>
  )
}
