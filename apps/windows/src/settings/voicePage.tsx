// The Voice page (ReloSettingsView.swift `ReloVoiceSettingsView`): the play button on cards, spoken updates, the engine
// and the Relo voice's model (download, progress, cancel, delete), with a preview through the real engine.
import { useEffect, useState } from "react"
import * as voice from "../voice/ipc"
import { speaks, type ReloSettings, type SettingsPatch, type VoiceDetail, type VoiceEngine, type VoiceMode } from "./store"
import { formatBytes } from "./voiceSpeak"
import { Btn, Group, Page, Row, Select, ToggleRow } from "./ui"

export const VOICE_MODE_OPTIONS: ReadonlyArray<{ value: VoiceMode; label: string }> = [
  { value: "soundOnly", label: "Sound only" },
  { value: "soundThenVoice", label: "Sound, then voice" },
  { value: "soundAsKind", label: "Sound as the kind, then voice" },
  { value: "voiceOnly", label: "Voice only" },
]

export const VOICE_DETAIL_OPTIONS: ReadonlyArray<{ value: VoiceDetail; label: string }> = [
  { value: "brief", label: "Brief: the kind and the work" },
  { value: "full", label: "Full: and what happened" },
  { value: "verbose", label: "Verbose: and each finished step" },
]

export const VOICE_ENGINE_OPTIONS: ReadonlyArray<{ value: VoiceEngine; label: string }> = [
  { value: "relo", label: "Relo voice" },
  { value: "system", label: "Windows voice" },
]

export const VOICE_FOOTER =
  "Every line starts with what kind of update it is: Needs you, Failed, Your turn or Finished. With Sound as the kind, the sound says that and the line starts at the work's name; with Voice only, those updates play no sound. A project set to say less with relo voice says less here too. Lines are made and played on this PC from what its cards show; nothing is sent anywhere. Updates are not said during a call or dictation. The Relo voice (Phonon by Gradium) downloads on its own over a connection that is not metered; until then the Windows voice speaks."

/** What the Relo voice row shows and offers for the model's state. */
export function modelRow(m: voice.ModelStatus): { text: string; progress: number | null; action: "download" | "downloadNow" | "cancel" | "delete" | "retry" } {
  switch (m.state) {
    case "missing":
      return m.waitingForNetwork ? { text: "Waiting for a network that is not metered", progress: null, action: "downloadNow" } : { text: formatBytes(m.totalBytes), progress: null, action: "download" }
    case "downloading":
      return { text: `${Math.round(m.fraction * 100)}%`, progress: m.fraction, action: "cancel" }
    case "ready":
      return { text: "Downloaded", progress: null, action: "delete" }
    case "failed":
      return { text: m.error ?? "The download failed", progress: null, action: "retry" }
  }
}

const ACTION_LABEL = { download: "Download", downloadNow: "Download Now", cancel: "Cancel", delete: "Delete", retry: "Try Again" } as const

export function VoicePage({ s, set }: { s: ReloSettings; set: (patch: SettingsPatch) => void }) {
  const [status, setStatus] = useState<voice.VoiceStatus | null>(null)
  useEffect(() => {
    void voice.status().then(setStatus)
    const offModel = voice.onProgress((model) => setStatus((cur) => (cur ? { ...cur, model } : cur)))
    const offState = voice.tauriBackend.onState((state) => setStatus((cur) => (cur ? { ...cur, state } : cur)))
    return () => {
      offModel()
      offState()
    }
  }, [])

  const playing = status !== null && status.state.phase !== "idle"
  const act = (a: ReturnType<typeof modelRow>["action"]) => {
    if (a === "cancel") void voice.cancelDownload()
    else if (a === "delete") void voice.deleteModel().then(() => voice.status().then(setStatus))
    else void voice.download(false)
  }
  const row = status ? modelRow(status.model) : null
  const off = !s.voiceButton
  return (
    <Page title="Voice" detail="The play button on cards, spoken updates, and the Relo voice">
      <Group title="Voice" footer={VOICE_FOOTER}>
        <ToggleRow
          title="Show a play button on cards"
          checked={s.voiceButton}
          onChange={(voiceButton) => {
            set({ voiceButton })
            if (voiceButton && s.voiceMode !== "soundOnly") void voice.start()
          }}
        />
        <Row title="Updates" disabled={off}>
          <Select<VoiceMode> label="Updates" value={s.voiceMode} options={VOICE_MODE_OPTIONS} onChange={(voiceMode) => set({ voiceMode })} />
        </Row>
        <Row title="Spoken detail" disabled={off || !speaks(s.voiceMode)}>
          <Select<VoiceDetail> label="Spoken detail" value={s.voiceDetail} options={VOICE_DETAIL_OPTIONS} onChange={(voiceDetail) => set({ voiceDetail })} />
        </Row>
        <Row title="Voice" disabled={off}>
          <Select<VoiceEngine>
            label="Voice"
            value={s.voiceEngine}
            options={VOICE_ENGINE_OPTIONS}
            onChange={(voiceEngine) => {
              set({ voiceEngine })
              void voice.setEngine(voiceEngine)
            }}
          />
        </Row>
        {s.voiceEngine === "relo" && row && (
          <Row title="Relo voice" disabled={off}>
            {row.progress !== null && <progress className="meter" max={1} value={row.progress} aria-label="Download progress" />}
            <span className="row-detail" style={{ marginTop: 0 }}>{row.text}</span>
            <Btn onClick={() => act(row.action)}>{ACTION_LABEL[row.action]}</Btn>
          </Row>
        )}
        <Row title="Preview" detail={status?.state.error ?? "Says a sentence with the voice above"} disabled={off}>
          <Btn primary onClick={() => (playing ? void voice.tauriBackend.cancel() : void voice.preview())}>
            {playing ? "Stop" : "Preview"}
          </Btn>
        </Row>
      </Group>
    </Page>
  )
}
