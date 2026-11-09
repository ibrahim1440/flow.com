// «الخطط والأهداف» (owner decision, 3 Nov 2026): a rep's plan of a day, a week (Sunday → Saturday) or a month, in Riyadh
// time. Management goals (ADMIN) are set by sales › lead_assign — the people who set the monthly target — and read by the
// rep locked; the rep's own goals and checklist items (SELF) are private to the rep (the supervisor only reads them).
// A goal's progress is COUNTED from the rep's own records, never typed, except a CUSTOM goal (a free label) whose progress
// the rep enters. «خطة الأسبوع v2» (owner-approved Figma page 07, 3 Nov 2026): the plan is made of ACTIONS — a visit, a
// call, a quotation, a collection or a sample for one customer, on a day or undated — each DONE when the rep's own record
// of it exists in its week (`matchPlan`); the supervisor may put actions and free items in a rep's plan too (ADMIN). The counting rules are the ones the supervisor's screen states:
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

export const ACTION_METRICS = ["VISITS", "CALLS", "QUOTES", "COLLECTION", "SAMPLES"] as const;
export type ActionMetric = (typeof ACTION_METRICS)[number];
export const isActionMetric = (v: unknown): v is ActionMetric => (ACTION_METRICS as readonly string[]).includes(String(v));

/** One record of the rep's that can fulfil a planned action: a visit, a call (answered), a quotation, a collection, a sample. */
export type PlanRecord = { metric: ActionMetric; id: string; customerId: string | null; customerName: string | null; title: string | null; at: Date; outcome: string | null; body: string | null };

/** The rep's records of the five action kinds in [from, to), each with its customer (directly, or through the deal). */
export async function recordsFor(db: Pick<PrismaClient, "$queryRaw">, employeeId: string, from: Date, to: Date): Promise<PlanRecord[]> {
  if (to <= from) return [];
  const rows = await db.$queryRaw<{ metric: ActionMetric; id: string; customerId: string | null; at: Date; outcome: string | null; body: string | null; title: string | null; name: string | null; nameAr: string | null }[]>`
    SELECT r.*, c."name", c."nameAr" FROM (
      SELECT CASE WHEN a."type"::text = 'VISIT' THEN 'VISITS' ELSE 'CALLS' END AS metric, a."id", coalesce(a."customerId", o."customerId") AS "customerId",
             a."completedAt" AS at, a."outcome"::text AS outcome, a."body", a."subject" AS title
        FROM "Activity" a LEFT JOIN "Opportunity" o ON o."id" = a."opportunityId"
       WHERE a."ownerId" = ${employeeId} AND a."completedAt" >= ${from} AND a."completedAt" < ${to}
         AND (a."type"::text = 'VISIT' OR (a."type"::text = 'CALL' AND (a."outcome" IS NULL OR a."outcome"::text <> 'NO_ANSWER')))
      UNION ALL
      SELECT 'QUOTES', q."id", coalesce(q."customerId", o."customerId"), q."issuedAt", NULL, NULL, NULL
        FROM "Quote" q LEFT JOIN "Opportunity" o ON o."id" = q."opportunityId"
       WHERE q."createdById" = ${employeeId} AND q."issuedAt" >= ${from} AND q."issuedAt" < ${to}
      UNION ALL
      SELECT 'COLLECTION', e."id", o."customerId", e."collectedAt", NULL, NULL, NULL
        FROM "CollectionEvent" e JOIN "Opportunity" o ON o."id" = e."opportunityId"
       WHERE e."status"::text = 'RECORDED' AND e."collectedAt" >= ${from} AND e."collectedAt" < ${to}
         AND (o."ownerId" = ${employeeId} OR EXISTS (SELECT 1 FROM "OpportunityOwner" w WHERE w."opportunityId" = o."id" AND w."employeeId" = ${employeeId}))
      UNION ALL
      SELECT 'SAMPLES', s."id", o."customerId", s."sentAt", NULL, NULL, NULL
        FROM "SampleShipment" s JOIN "Opportunity" o ON o."id" = s."opportunityId"
       WHERE o."ownerId" = ${employeeId} AND s."sentAt" >= ${from} AND s."sentAt" < ${to}
    ) r LEFT JOIN "Customer" c ON c."id" = r."customerId"
    ORDER BY r.at`;
  return rows.map((r) => ({ metric: r.metric, id: r.id, customerId: r.customerId, customerName: r.nameAr ?? r.name, title: r.title, at: new Date(r.at), outcome: r.outcome, body: r.body }));
}

