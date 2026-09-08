import { Client } from "pg";

// ── Safety rail ──────────────────────────────────────────────────────────────
// This suite creates orders, consumes stock and deliberately attempts invalid
// operations. That is only acceptable against the throwaway database, so refuse to start
// anywhere else rather than trusting whoever set the environment.
/**
 * The only databases this suite may touch, by exact name.
 *
 * Deliberately a fixed literal rather than anything the environment can widen: this is a
 * safety boundary, and a boundary that whoever sets the variables can move is not one.
 * No wildcard and no prefix match — "erp_mvp_preprod" must not pass merely because it
 * begins with "erp_mvp" — and an unrecognised name is refused rather than allowed.
 */
const ALLOWED_TEST_DATABASES = ["erp_mvp_test", "erp_e2e"];

function refuseTestDatabase(why: string): Error {
  return new Error(
    `REFUSING TO RUN: ${why}\n` +
      "The browser UAT writes freely and must never point at real data.\n" +
      `DATABASE_URL must name exactly one of: ${ALLOWED_TEST_DATABASES.join(", ")}.`
  );
}

export function assertTestDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw refuseTestDatabase("DATABASE_URL is not set.");
  // Resolved by asking pg itself, rather than by a URL parse of our own, so the name
  // checked here is by construction the name pg will actually open. Constructing a Client
  // performs no I/O — it only resolves the connection string. Any separate parse can
  // disagree with pg, and a guard that disagrees with the client it guards is not a guard:
  // `socket:/erp_e2e?db=erp_mvp_preprod` has an approved-looking URL path while pg
  // connects to erp_mvp_preprod.
  let name: string | undefined;
  try {
    name = new Client({ connectionString: url }).database;
  } catch {
    throw refuseTestDatabase("DATABASE_URL is not a usable connection string.");
  }
  if (!name || !ALLOWED_TEST_DATABASES.includes(name)) {
    throw refuseTestDatabase(`database "${name || "<none>"}" is not an approved test database.`);
  }
  return url;
}

export async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: assertTestDatabase() });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

export async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return withDb(async (db) => (await db.query(sql, params)).rows[0] as T);
}

export async function all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return withDb(async (db) => (await db.query(sql, params)).rows as T[]);
}

export async function exec(sql: string, params: unknown[] = []): Promise<void> {
  await withDb(async (db) => { await db.query(sql, params); });
}

export const num = (v: unknown): number => (v === null || v === undefined ? NaN : Number(v));

/** Gram precision, matching the repository's three-decimal convention. */
export const near = (a: number, b: number, tol = 0.002): boolean => Math.abs(a - b) < tol;
