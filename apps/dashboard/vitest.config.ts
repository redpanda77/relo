import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // The CLI's reference crypto, used only by the interop tests (typed in src/test/cli-e2ee.d.ts).
      "@relo/cli-e2ee": path.resolve(import.meta.dirname, "../../packages/cli/src/crypto/e2ee.mjs"),
    },
  },
  // A test may wait up to 5 s in each findBy/waitFor (src/test/setup.ts), so it gets 15 s in all: a test capped at the
  // same 5 s timed out on the capped release builder before a slow wait could finish or fail on its own.
  test: { environment: "jsdom", setupFiles: "./src/test/setup.ts", css: true, testTimeout: 15_000 },
})
