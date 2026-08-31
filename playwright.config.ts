import { defineConfig, devices } from "@playwright/test";

// Browser UAT for the operational workflow. These tests drive the real UI as real
// employees: they log in through the keypad, fill the real forms and click the real
// buttons. Direct API and database access appears only in setup and in verification
// after a UI action, never to perform a step the UI offers.
//
// The browser is the Chrome already installed on the machine (channel: "chrome") rather
// than a downloaded build, so no separate `playwright install` step is required.

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3010";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/support/global-setup.ts",

  // One worker on purpose. Every test shares one database and one stock pool, and the
  // whole point of the suite is that concurrent operators cannot corrupt that pool —
  // which is asserted deliberately, in the tests that mean to, rather than by letting the
  // runner interleave everything and make failures irreproducible.
  workers: 1,
  fullyParallel: false,
  retries: 0,

  timeout: 180_000,
  expect: { timeout: 30_000 },

  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],

  use: {
    baseURL: BASE_URL,
    // This deployment talks to a database over the public internet, so ordinary actions
    // take seconds rather than milliseconds. The generous timeouts are about network
    // latency, not about papering over slow assertions.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    locale: "en-GB",
  },

  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 900 } },
    },
    {
      // The workstation screens are the ones that live on a tablet propped next to a
      // roaster, so they are exercised at that size rather than only assumed to reflow.
      name: "tablet",
      use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1024, height: 768 } },
      testMatch: /responsive\.spec\.ts/,
    },
  ],
});
