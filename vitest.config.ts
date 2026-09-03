import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "vendor/umami/src"),
    },
  },
  test: {
    exclude: [
      "**/node_modules/**",
      // Dashboard-only vendored tests that reach into src/app/(main)/* (not
      // vendored — out of scope per the fork plan).
      "vendor/umami/src/lib/boards.test.ts",
      "vendor/umami/src/lib/colors.test.ts",
      // Needs a real Postgres with the umami schema — run separately via
      // `bun run test:integration`, not part of the plain unit-test run.
      "tests/integration/**",
    ],
  },
});
