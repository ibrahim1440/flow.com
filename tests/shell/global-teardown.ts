/**
 * Remove every `NAV_` account after the shell suite.
 *
 * Deliberately unconditional and prefix-wide: it deletes fixtures an earlier aborted run
 * abandoned as well as this run's. Playwright calls this even when tests fail, so the only
 * way to leave accounts behind is for the database itself to be unreachable — in which
 * case we say so loudly rather than exiting quietly.
 */
import { removeNavFixtures } from "../../scripts/sales-preview/nav-fixtures";
import { PreviewRefusal } from "../../scripts/sales-preview/preview-guard";

export default async function globalTeardown() {
  try {
    const n = await removeNavFixtures();
    console.log(`[shell] removed ${n} disposable navigation fixtures`);
  } catch (e) {
    if (e instanceof PreviewRefusal) return; // setup refused too; nothing was created
    console.error(
      "[shell] COULD NOT REMOVE THE NAVIGATION FIXTURES — remove them by hand:\n" +
        "  PREVIEW_ENV=<app env file> npx tsx scripts/sales-preview/nav-fixtures.ts --remove",
    );
    throw e;
  }
}
