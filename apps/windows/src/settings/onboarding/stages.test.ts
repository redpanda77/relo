import { describe, expect, it } from "vitest"
import { canContinue, initialProgress, nextPending, normalizeOrigin, originFromInstaller, reduce, RELO_ROW, RELO_ROW_NAME, resume, setupFinished, type Event, type Progress } from "./stages"

const run = (p: Progress, ...events: Event[]) => events.reduce(reduce, p)
const agents = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
]

describe("originFromInstaller", () => {
  it("prefers the launch flag, then the installer's record, and shrugs off failures", async () => {
    const record = async () => "https://recorded.example.com"
    expect(await originFromInstaller(async () => ({ origin: "https://flag.example.com" }), record)).toBe("https://flag.example.com")
    expect(await originFromInstaller(async () => null, record)).toBe("https://recorded.example.com")
    expect(await originFromInstaller(async () => Promise.reject(new Error("x")), record)).toBe("https://recorded.example.com")
    expect(await originFromInstaller(async () => null, async () => null)).toBeNull()
    expect(await originFromInstaller(async () => null, async () => "")).toBeNull()
    expect(await originFromInstaller(async () => null, async () => Promise.reject(new Error("x")))).toBeNull()
  })
})

describe("normalizeOrigin", () => {
  it("accepts https servers and bare hostnames, drops paths", () => {
    expect(normalizeOrigin("relo.example.com")).toBe("https://relo.example.com")
    expect(normalizeOrigin(" https://relo.example.com/ ")).toBe("https://relo.example.com")
    expect(normalizeOrigin("http://localhost:8787")).toBe("http://localhost:8787")
  })
  it("refuses everything else", () => {
    for (const bad of ["", "http://relo.example.com", "https://a.com/path", "https://a.com?x=1", "https://u:p@a.com", "javascript:alert(1)", "ftp://a.com", "nodots"]) {
      expect(normalizeOrigin(bad), bad).toBeNull()
    }
  })
})

