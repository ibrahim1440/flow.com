// «الخطط والأهداف» (owner decision, 3 Nov 2026): a rep's plan of a day, a week (Sunday → Saturday) or a month, in Riyadh
// time. Management goals (ADMIN) are set by sales › lead_assign — the people who set the monthly target — and read by the
// rep locked; the rep's own goals and checklist items (SELF) are private to the rep (the supervisor only reads them).
// A goal's progress is COUNTED from the rep's own records, never typed, except a CUSTOM goal (a free label) whose progress
// the rep enters. The counting rules are the ones the supervisor's screen states:
//   VISITS         completed «زيارة» activities the rep owns;
//   CALLS          completed «مكالمة» activities, «لا رد» excluded;
//   QUOTES         quotations the rep created that were issued in the period;
//   COLLECTION     recorded collections on the rep's deals, attributed by ownership share — the same figure as the target;
//   NEW_CUSTOMERS  customers created in the period that the rep is the account owner of;
//   SAMPLES        samples sent in the period on the rep's deals.
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { Decimal, ZERO } from "@/lib/services/commissions/engine";
import { attributeCollections, type DealOwners } from "@/lib/services/sales/performance";

type Db = Pick<PrismaClient, "$queryRaw" | "salesPlanItem">;
export type Tx = Prisma.TransactionClient;

export const PERIODS = ["DAY", "WEEK", "MONTH"] as const;
export type Period = (typeof PERIODS)[number];
export const METRICS = ["VISITS", "CALLS", "QUOTES", "COLLECTION", "NEW_CUSTOMERS", "SAMPLES", "CUSTOM"] as const;
export type Metric = (typeof METRICS)[number];
export const METRIC_LABEL: Record<Metric, { ar: string; en: string; unitAr?: string }> = {
  VISITS: { ar: "زيارات عملاء", en: "Customer visits" },
  CALLS: { ar: "مكالمات", en: "Calls" },
  QUOTES: { ar: "عروض أسعار", en: "Quotations" },
  COLLECTION: { ar: "تحصيل", en: "Collections", unitAr: "ر.س" },
  NEW_CUSTOMERS: { ar: "عملاء جدد", en: "New customers" },
  SAMPLES: { ar: "عيّنات مرسلة", en: "Samples sent" },
  CUSTOM: { ar: "هدف خاص", en: "Custom goal" },
};

const RIYADH = 3 * 3_600_000;
const DAY = 86_400_000;
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The Riyadh calendar day of an instant, "YYYY-MM-DD". */
export const riyadhIso = (d: Date) => isoOf(d.getTime() + RIYADH);

/** The first day of the period containing `day` (Riyadh dates): itself, the Sunday before it, or the 1st. */
export function periodStartOf(period: Period, day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) throw new RangeError("bad day");
  if (period === "DAY") return isoOf(t);
  if (period === "WEEK") return isoOf(t - new Date(t).getUTCDay() * DAY);
  return `${day.slice(0, 7)}-01`;
}

