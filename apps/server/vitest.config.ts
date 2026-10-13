import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test-support/work-identity-setup.ts"],
  },
});
