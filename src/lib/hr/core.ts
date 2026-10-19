// Native HR — shared server context: who is acting, what they may touch, errors, audit,
// locks and the small value helpers every HR service uses.
//
// Pure helpers (money, dates) live in ./money.ts and ./dates.ts so they can be unit-tested
// without a database. This file is the boundary to Prisma.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { freshEnough, REAUTH_EN } from "@/lib/auth/step-up";
import { CONCURRENT_UPDATE_MESSAGE, CONCURRENT_UPDATE_RETRY, concurrencyFailureOf } from "./db-errors";
import { isSimpleMode } from "@/lib/simple-mode";

export type Db = Prisma.TransactionClient | typeof prisma;

/**
 * `authTime`: the session's last strong authentication, set by every HTTP route (hrHandler,
 * the account-editor routes). Undefined only for in-process callers (fixture, tests), which
 * have no session to re-authenticate.
 */
export type HrActor = { id: string; role: string; permissions: Permissions; authTime?: Date | string };

export type HrSub =
  | "directory"
  | "people_manage"
  | "private_view"
  | "documents_view"
  | "documents_manage"
  | "contracts_manage"
  | "attendance_manage"
  | "attendance_approve"
  | "leave_manage"
  | "leave_approve"
  | "payroll_prepare"
  | "payroll_approve"
  | "payroll_pay"
  | "payroll_cancel_approved"
  | "advances_manage"
  | "advances_approve"
  | "advances_disburse"
  | "recruit"
  | "assets_manage"
  | "performance_manage"
  | "offboard"
  | "policy_manage"
  | "all_branches";

export class HrError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "HrError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Whether the actor holds an HR duty.
 *
 * No admin shortcut. An administrator acts through the sub-keys their stored permissions
 * grant — `buildDefaultPermissions("admin")` grants every one of them when nothing is
 * stored — so what the permission editor shows and what the server allows are the same
 * thing.
 */
export function can(actor: HrActor, sub: HrSub): boolean {
  return hasModuleAccess(actor.permissions, "hr") && hasSubPrivilege(actor.permissions, "hr", sub);
}

export function assertCan(actor: HrActor, sub: HrSub) {
  if (!can(actor, sub)) throw new HrError("Insufficient permissions", 403, "FORBIDDEN");
}

/** Step-up (owner security decision): a sensitive action needs a recent strong authentication. */
export function assertFresh(actor: { authTime?: Date | string }) {
  // Re-test AUTH-E: fail closed — an actor that does not state when it last authenticated
  // strongly is treated as stale, never as fresh.
  if (!freshEnough(actor.authTime)) throw new HrError(REAUTH_EN, 401, "REAUTH_REQUIRED");
}

export function assertAny(actor: HrActor, subs: HrSub[]) {
  if (!subs.some((s) => can(actor, s))) throw new HrError("Insufficient permissions", 403, "FORBIDDEN");
}

// ── Scope ────────────────────────────────────────────────────────────────────────────

/**
 * Which people the actor may act on.
 *
 * `all`: every person. Otherwise the branches granted through the existing finance
 * branch-access rows (one branch list, one access table for the whole ERP), plus the
 * actor's own direct reports when the actor is themself an HR person. A person with no
 * branch is visible only with `all_branches`.
 */
export type HrScope = { all: boolean; branchIds: string[]; reportIds: string[]; selfEmployeeId: string | null };

export async function resolveScope(actor: HrActor, db: Db = prisma): Promise<HrScope> {
  const me = await db.hrEmployee.findUnique({ where: { accountId: actor.id }, select: { id: true } });
  if (can(actor, "all_branches")) return { all: true, branchIds: [], reportIds: [], selfEmployeeId: me?.id ?? null };
  const [rows, reports] = await Promise.all([
    db.finBranchAccess.findMany({ where: { employeeId: actor.id, branch: { active: true } }, select: { branchId: true } }),
    me ? db.hrEmployee.findMany({ where: { managerId: me.id }, select: { id: true } }) : Promise.resolve([]),
  ]);
  return {
    all: false,
    branchIds: rows.map((r) => r.branchId),
    reportIds: reports.map((r) => r.id),
    selfEmployeeId: me?.id ?? null,
  };
}

export function scopeWhere(scope: HrScope): Prisma.HrEmployeeWhereInput {
  if (scope.all) return {};
  return { OR: [{ branchId: { in: scope.branchIds } }, { id: { in: scope.reportIds } }] };
}

export function inScope(scope: HrScope, person: { id: string; branchId: string | null }): boolean {
  if (scope.all) return true;
  if (scope.reportIds.includes(person.id)) return true;
  return person.branchId !== null && scope.branchIds.includes(person.branchId);
}

/** Load a person the actor may act on, or 404 (another branch's people are not acknowledged). */
export async function personInScope(db: Db, scope: HrScope, employeeId: string) {
  const p = await db.hrEmployee.findUnique({ where: { id: employeeId } });
  if (!p || !inScope(scope, p)) throw new HrError("Employee not found", 404, "NOT_FOUND");
  return p;
}