/** The next period's first day. */
export function periodEndOf(period: Period, start: string): string {
  const t = Date.parse(`${start}T00:00:00Z`);
  if (period === "DAY") return isoOf(t + DAY);
  if (period === "WEEK") return isoOf(t + 7 * DAY);
  const d = new Date(t);
  return isoOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** The UTC instants of a Riyadh-dates window [start, end). */
export const windowOf = (start: string, end: string) => ({ from: new Date(Date.parse(`${start}T00:00:00Z`) - RIYADH), to: new Date(Date.parse(`${end}T00:00:00Z`) - RIYADH) });

export type Counts = Record<Exclude<Metric, "CUSTOM">, number>;

/** What the rep did in [from, to), per counted metric — one round trip for the five counts, one for collections. */
export async function countsFor(db: Pick<PrismaClient, "$queryRaw">, employeeId: string, from: Date, to: Date): Promise<Counts> {
  const [row] = await db.$queryRaw<{ visits: bigint; calls: bigint; quotes: bigint; customers: bigint; samples: bigint }[]>`
    SELECT
      (SELECT count(*) FROM "Activity" a WHERE a."ownerId" = ${employeeId} AND a."type"::text = 'VISIT'
         AND a."completedAt" >= ${from} AND a."completedAt" < ${to}) AS visits,
      (SELECT count(*) FROM "Activity" a WHERE a."ownerId" = ${employeeId} AND a."type"::text = 'CALL'
         AND a."completedAt" >= ${from} AND a."completedAt" < ${to} AND (a."outcome" IS NULL OR a."outcome"::text <> 'NO_ANSWER')) AS calls,
      (SELECT count(*) FROM "Quote" q WHERE q."createdById" = ${employeeId} AND q."issuedAt" >= ${from} AND q."issuedAt" < ${to}) AS quotes,
      (SELECT count(*) FROM "Customer" c WHERE c."accountOwnerId" = ${employeeId} AND c."createdAt" >= ${from} AND c."createdAt" < ${to}) AS customers,
      (SELECT count(*) FROM "SampleShipment" s JOIN "Opportunity" o ON o."id" = s."opportunityId"
         WHERE o."ownerId" = ${employeeId} AND s."sentAt" >= ${from} AND s."sentAt" < ${to}) AS samples`;
  const rows = await db.$queryRaw<{ amountGross: unknown; amountTax: unknown; amountNonQualifying: unknown; collectedAt: Date; opportunityId: string;
    ownerId: string; owners: { employeeId: string; sharePercent: string; effectiveFrom: string }[] | null }[]>`
    SELECT e."amountGross", e."amountTax", e."amountNonQualifying", e."collectedAt", e."opportunityId", o."ownerId",
           (SELECT json_agg(json_build_object('employeeId', w."employeeId", 'sharePercent', w."sharePercent", 'effectiveFrom', w."effectiveFrom"))
              FROM "OpportunityOwner" w WHERE w."opportunityId" = o."id") AS owners
      FROM "CollectionEvent" e JOIN "Opportunity" o ON o."id" = e."opportunityId"
     WHERE e."status"::text = 'RECORDED' AND e."collectedAt" >= ${from} AND e."collectedAt" < ${to}
       AND (o."ownerId" = ${employeeId} OR EXISTS (SELECT 1 FROM "OpportunityOwner" w WHERE w."opportunityId" = o."id" AND w."employeeId" = ${employeeId}))`;
  const dec = (v: unknown) => (v === null || v === undefined ? ZERO : new Decimal(String(v)));
  const deals = new Map<string, DealOwners>();
  for (const r of rows) {
    if (!deals.has(r.opportunityId)) deals.set(r.opportunityId, { id: r.opportunityId, ownerId: r.ownerId,
      owners: (r.owners ?? []).map((o) => ({ employeeId: o.employeeId, sharePercent: new Decimal(String(o.sharePercent)), effectiveFrom: new Date(o.effectiveFrom) })) });
  }
  const collected = attributeCollections(rows.map((r) => ({ amountGross: dec(r.amountGross), amountTax: dec(r.amountTax), amountNonQualifying: dec(r.amountNonQualifying),
    collectedAt: r.collectedAt, opportunityId: r.opportunityId })), [...deals.values()]).get(employeeId) ?? ZERO;
  return {
    VISITS: Number(row?.visits ?? 0), CALLS: Number(row?.calls ?? 0), QUOTES: Number(row?.quotes ?? 0),
    NEW_CUSTOMERS: Number(row?.customers ?? 0), SAMPLES: Number(row?.samples ?? 0),
    COLLECTION: Math.round(Number(collected) * 100) / 100,
  };
}

export type PlanItem = {
  id: string; source: "ADMIN" | "SELF"; kind: "GOAL" | "CHECK"; metric: Metric | null; label: string | null;
  target: number | null; done: number | null; checked: boolean; position: number; setBy: string | null;
};

/** The plan of one rep for one period, with every goal's progress. */
export async function loadPlan(db: Db, employeeId: string, period: Period, start: string, now = new Date()) {
  const end = periodEndOf(period, start);
  const { from, to } = windowOf(start, end);
  const [rows, counts] = await Promise.all([
    db.salesPlanItem.findMany({
      where: { employeeId, period, periodStart: new Date(`${start}T00:00:00Z`) },
      orderBy: [{ source: "asc" }, { position: "asc" }, { createdAt: "asc" }],
      select: { id: true, source: true, kind: true, metric: true, label: true, target: true, manualDone: true, checkedAt: true, position: true, createdBy: { select: { name: true } } },
    }),
    countsFor(db, employeeId, from, to < now ? to : now),
  ]);
  const items: PlanItem[] = rows.map((r) => ({
    id: r.id, source: r.source as PlanItem["source"], kind: r.kind as PlanItem["kind"], metric: (r.metric as Metric | null) ?? null, label: r.label,
    target: r.target === null ? null : Number(r.target),
    done: r.kind !== "GOAL" ? null : r.metric === "CUSTOM" ? Number(r.manualDone ?? 0) : counts[r.metric as keyof Counts] ?? 0,
    checked: !!r.checkedAt, position: r.position, setBy: r.source === "ADMIN" ? r.createdBy?.name ?? null : null,
  }));
  return { period, start, end, items, counts };
}

export class PlanError extends Error {
  constructor(public status: number, public ar: string, en: string) { super(en); }
}

export type SelfInput = { id?: string | null; kind: "GOAL" | "CHECK"; metric?: string | null; label?: string | null; target?: number | string | null; checked?: boolean; manualDone?: number | string | null };

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};

