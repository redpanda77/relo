import { describe, expect, it, vi } from "vitest"
import type { OwnerView } from "../client/ownerApp"
import { ACTION_EVENT, createMirrorClient, createMirrorHost, HELLO_EVENT, performAction, STATE_EVENT, type MirrorTarget, type Wire } from "./bridge"
import { mirroredOwner, STARTING_VIEW } from "./useMirroredState"

/** Two windows' worth of Tauri events: every emit reaches every listener. */
function bus(): Wire {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  return {
    emit: (name, payload) => {
      const copy = JSON.parse(JSON.stringify(payload ?? null)) as unknown // events cross as JSON
      queueMicrotask(() => listeners.get(name)?.forEach((cb) => cb(copy)))
    },
    listen: async (name, cb) => {
      const set = listeners.get(name) ?? new Set()
      listeners.set(name, set)
      set.add(cb)
      return () => void set.delete(cb)
    },
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

function target(): MirrorTarget & { calls: unknown[][] } {
  const calls: unknown[][] = []
  const rec = (name: string) => (...args: unknown[]) => void calls.push([name, ...args])
  return {
    calls,
    answer: rec("answer"), dismissMissed: rec("dismiss"), signIn: rec("signIn"), cancelSignIn: rec("cancelSignIn"), refresh: rec("refresh"),
    approveComputer: rec("approve"), declineComputer: rec("decline"), installUpdate: rec("install"), later: rec("later"),
    dismissFailure: rec("dismissFailure"), signOut: rec("signOut"), switchAccount: rec("switchAccount"), viewChanged: rec("viewChanged"),
  }
}

const view = (over: Partial<OwnerView> = {}): OwnerView => ({ ...STARTING_VIEW, connection: "live", ...over })

describe("the state bridge", () => {
  it("a mirror receives what the main notch publishes", async () => {
    const wire = bus()
    const host = createMirrorHost(wire, () => true)
    const client = createMirrorClient(wire)
    client.start()
    await tick()
    host.publish(view({ accountEmail: "a@b.c", offline: true }))
    await tick()
    expect(client.getView()).toMatchObject({ connection: "live", accountEmail: "a@b.c", offline: true })
  })

  it("a mirror that starts late is brought up to date by its hello", async () => {
    const wire = bus()
    const host = createMirrorHost(wire, () => false) // nothing is broadcast while no mirror is wanted
    host.attach(target())
    host.publish(view({ serverOrigin: "https://relo.example" }))
    const client = createMirrorClient(wire)
    client.start()
    await tick()
    await tick()
    expect(client.getView()?.serverOrigin).toBe("https://relo.example")
  })

  it("does not broadcast while Show on all displays is off", async () => {
    const wire = bus()
    const seen = vi.fn()
    await wire.listen(STATE_EVENT, seen)
    const host = createMirrorHost(wire, () => false)
    host.publish(view())
    await tick()
    expect(seen).not.toHaveBeenCalled()
  })

  it("notifies subscribers on every new view", async () => {
    const wire = bus()
    const host = createMirrorHost(wire, () => true)
    const client = createMirrorClient(wire)
    const changed = vi.fn()
    client.subscribe(changed)
    client.start()
    await tick()
    host.publish(view())
    host.publish(view({ offline: true }))
    await tick()
    expect(changed).toHaveBeenCalledTimes(2)
  })
})

describe("action forwarding", () => {
  it("every owner action in a mirror is performed by the main notch", async () => {
    const wire = bus()
    const t = target()
    createMirrorHost(wire, () => true).attach(t)
    const client = createMirrorClient(wire)
    const owner = mirroredOwner(STARTING_VIEW, client.act)
    owner.input.onAnswer?.("q1", "yes" as never, "opt")
    await owner.signIn("https://relo.example")
    owner.cancelSignIn()
    owner.retry()
    owner.approveComputer("c1")
    owner.declineComputer("c2")
    owner.installUpdate()
    owner.later()
    owner.dismissFailure()
    owner.signOut()
    owner.switchAccount()
    owner.onOpenChange(true)
    owner.onOpenChange(false) // a closing mirror says nothing
    owner.input.onDismiss?.("q2")
    await tick()
    expect(t.calls).toEqual([
      ["answer", "q1", "yes", "opt"], ["signIn", "https://relo.example"], ["cancelSignIn"], ["refresh"], ["approve", "c1"], ["decline", "c2"], ["install"],
      ["later"], ["dismissFailure"], ["signOut"], ["switchAccount"], ["viewChanged", true], ["dismiss", "q2"],
    ])
  })

  it("refuses anything that is not an action", () => {
    const t = target()
    for (const bad of [null, "x", {}, { kind: "exec" }, { kind: "answer" }, { kind: "approveComputer", id: "" }, { kind: "dismiss", interactionId: 3 }]) {
      expect(performAction(t, bad)).toBe(false)
    }
    expect(t.calls).toEqual([])
  })

  it("the mirrored owner draws the broadcast view and is enabled", () => {
    const v = view({ questions: { q: { kind: "yesNo", prompt: "Deploy?" } as never } })
    const owner = mirroredOwner(v, () => {})
    expect(owner.enabled).toBe(true)
    expect(owner.input.questions).toBe(v.questions)
    expect(owner.view).toBe(v)
  })

  it("uses the event names Rust and the pages agree on", () => {
    expect([STATE_EVENT, ACTION_EVENT, HELLO_EVENT]).toEqual(["notch_state", "mirror_action", "mirror_hello"])
  })
})