/** A planned action as the matcher sees it. */
export type ActionRef = { id: string; metric: ActionMetric; customerId: string; weekStart: string; plannedDay: string | null; createdAt: Date };

/**
 * Which record fulfils which planned action: the same kind, the same customer, one record per item.
 * Owner decision M1 (9 Nov 2026): an item planned for a DAY is ticked by a record of that Riyadh day or of a LATER day of
 * the same week (a visit planned Monday and made Tuesday counts) — never by one from before its day. Priority:
 *   1. every dated item takes a record of its own day first (Wednesday's own call stays Wednesday's);
 *   2. then, in planned-day order, the earliest unused record of a later day of its week (Monday's item claims Tuesday's);
 *   3. undated items take any unused record of their week (Riyadh), the oldest item first.
 * Records nobody took are «خارج الخطة». The counts of the targets (countsFor) and the commissions do not read this.
 */
export function matchPlan(items: ActionRef[], records: PlanRecord[]): { done: Map<string, PlanRecord>; unplanned: PlanRecord[] } {
  const used = new Set<string>();
  const done = new Map<string, PlanRecord>();
  const byDay = (a: ActionRef, b: ActionRef) => (a.plannedDay ?? "9999").localeCompare(b.plannedDay ?? "9999") || a.createdAt.getTime() - b.createdAt.getTime();
  const dated = items.filter((i) => i.plannedDay).sort(byDay);
  const undated = items.filter((i) => !i.plannedDay).sort(byDay);
  const take = (it: ActionRef, from: Date, to: Date) => {
    if (done.has(it.id)) return;
    const r = records.filter((x) => !used.has(x.id) && x.metric === it.metric && x.customerId === it.customerId && x.at >= from && x.at < to)
      .sort((x, y) => x.at.getTime() - y.at.getTime())[0];
    if (r) { used.add(r.id); done.set(it.id, r); }
  };
  for (const it of dated) { const w = windowOf(it.plannedDay!, periodEndOf("DAY", it.plannedDay!)); take(it, w.from, w.to); }
  for (const it of dated) { const w = windowOf(it.plannedDay!, periodEndOf("WEEK", it.weekStart)); take(it, w.from, w.to); }
  for (const it of undated) { const w = windowOf(it.weekStart, periodEndOf("WEEK", it.weekStart)); take(it, w.from, w.to); }
  return { done, unplanned: records.filter((r) => !used.has(r.id)) };
}

