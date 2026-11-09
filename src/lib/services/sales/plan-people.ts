// D17 «خطتي» — who a rep may meet: «مشرفي» (the sales supervisors by role) and the «مع مين؟» search. Names only (as the
// workspace's invite picker): no job title, no contact. Gate R3: permissions are read the way a request reads them
// (effectivePermissions: the stored JSON or the role's defaults) — a malformed row is skipped, never a 500.
import type { Prisma as PrismaNS, PrismaClient } from "@/generated/prisma/client";
import { hasSubPrivilege } from "@/lib/auth-shared";
import { effectivePermissions } from "@/lib/notifications/recipients";

type Db = Pick<PrismaClient | PrismaNS.TransactionClient, "employee" | "$queryRaw">;
type DbHr = Pick<PrismaClient | PrismaNS.TransactionClient, "employee" | "$queryRaw" | "hrEmployee">;
/** D18 (Abu Fahd B2): the admin role is the system's owner / test accounts — never «مشرفي» by role alone. */
const ADMIN_ROLES = new Set(["admin"]);
export type PlanPerson = { id: string; name: string; role?: "manager" };

/** The active sales supervisors (sales › lead_assign, role defaults included; not the admin role), by name, at most `limit`. */
export async function salesSupervisors(db: Db, exclude: string, limit = 5): Promise<PlanPerson[]> {
  const rows = await db.employee.findMany({ where: { active: true, id: { not: exclude } }, select: { id: true, name: true, role: true, permissions: true }, orderBy: { name: "asc" } });
  const out: PlanPerson[] = [];
  for (const r of rows) {
    if (ADMIN_ROLES.has(r.role)) continue;
    let boss = false;
    try { boss = hasSubPrivilege(effectivePermissions(r), "sales", "lead_assign"); } catch { boss = false; }
    if (boss) out.push({ id: r.id, name: r.name, role: "manager" });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * D18 (Abu Fahd B2) — the rep's ACTUAL supervisor, first: the HR manager (whatever the role); else the sales supervisors
 * by role (sales › lead_assign), the admin role left out. Only the FIRST is «مشرفي»; the others are offered unmarked.
 * There is no sales team in the data model, so «the rep's team» is the HR line (the HR manager) — without one, the
 * company's supervisors by name.
 */
export async function mySupervisors(db: DbHr, me: string): Promise<{ first: PlanPerson | null; others: PlanPerson[] }> {
  const hr = await db.hrEmployee.findUnique({ where: { accountId: me }, select: { manager: { select: { accountId: true } } } });
  const hrId = hr?.manager?.accountId ?? null;
  if (hrId && hrId !== me) {
    const e = await db.employee.findFirst({ where: { id: hrId, active: true }, select: { id: true, name: true } });
    if (e) return { first: { id: e.id, name: e.name, role: "manager" }, others: [] };
  }
  const bosses = await salesSupervisors(db, me);
  return { first: bosses[0] ?? null, others: bosses.slice(1).map((b) => ({ id: b.id, name: b.name })) };
}

/** `%`, `_` and `\` taken literally in an ILIKE pattern (… ESCAPE '\'). */
export const likeLiteral = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Words that mean «my supervisor / a manager» (Abu Fahd: «المشرف», «مدير» found nobody). */
export const BOSS_WORDS = /مشرف|مدير|رئيس|supervisor|manager|lead/i;

/**
 * «مع مين؟» search: the supervisors for a role word, then active colleagues whose name — or HR job title — matches.
 * Names only are returned (the title is a way to FIND someone, not shown).
 */
export async function searchPeople(db: Db, q: string, me: string): Promise<(PlanPerson & { self: boolean })[]> {
  const text = q.trim().slice(0, 60);
  if (!text) return [];
  const pat = likeLiteral(text);
  const [bosses, rows] = await Promise.all([
    BOSS_WORDS.test(text) ? salesSupervisors(db, me) : Promise.resolve([] as PlanPerson[]),
    db.$queryRaw<{ id: string; name: string }[]>`
      SELECT e.id, e.name FROM "Employee" e LEFT JOIN "HrEmployee" h ON h."accountId" = e.id
       WHERE e.active AND (e.name ILIKE ${pat} ESCAPE '\\' OR h."jobTitle" ILIKE ${pat} ESCAPE '\\')
       ORDER BY e.name LIMIT 8`,
  ]);
  const seen = new Set<string>();
  return [...bosses, ...rows.map((r) => ({ id: r.id, name: r.name }))]
    .filter((p) => p.name && !seen.has(p.id) && !!seen.add(p.id)).slice(0, 8).map((p) => ({ ...p, self: p.id === me }));
}
