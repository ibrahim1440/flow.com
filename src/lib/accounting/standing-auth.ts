// «التفويض الدائم» — StandingAuthorisation (batch 22 WP-A, 20261124090000_standing_authorisation; council ruling 2).
//
// Who authorised the scheduler to post a register's entries without a person running them:
//   • RECURRING_AUTOPOST — one recurring JOURNAL (scopeId = the schedule): the auto-post of «المعاملات المتكررة»;
//   • DEFERRAL_RECOGNITION — the monthly recognition of «قوالب التأجيل», register-wide;
//   • DEPRECIATION — the monthly depreciation of «الأصول الثابتة», register-wide (ruling 1: person-run until granted).
// One live row per (register, scope) (the database's partial unique index); never deleted; revoked once, with who and why
// (standing_auth_guard). RecurringSchedule.autoPost* is the database's read-only mirror of the live recurring row.
//
// GRANTING (the routes): the central gate (privilegedGate + requireFreshAuth) and
//   RECURRING_AUTOPOST: accounting › recurring + journal_post + the admin role (today's rule);
//   DEFERRAL_RECOGNITION: accounting › deferrals + journal_post;
//   DEPRECIATION: accounting › fixed_assets + journal_post.
// The SoD setting decides a SELF-authorisation (sodBypass, carried to every entry posted under it and listed in
// «استثناءات فصل المهام»): for a recurring journal the authoriser is its preparer or last editor; for a register-wide run
// (council ruling, batch 22) the authoriser prepared a live item of the register — an ACTIVE deferral schedule, an
// ACTIVE / FULLY_DEPRECIATED asset they created or activated. A strict setting refuses it (SOD_SELF_APPROVAL), and
// a strict «approver may not post» refuses every standing authorisation (granting it is approving and posting in one act).
//
// AT RUN TIME (rightsProblem, re-checked every run): the authoriser is active and holds the register's sub and
// journal_post (and the admin role for recurring auto-post). If not, the runner REVOKES the row with
// revokeReason 'RIGHTS_LAPSED: …', logs it (the audit trail names the reason) and notifies (finance.standing_auth_lapsed
// for the register-wide runs; finance.recurring_attention for a recurring journal, as before); the register goes back
// to SKIPPED NOT_AUTHORISED (recurring: drafts only). The entries name the authoriser as postedBy and carry sodBypass.
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { hasModuleAccess, hasSubPrivilege } from "@/lib/auth-shared";
import { effectivePermissions } from "@/lib/notifications/recipients";
import { notify } from "@/lib/notifications/notify";
import { setAuditContext, type AuditContext } from "./audit";
import { refuse } from "./refusals";
import { sodDecision, sodPolicy } from "./sod";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export const STANDING_REGISTERS = ["RECURRING_AUTOPOST", "DEFERRAL_RECOGNITION", "DEPRECIATION"] as const;
export type StandingRegister = (typeof STANDING_REGISTERS)[number];
/** The register-wide ones (granted from their register's page; RECURRING_AUTOPOST is per schedule). */
export const REGISTER_WIDE = ["DEFERRAL_RECOGNITION", "DEPRECIATION"] as const;
export type RegisterWide = (typeof REGISTER_WIDE)[number];
/** The register's own sub-privilege under `accounting` (its maintenance duty; granting also needs journal_post). */
export const REGISTER_SUB: Record<StandingRegister, "recurring" | "deferrals" | "fixed_assets"> = {
  RECURRING_AUTOPOST: "recurring", DEFERRAL_RECOGNITION: "deferrals", DEPRECIATION: "fixed_assets",
};
export const REGISTER_LABEL: Record<StandingRegister, { ar: string; en: string }> = {
  RECURRING_AUTOPOST: { ar: "الترحيل التلقائي لمعاملة متكررة", en: "Recurring journal auto-post" },
  DEFERRAL_RECOGNITION: { ar: "الاعتراف الشهري بالمؤجلات", en: "Monthly deferral recognition" },
  DEPRECIATION: { ar: "الإهلاك الشهري", en: "Monthly depreciation" },
};
/** Who revokes when the rights lapsed (the scheduler / runner). */
export const STANDING_SYSTEM_ACTOR = "system:standing-auth";
export const RIGHTS_LAPSED = "RIGHTS_LAPSED";

