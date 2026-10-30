// The employee row every authenticated request reads (getUserWithPermissions), with the «صفحتي الرئيسية» column.
//
// Deploy order (council fix round 3, MED-2): `Employee.homePreference` comes with 20261206110000_sales_call_await_home.
// The release applies that migration BEFORE the code goes live (package SUMMARY / RUNBOOK §10.16), but if the code ever
// runs against a database without it — deployed early, or the migration rolled back under a live build — sign-in must
// not break: a missing-column error (Prisma P2022 / PostgreSQL 42703) on that read falls back to the same read without
// the column (homePreference = null, i.e. «يومي»), logged once per server instance. Any other error is thrown as before.
type Select = Record<string, unknown>;
type Db = { employee: { findUnique: (args: { where: { id: string }; select: Select }) => Promise<unknown> } };

let warned = false;
/** Test hook. */
export function resetMissingColumnWarning(): void { warned = false; }

export function isMissingColumnError(err: unknown, column = "homePreference"): boolean {
  const e = err as { code?: unknown; meta?: { code?: unknown; column?: unknown }; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  const msg = typeof e.message === "string" ? e.message : "";
  const named = msg.includes(column) || String(e.meta?.column ?? "").includes(column);
  return named && (e.code === "P2022" || e.meta?.code === "42703" || e.code === "42703" || /does not exist/i.test(msg));
}

export async function readSessionEmployee<T>(db: Db, id: string, select: Select): Promise<(T & { homePreference: string | null }) | null> {
  try {
    return (await db.employee.findUnique({ where: { id }, select: { ...select, homePreference: true } })) as (T & { homePreference: string | null }) | null;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    if (!warned) {
      warned = true;
      console.error("[auth] Employee.homePreference is missing: migration 20261206110000_sales_call_await_home is not applied. Sign-in continues with «يومي» as everyone's home; apply the migration.");
    }
    const row = (await db.employee.findUnique({ where: { id }, select })) as T | null;
    return row ? { ...row, homePreference: null } : null;
  }
}
