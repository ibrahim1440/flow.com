import { defineConfig, devices } from "@playwright/test";
import { PREVIEW_ENV_DEFAULT } from "./scripts/sales-preview/preview-guard";

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
 * ── Running it ──
 *
 *   npm run test:shell
 *
 * Nothing to set up first. It provisions three disposable `NAV_` identities, starts a dev
 * server on :3100 bound to the preview database through the existing `withpreview.mjs`
 * guard, runs the suite, and deletes the identities again however the run ends. No
 * credentials are printed and no account survives the run.
 *
 * `PREVIEW_ENV` overrides the env file. `SHELL_BASE_URL` points at a server you are
 * running yourself — the launcher is then skipped, and it is on you to ensure that server
 * talks to the preview database.
 */
const PREVIEW_ENV = process.env.PREVIEW_ENV ?? PREVIEW_ENV_DEFAULT;
const PORT = Number(process.env.SHELL_PORT ?? 3100);

const EXTERNAL = process.env.SHELL_BASE_URL;
const BASE_URL = EXTERNAL ?? `http://localhost:${PORT}`;

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

  // Create the disposable identities, and remove them whatever happens.
  globalSetup: "./tests/shell/global-setup.ts",
  globalTeardown: "./tests/shell/global-teardown.ts",

  // Only when the caller has not supplied a server. `withpreview.mjs` refuses to start
  // anything whose connection string is not the approved preview endpoint, database and
  // restricted role, so this cannot come up against the wrong database. Its own port, so
  // it is never confused with an ordinary `npm run dev`.
  webServer: EXTERNAL
    ? undefined
    : {
        command: `node scripts/sales-preview/withpreview.mjs next dev --port ${PORT}`,
        env: { PREVIEW_ENV },
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
      },

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
