import { describe, expect, it } from "vitest"

import { semanticStatusTone, toneFor } from "@/lib/status-tone"

describe("semanticStatusTone", () => {
  it("keeps operational status semantics stable across features", () => {
    expect(semanticStatusTone("active")).toBe("active")
    expect(semanticStatusTone("ended")).toBe("success")
    expect(semanticStatusTone("pending")).toBe("warning")
    expect(semanticStatusTone("failed")).toBe("danger")
    expect(semanticStatusTone("live_activity")).toBe("info")
    expect(semanticStatusTone("unknown")).toBe("neutral")
  })
})

describe("toneFor", () => {
  it("maps every state onto the meaning palette", () => {
    expect(toneFor("delivered")).toBe("mint")
    expect(toneFor("active")).toBe("cyan")
    expect(toneFor("running")).toBe("cyan")
    expect(toneFor("pending")).toBe("yellow")
    expect(toneFor("failed")).toBe("red")
    expect(toneFor("question")).toBe("violet")
    expect(toneFor("whatever")).toBe("neutral")
  })
})
