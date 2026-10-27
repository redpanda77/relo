import { settingsStore } from "../settings/store"
import { createMirrorHost, tauriWire } from "./bridge"

export * from "./bridge"
export { mirroredOwner, STARTING_VIEW, useMirroredState } from "./useMirroredState"

/** The main notch's host: broadcasts only while "Show on all displays" is on. */
const host = createMirrorHost(tauriWire, () => settingsStore.get().showOnAllDisplays)
export const publishNotchState = host.publish
export const serveMirrors = host.attach
