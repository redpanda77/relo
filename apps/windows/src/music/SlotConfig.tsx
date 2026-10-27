// MusicSlotConfigurationView.swift: the five-slot preview (drag to reorder, drop a palette control onto a slot, drop on
// the trash to clear), the palette (drag or click to add) and "Reset to Defaults". Drag payloads are the Mac's strings.
// The Settings window needs `dragDropEnabled: false` (tauri.conf.json) so WebView2 delivers HTML5 drag events.

import { useState, type DragEvent } from "react"
import { ControlGlyph, TrashIcon } from "./icons"
import { addControl, applyDrop, applyTrashDrop, clearSlot, encodeDrop, LABELS, PICKER_OPTIONS, resetSlots } from "./slots"
import { SLOT_COUNT, type MusicControl } from "./types"
import "./music.css"

const TYPE = "text/plain"

export function SlotConfig({ slots, onChange }: { slots: MusicControl[]; onChange: (slots: MusicControl[]) => void }) {
  const [over, setOver] = useState<number | "trash" | null>(null)
  const drop = (e: DragEvent, to: number | "trash") => {
    e.preventDefault()
    setOver(null)
    const raw = e.dataTransfer.getData(TYPE)
    onChange(to === "trash" ? applyTrashDrop(slots, raw) : applyDrop(slots, raw, to))
  }
  const allow = (e: DragEvent, to: number | "trash") => {
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    setOver(to)
  }
  const cells = Array.from({ length: SLOT_COUNT }, (_, i) => slots[i] ?? "none")

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <span style={{ fontWeight: 600, opacity: 0.7 }}>Layout Preview</span>
        <span style={{ fontSize: 12, opacity: 0.55 }}>Drag items in the preview to reorder or drop from the palette</span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
        <div style={{ display: "flex", gap: 6, padding: 12, borderRadius: 8, background: "rgb(255 255 255 / 0.05)" }}>
          {cells.map((c, i) => (
            <div
              key={i}
              className="mu-slot"
              data-empty={c === "none" ? "" : undefined}
              data-over={over === i ? "" : undefined}
              draggable={c !== "none"}
              title={c === "none" ? "Empty slot" : LABELS[c]}
              onDragStart={(e) => {
                e.dataTransfer.setData(TYPE, encodeDrop({ kind: "slot", index: i }))
                e.dataTransfer.effectAllowed = "move"
              }}
              onDragOver={(e) => allow(e, i)}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => drop(e, i)}
              onDoubleClick={() => onChange(clearSlot(slots, i))}
            >
              {c !== "none" && <ControlGlyph control={c} size={c === "playPause" ? 20 : 17} />}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <div className="mu-slot" data-over={over === "trash" ? "" : undefined} style={{ width: 56, height: 56, borderRadius: 10 }} onDragOver={(e) => allow(e, "trash")} onDragLeave={() => setOver(null)} onDrop={(e) => drop(e, "trash")} aria-label="Clear slot">
            <TrashIcon size={18} />
          </div>
          <span style={{ fontSize: 11, opacity: 0.55 }}>Clear slot</span>
        </div>
      </div>

      <div style={{ height: 1, background: "rgb(255 255 255 / 0.1)" }} />

      <div>
        <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 6 }}>Drag a control onto a slot, or click it to add</div>
        <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
          {PICKER_OPTIONS.map((c) => (
            <div key={c} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: 60, flex: "none" }}>
              <button
                type="button"
                className="mu-slot"
                draggable
                aria-label={`Add ${LABELS[c]}`}
                onDragStart={(e) => {
                  e.dataTransfer.setData(TYPE, encodeDrop({ kind: "control", control: c }))
                  e.dataTransfer.effectAllowed = "copy"
                }}
                onClick={() => onChange(addControl(slots, c))}
                style={{ cursor: "grab" }}
              >
                <ControlGlyph control={c} size={c === "playPause" ? 20 : 17} />
              </button>
              <span style={{ fontSize: 11, opacity: 0.55, textAlign: "center" }}>{LABELS[c]}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={() => onChange(resetSlots())}>
          Reset to Defaults
        </button>
      </div>
    </div>
  )
}
