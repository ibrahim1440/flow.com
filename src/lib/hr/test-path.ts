// Native HR — the ONLY gate for in-process test / fixture shortcuts (P-2 / E-1).
//
// Inventory of test-only paths in the HR and payroll services (src/lib/hr/**), kept here so a
// reviewer has one place to look (docs/hr/P2-CONTROLS.md §E-1):
//   1. `activatePolicy(actor, id)` with the fingerprint omitted — used by the preview fixture
//      and the integration tests, which have no reviewed fingerprint to name. The HTTP route
//      always passes one (null when absent → 400).
// No other HR or payroll service reads an environment variable for a shortcut or accepts an
// override field (a unit test scans src/lib/hr for both).
//
// A shortcut is allowed only when ALL hold, none of which a request can influence:
//   · the caller is in-process code that asks for it explicitly (no route does — a unit test
//     scans every route file for it);
//   · NODE_ENV is not "production" (`next build` / `next start` always run as production);
//   · the connected database carries the disposable marker the guard in
//     scripts/hr/local-db-guard.mjs requires (COMMENT ON DATABASE … 'hiqbah-hr-disposable'),
//     which only a database owner can set — never an HTTP request or an HR setting.
// Pure at load time (no database client is created by importing it), so it unit-tests offline.
type MarkerDb = { $queryRawUnsafe: <T = unknown>(q: string) => Promise<T> };

export const HR_DISPOSABLE_MARKER = "hiqbah-hr-disposable";

/** Whether in-process test shortcuts may run here. Never true in production. */
export async function testPathAllowed(db: MarkerDb, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  // Review P3-A7: `process.env.NODE_ENV` written out LITERALLY, so the production build replaces it
  // in place ("production" === "production") and this path is dead code in `next build` output.
  // The injectable `env` (unit tests) can only make it stricter, never allow more.
  if (process.env.NODE_ENV === "production") return false;
  if (env.NODE_ENV === "production") return false;
  const rows = await db.$queryRawUnsafe<{ marker: string | null }[]>("SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()");
  return rows[0]?.marker === HR_DISPOSABLE_MARKER;
}

/** Refuse (403 TEST_PATH_FORBIDDEN, audited) unless a test shortcut is allowed here. */
export async function assertTestPath(db: MarkerDb, what: string, actorId: string): Promise<void> {
  if (await testPathAllowed(db)) return;
  const [{ prisma }, { HrError, audit }] = await Promise.all([import("@/lib/db"), import("./core")]);
  // Written outside the caller's transaction, which the refusal rolls back.
  await audit(prisma, { action: "TEST_PATH_REFUSED", entityType: "HrTestPath", entityId: what, after: { what }, actorId }).catch(() => undefined);
  throw new HrError(`${what} is a test-only path and is not available here.`, 403, "TEST_PATH_FORBIDDEN");
}
