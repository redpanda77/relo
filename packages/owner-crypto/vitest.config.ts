import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      // The CLI's reference crypto, used only by the interop tests (typed in test/cli-e2ee.d.ts).
      "@relo/cli-e2ee": path.resolve(import.meta.dirname, "../cli/src/crypto/e2ee.mjs"),
    },
  },
  // WebCrypto is globalThis.crypto in Node 22, as in a browser or WebView2: no DOM environment is needed.
  test: { environment: "node", include: ["test/**/*.test.ts"] },
})
