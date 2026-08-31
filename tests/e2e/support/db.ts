import { Client } from "pg";

// ── Safety rail ──────────────────────────────────────────────────────────────
// This suite creates orders, consumes stock and deliberately attempts invalid
// operations. That is only acceptable against the throwaway database, so refuse to start
// anywhere else rather than trusting whoever set the environment.
export function assertTestDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url || !/\/erp_mvp_test(\?|$)/.test(url)) {
    throw new Error(
      "REFUSING TO RUN: DATABASE_URL is not the isolated test database (erp_mvp_test).\n" +
        "The browser UAT writes freely and must never point at real data."
    );
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