/** The actor may never decide something about themself. */
export function assertNotSelf(actor: HrActor, subject: { accountId: string | null }, what: string) {
  // SIMPLE MODE: the single owner may act on their own HR record.
  if (subject.accountId && subject.accountId === actor.id && !isSimpleMode()) {
    throw new HrError(`You cannot ${what} for yourself. Another authorised person must do it.`, 403, "SELF_ACTION");
  }
}

/** Display names of login accounts (id → name) — never credentials. */
export async function accountNames(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const rows = await db.employee.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ── Audit and locks ─────────────────────────────────────────────────────────────────

const json = (v: unknown) => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));

export async function audit(
  db: Db,
  e: {
    action: string;
    entityType: string;
    entityId: string;
    employeeId?: string | null;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    actorId: string;
  },
) {
  await db.hrAuditLog.create({
    data: {
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      employeeId: e.employeeId ?? null,
      before: json(e.before),
      after: json(e.after),
      reason: e.reason ?? null,
      actorId: e.actorId,
    },
  });
}

/**
 * Serialise writes that read-then-decide on one subject (a person's leave balance, a payroll
 * period, a commission period). Transaction-scoped: released at commit or rollback, so the
 * second writer re-reads after the first has committed.
 */
export async function lock(tx: Prisma.TransactionClient, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"hr:" + key}))`;
}

export const TX = { timeout: 30_000, maxWait: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;

/** Translate a database guard (trigger / check / unique) into a 409 the UI can show. */
export function mapDbError(err: unknown): never {
  const e = err as { code?: string; message?: string; meta?: { code?: string; message?: string } };
  const msg = String(e?.meta?.message ?? e?.message ?? "");
  // The commission payout freeze (docs/hr/COMMISSION-PAYOUT-FREEZE.md): the payment that would settle a
  // reserved commission period is refused whole. Same English text as the database, so it reads the same.
  if (/Commission payout recording is frozen at the database/.test(msg)) {
    throw new HrError("Commission payout recording is frozen at the database. No PAYOUT entry can be written until the freeze is lifted.", 409, "COMMISSION_PAYOUT_FROZEN");
  }
  const m = /HR: ([^\n"]+)/.exec(msg);
  if (m) throw new HrError(m[1].trim(), 409, "DB_GUARD");
  if (e?.code === "P2002") throw new HrError("A record with these details already exists.", 409, "DUPLICATE");
  // Round-4 W6 fallback: a deadlock (40P01) or serialization failure (40001) — raw (P2010) or
  // transaction (P2034) — rolled everything back; nothing was saved. Say so cleanly.
  const conflict = concurrencyFailureOf(err);
  if (conflict) {
    // Round-5 P3c: kept visible in the server log (the kind only — no statement, value or secret).
    console.warn(`[hr] concurrent update refused (${conflict}); mapped to 409 ${CONCURRENT_UPDATE_RETRY}`);
    throw new HrError(CONCURRENT_UPDATE_MESSAGE, 409, CONCURRENT_UPDATE_RETRY);
  }
  throw err;
}

// ── Input parsing ───────────────────────────────────────────────────────────────────

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new HrError("Invalid JSON body.", 400);
  }
}

export function text(v: unknown, field: string, opts: { required?: boolean; max?: number; min?: number } = {}): string | null {
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw new HrError(`${field} is required.`, 400);
    return null;
  }
  if (typeof v !== "string") throw new HrError(`${field} must be text.`, 400);
  const t = v.trim();
  if (opts.required && !t) throw new HrError(`${field} is required.`, 400);
  if (t.length > (opts.max ?? 500)) throw new HrError(`${field} is longer than ${opts.max ?? 500} characters.`, 400);
  if (opts.min && t.length < opts.min) throw new HrError(`${field} must be at least ${opts.min} characters.`, 400);
  return t || null;
}

export function reqText(v: unknown, field: string, max = 500, min?: number): string {
  return text(v, field, { required: true, max, min }) as string;
}

export function int(v: unknown, field: string, opts: { min?: number; max?: number; required?: boolean } = {}): number | null {
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw new HrError(`${field} is required.`, 400);
    return null;
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n)) throw new HrError(`${field} must be a whole number.`, 400);
  if (opts.min !== undefined && n < opts.min) throw new HrError(`${field} must be at least ${opts.min}.`, 400);
  if (opts.max !== undefined && n > opts.max) throw new HrError(`${field} must be at most ${opts.max}.`, 400);
  return n;
}

export function bool(v: unknown, fallback = false): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  throw new HrError("Expected true or false.", 400);
}

export function oneOf<T extends string>(v: unknown, field: string, values: readonly T[], fallback?: T): T {
  if ((v === undefined || v === null || v === "") && fallback !== undefined) return fallback;
  if (typeof v !== "string" || !values.includes(v as T)) {
    throw new HrError(`${field} must be one of: ${values.join(", ")}.`, 400);
  }
  return v as T;
}