describe("stage transitions", () => {
  it("walks Hello, Sound, Where", () => {
    const p = run(initialProgress(), { type: "continue" }, { type: "continue" })
    expect(p.stage).toBe("where")
  })

  it("Where: Run Relo on this PC is the default and goes straight to its steps; a server needs a valid origin", () => {
    let p: Progress = { ...initialProgress(), stage: "where" }
    expect(p.place).toBe("local")
    expect(canContinue(p)).toBe(true)
    expect(reduce(p, { type: "continue" }).stage).toBe("local")
    p = run(p, { type: "choosePlace", place: "server" })
    expect(canContinue(p)).toBe(false)
    p = run(p, { type: "setOrigin", origin: "nope" })
    expect(reduce(p, { type: "continue" }).stage).toBe("where")
    p = run(p, { type: "setOrigin", origin: "relo.example.com" }, { type: "continue" })
    expect(p.stage).toBe("server")
  })

  it("sign-in waits, then owner_state advances to Agents", () => {
    let p: Progress = { ...initialProgress(), stage: "server", origin: "relo.example.com" }
    expect(canContinue(p)).toBe(false)
    p = run(p, { type: "signInStarted" })
    expect(p.signIn).toBe("waiting")
    expect(run(p, { type: "ownerState", state: "signingIn" }).stage).toBe("server")
    p = run(p, { type: "ownerState", state: "live" })
    expect(p).toMatchObject({ stage: "agents", signIn: "signedIn" })
  })

  it("sign-in cannot start without a valid origin and can be cancelled", () => {
    const p: Progress = { ...initialProgress(), stage: "server", origin: "" }
    expect(run(p, { type: "signInStarted" }).signIn).toBe("idle")
    const q = run({ ...p, origin: "relo.example.com" }, { type: "signInStarted" }, { type: "signInCancelled" })
    expect(q.signIn).toBe("idle")
  })

  it("changing the origin restarts the sign-in", () => {
    const p = run({ ...initialProgress(), stage: "where", origin: "a.example.com", signIn: "signedIn" }, { type: "setOrigin", origin: "b.example.com" })
    expect(p.signIn).toBe("idle")
  })

  it("Agents: everything found is ticked; with none chosen only the relo command is set up", () => {
    let p: Progress = { ...initialProgress(), stage: "agents" }
    p = run(p, { type: "agentsDetected", agents })
    expect(p.selected).toEqual(["claude-code", "codex"])
    p = run(p, { type: "toggleAgent", id: "codex" })
    expect(p.selected).toEqual(["claude-code"])
    // A second detection keeps the owner's unticking.
    expect(run(p, { type: "agentsDetected", agents }).selected).toEqual(["claude-code"])
    const none = run(p, { type: "toggleAgent", id: "claude-code" }, { type: "continue" })
    expect(none.stage).toBe("setup")
    expect(none.rows).toEqual([{ id: RELO_ROW, name: RELO_ROW_NAME, status: "pending" }])
    const bare = run({ ...initialProgress(), stage: "agents" }, { type: "agentsDetected", agents: [] }, { type: "continue" })
    expect(bare.rows.map((r) => r.id)).toEqual([RELO_ROW])
    expect(run(bare, { type: "rowStarted", id: RELO_ROW }, { type: "rowFinished", id: RELO_ROW, ok: true }, { type: "continue" }).stage).toBe("ready")
  })

  it("the relo command is set up before the agents, and skipping it skips them too", () => {
    let p: Progress = run({ ...initialProgress(), stage: "agents" }, { type: "agentsDetected", agents }, { type: "continue" })
    expect(p.rows.map((r) => r.id)).toEqual([RELO_ROW, "claude-code", "codex"])
    expect(nextPending(p)?.id).toBe(RELO_ROW)
    p = run(p, { type: "rowStarted", id: RELO_ROW }, { type: "rowFinished", id: RELO_ROW, ok: false })
    expect(p.rows[0]).toMatchObject({ status: "failed", message: "Relo could not add the relo command to this PC." })
    expect(nextPending(p)).toBeNull() // the agents wait for Retry or Skip
    expect(run(p, { type: "skip", id: RELO_ROW }).rows.map((r) => r.status)).toEqual(["skipped", "skipped", "skipped"])
    // A retry that works lets the agents go on one by one.
    p = run(p, { type: "retry", id: RELO_ROW }, { type: "rowStarted", id: RELO_ROW }, { type: "rowFinished", id: RELO_ROW, ok: true })
    expect(nextPending(p)?.id).toBe("claude-code")
    // Skipping an agent leaves the others alone.
    expect(run(p, { type: "skip", id: "codex" }).rows.map((r) => r.status)).toEqual(["done", "pending", "skipped"])
  })

  it("Setup runs one agent at a time, blocks on a failure, retries and skips", () => {
    let p: Progress = run({ ...initialProgress(), stage: "agents" }, { type: "agentsDetected", agents }, { type: "continue" })
    expect(p.stage).toBe("setup")
    p = run(p, { type: "rowStarted", id: RELO_ROW }, { type: "rowFinished", id: RELO_ROW, ok: true })
    expect(p.rows.map((r) => r.status)).toEqual(["done", "pending", "pending"])
    expect(nextPending(p)?.id).toBe("claude-code")
    p = run(p, { type: "rowStarted", id: "claude-code" })
    expect(nextPending(p)).toBeNull() // one at a time
    p = run(p, { type: "rowFinished", id: "claude-code", ok: false, message: "boom" })
    expect(p.rows[1]).toMatchObject({ status: "failed", message: "boom" })
    expect(nextPending(p)).toBeNull() // a failure waits for Retry or Skip
    expect(canContinue(p)).toBe(false)
    p = run(p, { type: "retry", id: "claude-code" })
    expect(nextPending(p)?.id).toBe("claude-code")
    p = run(p, { type: "rowStarted", id: "claude-code" }, { type: "rowFinished", id: "claude-code", ok: true })
    p = run(p, { type: "skip", id: "codex" })
    expect(p.rows.map((r) => r.status)).toEqual(["done", "done", "skipped"])
    expect(setupFinished(p)).toBe(true)
    expect(run(p, { type: "continue" }).stage).toBe("ready")
  })

  it("a failed row with no message gets one; done and skipped rows are not retried or skipped again", () => {
    let p: Progress = { ...initialProgress(), stage: "setup", rows: [{ id: "codex", name: "Codex", status: "running" }] }
    p = run(p, { type: "rowFinished", id: "codex", ok: false })
    expect(p.rows[0]?.message).toBe("Relo could not set up Codex.")
    const done: Progress = { ...p, rows: [{ id: "codex", name: "Codex", status: "done" }] }
    expect(run(done, { type: "retry", id: "codex" }, { type: "skip", id: "codex" }).rows[0]?.status).toBe("done")
  })

  it("Back goes to the previous screen and drops finished rows", () => {
    expect(run({ ...initialProgress(), stage: "server" }, { type: "back" }).stage).toBe("where")
    const server = { ...initialProgress(), place: "server" as const }
    expect(run({ ...server, stage: "ready", rows: [{ id: "codex", name: "Codex", status: "done" }] }, { type: "back" })).toMatchObject({ stage: "agents", rows: [] })
    expect(run({ ...server, stage: "ready" }, { type: "back" }).stage).toBe("agents")
    expect(run({ ...initialProgress(), stage: "setup", rows: [{ id: "codex", name: "Codex", status: "failed" }] }, { type: "back" })).toMatchObject({ stage: "agents", rows: [] })
  })

  it("resume sets an interrupted run back to pending", () => {
    const p = resume({ ...initialProgress(), stage: "setup", rows: [{ id: "codex", name: "Codex", status: "running" }] })
    expect(p.rows[0]?.status).toBe("pending")
  })
})
