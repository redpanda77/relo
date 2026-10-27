// The Shortcuts page (SettingsView.swift `Shortcuts`, KeyboardShortcuts.Recorder): click a binding, press the keys.
// A binding is applied at once (shortcutsSet) and, when Rust accepts it, saved as `shortcuts` in settings.json; a
// refused one (taken by another app, used for the other action) says why and changes nothing. Bindings that failed to
// register at launch show their error too, as the Mac shows conflicts.
import { useEffect, useState } from "react"
import { DEFAULT_SHORTCUTS, displayAccelerator, onShortcutsChanged, shortcutsList, shortcutsSet, type ShortcutInfo } from "../shortcuts"
import { recorderKey } from "./recorder"
import type { SettingsPatch } from "./store"
import { Btn, Group, Page, Row } from "./ui"

function Keys({ accelerator }: { accelerator: string }) {
  const keys = displayAccelerator(accelerator)
  if (keys.length === 0) return <span className="row-detail" style={{ marginTop: 0 }}>Not set</span>
  return (
    <span>
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  )
}

function Binding({ info, set }: { info: ShortcutInfo; set: (patch: SettingsPatch) => void }) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const apply = async (accelerator: string | null) => {
    try {
      await shortcutsSet(info.action, accelerator)
      set({ shortcuts: { [info.action]: accelerator ?? "" } })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const out = recorderKey(e)
      if (out.kind === "wait") return
      if (out.kind === "needsModifier") return setError("Add Ctrl, Alt, Shift or Win: a bare key would steal typing from every app.")
      setRecording(false)
      if (out.kind === "set") void apply(out.accelerator)
      else if (out.kind === "clear") void apply(null)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, info.action])

  const failed = info.accelerator !== "" && !info.registered
  const detail = error ?? (failed ? info.error ?? "This shortcut could not be registered." : undefined)
  return (
    <Row title={info.label} detail={detail && <span className="warn">{detail}</span>}>
      {recording ? (
        <button type="button" className="btn recorder" data-recording="" onBlur={() => setRecording(false)} autoFocus>
          Press the shortcut
        </button>
      ) : (
        <button type="button" className="btn recorder" aria-label={`${info.label}: change the shortcut`} onClick={() => (setError(null), setRecording(true))}>
          <Keys accelerator={info.accelerator} />
        </button>
      )}
      {info.accelerator !== info.defaultAccelerator && <Btn onClick={() => void apply(info.defaultAccelerator)}>Reset</Btn>}
      {info.accelerator !== "" && <Btn onClick={() => void apply(null)}>Clear</Btn>}
    </Row>
  )
}

/** Until Rust answers (or in a plain browser): the defaults, as bound. */
const FALLBACK: ShortcutInfo[] = [
  { action: "toggleSneakPeek", label: "Toggle Sneak Peek", accelerator: DEFAULT_SHORTCUTS.toggleSneakPeek, defaultAccelerator: DEFAULT_SHORTCUTS.toggleSneakPeek, registered: true, error: null },
  { action: "toggleNotchOpen", label: "Toggle Notch Open", accelerator: DEFAULT_SHORTCUTS.toggleNotchOpen, defaultAccelerator: DEFAULT_SHORTCUTS.toggleNotchOpen, registered: true, error: null },
]

export function ShortcutsPage({ set }: { set: (patch: SettingsPatch) => void }) {
  const [list, setList] = useState<ShortcutInfo[]>(FALLBACK)
  useEffect(() => {
    void shortcutsList().then((l) => l.length > 0 && setList(l))
    return onShortcutsChanged(setList)
  }, [])
  const of = (action: ShortcutInfo["action"]) => list.find((s) => s.action === action)
  const sneak = of("toggleSneakPeek")
  const open = of("toggleNotchOpen")
  return (
    <Page title="Shortcuts" detail="Keys that work from anywhere. Click one, then press the new keys; Backspace clears it, Esc cancels.">
      <Group title="Media" footer="Sneak Peek shows the media title and artist under the notch for a few seconds.">
        {sneak && <Binding info={sneak} set={set} />}
      </Group>
      <Group>{open && <Binding info={open} set={set} />}</Group>
    </Page>
  )
}
