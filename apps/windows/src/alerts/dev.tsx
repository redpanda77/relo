// Dev harness (alerts-dev.html, never shipped): the real controller, cue player (Web Audio, the real .wav files) and voice
// orchestration, on a snapshot sequence that changes over time, with the browser's speechSynthesis standing in for the Relo
// voice. It logs every cue played and line spoken, so a run shows the right cue + voice for each change.
//   http://localhost:1420/alerts-dev.html?mode=soundThenVoice&detail=verbose   then press "Play sequence"

import { StrictMode, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { EMPTY, type Presentation, type Row, type Section, type SectionKind, type Tone } from "../relo/presentation"
import { settingsStore, type ReloSettings } from "../settings/store"
import { cuePlayer, isQuiet, type Cue } from "../sound"
import type { VoiceBackend, VoiceState } from "../voice/ipc"
import { VoiceMoments } from "../voice/moments"
import { AlertsController } from "./controller"

const params = new URLSearchParams(location.search)
const log: string[] = []
const lines = new Set<() => void>()
const t0 = Date.now()
const stamp = (message: string) => {
  log.push(`+${((Date.now() - t0) / 1000).toFixed(2)}s ${message}`)
  lines.forEach((cb) => cb())
}

// Log what the player plays.
const play = cuePlayer.play.bind(cuePlayer)
cuePlayer.play = (cue: Cue, options?: { force?: boolean }) => {
  const played = play(cue, options)
  stamp(`${played ? "CUE   " : "cue(skipped) "}${cue}`)
  return played
}

let listener: ((s: VoiceState) => void) | null = null
const state = (phase: VoiceState["phase"]): VoiceState => ({ phase, id: null, engine: "system", error: null })
const backend: VoiceBackend = {
  async speak(_id, text) {
    stamp(`VOICE ${text}`)
    listener?.(state("playing"))
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.onend = utterance.onerror = () => listener?.(state("idle"))
    speechSynthesis.speak(utterance)
    // No audio device in some previews: never hold the queue for more than 6 s.
    setTimeout(() => listener?.(state("idle")), 6_000)
  },
  async cancel() {
    speechSynthesis.cancel()
    listener?.(state("idle"))
  },
  async microphoneInUse() {
    return false
  },
  onState(cb) {
    listener = cb
    return () => void (listener = null)
  },
}

const voice = new VoiceMoments({
  settings: () => settingsStore.get(),
  quiet: () => isQuiet(),
  cues: cuePlayer,
  voice: backend,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})
voice.attach()
const controller = new AlertsController(
  {
    settings: () => settingsStore.get(),
    quiet: () => isQuiet(),
    cues: cuePlayer,
    voice,
    speech: { speak: backend.speak, cancel: backend.cancel, microphoneInUse: backend.microphoneInUse, ready: async () => true, current: async () => null },
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
  EMPTY,
)

const row = (id: string, tone: Tone, extra: Partial<Row> = {}): Row => ({
  id, title: `Work ${id}`, status: null, project: null, source: null, tone, stepsDone: null, stepsTotal: null, currentStep: null,
  startedAt: 0, questionId: null, notificationId: null, questionPending: false, unreadable: false, questionMissed: false,
  computerIcon: null, declaredAt: 0, roundOutcome: null, outline: null, currentIndex: null, currentFill: null, ...extra,
})
const SECTION: Record<Tone, SectionKind> = { needsYou: "needsYou", yourTurn: "waitingOnYou", working: "running", done: "recent", failed: "recent", dropped: "recent", leftUnfinished: "recent", quiet: "quiet", paused: "paused" }
const pres = (...rows: Row[]): Presentation => {
  const sections: Section[] = []
  for (const r of rows) {
    const found = sections.find((s) => s.kind === SECTION[r.tone])
    if (found) found.rows.push(r)
    else sections.push({ kind: SECTION[r.tone], rows: [r] })
  }
  return { ...EMPTY, sections }
}
const SPOKEN = {
  deploy: { spoken: "Shipped and verified.", name: "Release cut", voice: null },
  ask: { spoken: null, name: "Database migration", voice: null },
}
/** Each step is what the next summary shows; `wait` is the pause before it (ms). */
const sequence: Array<{ label: string; wait: number; presentation: Presentation; extra?: { questions?: Record<string, { prompt: string }>; answers?: Record<string, { state: string }> } }> = [
  { label: "first summary (baseline, silent)", wait: 0, presentation: pres(row("deploy", "working", { stepsDone: 1, stepsTotal: 4, currentStep: "Run the tests", spokenName: "Release cut" })) },
  { label: "a plan step finishes (tick, Every step line)", wait: 3_000, presentation: pres(row("deploy", "working", { stepsDone: 2, stepsTotal: 4, currentStep: "Build the installer", spokenName: "Release cut" })) },
  { label: "a question arrives (needs-you, then its line)", wait: 6_000, presentation: pres(row("deploy", "working", { stepsDone: 2, stepsTotal: 4, currentStep: "Build the installer" }), row("ask", "needsYou", { questionId: "q1", notificationId: "n1", questionPending: true })), extra: { questions: { q1: { prompt: "Run the migration on production? It locks the users table." } } } },
  { label: "the owner answers (sent)", wait: 6_000, presentation: pres(row("deploy", "working", { stepsDone: 2, stepsTotal: 4, currentStep: "Build the installer" })), extra: { answers: { q1: { state: "accepted" } } } },
  { label: "the work finishes (done, then its line)", wait: 6_000, presentation: pres(row("deploy", "done", { stepsDone: 4, stepsTotal: 4 })) },
]

function App() {
  const [, force] = useState(0)
  const running = useRef(false)
  useEffect(() => {
    const cb = () => force((n) => n + 1)
    lines.add(cb)
    return () => void lines.delete(cb)
  }, [])
  const start = async () => {
    if (running.current) return
    running.current = true
    await settingsStore.start()
    const patch: Partial<ReloSettings> = {
      voiceMode: (params.get("mode") as ReloSettings["voiceMode"]) ?? "soundThenVoice",
      voiceDetail: (params.get("detail") as ReloSettings["voiceDetail"]) ?? "verbose",
      sounds: true,
    }
    settingsStore.update(patch)
    await cuePlayer.preload()
    stamp(`settings ${JSON.stringify({ mode: patch.voiceMode, detail: patch.voiceDetail })}`)
    for (const step of sequence) {
      await new Promise((r) => setTimeout(r, step.wait))
      stamp(`--- ${step.label}`)
      controller.receive({ hasData: true, presentation: step.presentation, spoken: SPOKEN, ...step.extra })
    }
    await new Promise((r) => setTimeout(r, 8_000))
    stamp("--- end")
  }
  return (
    <main style={{ fontFamily: "ui-monospace, monospace", padding: 16 }}>
      <button id="go" onClick={() => void start()}>Play sequence</button>
      <pre id="log">{log.join("\n")}</pre>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>)