export const isRegisterWide = (v: unknown): v is RegisterWide => (REGISTER_WIDE as readonly unknown[]).includes(v);

export type StandingRow = Prisma.StandingAuthorisationGetPayload<object>;

/** The live authorisation of (register, scope), or null. */
export function liveAuthorisation(db: Db, register: StandingRegister, scopeId: string | null = null): Promise<StandingRow | null> {
  return db.standingAuthorisation.findFirst({ where: { register, scopeId, revokedAt: null } });
}

// ── Rights as of now ─────────────────────────────────────────────────────────────────────────────

type Person = { id: string; active: boolean; role: string; permissions: unknown } | null;
const loadPerson = (db: Db, id: string | null): Promise<Person> => (id ? db.employee.findUnique({ where: { id }, select: { id: true, active: true, role: true, permissions: true } }) : Promise.resolve(null));
const holds = (p: NonNullable<Person>, sub: string) => {
  const perms = effectivePermissions(p);
  return hasModuleAccess(perms, "accounting") && hasSubPrivilege(perms, "accounting", sub);
};

/** Why `personId` may not (or no longer) post this register's entries under a standing authorisation; null = may. */
export async function rightsProblem(db: Db, register: StandingRegister, personId: string | null): Promise<string | null> {
  const p = await loadPerson(db, personId);
  if (!p) return "the authoriser's account no longer exists";
  if (!p.active) return "the authoriser's account is deactivated";
  if (register === "RECURRING_AUTOPOST" && p.role !== "admin") return "the authoriser no longer has the admin role (the posting gate)";
  const sub = REGISTER_SUB[register];
  if (!holds(p, sub)) return `the authoriser no longer holds accounting › ${sub}`;
  if (!holds(p, "journal_post")) return "the authoriser no longer holds accounting › journal_post";
  return null;
}

// ── Grant / revoke (inside the caller's transaction) ─────────────────────────────────────────────

const newId = () => `sa_${crypto.randomUUID().replace(/-/g, "")}`;
const reasonOf = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500) : "");

/** Grant (the caller checked the gate and the SoD). Refuses STANDING_AUTH_EXISTS when one is live already. */
export async function grantIn(tx: Tx, input: { register: StandingRegister; scopeId: string | null; sodBypass: boolean }, actorId: string): Promise<StandingRow> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`standing-auth:${input.register}:${input.scopeId ?? ""}`}, 0))`;
  if (await liveAuthorisation(tx, input.register, input.scopeId)) throw refuse("STANDING_AUTH_EXISTS");
  return tx.standingAuthorisation.create({ data: { id: newId(), register: input.register, scopeId: input.scopeId, authorisedBy: actorId, sodBypass: input.sodBypass } });
}

/** Revoke the live authorisation of (register, scope), if any. Returns the revoked row (null = there was none). */
export async function revokeLiveIn(tx: Tx, register: StandingRegister, scopeId: string | null, by: string, reason: string): Promise<StandingRow | null> {
  const live = (await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "StandingAuthorisation" WHERE "register" = ${register} AND coalesce("scopeId", '') = ${scopeId ?? ""} AND "revokedAt" IS NULL FOR UPDATE`)[0];
  if (!live) return null;
  return tx.standingAuthorisation.update({ where: { id: live.id }, data: { revokedAt: new Date(), revokedBy: by, revokeReason: reason.slice(0, 500) } });
}

