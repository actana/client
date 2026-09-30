import { defineConfig } from "vitest/config";
import path from "node:path";

const sdkSrc = path.resolve(import.meta.dirname, "src");
// Pinned Control sources for test-only @actana/core and @actana/shared aliases (d7eeb65).
const controlPinSrc = path.resolve(import.meta.dirname, "../../.vendor/control-d7eeb65/src");

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: [
      { find: /^@actana\/sdk\/pairing\/server$/, replacement: path.join(sdkSrc, "pairing/server/index.ts") },
      {
        find: /^@actana\/sdk\/pairing\/stores\/json-file$/,
        replacement: path.join(sdkSrc, "pairing/stores/json-file.ts"),
      },
      {
        find: /^@actana\/sdk\/pairing\/stores\/postgres$/,
        replacement: path.join(sdkSrc, "pairing/stores/postgres.ts"),
      },
      { find: /^@actana\/sdk\/pairing$/, replacement: path.join(sdkSrc, "pairing.ts") },
      { find: /^@actana\/sdk\/core$/, replacement: path.join(sdkSrc, "core.ts") },
      { find: /^@actana\/sdk\/core\/link-frames$/, replacement: path.join(sdkSrc, "core/browser.ts") },
      { find: /^@actana\/sdk\/search$/, replacement: path.join(sdkSrc, "search.ts") },
      // Control's Core imports the SDK by its old flat paths; map them to /core.
      { find: /^@actana\/sdk\/core-link-frames$/, replacement: path.join(sdkSrc, "core/link-frames.ts") },
      {
        find: /^@actana\/sdk\/core-files-error-codes$/,
        replacement: path.join(sdkSrc, "core/files-error-codes.ts"),
      },
      { find: /^@actana\/sdk\/core-client$/, replacement: path.join(sdkSrc, "core/client.ts") },
      { find: /^@actana\/sdk\/core-pairing-wire$/, replacement: path.join(sdkSrc, "pairing/wire.ts") },
      {
        find: /^@actana\/sdk\/__tests__\/files-error-code-contract$/,
        replacement: path.join(sdkSrc, "__tests__/files-error-code-contract.ts"),
      },
      {
        find: /^@actana\/sdk\/__tests__\/files-list-contract$/,
        replacement: path.join(sdkSrc, "__tests__/files-list-contract.ts"),
      },
      // Test-only: core client suites drive the real Core server (ADR 0025 D2).
      { find: "@actana/core", replacement: controlPinSrc },
      { find: "@actana/shared", replacement: controlPinSrc },
    ],
  },
});
