// The Shelf settings page, ported from the Mac's `Shelf` settings view (SettingsView.swift): Enable shelf, open by
// default, expanded drag detection, copy on drag, remove after dragging. The Quick Share service picker has no
// Windows counterpart (AirDrop and the other Mac providers): sharing always opens the Windows share sheet.
//
// Registration (one line each, in files this change does not own):
//   settings/SettingsApp.tsx  PAGES:   { id: "shelf", title: "Shelf", color: "#e08e0b", group: "notch", icon: svg("M3 13l1.6-5h6.8L13 13M3 13v1.5h10V13") },
//   settings/SettingsApp.tsx  render:  {page === "shelf" && <ShelfPage />}   (import { ShelfPage } from "./shelf")
//   settings_window.rs PAGES: add "shelf" to the accepted page ids.
import { useShelf } from "../shelf/store"
import * as ipc from "../shelf/ipc"
import type { ShelfSettings } from "../shelf/types"
import { Btn, Group, Page, Row, ToggleRow } from "./ui"

export interface ShelfPageProps {
  /** Tests and previews can pass settings and a setter; by default the page is live. */
  settings?: ShelfSettings
  onChange?: (patch: Partial<ShelfSettings>) => void
  itemCount?: number
  onClear?: () => void
}

export function ShelfPageView({ settings: s, onChange, itemCount = 0, onClear }: Required<Pick<ShelfPageProps, "settings" | "onChange">> & ShelfPageProps) {
  return (
    <Page title="Shelf" detail="Keep files, text and links in the notch while you move things around">
      <Group title="General" footer="Drag files, text or links onto the notch to keep them here. Drag them out to Explorer or any app.">
        <ToggleRow title="Enable shelf" checked={s.enabled} onChange={(enabled) => onChange({ enabled })} />
        <ToggleRow title="Open shelf by default if items are present" checked={s.openByDefault} disabled={!s.enabled} onChange={(openByDefault) => onChange({ openByDefault })} />
        <ToggleRow title="Tap the shelf to open items" detail="Click an item to open it; off: items only drag out" checked={s.tapToOpen} disabled={!s.enabled} onChange={(tapToOpen) => onChange({ tapToOpen })} />
        <ToggleRow
          title="Expanded drag detection area"
          detail="Open the notch as soon as a drag reaches the area it will take, not only when it touches the closed notch"
          checked={s.expandedDragDetection}
          disabled={!s.enabled}
          onChange={(expandedDragDetection) => onChange({ expandedDragDetection })}
        />
        <ToggleRow title="Copy items on drag" detail="Off: Explorer may move the original file when you drop it" checked={s.copyOnDrag} disabled={!s.enabled} onChange={(copyOnDrag) => onChange({ copyOnDrag })} />
        <ToggleRow title="Remove from shelf after dragging" checked={s.autoRemove} disabled={!s.enabled} onChange={(autoRemove) => onChange({ autoRemove })} />
      </Group>
      <Group title="Share" footer="Files dropped on the Share tile, or picked by clicking it, go to the Windows share sheet (Nearby Sharing, Mail, Teams and the apps you have installed).">
        <Row title="Share service" detail="Windows share sheet" />
        <Row title="Shelf items" detail={itemCount === 0 ? "Nothing on the shelf" : `${itemCount} on the shelf`} disabled={itemCount === 0}>
          <Btn disabled={itemCount === 0} onClick={onClear}>
            Remove all
          </Btn>
        </Row>
      </Group>
    </Page>
  )
}

/** The page the Settings window shows. Reads and writes through Rust, so the notch follows at once. */
export function ShelfPage() {
  const s = useShelf()
  return (
    <ShelfPageView
      settings={s.settings}
      itemCount={s.items.length}
      onChange={(patch) => void ipc.setSettings(patch)}
      onClear={() => void ipc.remove(s.items.map((i) => i.id))}
    />
  )
}
