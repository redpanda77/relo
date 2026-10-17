import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./src/test-support/database-notice.ts"],
    // worker-database-setup first: every DB suite reads TEST_DATABASE_URL at import, after it is rewritten.
    setupFiles: ["./src/test-support/worker-database-setup.ts", "./src/test-support/work-identity-setup.ts"],
  },
});
