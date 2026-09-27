import { defineConfig } from "@playwright/test";
import base from "./playwright.shell.config";

/**
 * The same shell suite (tests/shell/navigation.spec.ts, unchanged) against a server you run
 * on an isolated LOCAL database — see tests/shell/local-fixtures.ts. No preview launcher, no
 * preview database: SHELL_BASE_URL must be a local server bound to erp_shell_local.
 *
 *   SHELL_LOCAL_URL=… PIN_LOOKUP_SECRET=… SHELL_BASE_URL=http://localhost:3100 \
 *     npx playwright test -c playwright.shell.local.config.ts
 */
const BASE_URL = process.env.SHELL_BASE_URL ?? "";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE_URL)) throw new Error("SHELL_BASE_URL must be a local server bound to erp_shell_local.");

export default defineConfig({
  ...base,
  globalSetup: "./tests/shell/local-fixtures.ts",
  globalTeardown: undefined,
  webServer: undefined,
  outputDir: "./test-results/shell-local",
  use: { ...base.use, baseURL: BASE_URL },
});
