import { defineConfig, devices } from "@playwright/test";

/**
 * The application shell, in a real browser, against a running app.
 *
 * A third config on purpose. `playwright.harness.config.ts` mounts components from
 * file:// and proves rendering; `playwright.config.ts` drives the operational workflow
 * against the regression database with one worker because it shares a stock pool. This
 * one drives the NAVIGATION — the sidebar, the contextual bar, the breadcrumbs, the
 * drawer — which needs the real layout and a real session but writes nothing, so it can
 * run in parallel and against the preview database without touching anybody's data.
 *
 *   SHELL_BASE_URL=http://localhost:3000 npx playwright test -c playwright.shell.config.ts
 */
const BASE_URL = process.env.SHELL_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/shell",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  outputDir: "./test-results/shell",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    baseURL: BASE_URL,
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "shell" }],
});
