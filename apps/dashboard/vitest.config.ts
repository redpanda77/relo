import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // The CLI's reference crypto, used only by the interop tests (typed in src/test/cli-e2ee.d.ts).
      "@relo/cli-e2ee": path.resolve(import.meta.dirname, "../../packages/cli/src/e2ee.mjs"),
    },
  },
  test: { environment: "jsdom", setupFiles: "./src/test/setup.ts", css: true },
})
