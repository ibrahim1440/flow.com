/**
 * The environment/database safety boundary for destructive dataset resets.
 *
 * Authentication, authorization, a typed confirmation phrase and a PIN re-verification all
 * establish that a human MEANT to do this. None of them establish WHICH DATABASE they are
 * about to empty, and that is the question that actually matters: an administrator with
 * `settings.reset` holds the same privilege in the production deployment as in a training
 * one, and the phrase they type is identical in both.
 *
 * So the boundary is drawn on the connection itself, and it is drawn DENY-FIRST: a reset is
 * refused unless the running configuration explicitly names this database as a disposable
 * reset target. Missing configuration, empty configuration, a value that is merely
 * truthy-looking, an unparseable URL — every one of those is a refusal, because the failure
 * mode of guessing is the irreversible destruction of a customer's operational history.
 *
 * ── Why the host must be pinned, not just the database name ──────────────────
 * This deployment is on Neon, where every branch — production, demo, and this regression
 * branch — is served as a database called `neondb`. Matching on the database name alone
 * would therefore authorize production just as readily as a throwaway branch. The endpoint
 * host is the only part of the connection that actually distinguishes them, so BOTH must be
 * allowlisted and BOTH must match.
 *
 * ── Why NODE_ENV is not used ─────────────────────────────────────────────────
 * It describes how the JavaScript was built, not what it is connected to. This very
 * regression server runs with NODE_ENV=production against a disposable branch, and a
 * developer can trivially run a development build pointed at the real database. It is not a
 * database-safety boundary and is deliberately ignored here.
 *
 * Nothing in this module logs or returns a connection string, a password, or a full URL.
 */

export type ResetAuthorization =
  | { allowed: true; host: string; database: string }
  | { allowed: false; reason: string };

/** Exactly this, nothing else. "1", "yes", "TRUE" and "" are all refusals. */
const ENABLE_FLAG = "ERP_TRAINING_RESET_ENABLED";
const ALLOWED_HOSTS = "ERP_RESET_ALLOWED_HOST";
const ALLOWED_DATABASES = "ERP_RESET_ALLOWED_DATABASE";

const list = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Decide whether the database this process is connected to may be wiped.
 *
 * Pure, and takes its environment as an argument, so every permutation is exercised
 * directly by harness-selftest with no server, no database and no risk. That matters more
 * here than anywhere else in the codebase: a guard that is hard to test is a guard nobody
 * proves, and this one is the last thing standing between an admin's click and a
 * customer's data.
 */
export function evaluateResetAuthorization(
  env: Record<string, string | undefined>
): ResetAuthorization {
  if (env[ENABLE_FLAG] !== "true") {
    return {
      allowed: false,
      reason: `${ENABLE_FLAG} is not set to exactly "true", so no database is an authorized reset target.`,
    };
  }

  const hosts = list(env[ALLOWED_HOSTS]);
  if (hosts.length === 0) {
    return { allowed: false, reason: `${ALLOWED_HOSTS} names no host.` };
  }

  const databases = list(env[ALLOWED_DATABASES]);
  if (databases.length === 0) {
    return { allowed: false, reason: `${ALLOWED_DATABASES} names no database.` };
  }

  const url = env.DATABASE_URL;
  if (!url) return { allowed: false, reason: "DATABASE_URL is not set." };
  if (!/^postgres(ql)?:\/\//.test(url)) {
    return { allowed: false, reason: "DATABASE_URL is not a PostgreSQL connection URL." };
  }

  let host: string;
  let database: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    database = parsed.pathname.replace(/^\//, "").split("?")[0];
  } catch {
    return { allowed: false, reason: "DATABASE_URL could not be parsed." };
  }

  // A libpq-style multi-host string is ambiguous about which server would be reached, and
  // an ambiguous target can never be an authorized one.
  if (!host || host.includes(",")) {
    return { allowed: false, reason: "DATABASE_URL does not name exactly one host." };
  }
  if (!database) {
    return { allowed: false, reason: "DATABASE_URL names no database." };
  }

  if (!hosts.includes(host)) {
    return {
      allowed: false,
      reason: `the connected host is not listed in ${ALLOWED_HOSTS}.`,
    };
  }
  if (!databases.includes(database)) {
    return {
      allowed: false,
      reason: `the connected database is not listed in ${ALLOWED_DATABASES}.`,
    };
  }

  return { allowed: true, host, database };
}

/**
 * The refusal a reset endpoint returns. Names the reason so an operator configuring a
 * training environment can fix it, while saying nothing about the connection itself.
 */
export function resetRefusalBody(reason: string): { error: string; reason: string } {
  return {
    error:
      "This database is not an authorized destructive-reset target, so no data was changed.",
    reason,
  };
}
