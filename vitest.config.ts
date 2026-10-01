// Root vitest project — repo-level scripts and the runnable examples (examples/panel-recipe). Package suites live in
// `packages/*/vitest.config.ts`; `pnpm test` drives each from
// `scripts/run-unit-tests.mjs`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.mjs", "examples/**/*.test.mjs"],
  },
});
