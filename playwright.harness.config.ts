import { defineConfig, devices } from "@playwright/test";

/**
 * Component-harness config.
 *
 * Separate from playwright.config.ts on purpose: that one drives the real app against a
 * running server and a database. This one loads a bundled harness from file:// and needs
 * neither, which is why it can run while the shared compute stays idle. Nothing it proves
 * is persistence or authorisation evidence.
 */
export default defineConfig({
  testDir: "./tests/harness",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], channel: "chrome" },
  projects: [{ name: "harness" }],
});