export type PlanItem = {
  id: string; source: "ADMIN" | "SELF"; kind: "GOAL" | "CHECK" | "ACTION"; metric: Metric | null; label: string | null;
  target: number | null; done: number | null; checked: boolean; position: number; setBy: string | null;
  /** D16: the customer's phone and address — the row's call / WhatsApp / map buttons; null without the contact right. */
  customer: { id: string; name: string; phone?: string | null; address?: string | null } | null; plannedDay: string | null; doneAt: string | null; doneOutcome: string | null; doneBody: string | null;
  /** The week (its Sunday) an action or free item belongs to; null for a number. */
  weekStart: string | null;
  /** D16: "HH:MM" (Riyadh) — a time makes the item an appointment («موعد»); null = a day only («تذكير»). */
  plannedTime: string | null;
  /**
   * D16 — how a done item got done: "record" (the rep recorded the visit / call), "auto" (a quotation, a collection or a
   * sample shipment the system saw — «انحسبت تلقائياً»), "manual" (a free item, or a sample ticked by hand); null = open.
   */
  doneHow: "record" | "auto" | "manual" | null;
};
export type OffPlan = { id: string; metric: ActionMetric; customer: { id: string; name: string } | null; title: string | null; at: string; outcome: string | null; body: string | null };

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * The plan of one rep for one period: the goals of that period with their progress, and the planned actions and free items
 * that fall in it (the week's items; for a day, those planned that day or undated; for a month, the weeks that touch it),
 * each action DONE when the rep's own record of it exists in its week, and the period's visits and calls nobody planned.
 */
export async function loadPlan(db: Db, employeeId: string, period: Period, start: string, now = new Date(), opts: { contact?: boolean } = {}) {
  const end = periodEndOf(period, start);
  const weekFrom = periodStartOf("WEEK", start);
  const { from, to } = windowOf(start, end);
  const [goals, rows] = await Promise.all([
    db.salesPlanItem.findMany({
      where: { employeeId, period, periodStart: new Date(`${start}T00:00:00Z`), kind: "GOAL" },
      orderBy: [{ source: "asc" }, { position: "asc" }, { createdAt: "asc" }],
      select: { id: true, source: true, kind: true, metric: true, label: true, target: true, manualDone: true, position: true, createdBy: { select: { name: true } } },
    }),
    db.salesPlanItem.findMany({
      where: { employeeId, kind: { in: ["ACTION", "CHECK"] }, OR: [
        { period: "WEEK", periodStart: { gte: new Date(`${weekFrom}T00:00:00Z`), lt: new Date(`${end}T00:00:00Z`) } },
        { period, periodStart: new Date(`${start}T00:00:00Z`) },
      ] },
      orderBy: [{ plannedDay: { sort: "asc", nulls: "last" } }, { position: "asc" }, { createdAt: "asc" }],
      select: { id: true, source: true, kind: true, metric: true, label: true, checkedAt: true, position: true, periodStart: true, plannedDay: true, plannedTime: true, createdAt: true,
        // D16 gate P1: the phone and address only for a caller with the customer-contact right (canSeeCustomerContact).
        customer: { select: { id: true, name: true, nameAr: true, phone: !!opts.contact, address: !!opts.contact } }, createdBy: { select: { name: true } } },
    }),
  ]);
  const inView = rows.filter((r) => {
    const d = isoDay(r.plannedDay);
    return d ? d >= start && d < end : period !== "DAY" || isoDay(r.periodStart) === weekFrom;
  });
  // Gate N1: the matching runs over every planned item of the weeks fetched (not only those in view), so a day's view
  // ticks exactly what the week's view ticks — Monday's item never takes Tuesday's call because Tuesday is out of view.
  const lastWeek = rows.reduce((m, r) => { const w = isoDay(r.periodStart)!; return w > m ? w : m; }, weekFrom);
  const recEnd = periodEndOf("WEEK", lastWeek) > end ? periodEndOf("WEEK", lastWeek) : end;
  const recWin = windowOf(weekFrom < start ? weekFrom : start, recEnd);
  const cap = (d: Date) => (d < now ? d : now);
  const [records, counts] = await Promise.all([
    recordsFor(db, employeeId, recWin.from, cap(recWin.to)),
    countsFor(db, employeeId, from, cap(to)),
  ]);
  // A sample ticked by hand (D16) is done already: it does not take a record from another planned item.
  const actions: ActionRef[] = rows.filter((r) => r.kind === "ACTION" && r.customer && isActionMetric(r.metric) && !r.checkedAt)
    .map((r) => ({ id: r.id, metric: r.metric as ActionMetric, customerId: r.customer!.id, weekStart: isoDay(r.periodStart)!, plannedDay: isoDay(r.plannedDay), createdAt: r.createdAt }));
  const { done, unplanned } = matchPlan(actions, records);
  const name = (c: { id: string; name: string; nameAr: string | null; phone?: string | null; address?: string | null } | null) =>
    (c ? { id: c.id, name: c.nameAr ?? c.name, phone: c.phone ?? null, address: c.address ?? null } : null);
  const items: PlanItem[] = [
    ...goals.map((r) => ({
      id: r.id, source: r.source as PlanItem["source"], kind: "GOAL" as const, metric: (r.metric as Metric | null) ?? null, label: r.label,
      target: r.target === null ? null : Number(r.target),
      done: r.metric === "CUSTOM" ? Number(r.manualDone ?? 0) : counts[r.metric as keyof Counts] ?? 0,
      checked: false, position: r.position, setBy: r.source === "ADMIN" ? r.createdBy?.name ?? null : null,
      customer: null, plannedDay: null, doneAt: null, doneOutcome: null, doneBody: null, weekStart: null, plannedTime: null, doneHow: null,
    })),
    ...inView.map((r) => {
      const rec = done.get(r.id);
      const manual = !!r.checkedAt;
      const doneHow: PlanItem["doneHow"] = r.kind === "CHECK" ? (manual ? "manual" : null)
        : manual ? "manual" : rec ? (r.metric === "VISITS" || r.metric === "CALLS" ? "record" : "auto") : null;
      return {
        id: r.id, source: r.source as PlanItem["source"], kind: r.kind as PlanItem["kind"], metric: (r.metric as Metric | null) ?? null, label: r.label,
        target: null, done: null, checked: !!doneHow, position: r.position,
        setBy: r.source === "ADMIN" ? r.createdBy?.name ?? null : null, customer: name(r.customer), plannedDay: isoDay(r.plannedDay),
        doneAt: rec ? rec.at.toISOString() : r.checkedAt ? r.checkedAt.toISOString() : null,
        doneOutcome: rec?.outcome ?? null, doneBody: rec?.body ?? null, weekStart: isoDay(r.periodStart),
        plannedTime: r.plannedTime ?? null, doneHow,
      };
    }),
  ];
  const offPlan: OffPlan[] = unplanned
    .filter((r) => (r.metric === "VISITS" || r.metric === "CALLS") && r.at >= from && r.at < to)
    .map((r) => ({ id: r.id, metric: r.metric, customer: r.customerId ? { id: r.customerId, name: r.customerName ?? "" } : null, title: r.title, at: r.at.toISOString(), outcome: r.outcome, body: r.body }));
  return { period, start, end, weekStart: weekFrom, items, offPlan, counts, contact: !!opts.contact };
}

export class PlanError extends Error {
  /** `code`: a stable name the client may act on (e.g. PAST_DAY, TWIN). */
  constructor(public status: number, public ar: string, en: string, public code?: string) { super(en); }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const cleanText = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");

/**
 * `restore`: the «تراجع» of a removal puts the item back as it was, even on a day already past (D16 gate); never set by
 * the add sheet, which refuses a past day.
 */
export type ItemInput = { kind?: unknown; metric?: unknown; customerId?: unknown; plannedDay?: unknown; plannedTime?: unknown; label?: unknown; date?: unknown; restore?: unknown };
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** "9:5" / "09:05" / "" → "09:05" | null; anything else is refused. A time needs a day (D16: a time = an appointment). */
export function cleanTime(v: unknown, plannedDay: string | null): string | null {
  if (v === null || v === undefined || v === "") return null;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v).trim());
  const t = m ? `${m[1].padStart(2, "0")}:${m[2].padStart(2, "0")}` : "";
  if (!HHMM.test(t)) throw new PlanError(400, "الوقت غير صحيح.", "Bad time.");
  if (!plannedDay) throw new PlanError(400, "اختر اليوم قبل الوقت.", "Choose the day before the time.");
  return t;
}

