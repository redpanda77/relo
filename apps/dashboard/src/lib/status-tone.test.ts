import { describe, expect, it } from "vitest"

import { semanticStatusTone } from "@/lib/status-tone"

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
