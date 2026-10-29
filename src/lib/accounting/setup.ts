// Accounting core A1 — the owner's setup path, in order:
//   1. «تهيئة دليل الحسابات» — seed the default chart into an EMPTY chart (opt-in; never automatic);
//   2. map the posting roles (AccountRole) — seeding maps them to the default chart, the owner may change any;
//   3. create the fiscal year(s);
//   4. set the go-live date and ACTIVATE (readiness checked); from then on the engine posts;
//   5. post the opening balances at the go-live date (./opening.ts).
// Every write runs with the audit context; the database records it.
import type { Prisma } from "@/generated/prisma/client";
import { prisma, TX_OPTS } from "@/lib/db";
import { CATEGORY_SEED_COST_CODE, COA_TEMPLATE, COA_TEMPLATE_KEY } from "./coa-template";
import { ACCOUNT_ROLES, ACTIVATION_ROLES, roleDef, type RolePhase } from "./roles";
import { refuse } from "./refusals";
import { setAuditContext, type AuditContext } from "./audit";
import { dayText, parseBusinessDay } from "./dates";
import { ENGINE_MODULES } from "./posting-engine";
import { payrollAlignment } from "./ops/payroll-alignment";
import { assertGoLiveFirstOfMonth } from "./fixed-assets/common";

type Tx = Prisma.TransactionClient;
const SINGLETON = "singleton";

/** The settings row, or its defaults when it was never written (a read never writes). */
export async function getSettings(tx: Tx | typeof prisma = prisma) {
  const s = await tx.accountingSettings.findUnique({ where: { id: SINGLETON } });
  return s ?? {
    id: SINGLETON, baseCurrency: "SAR", costingMethod: "WeightedAverage", cogsPolicy: "OnShipping", branchAccountingMode: "CostCenterOnly",
    exportToQoyod: false, setupComplete: false, createdAt: null, updatedAt: null, updatedBy: null, tenantId: "hiqbah", accountingActive: false,
    goLiveDate: null, activatedAt: null, activatedBy: null, coaSeededAt: null, coaSeededBy: null, coaTemplate: null, openingEntryId: null,
  };
}

/** Has the posting engine posted anything (an engine module, with an idempotency key)? */
export async function enginePosted(tx: Tx | typeof prisma = prisma): Promise<boolean> {
  return (await tx.journalEntry.count({ where: { idempotencyKey: { not: null }, sourceModule: { in: [...ENGINE_MODULES] } } })) > 0;
}

export type Readiness = {
  active: boolean;
  goLiveDate: string | null;
  accounts: number;
  postable: number;
  roles: { key: string; ar: string; en: string; phase: RolePhase; group: string; accountId: string | null; accountCode: string | null; accountName: string | null }[];
  missingForActivation: string[];
  missingByPhase: Record<RolePhase, string[]>;
  goLivePeriod: { id: string; status: string } | null;
  openingPosted: boolean;
  enginePosted: boolean;
  checks: { key: string; ok: boolean; ar: string; en: string }[];
  canActivate: boolean;
};

const PAYROLL_CHECK = { key: "payroll", ar: "حسابات الرواتب في الموارد البشرية مطابقة لأدوار الترحيل", en: "HR's payroll account map matches the posting roles" };

export async function readiness(goLiveOverride?: string | null): Promise<Readiness> {
  const s = await getSettings();
  const goLive = goLiveOverride ? parseBusinessDay(goLiveOverride) : s.goLiveDate;
  const [accounts, postable, maps, period, posted, alignment] = await Promise.all([
    prisma.account.count(),
    prisma.account.count({ where: { isActive: true, allowPosting: true, children: { none: {} } } }),
    prisma.accountRole.findMany({ include: { account: { select: { code: true, nameAr: true, nameEn: true } } } }),
    goLive ? prisma.fiscalPeriod.findFirst({ where: { startDate: { lte: goLive }, endDate: { gte: goLive } }, select: { id: true, status: true } }) : Promise.resolve(null),
    enginePosted(),
    payrollAlignment(),
  ]);
  const byRole = new Map(maps.map((m) => [m.role, m]));
  const roles = ACCOUNT_ROLES.map((r) => {
    const m = byRole.get(r.key);
    return { key: r.key, ar: r.ar, en: r.en, phase: r.phase, group: r.group, accountId: m?.accountId ?? null, accountCode: m?.account.code ?? null, accountName: m ? (m.account.nameAr ?? m.account.nameEn) : null };
  });
  const missing = (keys: string[]) => keys.filter((k) => !byRole.has(k));
  const missingByPhase = { A1: missing(ACCOUNT_ROLES.filter((r) => r.phase === "A1").map((r) => r.key)), A2: missing(ACCOUNT_ROLES.filter((r) => r.phase === "A2").map((r) => r.key)), A3: missing(ACCOUNT_ROLES.filter((r) => r.phase === "A3").map((r) => r.key)) };
  const missingForActivation = missing(ACTIVATION_ROLES);
  const checks = [
    { key: "chart", ok: postable > 0, ar: "دليل حسابات فيه حسابات قابلة للترحيل", en: "A chart with postable accounts" },
    { key: "roles", ok: missingForActivation.length === 0, ar: "ربط أدوار المرحلة الأولى (فروقات التقريب، حقوق ملكية الأرصدة الافتتاحية)", en: "Phase A1 roles mapped (rounding, opening balance equity)" },
    { key: "goLive", ok: !!goLive, ar: "تاريخ بدء المحاسبة محدد", en: "A go-live date" },
    { key: "period", ok: !!period && period.status === "OPEN", ar: "فترة تاريخ البدء موجودة ومفتوحة", en: "The go-live date's period exists and is open" },
    // Audit F-6: no HR posting key sits on an account other than its role's (payroll-alignment.ts). A misaligned key
    // posts payroll where the ledger does not expect it — COMMISSION_EXPENSE off its payable expenses commission twice.
    // An unmapped key is not a refusal here: HR refuses to post through it on its own.
    { ...PAYROLL_CHECK, ok: !alignment.rows.some((r) => r.status === "MISALIGNED") },
  ];
  return {
    active: s.accountingActive,
    goLiveDate: goLive ? dayText(goLive) : null,
    accounts, postable, roles, missingForActivation, missingByPhase,
    goLivePeriod: period ? { id: period.id, status: String(period.status) } : null,
    openingPosted: !!s.openingEntryId,
    enginePosted: posted,
    checks,
    canActivate: !s.accountingActive && checks.every((c) => c.ok),
  };
}

