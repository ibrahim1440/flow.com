/**
 * The database configuration boundary.
 *
 * This exists because the runtime client used to answer a missing or malformed
 * DATABASE_URL by quietly opening a local SQLite file:
 *
 *     const resolvedUrl = url.startsWith("file:./") ? … : url || `file:${resolve("prisma/dev.db")}`;
 *     return new PrismaClient({ adapter: new PrismaLibSql({ url: resolvedUrl }) });
 *
 * In production that is the worst failure mode available. A typo in one environment
 * variable does not stop the deployment — it starts an ERP that looks healthy, reports an
 * empty dataset, and accepts orders, roasts and deliveries that are written to a scratch
 * file nobody will ever read. Nothing raises until somebody notices the business has no
 * data, by which time the writes are gone.
 *
 * ── Why the fallback is removed rather than gated ───────────────────────────
 * It could not have worked anyway. `prisma/schema.prisma` declares
 * `provider = "postgresql"`, `prisma/migrations/migration_lock.toml` pins the same
 * provider, and Prisma refuses to apply a migration history across providers — so no
 * SQLite database could ever have been migrated into a usable shape. No `prisma/dev.db`
 * exists, no documentation describes a SQLite workflow, and the generated client is a
 * PostgreSQL client. The branch was not a supported local mode; it was an unreachable
 * happy path that turned a loud configuration error into a silent data-loss condition.
 *
 * So there is no ERP_ALLOW_SQLITE opt-in here. Adding one would be inventing a workflow
 * to justify keeping the hazard.
 *
 * ── Never in an error message ───────────────────────────────────────────────
 * A connection URL carries a password. Every refusal below names the PROBLEM and, at
 * most, the scheme — never the URL, the host, the user or the password.
 */

export type DatabaseUrlDecision =
  | { ok: true; scheme: string; host: string; database: string }
  | { ok: false; reason: string };

const POSTGRES_SCHEMES = ["postgres:", "postgresql:"];

/**
 * Decide whether a connection string is a usable PostgreSQL URL for this application.
 *
 * Pure and environment-shaped on purpose — the same reason evaluateResetAuthorization is:
 * every case can then be exercised with no server, no database and no risk.
 */
export function evaluateDatabaseUrl(
  env: Record<string, string | undefined>,
  varName = "DATABASE_URL",
): DatabaseUrlDecision {
  const raw = env[varName];

  if (!raw || raw.trim() === "") {
    return { ok: false, reason: `${varName} is not set.` };
  }

  const value = raw.trim();

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: `${varName} is not a valid connection URL.` };
  }

  // Checked against the parsed scheme rather than a string prefix, so "POSTGRESQL://" and
  // any stray whitespace are handled the same way the URL parser handles them.
  if (!POSTGRES_SCHEMES.includes(parsed.protocol.toLowerCase())) {
    return {
      ok: false,
      reason:
        `${varName} must be a PostgreSQL connection URL (postgresql:// or postgres://). ` +
        `Its scheme is "${parsed.protocol.replace(":", "")}".`,
    };
  }

  const host = parsed.hostname;
  if (!host) {
    return { ok: false, reason: `${varName} names no host.` };
  }
  // A comma-separated multi-host string parses as one hostname containing commas. Refused
  // for the same reason the reset guard refuses it: "which database is this" must have
  // exactly one answer.
  if (host.includes(",")) {
    return { ok: false, reason: `${varName} does not name exactly one host.` };
  }

  const database = parsed.pathname.replace(/^\//, "").split("?")[0];
  if (!database) {
    return { ok: false, reason: `${varName} names no database.` };
  }

  return { ok: true, scheme: parsed.protocol.replace(":", ""), host, database };
}

/**
 * The connection string, or a thrown configuration error.
 *
 * Thrown at module load, which is what makes it fail CLOSED: the process does not start,
 * the deployment does not go live, and nobody discovers the problem a week later from a
 * missing sales history.
 */
export function requireDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
  varName = "DATABASE_URL",
): string {
  const decision = evaluateDatabaseUrl(env, varName);
  if (!decision.ok) {
    throw new Error(
      `${decision.reason} This application requires a PostgreSQL database. ` +
        "Set it to the connection string of the environment you intend to run against; " +
        "there is no local fallback and none is wanted.",
    );
  }
  return (env[varName] as string).trim();
}

/**
 * The migration connection string.
 *
 * Kept separate from the runtime URL deliberately. DATABASE_URL is the POOLED endpoint the
 * application runs on; DDL wants the direct one. Requiring it here — rather than letting a
 * missing DIRECT_URL silently redirect schema changes down the pooler — is what makes the
 * split real instead of advisory, and it is checked by the explicit migration command
 * rather than by the shared config, so that `prisma generate` still works in a build
 * environment that has no business holding a migration credential.
 */
export function requireDirectUrl(env: Record<string, string | undefined> = process.env): string {
  const decision = evaluateDatabaseUrl(env, "DIRECT_URL");
  if (!decision.ok) {
    throw new Error(
      `${decision.reason} Migrations must run against the direct (non-pooled) PostgreSQL ` +
        "endpoint, supplied as DIRECT_URL.",
    );
  }
  return (env.DIRECT_URL as string).trim();
}