/** The next working day after `day` (Sunday–Thursday; Friday and Saturday skipped) — «انقلها لبكرة». */
export function nextWorkDay(day: string): string {
  let t = Date.parse(`${day}T00:00:00Z`) + DAY;
  while ([5, 6].includes(new Date(t).getUTCDay())) t += DAY;
  return isoOf(t);
}

/** One planned item, checked: what the database CHECK accepts, said in plain words. The week is the planned day's, or `today`'s. */
export function cleanItem(it: ItemInput, today: string): { kind: "ACTION" | "CHECK"; metric: ActionMetric | null; customerId: string | null; label: string | null; plannedDay: string | null; plannedTime: string | null; weekStart: string } {
  const kind = it.kind === "CHECK" ? "CHECK" : it.kind === "ACTION" ? "ACTION" : null;
  if (!kind) throw new PlanError(400, "اختر النوع.", "Unknown item kind.");
  const plannedDay = it.plannedDay === null || it.plannedDay === undefined || it.plannedDay === "" ? null : String(it.plannedDay);
  if (plannedDay !== null && !ISO.test(plannedDay)) throw new PlanError(400, "اليوم غير صحيح.", "Bad day.");
  // D16 gate («أبو فهد»): a day already past is refused (it would vanish from «خطة اليوم» and the week) — except a restore.
  if (plannedDay !== null && plannedDay < today && it.restore !== true) throw new PlanError(400, "هذا اليوم فات. اختر اليوم أو بعده.", "That day has passed. Choose today or later.", "PAST_DAY");
  const base = plannedDay ?? (typeof it.date === "string" && ISO.test(it.date) ? it.date : today);
  const label = cleanText(it.label);
  const plannedTime = cleanTime(it.plannedTime, plannedDay);
  if (kind === "CHECK") {
    if (label.length < 2 || label.length > 200) throw new PlanError(400, "اكتب الشغلة (حرفين على الأقل).", "Write the item (2–200 characters).");
    return { kind, metric: null, customerId: null, label, plannedDay, plannedTime, weekStart: periodStartOf("WEEK", base) };
  }
  if (!isActionMetric(it.metric)) throw new PlanError(400, "اختر وش بتسوي.", "Choose what you will do.");
  if (typeof it.customerId !== "string" || !it.customerId) throw new PlanError(400, "اختر العميل.", "Choose the customer.");
  if (label && (label.length < 2 || label.length > 200)) throw new PlanError(400, "الملاحظة طويلة.", "The note is too long.");
  return { kind, metric: it.metric, customerId: it.customerId, label: label || null, plannedDay, plannedTime, weekStart: periodStartOf("WEEK", base) };
}