/** «تهيئة دليل الحسابات»: the default chart into an EMPTY chart, and its role mapping. `dryRun` = preview only. */
export async function seedChart(ctx: AuditContext, opts: { dryRun?: boolean } = {}) {
  const roles = ACCOUNT_ROLES.map((r) => ({ role: r.key, code: r.seedCode }));
  const preview = { template: COA_TEMPLATE_KEY, accounts: COA_TEMPLATE.length, postable: COA_TEMPLATE.filter((r) => r.postable).length, roles: roles.length };
  if (opts.dryRun) {
    if ((await prisma.account.count()) > 0) throw refuse("CHART_NOT_EMPTY");
    return { ...preview, dryRun: true, rows: COA_TEMPLATE };
  }
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, { ...ctx, reason: ctx.reason ?? `seed ${COA_TEMPLATE_KEY}` });
    // Serialise two seeding clicks: the second sees the first one's chart and is refused.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('accounting:coa-seed', 0))`;
    if ((await tx.account.count()) > 0) throw refuse("CHART_NOT_EMPTY");
    const idOf = new Map<string, string>();
    for (const r of COA_TEMPLATE) {
      const a = await tx.account.create({
        data: {
          code: r.code, nameAr: r.ar, nameEn: r.en, type: r.type, normalBalance: r.normal,
          parentId: r.parent ? idOf.get(r.parent) ?? null : null, allowPosting: r.postable,
          controlType: r.control, allowManualJournal: r.manual, createdBy: ctx.actorId, updatedBy: ctx.actorId,
        },
        select: { id: true },
      });
      idOf.set(r.code, a.id);
    }
    for (const { role, code } of roles) {
      const accountId = idOf.get(code);
      if (accountId) await tx.accountRole.create({ data: { role, accountId, updatedBy: ctx.actorId } });
    }
    // «الأصول الثابتة»: the seeded categories that name no cost account yet take the default chart's (1210 … 1240).
    for (const [code, acc] of Object.entries(CATEGORY_SEED_COST_CODE)) {
      const accountId = idOf.get(acc);
      if (accountId) await tx.fixedAssetCategory.updateMany({ where: { code, costAccountId: null }, data: { costAccountId: accountId, updatedBy: ctx.actorId } });
    }
    await tx.accountingSettings.upsert({
      where: { id: SINGLETON },
      create: { id: SINGLETON, coaSeededAt: new Date(), coaSeededBy: ctx.actorId, coaTemplate: COA_TEMPLATE_KEY, updatedBy: ctx.actorId },
      update: { coaSeededAt: new Date(), coaSeededBy: ctx.actorId, coaTemplate: COA_TEMPLATE_KEY, updatedBy: ctx.actorId },
    });
    return { ...preview, dryRun: false };
  }, TX_OPTS);
}

