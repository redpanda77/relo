import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      // The CLI's reference crypto: seals what this PC opens and verifies what it signs (tests only; typed in src/client/cli-e2ee.d.ts).
      "@relo/cli-e2ee": path.resolve(import.meta.dirname, "../../packages/cli/src/crypto/e2ee.mjs"),
    },
  },
  // WebCrypto is globalThis.crypto in Node 22, as in WebView2.
  test: { environment: "node", include: ["src/**/*.test.ts"] },
})