/**
 * Put one item in a rep's week — the rep's own (SELF), or the supervisor's (ADMIN). The same action for the same customer
 * on the same day (or twice undated in the week) is refused — two calls on different days of a week are fine (D16 gate).
 */
export async function addItem(tx: Tx, who: { employeeId: string; actorId: string; source: "SELF" | "ADMIN" }, input: ItemInput, today: string) {
  const c = cleanItem(input, today);
  // A restore onto a day already past (gate): only the item this same person removed in the last two minutes, once.
  if (c.plannedDay && c.plannedDay < today) await consumeRemoval(tx, who, c);
  const periodStart = new Date(`${c.weekStart}T00:00:00Z`);
  if (c.kind === "ACTION") {
    const customer = await tx.customer.findUnique({ where: { id: c.customerId! }, select: { id: true } });
    if (!customer) throw new PlanError(404, "العميل غير موجود.", "Customer not found.");
    const twin = await tx.salesPlanItem.findFirst({ where: { employeeId: who.employeeId, period: "WEEK", periodStart, kind: "ACTION", metric: c.metric, customerId: c.customerId,
      plannedDay: c.plannedDay ? new Date(`${c.plannedDay}T00:00:00Z`) : null }, select: { id: true } });
    if (twin) throw new PlanError(409, c.plannedDay ? "نفس الشي مخطّط لهالعميل في نفس اليوم." : "نفس الشي مخطّط لهالعميل خلال هالأسبوع بدون يوم.", "The same is already planned for this customer that day.", "TWIN");
  }
  const position = await tx.salesPlanItem.count({ where: { employeeId: who.employeeId, period: "WEEK", periodStart } });
  return tx.salesPlanItem.create({
    data: { employeeId: who.employeeId, period: "WEEK", periodStart, source: who.source, kind: c.kind, metric: c.metric, customerId: c.customerId, label: c.label,
      plannedDay: c.plannedDay ? new Date(`${c.plannedDay}T00:00:00Z`) : null, plannedTime: c.plannedTime, position, createdById: who.actorId },
    select: { id: true },
  });
}

const RESTORE_WINDOW_MS = 2 * 60_000;
type Removed = { itemId: string; employeeId: string; kind: string; metric: string | null; customerId: string | null; label: string | null; plannedDay: string | null; plannedTime: string | null };

/**
 * «شيله من الخطة» (D16): the item is deleted and the removal written to AuthAuditLog (PLAN_ITEM_REMOVED, by whoever removed
 * it) — what «تراجع» may put back, and only that (gate: `restore` is no way to backdate an item).
 */
export async function removeItem(tx: Tx, id: string, actorId: string) {
  const it = await tx.salesPlanItem.findUnique({ where: { id }, select: { id: true, employeeId: true, kind: true, metric: true, customerId: true, label: true, plannedDay: true, plannedTime: true } });
  if (!it) return null;
  await tx.salesPlanItem.delete({ where: { id } });
  const { ipHashOf } = await import("@/lib/accounting/ops/purchase-activity");
  const meta: Removed = { itemId: it.id, employeeId: it.employeeId, kind: it.kind, metric: it.metric, customerId: it.customerId, label: it.label, plannedDay: isoDay(it.plannedDay), plannedTime: it.plannedTime };
  await tx.authAuditLog.create({ data: { userId: actorId, action: "PLAN_ITEM_REMOVED", result: "SUCCESS", sourceInterface: "WEB", ipHash: await ipHashOf(null), metadata: meta } });
  return it;
}

