/**
 * The server environment gate.
 *
 * Three secrets decide whether this deployment can work at all, and until now they failed at
 * three different moments:
 *
 *   DATABASE_URL       throws at module load (src/lib/db.ts) and in prisma.config.ts, so any
 *                      Prisma CLI command or server boot refuses without it.
 *   JWT_SECRET         throws at module load in src/lib/auth.ts, which every authenticated
 *                      route imports — so `next build` fails while compiling them.
 *   PIN_LOOKUP_SECRET  was resolved ONLY inside request handlers. A deployment missing it
 *                      installed, built, started and reported healthy, and then returned 500
 *                      on the first PIN login — possibly hours later, in front of staff at a
 *                      wall-mounted pad. That is the gap this module closes.
 *
 * ── Why a separate module and not another inline check ──────────────────────
 * The rules are not restated here. This aggregates the evaluators that already own them —
 * evaluateDatabaseUrl and evaluatePinLookupSecret — so there is exactly one definition of
 * "usable" per variable and no second copy to drift. It exists to give those rules a single
 * entry point that can be called from two places that are not request handlers: the Next.js
 * startup hook (src/instrumentation.ts) and the pre-build validator (scripts/validate-env.ts,
 * executed through the locally installed `tsx`).
 *
 * ── Why it deliberately does NOT import "server-only" ───────────────────────
 * The build-time validator imports this module outside the Next bundler, where the
 * `server-only` package resolves to its throwing entry point; importing it here would make
 * that half impossible. Client safety is instead kept by construction — nothing under a "use
 * client" boundary imports this module, and harness-selftest asserts that it never will.
 *
 * ── Never the value ─────────────────────────────────────────────────────────
 * Every reason below comes from an evaluator that names the problem and never any part of
 * the value. The aggregate message is therefore safe to log, print in a build log, or show
 * to whoever is configuring the deployment.
 */
import { evaluateDatabaseUrl } from "./db-config";
import { evaluatePinLookupSecret } from "./pin-lookup";

/**
 * Every reason this environment cannot serve traffic, or an empty list.
 *
 * Pure and environment-shaped, so every permutation is exercisable with no server, no
 * database and no real secret.
 *
 * JWT_SECRET is deliberately absent: src/lib/auth.ts already throws on it at module load,
 * and auth.ts carries `import "server-only"`, so it cannot be imported by the build validator
 * without resolving to that package's throwing entry. Restating its rules
 * here would create the second copy this module exists to avoid. See the header for where
 * each variable is enforced.
 */
export function evaluateServerEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const problems: string[] = [];

  const database = evaluateDatabaseUrl(env);
  if (!database.ok) problems.push(database.reason);

  const pinLookup = evaluatePinLookupSecret(env);
  if (!pinLookup.ok) problems.push(pinLookup.reason);

  return problems;
}

/**
 * Refuse to start, naming every problem at once.
 *
 * Throwing is the point: from src/instrumentation.ts this runs before the server accepts its
 * first request, and from scripts/validate-env.ts it runs before `next build` compiles
 * anything. A deployment that is missing a secret fails loudly at deploy time rather than
 * quietly at the pad.
 */
export function assertServerEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  const problems = evaluateServerEnv(env);
  if (problems.length === 0) return;

  throw new Error(
    `This deployment is not configured to run (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\nSet these in the server environment. No value is ever printed here or in any log.",
  );
}
