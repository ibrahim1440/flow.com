// Who receives one notification — the pure decision (unit-tested) and the one database read
// (feat/notifications). See catalog.ts for the rules.
import type { Prisma as PrismaNS, PrismaClient } from "@/generated/prisma/client";
import { buildDefaultPermissions, hasModuleAccess, parsePermissions, type Permissions } from "@/lib/auth-shared";
import { simpleModePermissions } from "@/lib/simple-mode";
import { seesAllSales } from "@/lib/services/sales/scope";
import { holdsAbility, type NotificationEventDef } from "./catalog";

type Db = PrismaClient | PrismaNS.TransactionClient;

export type Candidate = { id: string; role: string; active: boolean; permissions: Permissions };
export type People = Record<string, string | null | undefined | (string | null | undefined)[]>;

/** The permissions a request by this account would carry (getUserWithPermissions, minus the session). */
export function effectivePermissions(row: { role: string; permissions: unknown }): Permissions {
  let p = parsePermissions(row.permissions as string);
  if (!p || typeof p !== "object" || Object.keys(p).length === 0) p = buildDefaultPermissions(row.role);
  return simpleModePermissions(p, row.role);
}

function idsOf(v: People[string]): string[] {
  const list = Array.isArray(v) ? v : [v];
  return list.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** Every person id the event names (for the narrow read when there is no permission rule). */
export function namedPeople(def: NotificationEventDef, people: People): string[] {
  const out = new Set<string>();
  for (const r of def.recipients) if ("person" in r) for (const id of idsOf(people[r.person])) out.add(id);
  return [...out];
}

/**
 * The recipients of one event, in a stable order. Pure.
 *   permission rules ∪ person rules → active → not the actor → holds `requires` → customer scope
 *   (permission-based recipients who are scoped sales reps must be among `scopeOwners`).
 */
export function selectRecipients(
  def: NotificationEventDef,
  input: { actorId?: string | null; people?: People; scopeOwners?: (string | null | undefined)[] },
  candidates: Candidate[],
): string[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const owners = new Set((input.scopeOwners ?? []).filter((x): x is string => !!x));
  const chosen = new Map<string, "perm" | "person">();
  for (const rule of def.recipients) {
    if ("perm" in rule) {
      for (const c of candidates) {
        if (rule.perm.some((a) => holdsAbility(c.permissions, a)) && !chosen.has(c.id)) chosen.set(c.id, "perm");
      }
    } else {
      for (const id of idsOf(input.people?.[rule.person])) chosen.set(id, "person");
    }
  }
  const out: string[] = [];
  for (const [id, via] of chosen) {
    const c = byId.get(id);
    if (!c || !c.active) continue;
    if (input.actorId && id === input.actorId) continue;
    if (def.requires && !def.requires.some((a) => holdsAbility(c.permissions, a))) continue;
    if (def.scope === "customer" && via === "perm" && hasModuleAccess(c.permissions, "sales") && !seesAllSales(c.permissions) && !owners.has(id)) continue;
    out.push(id);
  }
  return out.sort();
}

/** The candidates the decision needs: every active account when a permission rule applies, else the named people. */
export async function loadCandidates(db: Db, def: NotificationEventDef, people: People): Promise<Candidate[]> {
  const byPerm = def.recipients.some((r) => "perm" in r);
  const named = namedPeople(def, people);
  if (!byPerm && named.length === 0) return [];
  const rows = await db.employee.findMany({
    where: byPerm ? { active: true } : { id: { in: named } },
    select: { id: true, role: true, active: true, permissions: true },
  });
  return rows.map((r) => ({ id: r.id, role: r.role, active: r.active, permissions: effectivePermissions(r) }));
}