/** The removal a restore onto a past day stands for: the same person, the same item's fields, within two minutes, unused. */
async function consumeRemoval(tx: Tx, who: { employeeId: string; actorId: string }, c: ReturnType<typeof cleanItem>) {
  const since = new Date(Date.now() - RESTORE_WINDOW_MS);
  const [removed, used] = await Promise.all([
    tx.authAuditLog.findMany({ where: { userId: who.actorId, action: "PLAN_ITEM_REMOVED", occurredAt: { gte: since } }, orderBy: { occurredAt: "desc" }, take: 20, select: { id: true, metadata: true } }),
    tx.authAuditLog.findMany({ where: { userId: who.actorId, action: "PLAN_ITEM_RESTORED", occurredAt: { gte: since } }, take: 20, select: { metadata: true } }),
  ]);
  const usedIds = new Set(used.map((u) => (u.metadata as { removalId?: string } | null)?.removalId));
  const hit = removed.find((r) => {
    const m = r.metadata as Removed | null;
    return !!m && !usedIds.has(r.id) && m.employeeId === who.employeeId && m.kind === c.kind && (m.metric ?? null) === c.metric
      && (m.customerId ?? null) === c.customerId && m.plannedDay === c.plannedDay && (m.kind !== "CHECK" || m.label === c.label);
  });
  if (!hit) throw new PlanError(400, "هذا اليوم فات. اختر اليوم أو بعده.", "That day has passed. Choose today or later.", "PAST_DAY");
  // One restore per removal even when two «تراجع» race (gate R3): the restore row's id is the removal's, inserted FIRST — the
  // second call waits on the first's insert and then hits the primary key.
  const { ipHashOf } = await import("@/lib/accounting/ops/purchase-activity");
  const inserted = await tx.$executeRaw`INSERT INTO "AuthAuditLog" ("id", "userId", "action", "result", "sourceInterface", "ipHash", "metadata", "occurredAt")
    VALUES (${`restore_${hit.id}`}, ${who.actorId}, 'PLAN_ITEM_RESTORED', 'SUCCESS', 'WEB', ${await ipHashOf(null)}, ${JSON.stringify({ removalId: hit.id })}::jsonb, now() AT TIME ZONE 'UTC')
    ON CONFLICT ("id") DO NOTHING`;
  if (inserted === 0) throw new PlanError(409, "رجع هذا من قبل.", "This was already put back.", "ALREADY_RESTORED");
}

/**
 * «خطّط أسبوعك › ثبّت خطتي» (D16): several items at once, in one transaction. An action already planned for that customer
 * that week is skipped (not an error) — the rep may run the planner twice; anything else invalid refuses the whole batch.
 */
export async function addItems(tx: Tx, who: { employeeId: string; actorId: string; source: "SELF" | "ADMIN" }, inputs: ItemInput[], today: string) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 60) throw new PlanError(400, "اختر من 1 إلى 60.", "Choose 1 to 60 items.");
  const added: string[] = [];
  let skipped = 0;
  for (const it of inputs) {
    try { added.push((await addItem(tx, who, it, today)).id); }
    catch (e) { if (e instanceof PlanError && e.status === 409) { skipped++; continue; } throw e; }
  }
  return { added, skipped };
}

/**
 * Move an item to another day (or «خلال الأسبوع» with null); a day in another week moves it to that week. D16: the time
 * moves with it only when given — moved to another day without one, an appointment becomes a reminder of that day (the
 * rep sets the new time there). The twin rule of addItem holds here too (gate, 9 Nov): when the target DAY already has the
 * same action for the same customer, a move is refused (`onTwin: "refuse"`, the default — 409 with a plain message) or,
 * for «انقلها لبكرة», MERGED (`onTwin: "merge"`): one item is kept — the supervisor's if either is theirs, else the one
 * already there — taking the moved one's time when it has none, and the other is removed. Answers what happened.
 */