/** Map (or re-map) posting roles. The account must be an active postable leaf of a type the role accepts. */
export async function setRoles(map: Record<string, unknown>, ctx: AuditContext) {
  const entries = Object.entries(map);
  if (!entries.length) throw refuse("BAD_INPUT", "No roles given.");
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    for (const [role, accountId] of entries) {
      const def = roleDef(role);
      if (!def) throw refuse("ROLE_UNKNOWN", `(${role})`);
      if (accountId === null) {
        if (ACTIVATION_ROLES.includes(role) && (await getSettings(tx)).accountingActive) throw refuse("ROLE_NOT_MAPPED", `(${role} is required while accounting is active)`);
        await tx.accountRole.deleteMany({ where: { tenantId: "hiqbah", role } });
        continue;
      }
      if (typeof accountId !== "string") throw refuse("BAD_INPUT", `(${role})`);
      const a = await tx.account.findUnique({ where: { id: accountId }, select: { id: true, code: true, type: true, isActive: true, allowPosting: true, _count: { select: { children: true } } } });
      if (!a) throw refuse("ACCOUNT_NOT_FOUND");
      if (!a.isActive || !a.allowPosting || a._count.children > 0) throw refuse("ACCOUNT_NOT_POSTABLE", `(${a.code})`, `(${a.code})`);
      if (!def.types.includes(String(a.type) as never)) throw refuse("ROLE_TYPE", `(${role} → ${a.code})`, `(${def.ar} ← ${a.code})`);
      await tx.accountRole.upsert({
        where: { tenantId_role: { tenantId: "hiqbah", role } },
        create: { role, accountId, updatedBy: ctx.actorId },
        update: { accountId, updatedBy: ctx.actorId },
      });
    }
    return tx.accountRole.findMany({ orderBy: { role: "asc" } });
  }, TX_OPTS);
}

/** Council F3 (fixed assets): with assets in the register, the go-live date is the 1st of a month (FA_GO_LIVE_DAY). */
async function faGoLiveGuard(tx: Prisma.TransactionClient, day: Date): Promise<void> {
  if (day.getUTCDate() === 1) return;
  if (await tx.fixedAsset.count({ where: { status: { not: "DRAFT" } } })) assertGoLiveFirstOfMonth(day);
}

/** Activate (with the go-live date) when every readiness check passes. */
export async function activate(goLive: string, ctx: AuditContext) {
  let day: Date;
  try { day = parseBusinessDay(goLive); } catch { throw refuse("GO_LIVE_REQUIRED"); }
  const r = await readiness(goLive);
  if (r.active) throw refuse("ALREADY_ACTIVE");
  if (!r.canActivate) throw refuse("ACTIVATION_NOT_READY", `(${r.checks.filter((c) => !c.ok).map((c) => c.key).join(", ")})`, `(${r.checks.filter((c) => !c.ok).map((c) => c.ar).join("؛ ")})`);
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    // Review L-2: the readiness above ran outside this transaction. Hold the settings row and freeze the HR map and the
    // role map (SHARE: no concurrent insert / update / delete until this commits), then re-check the payroll alignment
    // on what this activation commits with: a map made MISALIGNED meanwhile rolls the activation back.
    await tx.$queryRaw`SELECT "id" FROM "AccountingSettings" WHERE "id" = ${SINGLETON} FOR UPDATE`;
    await tx.$executeRawUnsafe(`LOCK TABLE "HrAccountMap", "HrPayrollAccount", "AccountRole" IN SHARE MODE`);
    await faGoLiveGuard(tx, day);
    if ((await payrollAlignment(tx)).rows.some((row) => row.status === "MISALIGNED")) {
      const c = PAYROLL_CHECK;
      throw refuse("ACTIVATION_NOT_READY", `(${c.key})`, `(${c.ar})`);
    }
    const now = new Date();
    return tx.accountingSettings.upsert({
      where: { id: SINGLETON },
      create: { id: SINGLETON, accountingActive: true, goLiveDate: day, activatedAt: now, activatedBy: ctx.actorId, setupComplete: true, updatedBy: ctx.actorId },
      update: { accountingActive: true, goLiveDate: day, activatedAt: now, activatedBy: ctx.actorId, setupComplete: true, updatedBy: ctx.actorId },
    });
  }, TX_OPTS);
}

/** Only before the engine has posted anything (the database refuses it after). */
export async function deactivate(ctx: AuditContext) {
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    if (await enginePosted(tx)) throw refuse("ENGINE_HAS_POSTED");
    return tx.accountingSettings.update({ where: { id: SINGLETON }, data: { accountingActive: false, activatedAt: null, activatedBy: null, updatedBy: ctx.actorId } });
  }, TX_OPTS);
}

/** The go-live date before activation (after the engine has posted, the database refuses a change). */
export async function setGoLiveDate(goLive: string | null, ctx: AuditContext) {
  let day: Date | null = null;
  if (goLive) { try { day = parseBusinessDay(goLive); } catch { throw refuse("BAD_INPUT", "goLiveDate is YYYY-MM-DD."); } }
  return prisma.$transaction(async (tx) => {
    await setAuditContext(tx, ctx);
    const s = await getSettings(tx);
    if (s.accountingActive) throw refuse("ALREADY_ACTIVE");
    if (day) await faGoLiveGuard(tx, day);
    return tx.accountingSettings.upsert({ where: { id: SINGLETON }, create: { id: SINGLETON, goLiveDate: day, updatedBy: ctx.actorId }, update: { goLiveDate: day, updatedBy: ctx.actorId } });
  }, TX_OPTS);
}
