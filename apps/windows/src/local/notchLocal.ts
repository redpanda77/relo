// The notch's half of local mode: it signs itself in to Relo on this PC with the code Rust hands it (no browser, no
// password), signs out when the owner leaves for a server, and reports where its own link stands (`owner_state`) so
// the setup in the Settings window can see it work (the Mac's `signInLocally`).
import { listen } from "@tauri-apps/api/event"
import { inTauri } from "../bridge"
import { onLocalSignIn, reportOwnerState, type LocalSignIn } from "./api"

/** What the notch's owner app offers local mode. */
export interface LocalOwner {
  signInLocally(origin: string, code: string, verifier: string): Promise<void>
  signOut(): Promise<void>
  /** Calls back with the connection state now and on every change. */
  subscribe(listener: () => void): () => void
  getView(): { connection: string; approval?: "waiting" | "approved" | null; problem?: string | null }
}

/** Wires `app` to the local events; returns the unsubscribe. */
export function attachLocal(app: LocalOwner): () => void {
  const offs: Array<() => void> = []
  offs.push(onLocalSignIn((s: LocalSignIn) => void app.signInLocally(s.origin, s.code, s.verifier)))
  if (inTauri) {
    const p = listen("local_sign_out", () => void app.signOut())
    offs.push(() => void p.then((off) => off()))
  }
  let last = ""
  const report = () => {
    const view = app.getView()
    const approval = view.approval ?? null
    const problem = view.problem ?? null
    const key = JSON.stringify([view.connection, approval, problem])
    if (key === last) return
    last = key
    reportOwnerState(view.connection, { approval, problem })
  }
  offs.push(app.subscribe(report))
  report()
  return () => offs.splice(0).forEach((off) => off())
}
