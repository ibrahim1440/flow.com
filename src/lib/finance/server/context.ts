// Shared server context for the finance module: who is acting, which branches they may
// touch, errors, audit, and the pool lock that serialises every write that moves cash
// between "unallocated" and a category.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";

export type Db = Prisma.TransactionClient | typeof prisma;

export type FinanceActor = { id: string; role: string; permissions: Permissions };

export type FinanceScope = { all: boolean; branchKeys: string[] };

export const COMPANY = "COMPANY";

export type FinanceSub =
  | "txn_enter"
  | "reconcile"
  | "budget_prepare"
  | "budget_approve"
  | "allocate"
  | "transfer_approve"
  | "spend_override_approve"
  | "period_close"
  | "all_branches"
  | "settings_manage";

export class FinanceError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "FinanceError";
    this.status = status;
    this.details = details;
  }
}

export function can(actor: FinanceActor, sub: FinanceSub): boolean {
  return hasModuleAccess(actor.permissions, "finance") && hasSubPrivilege(actor.permissions, "finance", sub);
}

export function assertCan(actor: FinanceActor, sub: FinanceSub) {
  if (!can(actor, sub)) throw new FinanceError("Insufficient permissions", 403);
}

export async function resolveScope(actor: FinanceActor, db: Db = prisma): Promise<FinanceScope> {
  if (can(actor, "all_branches")) {
    const branches = await db.finBranch.findMany({ select: { id: true } });
    return { all: true, branchKeys: [COMPANY, ...branches.map((b) => b.id)] };
  }
  const rows = await db.finBranchAccess.findMany({
    where: { employeeId: actor.id, branch: { active: true } },
    select: { branchId: true },
  });
  return { all: false, branchKeys: rows.map((r) => r.branchId) };
}

export function inScope(scope: FinanceScope, branchKey: string): boolean {
  return scope.all || (branchKey !== COMPANY && scope.branchKeys.includes(branchKey));
}

export function assertScope(scope: FinanceScope, branchKey: string) {
  // 404 rather than 403: another branch's records are not acknowledged to exist.
  if (!inScope(scope, branchKey)) throw new FinanceError("Not found", 404);
}

export function scopeWhere(scope: FinanceScope): { branchKey?: { in: string[] } } {
  return scope.all ? {} : { branchKey: { in: scope.branchKeys } };
}

/** Optional narrowing to one branch key requested by the UI, still inside the scope. */
export function narrowScope(scope: FinanceScope, branchKey: string | null | undefined): FinanceScope {
  if (!branchKey) return scope;
  assertScope(scope, branchKey);
  return { all: false, branchKeys: [branchKey] };
}

export async function audit(
  db: Db,
  entry: {
    action: string;
    entityType: string;
    entityId: string;
    branchKey?: string | null;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    refs?: unknown;
    userId: string;
  },
) {
  const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));
  await db.finAuditLog.create({
    data: {
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      branchKey: entry.branchKey ?? null,
      before: json(entry.before),
      after: json(entry.after),
      reason: entry.reason ?? null,
      refs: json(entry.refs),
      userId: entry.userId,
    },
  });
}

/**
 * Serialise every write that changes allocated/unallocated cash in one scope.
 *
 * A transaction-scoped advisory lock: two concurrent allocation requests for the same pool
 * queue behind each other, and the second re-reads balances after the first commits, so the
 * same unallocated halala can never be handed out twice. Released automatically at commit
 * or rollback.
 */
export async function lockPool(tx: Prisma.TransactionClient, branchKey: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"fin-pool:" + branchKey}))`;
}

export async function getSettings(db: Db = prisma) {
  const s = await db.finSettings.findUnique({ where: { id: "singleton" } });
  return s ?? (await db.finSettings.create({ data: { id: "singleton" } }));
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new FinanceError("Invalid JSON body.", 400);
  }
}

export const str = (v: unknown, max = 500): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new FinanceError("Expected text.", 400);
  const t = v.trim();
  if (t.length > max) throw new FinanceError(`Text longer than ${max} characters.`, 400);
  return t === "" ? null : t;
};

export const reqStr = (v: unknown, field: string, max = 500): string => {
  const s = str(v, max);
  if (!s) throw new FinanceError(`${field} is required.`, 400);
  return s;
};
