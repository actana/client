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
    alias: {
      "@actana/sdk/pairing/server": path.join(sdkSrc, "pairing/server/index.ts"),
      "@actana/sdk/pairing/stores/json-file": path.join(sdkSrc, "pairing/stores/json-file.ts"),
      "@actana/sdk/pairing/stores/postgres": path.join(sdkSrc, "pairing/stores/postgres.ts"),
      // Control's Core imports the SDK by its old flat paths; map them to /core.
      "@actana/sdk/core-link-frames": path.join(sdkSrc, "core/link-frames.ts"),
      "@actana/sdk/core-files-error-codes": path.join(sdkSrc, "core/files-error-codes.ts"),
      "@actana/sdk/core-client": path.join(sdkSrc, "core/client.ts"),
      "@actana/sdk/core-pairing-wire": path.join(sdkSrc, "pairing/wire.ts"),
      "@actana/sdk/__tests__/files-error-code-contract": path.join(
        sdkSrc,
        "__tests__/files-error-code-contract.ts",
      ),
      "@actana/sdk/__tests__/files-list-contract": path.join(sdkSrc, "__tests__/files-list-contract.ts"),
      // Test-only: core client suites drive the real Core server (ADR 0025 D2).
      "@actana/core": controlPinSrc,
      "@actana/shared": controlPinSrc,
    },
  },
});
