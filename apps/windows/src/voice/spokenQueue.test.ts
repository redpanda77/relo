import { describe, expect, it } from "vitest"
import type { NotchEventKind } from "../sound/cues"
import { SpokenQueue, STALE_AFTER_MS, type QueuedLine } from "./spokenQueue"

// The lines waiting after their cue (ADR 0015): one at a time, two per burst, then a count; stale news dropped.
const start = 1_000_000_000
const line = (id: string, kind: NotchEventKind, at = 0): QueuedLine => ({ id, kind, text: `${kind} ${id}`, at: start + at })
const open = () => true

describe("SpokenQueue", () => {
  it("three updates in one burst give two lines and a count", () => {
    const queue = new SpokenQueue()
    queue.add([line("a", "finished"), line("b", "yourTurn"), line("c", "finished")])
    expect(queue.next(start, open)?.text).toBe("yourTurn b")
    expect(queue.next(start, open)?.text).toBe("finished a")
    expect(queue.next(start, open)?.text).toBe("And 1 more update.")
    expect(queue.next(start, open)).toBeNull()
  })

  it("questions come first, and questions and failures each get their own line", () => {
    const queue = new SpokenQueue()
    queue.add([line("a", "finished"), line("b", "finished"), line("c", "question"), line("d", "failed"), line("e", "question")])
    const said: string[] = []
    for (let i = 0; i < 6; i++) {
      const next = queue.next(start, open)
      if (next) said.push(next.text)
    }
    expect(said).toEqual(["question c", "question e", "failed d", "And 2 more updates."])
  })

  it("stale news is dropped and an answered question is not said", () => {
    const queue = new SpokenQueue()
    queue.add([line("a", "finished"), line("b", "question"), line("c", "question")])
    const later = start + STALE_AFTER_MS + 1
    expect(queue.next(later, (l) => l.id === "c")?.text).toBe("question c")
    expect(queue.next(later, open)).toBeNull()
  })

  it("a question stays while it is open, however old", () => {
    const queue = new SpokenQueue()
    queue.add([line("q", "question")])
    expect(queue.next(start + 10 * STALE_AFTER_MS, open)?.text).toBe("question q")
  })

  it("a newer line for the same card and kind replaces the older one", () => {
    const queue = new SpokenQueue()
    queue.add([line("a", "yourTurn")])
    queue.add([{ id: "a", kind: "yourTurn", text: "newer", at: start }])
    expect(queue.next(start, open)?.text).toBe("newer")
    expect(queue.isEmpty).toBe(true)
  })

  it("a burst ends when the queue empties", () => {
    const queue = new SpokenQueue()
    queue.add([line("a", "finished"), line("b", "finished")])
    queue.next(start, open)
    queue.next(start, open)
    expect(queue.next(start, open)).toBeNull()
    queue.add([line("c", "finished")])
    expect(queue.next(start, open)?.text).toBe("finished c")
  })

  it("clear drops everything and starts a new burst", () => {
    const queue = new SpokenQueue()
    queue.add([line("a", "finished"), line("b", "finished"), line("c", "finished")])
    queue.next(start, open)
    queue.next(start, open)
    queue.clear()
    expect(queue.isEmpty).toBe(true)
    queue.add([line("d", "finished")])
    expect(queue.next(start, open)?.text).toBe("finished d")
  })

  it("equal ranks keep the order they arrived in", () => {
    const queue = new SpokenQueue()
    queue.add([line("a", "finished"), line("b", "finished")])
    expect(queue.next(start, open)?.id).toBe("a")
  })
})