/** One SELF item, checked: what the database CHECK accepts, said in plain words. */
export function cleanSelf(it: SelfInput): { kind: "GOAL" | "CHECK"; metric: Metric | null; label: string | null; target: number | null; manualDone: number | null; checked: boolean } {
  const label = typeof it.label === "string" ? it.label.trim().replace(/\s+/g, " ") : "";
  if (it.kind === "CHECK") {
    if (label.length < 2 || label.length > 200) throw new PlanError(400, "اكتب البند (حرفين على الأقل).", "Write the item (2–200 characters).");
    return { kind: "CHECK", metric: null, label, target: null, manualDone: null, checked: !!it.checked };
  }
  if (it.kind !== "GOAL") throw new PlanError(400, "نوع البند غير معروف.", "Unknown item kind.");
  const metric = (METRICS as readonly string[]).includes(String(it.metric)) ? (it.metric as Metric) : null;
  if (!metric) throw new PlanError(400, "اختر نوع الهدف.", "Choose the goal's kind.");
  const target = num(it.target);
  if (target === null || Number.isNaN(target) || target <= 0) throw new PlanError(400, "اكتب رقم الهدف (أكبر من صفر).", "Give the target (above zero).");
  if (metric === "CUSTOM" && (label.length < 2 || label.length > 80)) throw new PlanError(400, "اكتب اسم الهدف الخاص.", "Name the custom goal (2–80 characters).");
  const manual = metric === "CUSTOM" ? num(it.manualDone) : null;
  if (manual !== null && (Number.isNaN(manual) || manual < 0)) throw new PlanError(400, "الإنجاز رقم موجب.", "Progress is a non-negative number.");
  return { kind: "GOAL", metric, label: metric === "CUSTOM" ? label : null, target, manualDone: manual, checked: false };
}

/** Replace the rep's own items of one period (the rep only). Ids kept keep their row; the rest are removed. */
export async function saveSelf(tx: Tx, employeeId: string, period: Period, start: string, input: SelfInput[]) {
  if (!Array.isArray(input) || input.length > 40) throw new PlanError(400, "الخطة طويلة جدًا (40 بندًا كحد أقصى).", "At most 40 items.");
  const periodStart = new Date(`${start}T00:00:00Z`);
  const existing = await tx.salesPlanItem.findMany({ where: { employeeId, period, periodStart, source: "SELF" }, select: { id: true, checkedAt: true } });
  const known = new Map(existing.map((e) => [e.id, e]));
  const keep = new Set<string>();
  const now = new Date();
  for (const [i, raw] of input.entries()) {
    const c = cleanSelf(raw);
    const data = { kind: c.kind, metric: c.metric, label: c.label, target: c.target, manualDone: c.manualDone, position: i };
    const prev = raw.id ? known.get(raw.id) : undefined;
    if (prev) {
      keep.add(prev.id);
      await tx.salesPlanItem.update({ where: { id: prev.id }, data: { ...data, checkedAt: c.kind === "CHECK" ? (c.checked ? prev.checkedAt ?? now : null) : null } });
    } else {
      await tx.salesPlanItem.create({ data: { ...data, employeeId, period, periodStart, source: "SELF", createdById: employeeId, checkedAt: c.kind === "CHECK" && c.checked ? now : null } });
    }
  }
  const drop = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (drop.length) await tx.salesPlanItem.deleteMany({ where: { id: { in: drop } } });
}

export type AdminGoalInput = { employeeId: string; metric: string; label?: string | null; target: number | string | null };

/** Set the management goals of one period for the listed reps: a number sets it, empty removes it. */
export async function setAdminGoals(tx: Tx, actorId: string, period: Period, start: string, goals: AdminGoalInput[]) {
  if (period === "DAY") throw new PlanError(400, "الأهداف الإدارية أسبوعية أو شهرية.", "Management goals are weekly or monthly.");
  if (!Array.isArray(goals) || goals.length > 500) throw new PlanError(400, "قائمة الأهداف طويلة جدًا.", "Too many goals.");
  const periodStart = new Date(`${start}T00:00:00Z`);
  for (const g of goals) {
    const metric = (METRICS as readonly string[]).includes(String(g.metric)) ? (g.metric as Metric) : null;
    if (!metric || typeof g.employeeId !== "string") throw new PlanError(400, "هدف غير صالح.", "Invalid goal.");
    const label = metric === "CUSTOM" ? (typeof g.label === "string" ? g.label.trim().replace(/\s+/g, " ") : "") : null;
    if (metric === "CUSTOM" && (!label || label.length < 2 || label.length > 80)) throw new PlanError(400, "اكتب اسم الهدف الخاص.", "Name the custom goal.");
    const target = num(g.target);
    if (target !== null && (Number.isNaN(target) || target <= 0)) throw new PlanError(400, "الهدف رقم أكبر من صفر، أو اتركه فاضي.", "A target is above zero, or empty.");
    const where = { employeeId: g.employeeId, period, periodStart, source: "ADMIN", metric, label };
    const prev = await tx.salesPlanItem.findFirst({ where, select: { id: true } });
    if (target === null) { if (prev) await tx.salesPlanItem.delete({ where: { id: prev.id } }); continue; }
    if (prev) await tx.salesPlanItem.update({ where: { id: prev.id }, data: { target, createdById: actorId } });
    else await tx.salesPlanItem.create({ data: { ...where, kind: "GOAL", target, createdById: actorId } });
  }
}