/** A register-wide grant is a self-authorisation when the authoriser prepared a live item of the register. */
export async function preparedLiveItem(db: Db, register: RegisterWide, actorId: string): Promise<boolean> {
  if (register === "DEFERRAL_RECOGNITION") return (await db.deferralSchedule.count({ where: { status: "ACTIVE", createdBy: actorId } })) > 0;
  return (await db.fixedAsset.count({ where: { status: { in: ["ACTIVE", "FULLY_DEPRECIATED"] }, OR: [{ createdBy: actorId }, { activatedBy: actorId }] } })) > 0;
}

/**
 * Grant a register-wide standing authorisation (the route has passed the gate: the register's sub + journal_post through
 * privilegedGate + requireFreshAuth). The SoD setting: a strict «approver may not post» refuses (SOD_APPROVER_POSTS);
 * a self-authorisation is refused when self-approval is off (SOD_SELF_APPROVAL), else recorded (sodBypass).
 */
export async function grantRegister(register: unknown, ctx: AuditContext) {
  if (!isRegisterWide(register)) throw refuse("BAD_INPUT", "(register: DEFERRAL_RECOGNITION or DEPRECIATION)", "(السجل غير معروف)");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: ctx.reason ?? `standing authorisation granted: ${register}` });
    const policy = await sodPolicy(tx);
    if (!sodDecision(policy, "APPROVER_POSTS")) throw refuse("SOD_APPROVER_POSTS");
    const self = await preparedLiveItem(tx, register, ctx.actorId);
    if (self && !sodDecision(policy, "SELF_APPROVAL")) throw refuse("SOD_SELF_APPROVAL", "(you prepared a live item of this register)", "(أعددت بندًا قائمًا في هذا السجل)");
    const row = await grantIn(tx, { register, scopeId: null, sodBypass: self }, ctx.actorId);
    return view(row);
  }, TX_OPTS);
}

/** Revoke an authorisation by id (a person: the register's sub at the route). A reason of ≥ 3 characters is required. */
export async function revokeById(id: string, reason: unknown, ctx: AuditContext) {
  const r = reasonOf(reason);
  if (r.length < 3) throw refuse("REASON_REQUIRED");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: `standing authorisation revoked: ${r}`.slice(0, 500) });
    const row = (await tx.$queryRaw<{ id: string; revokedAt: Date | null }[]>`SELECT "id", "revokedAt" FROM "StandingAuthorisation" WHERE "id" = ${id} FOR UPDATE`)[0];
    if (!row) throw refuse("NOT_FOUND");
    if (row.revokedAt) throw refuse("STANDING_AUTH_FINAL");
    return view(await tx.standingAuthorisation.update({ where: { id }, data: { revokedAt: new Date(), revokedBy: ctx.actorId, revokeReason: r } }));
  }, TX_OPTS);
}

/** The register of an authorisation (for the route's permission check), or null. */
export async function registerOf(id: string): Promise<StandingRegister | null> {
  const r = await prisma.standingAuthorisation.findUnique({ where: { id }, select: { register: true } });
  return (r?.register as StandingRegister | undefined) ?? null;
}

// ── At run time ──────────────────────────────────────────────────────────────────────────────────

export type RunAuthorisation =
  | { ok: true; auth: StandingRow }
  | { ok: false; reason: "NOT_AUTHORISED"; revoked: StandingRow | null; detail: string };

/**
 * The scheduler's check before a register-wide run: the live authorisation, its authoriser's rights as of now. Rights
 * lapsed → the row is REVOKED ('RIGHTS_LAPSED: …', by the system actor), logged and the accounting admins and the
 * authoriser are notified — in one transaction — and the run is SKIPPED NOT_AUTHORISED.
 */
