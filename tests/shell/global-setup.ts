/**
 * Provision the three disposable `NAV_` identities before the shell suite runs.
 *
 * Running the suite used to mean remembering to run a script first; forgetting produced a
 * wall of failed logins that looked like a navigation defect. It is now part of the run,
 * behind the same preview-database guard, and `global-teardown.ts` removes the accounts
 * however the run ends.
 */
import { provisionNavFixtures } from "../../scripts/sales-preview/nav-fixtures";
import { PreviewRefusal } from "../../scripts/sales-preview/preview-guard";

export default async function globalSetup() {
  try {
    const ids = await provisionNavFixtures();
    console.log(`[shell] provisioned ${ids.length} disposable navigation fixtures`);
  } catch (e) {
    if (e instanceof PreviewRefusal) {
      throw new Error(
        `${e.message}\n\n` +
          "The shell suite signs in as disposable fixtures on the isolated preview\n" +
          "database. Point PREVIEW_ENV at the preview app env file and run again:\n\n" +
          "  PREVIEW_ENV=<path to .env.preview-app> npm run test:shell\n",
      );
    }
    throw e;
  }
}