export async function moveItem(tx: Tx, id: string, plannedDay: string | null, today: string, time?: unknown, onTwin: "refuse" | "merge" = "refuse"):
  Promise<{ merged: false; skipped?: true } | { merged: true; keptId: string; removedId: string }> {
  if (plannedDay !== null && !ISO.test(plannedDay)) throw new PlanError(400, "اليوم غير صحيح.", "Bad day.");
  if (plannedDay !== null && plannedDay < today) throw new PlanError(400, "هذا اليوم فات. اختر اليوم أو بعده.", "That day has passed. Choose today or later.", "PAST_DAY");
  const it = await tx.salesPlanItem.findUnique({ where: { id }, select: { employeeId: true, periodStart: true, kind: true, metric: true, customerId: true, source: true, plannedDay: true, plannedTime: true } });
  if (!it || it.kind === "GOAL") throw new PlanError(400, "ما يتأجّل هذا الشي.", "This item cannot be moved.");
  const sameDay = isoDay(it.plannedDay) === plannedDay;
  const plannedTime = time !== undefined ? cleanTime(time, plannedDay) : sameDay ? it.plannedTime : null;
  const week = plannedDay ? periodStartOf("WEEK", plannedDay) : isoDay(it.periodStart) ?? periodStartOf("WEEK", today);
  const periodStart = new Date(`${week}T00:00:00Z`);
  const dayValue = plannedDay ? new Date(`${plannedDay}T00:00:00Z`) : null;
  if (it.kind === "ACTION" && !sameDay) {
    const twin = await tx.salesPlanItem.findFirst({
      where: { employeeId: it.employeeId, period: "WEEK", periodStart, kind: "ACTION", metric: it.metric, customerId: it.customerId, plannedDay: dayValue, id: { not: id } },
      select: { id: true, source: true, plannedDay: true, plannedTime: true },
    });
    if (twin) {
      if (onTwin === "refuse") throw new PlanError(409, "نفس الشي مخطّط لهالعميل في ذاك اليوم.", "The same is already planned for this customer that day.", "TWIN");
      // Two of the supervisor's: neither is the rep's to remove (gate) — it stays where it is, and carry says so.
      if (it.source === "ADMIN" && twin.source === "ADMIN") return { merged: false, skipped: true };
      // Keep the supervisor's item when either is theirs (the rep may not remove it); otherwise the one already there.
      const keepMoved = it.source === "ADMIN" && twin.source !== "ADMIN";
      if (keepMoved) {
        await tx.salesPlanItem.delete({ where: { id: twin.id } });
        await tx.salesPlanItem.update({ where: { id }, data: { plannedDay: dayValue, plannedTime: plannedTime ?? twin.plannedTime, periodStart } });
        return { merged: true, keptId: id, removedId: twin.id };
      }
      if (!twin.plannedTime && plannedTime && twin.plannedDay) await tx.salesPlanItem.update({ where: { id: twin.id }, data: { plannedTime } });
      await tx.salesPlanItem.delete({ where: { id } });
      return { merged: true, keptId: twin.id, removedId: id };
    }
  }
  await tx.salesPlanItem.update({ where: { id }, data: { plannedDay: dayValue, plannedTime, periodStart } });
  return { merged: false };
}

/** The rep's own number for a counted kind in a period (`null` removes it). A number the supervisor set is not overridden. */
export async function setSelfTarget(tx: Tx, employeeId: string, period: Period, start: string, metric: unknown, target: unknown) {
  if (!(METRICS as readonly string[]).includes(String(metric)) || metric === "CUSTOM") throw new PlanError(400, "نوع غير معروف.", "Unknown kind.");
  const t = num(target);
  if (t !== null && (Number.isNaN(t) || t <= 0)) throw new PlanError(400, "اكتب رقم أكبر من صفر، أو اتركه فاضي.", "A number above zero, or empty.");
  const periodStart = new Date(`${start}T00:00:00Z`);
  const admin = await tx.salesPlanItem.findFirst({ where: { employeeId, period, periodStart, kind: "GOAL", source: "ADMIN", metric: String(metric) }, select: { id: true } });
  if (admin) throw new PlanError(409, "هذا الرقم حدّده المشرف.", "Your supervisor set this number.");
  const where = { employeeId, period, periodStart, kind: "GOAL", source: "SELF", metric: String(metric) };
  const prev = await tx.salesPlanItem.findFirst({ where, select: { id: true } });
  if (t === null) { if (prev) await tx.salesPlanItem.delete({ where: { id: prev.id } }); return; }
  if (prev) await tx.salesPlanItem.update({ where: { id: prev.id }, data: { target: t } });
  else await tx.salesPlanItem.create({ data: { ...where, target: t, createdById: employeeId } });
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
    const where = { employeeId: g.employeeId, period, periodStart, source: "ADMIN", kind: "GOAL", metric, label };
    const prev = await tx.salesPlanItem.findFirst({ where, select: { id: true } });
    if (target === null) { if (prev) await tx.salesPlanItem.delete({ where: { id: prev.id } }); continue; }
    if (prev) await tx.salesPlanItem.update({ where: { id: prev.id }, data: { target, createdById: actorId } });
    else await tx.salesPlanItem.create({ data: { ...where, target, createdById: actorId } });
  }
}