export async function authoriseRun(register: RegisterWide, ctx: AuditContext = { actorId: STANDING_SYSTEM_ACTOR }): Promise<RunAuthorisation> {
  return prisma.$transaction(async (tx) => {
    const live = (await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "StandingAuthorisation" WHERE "register" = ${register} AND "scopeId" IS NULL AND "revokedAt" IS NULL FOR UPDATE`)[0];
    if (!live) return { ok: false as const, reason: "NOT_AUTHORISED" as const, revoked: null, detail: "no standing authorisation" };
    const auth = await tx.standingAuthorisation.findUniqueOrThrow({ where: { id: live.id } });
    const problem = await rightsProblem(tx, register, auth.authorisedBy);
    if (!problem) return { ok: true as const, auth };
    const why = `${RIGHTS_LAPSED}: ${problem}`.slice(0, 500);
    await setAuditContext(tx, { ...ctx, actorId: STANDING_SYSTEM_ACTOR, reason: `standing authorisation revoked by the scheduler — ${why}`.slice(0, 500) });
    const revoked = await tx.standingAuthorisation.update({ where: { id: auth.id }, data: { revokedAt: new Date(), revokedBy: STANDING_SYSTEM_ACTOR, revokeReason: why } });
    await notify(tx, {
      event: "finance.standing_auth_lapsed", dedupeKey: auth.id, actorId: STANDING_SYSTEM_ACTOR,
      facts: { register, labelAr: REGISTER_LABEL[register].ar, labelEn: REGISTER_LABEL[register].en, reason: problem },
      people: { authoriser: auth.authorisedBy }, entity: { type: "StandingAuthorisation", id: auth.id },
    });
    console.warn(`[standing-auth] ${register}: authorisation ${auth.id} revoked — ${why}`);
    return { ok: false as const, reason: "NOT_AUTHORISED" as const, revoked, detail: why };
  }, TX_OPTS);
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────

export function view(r: StandingRow) {
  return {
    id: r.id, register: r.register as StandingRegister, scopeId: r.scopeId, authorisedBy: r.authorisedBy, authorisedAt: r.authorisedAt.toISOString(),
    sodBypass: r.sodBypass, revokedAt: r.revokedAt?.toISOString() ?? null, revokedBy: r.revokedBy, revokeReason: r.revokeReason,
    lapsed: !!r.revokeReason?.startsWith(RIGHTS_LAPSED),
  };
}
export type StandingView = ReturnType<typeof view>;

/** The register-wide authorisations: the live one of each and the history (newest first), with names. */
export async function listRegisterWide(register?: RegisterWide) {
  const rows = await prisma.standingAuthorisation.findMany({ where: { register: register ? register : { in: [...REGISTER_WIDE] } }, orderBy: { authorisedAt: "desc" }, take: 100 });
  const ids = [...new Set(rows.flatMap((r) => [r.authorisedBy, r.revokedBy]).filter((x): x is string => !!x))];
  const people = ids.length ? await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const names = Object.fromEntries(people.map((p) => [p.id, p.name]));
  const live = Object.fromEntries(REGISTER_WIDE.map((g) => [g, rows.find((r) => r.register === g && !r.revokedAt) ?? null])) as Record<RegisterWide, StandingRow | null>;
  return {
    live: { DEFERRAL_RECOGNITION: live.DEFERRAL_RECOGNITION ? view(live.DEFERRAL_RECOGNITION) : null, DEPRECIATION: live.DEPRECIATION ? view(live.DEPRECIATION) : null },
    history: rows.map(view), names,
  };
}

/** The scheduler's state of the register-wide runs, for the dashboard (AUTHORISED with who, or NOT_AUTHORISED). */
export async function schedulerState(db: Db = prisma): Promise<Record<RegisterWide, { state: "AUTHORISED" | "NOT_AUTHORISED"; authorisedBy: string | null; since: string | null }>> {
  const rows = await db.standingAuthorisation.findMany({ where: { register: { in: [...REGISTER_WIDE] }, revokedAt: null } });
  const of = (g: RegisterWide) => {
    const r = rows.find((x) => x.register === g);
    return r ? { state: "AUTHORISED" as const, authorisedBy: r.authorisedBy, since: r.authorisedAt.toISOString() } : { state: "NOT_AUTHORISED" as const, authorisedBy: null, since: null };
  };
  return { DEFERRAL_RECOGNITION: of("DEFERRAL_RECOGNITION"), DEPRECIATION: of("DEPRECIATION") };
}
