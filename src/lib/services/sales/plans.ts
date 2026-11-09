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

type Db = Pick<PrismaClient, "$queryRaw" | "salesPlanItem" | "employee">;
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

/** D17 «شغلي»: the internal kinds of a free item (kind CHECK) — a meeting, a field round, a report / desk work, anything else. */
export const CATEGORIES = ["MEETING", "FIELD_ROUND", "REPORT", "OTHER"] as const;
export type Category = (typeof CATEGORIES)[number];
export const isCategory = (v: unknown): v is Category => (CATEGORIES as readonly string[]).includes(String(v));
/** How many weeks ahead a weekly rule is generated (its meetings' invitations reach the colleagues that far ahead). */
export const RECUR_AHEAD_WEEKS = 4;

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
  /**
   * D17 «شغلي»: a free item's kind (MEETING | FIELD_ROUND | REPORT | OTHER; null on a customer action or a number), a
   * meeting's length and colleagues — `invited` once they were sent the invitation (their calendar); `invitedBy` when the
   * meeting is someone else's and this rep put it in their plan («حطها في خطتي») — a field round's place, aim and outcome
   * with the leads added from it, and the weekly rule it repeats from.
   */
  category: Category | null;
  /** The row's name for this rep (a meeting without its own title composed per viewer); the label otherwise. */
  title: string | null;
  durationMin: number | null;
  attendees: { id: string; name: string }[];
  invited: boolean;
  invitedBy: string | null;
  area: string | null;
  targetNew: number | null;
  shopsVisited: number | null;
  roundLeads: { id: string; name: string }[];
  recurrence: { id: string; weekday: number } | null;
  /** The meeting's appointment (the rep's invitation, or the colleague's meeting put in this plan) — «يومي» shows it once. */
  appointmentId: string | null;
};
export type OffPlan = { id: string; metric: ActionMetric; customer: { id: string; name: string } | null; title: string | null; at: string; outcome: string | null; body: string | null };

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const NO_INTERNAL = (): Pick<PlanItem, "category" | "title" | "durationMin" | "attendees" | "invited" | "invitedBy" | "area" | "targetNew" | "shopsVisited" | "roundLeads" | "recurrence" | "appointmentId"> =>
  ({ category: null, title: null, durationMin: null, attendees: [], invited: false, invitedBy: null, area: null, targetNew: null, shopsVisited: null, roundLeads: [], recurrence: null, appointmentId: null });

/**
 * The plan of one rep for one period: the goals of that period with their progress, and the planned actions and free items
 * that fall in it (the week's items; for a day, those planned that day or undated; for a month, the weeks that touch it),
 * each action DONE when the rep's own record of it exists in its week, and the period's visits and calls nobody planned.
 */
/**
 * What a row is called for THIS rep (Abu Fahd): a meeting without a title of its own is «اجتماع مع <the others>» — the
 * organiser seen from the invitee's / the rep's side (a colleague's or the supervisor's meeting), the colleagues otherwise.
 */
function titleFor(r: { kind: string; category: string | null; label: string | null; employeeId: string; source: string; attendeeIds: string[];
  appointment: { organizerId: string; organizer: { name: string } | null } | null; createdBy: { name: string } | null }, people: Map<string, string>): string | null {
  if (r.kind !== "CHECK" || r.category !== "MEETING" || r.label !== MEETING_DEFAULT) return r.label;
  const others = (ids: string[]) => ids.filter((i) => i !== r.employeeId).length;
  if (r.appointment && r.appointment.organizerId !== r.employeeId) {
    const n = others(r.attendeeIds.filter((i) => i !== r.appointment!.organizerId));
    return `اجتماع مع ${displayName(r.appointment.organizer?.name)}${n ? ` (+${n})` : ""}`;
  }
  if (r.source === "ADMIN" && r.createdBy?.name) {
    const n = others(r.attendeeIds);
    return `اجتماع مع ${displayName(r.createdBy.name)}${n ? ` (+${n})` : ""}`;
  }
  const names = r.attendeeIds.filter((i) => i !== r.employeeId).map((i) => displayName(people.get(i))).filter(Boolean);
  return names.length ? `اجتماع مع ${names.join(" و")}` : MEETING_DEFAULT;
}

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
      select: { id: true, employeeId: true, source: true, kind: true, metric: true, label: true, checkedAt: true, position: true, periodStart: true, plannedDay: true, plannedTime: true, createdAt: true,
        // D16 gate P1: the phone and address only for a caller with the customer-contact right (canSeeCustomerContact).
        customer: { select: { id: true, name: true, nameAr: true, phone: !!opts.contact, address: !!opts.contact } }, createdBy: { select: { name: true } },
        // D17 «شغلي».
        category: true, durationMin: true, attendeeIds: true, appointmentId: true, area: true, targetNew: true, shopsVisited: true, recurrenceId: true,
        appointment: { select: { organizerId: true, organizer: { select: { name: true } } } }, recurrence: { select: { weekday: true } },
        roundLeads: { select: { id: true, companyName: true, companyNameAr: true }, orderBy: { createdAt: "asc" } } },
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
  // D17: the meetings' colleagues by name (one read for the whole view).
  const attendeeIds = [...new Set(inView.flatMap((r) => r.attendeeIds))];
  const people = new Map(attendeeIds.length ? (await db.employee.findMany({ where: { id: { in: attendeeIds } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]) : []);
  const name = (c: { id: string; name: string; nameAr: string | null; phone?: string | null; address?: string | null } | null) =>
    (c ? { id: c.id, name: c.nameAr ?? c.name, phone: c.phone ?? null, address: c.address ?? null } : null);
  const items: PlanItem[] = [
    ...goals.map((r) => ({
      id: r.id, source: r.source as PlanItem["source"], kind: "GOAL" as const, metric: (r.metric as Metric | null) ?? null, label: r.label,
      target: r.target === null ? null : Number(r.target),
      done: r.metric === "CUSTOM" ? Number(r.manualDone ?? 0) : counts[r.metric as keyof Counts] ?? 0,
      checked: false, position: r.position, setBy: r.source === "ADMIN" ? r.createdBy?.name ?? null : null,
      customer: null, plannedDay: null, doneAt: null, doneOutcome: null, doneBody: null, weekStart: null, plannedTime: null, doneHow: null,
      ...NO_INTERNAL(),
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
        category: r.kind === "CHECK" ? ((r.category as Category | null) ?? "OTHER") : null,
        durationMin: r.durationMin ?? null,
        attendees: r.attendeeIds.map((id) => ({ id, name: people.get(id) ?? "" })).filter((a) => a.name),
        title: titleFor(r, people),
        invited: !!r.appointmentId && r.appointment?.organizerId === r.employeeId,
        invitedBy: r.appointment && r.appointment.organizerId !== r.employeeId ? r.appointment.organizer?.name ?? null : null,
        area: r.area ?? null, targetNew: r.targetNew ?? null, shopsVisited: r.shopsVisited ?? null,
        roundLeads: r.roundLeads.map((l) => ({ id: l.id, name: l.companyNameAr ?? l.companyName })),
        recurrence: r.recurrenceId && r.recurrence ? { id: r.recurrenceId, weekday: r.recurrence.weekday } : null,
        appointmentId: r.appointmentId ?? null,
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
export type ItemInput = { kind?: unknown; metric?: unknown; customerId?: unknown; plannedDay?: unknown; plannedTime?: unknown; label?: unknown; date?: unknown; restore?: unknown;
  /** D17 «شغلي» (kind CHECK): the category and what it needs; `invite` sends the meeting to its colleagues; `repeat` makes it weekly. */
  category?: unknown; durationMin?: unknown; attendeeIds?: unknown; invite?: unknown; area?: unknown; targetNew?: unknown; repeat?: unknown };
/** What a free item of a category carries (D17). */
export type Internal = { category: Category; durationMin: number | null; attendeeIds: string[]; invite: boolean; area: string | null; targetNew: number | null };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const intIn = (v: unknown, lo: number, hi: number, ar: string, en: string): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new PlanError(400, ar, en);
  return n;
};

/**
 * D17: the category's own fields, checked — a meeting: its length (15–480 min) and colleagues (at most 30; the invitation
 * needs a day, a time and at least one of them); a field round: where (required) and the new customers aimed for (1–99).
 */
export function cleanInternal(it: ItemInput, plannedDay: string | null, plannedTime: string | null, opts: { repAttends?: boolean } = {}): Internal {
  const category: Category = it.category === undefined || it.category === null || it.category === "" ? "OTHER" : isCategory(it.category) ? it.category : (() => { throw new PlanError(400, "اختر النوع.", "Unknown category."); })();
  const meeting = category === "MEETING", round = category === "FIELD_ROUND";
  const durationMin = meeting ? intIn(it.durationMin, 15, 480, "مدة الاجتماع من 15 دقيقة إلى 8 ساعات.", "A meeting lasts 15–480 minutes.") : null;
  const attendeeIds = meeting && Array.isArray(it.attendeeIds) ? [...new Set(it.attendeeIds.filter((x): x is string => typeof x === "string" && ID.test(x)))] : [];
  if (attendeeIds.length > 30) throw new PlanError(400, "الحد 30 شخص في الاجتماع.", "At most 30 people.");
  const invite = meeting && it.invite === true;
  if (invite && !attendeeIds.length && !opts.repAttends) throw new PlanError(400, "اختر مين معك قبل ترسل الدعوة.", "Choose who attends before inviting.", "INVITE_NEEDS_PEOPLE");
  if (invite && (!plannedDay || !plannedTime)) throw new PlanError(400, "الدعوة تحتاج يوم ووقت.", "An invitation needs a day and a time.", "INVITE_NEEDS_TIME");
  const area = round ? cleanText(it.area) : "";
  if (round && (area.length < 2 || area.length > 100)) throw new PlanError(400, "اكتب وين الجولة.", "Write where the round is (2–100 characters).", "AREA_REQUIRED");
  const targetNew = round ? intIn(it.targetNew, 1, 99, "عدد العملاء الجدد من 1 إلى 99.", "Aim for 1–99 new customers.") : null;
  return { category, durationMin, attendeeIds, invite, area: round ? area : null, targetNew };
}
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
export function cleanItem(it: ItemInput, today: string, opts: { repAttends?: boolean } = {}): { kind: "ACTION" | "CHECK"; metric: ActionMetric | null; customerId: string | null; label: string | null; plannedDay: string | null; plannedTime: string | null; weekStart: string; internal: Internal | null } {
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
    const internal = cleanInternal(it, plannedDay, plannedTime, opts);
    // A meeting or a round may go without a title of its own: «اجتماع» / «جولة في …» (the sheet writes a fuller one).
    const title = label || (internal.category === "MEETING" ? MEETING_DEFAULT : internal.category === "FIELD_ROUND" ? `جولة في ${internal.area}` : "");
    if (title.length < 2 || title.length > 200) throw new PlanError(400, "اكتب الشغلة (حرفين على الأقل).", "Write the item (2–200 characters).");
    return { kind, metric: null, customerId: null, label: title, plannedDay, plannedTime, weekStart: periodStartOf("WEEK", base), internal };
  }
  if (!isActionMetric(it.metric)) throw new PlanError(400, "اختر وش بتسوي.", "Choose what you will do.");
  if (typeof it.customerId !== "string" || !it.customerId) throw new PlanError(400, "اختر العميل.", "Choose the customer.");
  if (label && (label.length < 2 || label.length > 200)) throw new PlanError(400, "الملاحظة طويلة.", "The note is too long.");
  return { kind, metric: it.metric, customerId: it.customerId, label: label || null, plannedDay, plannedTime, weekStart: periodStartOf("WEEK", base), internal: null };
}

/**
 * Put one item in a rep's week — the rep's own (SELF), or the supervisor's (ADMIN). The same action for the same customer
 * on the same day (or twice undated in the week) is refused — two calls on different days of a week are fine (D16 gate).
 */
export async function addItem(tx: Tx, who: { employeeId: string; actorId: string; source: "SELF" | "ADMIN" }, input: ItemInput, today: string) {
  // D17 (gate): the supervisor's meeting in a rep's plan — the supervisor organises it and the rep attends (no one else needed).
  const byBoss = who.source === "ADMIN" && who.actorId !== who.employeeId;
  const c = cleanItem(input, today, { repAttends: byBoss });
  if (byBoss && c.internal && input.repeat) throw new PlanError(400, "التكرار يحطه المندوب بنفسه.", "Only the rep sets an item to repeat.", "REPEAT_SELF_ONLY");
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
  const n = c.internal;
  const attendeeIds = n ? n.attendeeIds.filter((x) => x !== who.employeeId) : [];
  if (attendeeIds.length && (await tx.employee.count({ where: { id: { in: attendeeIds }, active: true } })) !== attendeeIds.length) {
    throw new PlanError(400, "أحد الأشخاص غير موجود أو حسابه معطّل.", "A colleague does not exist or is disabled.");
  }
  const position = await tx.salesPlanItem.count({ where: { employeeId: who.employeeId, period: "WEEK", periodStart } });
  const row = await tx.salesPlanItem.create({
    data: { employeeId: who.employeeId, period: "WEEK", periodStart, source: who.source, kind: c.kind, metric: c.metric, customerId: c.customerId, label: c.label,
      plannedDay: c.plannedDay ? new Date(`${c.plannedDay}T00:00:00Z`) : null, plannedTime: c.plannedTime, position, createdById: who.actorId,
      ...(n ? { category: n.category, durationMin: n.durationMin, attendeeIds, area: n.area, targetNew: n.targetNew } : {}) },
    select: { id: true },
  });
  // D17: «أرسل له دعوة» — the colleagues get an ordinary appointment (their «يومي», calendar and bell). The organiser is the
  // rep — or, for the supervisor's meeting in the rep's plan, the supervisor, with the rep among those invited.
  const weekly = !!(n && input.repeat && typeof input.repeat === "object" && c.plannedDay && input.restore !== true);
  let firstAppointment: string | null = null;
  // The supervisor's meeting with a day and a time is always an appointment of theirs (Abu Fahd: it lands in the supervisor's
  // own calendar / «يومي», and the rep is told); the rep's own is one only when they choose to invite.
  const bossTimed = byBoss && n?.category === "MEETING" && !!c.plannedDay && !!c.plannedTime;
  if ((n?.invite || bossTimed) && (attendeeIds.length || byBoss) && c.plannedDay && c.plannedTime && input.restore !== true) refusePastInvite(c.plannedDay, c.plannedTime);
  // A restore («تراجع») reopens the meeting's own appointment (restoreInvitation, below) instead of making a new one.
  if ((n?.invite || bossTimed) && (attendeeIds.length || byBoss) && input.restore !== true) {
    const organizer = byBoss ? who.actorId : who.employeeId;
    const people = [...new Set([...attendeeIds, ...(byBoss ? [who.employeeId] : [])])].filter((p) => p !== organizer);
    // A weekly meeting is told once for the series (below), not once per week (gate M2).
    firstAppointment = await meetingFor(tx, organizer, c.label!, c.plannedDay!, c.plannedTime!, n.durationMin, people, weekly);
    await tx.salesPlanItem.update({ where: { id: row.id }, data: { appointmentId: firstAppointment } });
  }
  // D17 (gate): «تراجع» after removing an invited meeting puts the invitation back too — the same appointment, reopened.
  if (input.restore === true && n?.category === "MEETING") await restoreInvitation(tx, who, row.id, c);
  // D17: «كرّرها كل أسبوع» — a weekly rule from this item's weekday; this week is this item, the next weeks are generated.
  if (n && weekly && c.plannedDay) {
    const until = (input.repeat as { until?: unknown }).until;
    const untilDay = typeof until === "string" && ISO.test(until) ? until : null;
    if (untilDay && untilDay < c.plannedDay) throw new PlanError(400, "النهاية قبل البداية.", "The end is before the start.");
    const rule = await tx.salesPlanRecurrence.create({
      data: { employeeId: who.employeeId, category: n.category, label: c.label!, weekday: new Date(`${c.plannedDay}T00:00:00Z`).getUTCDay(), plannedTime: c.plannedTime,
        durationMin: n.durationMin, attendeeIds, invite: n.invite && attendeeIds.length > 0, area: n.area, targetNew: n.targetNew,
        startWeek: periodStart, untilDay: untilDay ? new Date(`${untilDay}T00:00:00Z`) : null, createdById: who.actorId },
      select: { id: true },
    });
    await tx.salesPlanItem.update({ where: { id: row.id }, data: { recurrenceId: rule.id } });
    await tx.salesPlanRecurrenceWeek.create({ data: { recurrenceId: rule.id, weekStart: periodStart, itemId: row.id } });
    await generateRecurring(tx, who.employeeId, today, rule.id, { strict: true });
    if (firstAppointment) {
      const { tellWeekly } = await import("@/lib/workspace/server/appointments");
      const wd = new Date(`${c.plannedDay}T00:00:00Z`).getUTCDay();
      await tellWeekly(tx, who.employeeId, { ruleId: rule.id, appointmentId: firstAppointment, title: c.label!, ...weeklyWhen(wd, c.plannedTime), stamp: "0" }, attendeeIds, "WEEKLY_INVITED");
    }
  }
  return row;
}

/** The UTC instants of a Riyadh day + "HH:MM" and a length (a meeting without a length: half an hour). */
export function meetingWindow(day: string, time: string, durationMin: number | null) {
  const startAt = new Date(Date.parse(`${day}T${time}:00Z`) - RIYADH);
  return { startAt, endAt: new Date(startAt.getTime() + (durationMin ?? 30) * 60_000) };
}

async function meetingFor(tx: Tx, organizerId: string, title: string, day: string, time: string, durationMin: number | null, people: string[], silent = false) {
  const { createPlanMeeting } = await import("@/lib/workspace/server/appointments");
  // Abu Fahd (D17): the colleagues' copy is titled from THEIR side — «اجتماع مع أبو فهد (+1)», not «اجتماع مع <themselves>».
  let subject = title;
  if (title === MEETING_DEFAULT) {
    const org = (await tx.employee.findUnique({ where: { id: organizerId }, select: { name: true } }))?.name ?? "";
    subject = `اجتماع مع ${displayName(org)}${people.length > 1 ? ` (+${people.length - 1})` : ""}`;
  }
  return createPlanMeeting(tx, organizerId, { title: subject, ...meetingWindow(day, time, durationMin), participants: people }, new Date(), { silent });
}
/** The stored title of a meeting without one of its own: each viewer's plan composes «اجتماع مع …» from the people. */
export const MEETING_DEFAULT = "اجتماع";
/** The name as the chips show it (gate R3: «اجتماع مع UAT Sales Manager», not just the first word). */
const displayName = (n: string | null | undefined) => (n ?? "").trim().replace(/\s+/g, " ");
/** «الوقت فات» (Abu Fahd): no invitation for a time already gone today (Riyadh). */
function refusePastInvite(day: string, time: string) {
  const now = new Date(Date.now() + RIYADH).toISOString();
  if (day < now.slice(0, 10) || (day === now.slice(0, 10) && time <= now.slice(11, 16))) {
    throw new PlanError(400, "وقت الاجتماع فات — ما تنرسل دعوة لوقت فات. اختر وقت ثاني.", "That time has passed — no invitation for a past time.", "INVITE_PAST");
  }
}

const WD_AR = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const WD_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** «كل ثلاثاء 10:00» — a weekly meeting's one notice. */
const weeklyWhen = (weekday: number, time: string | null) => ({ whenAr: `كل ${WD_AR[weekday]}${time ? ` ${time}` : ""}`, whenEn: `Every ${WD_EN[weekday]}${time ? ` ${time}` : ""}` });
/** The colleagues of a rule still active (gate B2: a deactivated one is skipped, never fails the plan). */
async function activeOf(tx: Pick<Tx, "employee">, ids: string[]) {
  if (!ids.length) return [];
  const on = new Set((await tx.employee.findMany({ where: { id: { in: ids }, active: true }, select: { id: true } })).map((e) => e.id));
  return ids.filter((i) => on.has(i));
}

const RESTORE_WINDOW_MS = 2 * 60_000;
type Removed = { itemId: string; employeeId: string; kind: string; metric: string | null; customerId: string | null; label: string | null; plannedDay: string | null; plannedTime: string | null;
  category?: string | null; appointmentId?: string | null };

/**
 * «شيله من الخطة» (D16): the item is deleted and the removal written to AuthAuditLog (PLAN_ITEM_REMOVED, by whoever removed
 * it) — what «تراجع» may put back, and only that (gate: `restore` is no way to backdate an item).
 */
export async function removeItem(tx: Tx, id: string, actorId: string) {
  const it = await tx.salesPlanItem.findUnique({ where: { id }, select: { id: true, employeeId: true, kind: true, metric: true, customerId: true, label: true, plannedDay: true, plannedTime: true, category: true, appointmentId: true } });
  if (!it) return null;
  await tx.salesPlanItem.delete({ where: { id } });
  // D17: the rep's own invited meeting is cancelled for the colleagues; a meeting someone else organised is only out of this plan.
  if (it.appointmentId) {
    const { cancelPlanMeeting } = await import("@/lib/workspace/server/appointments");
    await cancelPlanMeeting(tx, it.employeeId, it.appointmentId); // the rep's own
    if (actorId !== it.employeeId) await cancelPlanMeeting(tx, actorId, it.appointmentId); // the supervisor's, removed by the supervisor
  }
  const { ipHashOf } = await import("@/lib/accounting/ops/purchase-activity");
  const meta: Removed = { itemId: it.id, employeeId: it.employeeId, kind: it.kind, metric: it.metric, customerId: it.customerId, label: it.label, plannedDay: isoDay(it.plannedDay), plannedTime: it.plannedTime, category: it.category, appointmentId: it.appointmentId };
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
 * The invitation of a meeting put back by «تراجع» (D17 gate): the removal this person made in the last two minutes of the
 * same meeting (label, day) that had an appointment — reopened and linked to the restored item. Reopening is a guarded
 * update (CANCELLED → SCHEDULED), so a second «تراجع» does nothing and each colleague is told once («INVITED» again).
 */
async function restoreInvitation(tx: Tx, who: { employeeId: string; actorId: string }, itemId: string, c: ReturnType<typeof cleanItem>) {
  const since = new Date(Date.now() - RESTORE_WINDOW_MS);
  const removed = await tx.authAuditLog.findMany({ where: { userId: who.actorId, action: "PLAN_ITEM_REMOVED", occurredAt: { gte: since } }, orderBy: { occurredAt: "desc" }, take: 20, select: { metadata: true } });
  const hit = removed.map((r) => r.metadata as Removed | null).find((m) => !!m?.appointmentId && m.employeeId === who.employeeId && m.kind === "CHECK" && m.label === c.label && m.plannedDay === c.plannedDay);
  if (!hit?.appointmentId) return;
  const { reopenPlanMeeting } = await import("@/lib/workspace/server/appointments");
  for (const organizer of [...new Set([who.employeeId, who.actorId])]) {
    if (await reopenPlanMeeting(tx, organizer, hit.appointmentId)) { await tx.salesPlanItem.update({ where: { id: itemId }, data: { appointmentId: hit.appointmentId } }); return; }
  }
  // A colleague's meeting this rep had put in the plan was never cancelled: it is linked again as it was.
  const a = await tx.workAppointment.findUnique({ where: { id: hit.appointmentId }, select: { status: true, participants: { where: { employeeId: who.employeeId }, select: { employeeId: true } } } });
  if (a?.status === "SCHEDULED" && a.participants.length) await tx.salesPlanItem.update({ where: { id: itemId }, data: { appointmentId: hit.appointmentId } });
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
  const it = await tx.salesPlanItem.findUnique({ where: { id }, select: { employeeId: true, periodStart: true, kind: true, metric: true, customerId: true, source: true, plannedDay: true, plannedTime: true,
    appointmentId: true, durationMin: true, appointment: { select: { organizerId: true } } } });
  if (!it || it.kind === "GOAL") throw new PlanError(400, "ما يتأجّل هذا الشي.", "This item cannot be moved.");
  // D17: a meeting someone else organised moves only in their calendar; an invited meeting of the rep's keeps a day and time.
  if (it.appointment && it.appointment.organizerId !== it.employeeId) throw new PlanError(400, "هذا الاجتماع منظّمه غيرك — يتغيّر من عنده.", "Someone else organised this meeting.", "NOT_ORGANIZER");
  if (it.appointmentId && plannedDay === null) throw new PlanError(400, "الاجتماع المرسل يحتاج يوم.", "An invited meeting needs a day.", "INVITE_NEEDS_TIME");
  const sameDay = isoDay(it.plannedDay) === plannedDay;
  const kept = it.appointmentId ? it.plannedTime : null;
  const plannedTime = time !== undefined ? cleanTime(time, plannedDay) ?? kept : sameDay ? it.plannedTime : kept;
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
  if (it.appointmentId && plannedDay && plannedTime) {
    const { movePlanMeeting } = await import("@/lib/workspace/server/appointments");
    const w = meetingWindow(plannedDay, plannedTime, it.durationMin);
    await movePlanMeeting(tx, it.employeeId, it.appointmentId, w.startAt, w.endAt);
  }
  return { merged: false };
}

// ─── D17 «كرّرها كل أسبوع» ──────────────────────────────────────────────────────────────────────────────────────────────
type Rule = { id: string; employeeId: string; category: string; label: string; weekday: number; plannedTime: string | null; durationMin: number | null;
  attendeeIds: string[]; invite: boolean; area: string | null; targetNew: number | null; startWeek: Date; untilDay: Date | null; createdById: string | null };

/**
 * Generate a rep's weekly rules for the current week and RECUR_AHEAD_WEEKS ahead (on «خطتي»'s load and when a rule is
 * saved). Each week is first claimed in SalesPlanRecurrenceWeek (primary key: rule + week) — a week claimed already is never
 * generated again, so two loads at once make one item, and an item the rep removed does not come back. A day already past
 * is claimed without an item. An invited meeting gets its appointment, so the colleagues see the weeks ahead.
 */
/** Gate L2(a): a rule that failed is retried after an hour, not on every load (per server process). */
const RULE_BACKOFF_MS = 60 * 60_000;
const failedAt = new Map<string, number>();
/** Tests only: forget the per-rule backoff. */
export const resetRuleBackoff = () => failedAt.clear();
/** Gate R3 L4: the rules a read skipped (failed, or still in their backoff) — «خطتي» says so and links to them. */
export const ruleIssues = (ids: string[]) => ids.filter((id) => failedAt.has(id));

/**
 * `strict` (gate L1): on a write (the rule saved or edited) a failure is NOT swallowed — the request is refused with
 * REPEAT_GENERATION_FAILED and the rule rolls back with it (atomic). On a read it is logged and the next rule goes on.
 */
export async function generateRecurring(tx: Tx, employeeId: string, today: string, onlyId?: string, opts: { strict?: boolean } = {}): Promise<number> {
  const rules: Rule[] = await tx.salesPlanRecurrence.findMany({
    where: { employeeId, stoppedAt: null, ...(onlyId ? { id: onlyId } : {}), OR: [{ untilDay: null }, { untilDay: { gte: new Date(`${today}T00:00:00Z`) } }] },
    select: { id: true, employeeId: true, category: true, label: true, weekday: true, plannedTime: true, durationMin: true, attendeeIds: true, invite: true, area: true, targetNew: true, startWeek: true, untilDay: true, createdById: true },
  });
  const current = Date.parse(`${periodStartOf("WEEK", today)}T00:00:00Z`);
  let made = 0;
  for (const r of rules) {
    if (opts.strict) {
      try { made += await generateRule(tx, employeeId, r, current, today); }
      catch (e) {
        if (e instanceof PlanError) throw e;
        console.error(`[plan] weekly rule ${r.id} not generated on save:`, e instanceof Error ? e.message : e);
        throw new PlanError(500, "ما قدرنا نجهّز الأسابيع الجاية، وما انحفظ التكرار. جرّب مرة ثانية.", "The coming weeks could not be prepared; the repeat was not saved. Try again.", "REPEAT_GENERATION_FAILED");
      }
      failedAt.delete(r.id);
      continue;
    }
    const last = failedAt.get(r.id);
    if (last !== undefined && Date.now() - last < RULE_BACKOFF_MS) continue;
    // Gate B2: one rule never fails the plan — its own savepoint; an error is logged and the next rule goes on.
    await tx.$executeRawUnsafe("SAVEPOINT plan_rule");
    try {
      made += await generateRule(tx, employeeId, r, current, today);
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT plan_rule");
      failedAt.delete(r.id);
    } catch (e) {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT plan_rule");
      failedAt.set(r.id, Date.now());
      console.error(`[plan] weekly rule ${r.id} not generated (next try in an hour):`, e instanceof Error ? e.message : e);
    }
  }
  return made;
}

async function generateRule(tx: Tx, employeeId: string, r: Rule, current: number, today: string): Promise<number> {
  let made = 0;
  {
    // Only colleagues still active are invited / listed (a deactivated one is skipped, gate B2).
    const people = await activeOf(tx, r.attendeeIds);
    const first = isoDay(r.startWeek)!, until = isoDay(r.untilDay);
    for (let i = 0; i <= RECUR_AHEAD_WEEKS; i++) {
      const week = isoOf(current + i * 7 * DAY);
      if (week < first) continue;
      const day = isoOf(Date.parse(`${week}T00:00:00Z`) + r.weekday * DAY);
      if (until && day > until) break;
      const claimed = await tx.$executeRaw`INSERT INTO "SalesPlanRecurrenceWeek" ("recurrenceId", "weekStart", "createdAt")
        VALUES (${r.id}, ${week}::date, now() AT TIME ZONE 'UTC') ON CONFLICT DO NOTHING`;
      if (!claimed || day < today) continue;
      const periodStart = new Date(`${week}T00:00:00Z`);
      const position = await tx.salesPlanItem.count({ where: { employeeId, period: "WEEK", periodStart } });
      const item = await tx.salesPlanItem.create({
        data: { employeeId, period: "WEEK", periodStart, source: "SELF", kind: "CHECK", label: r.label, plannedDay: new Date(`${day}T00:00:00Z`), plannedTime: r.plannedTime,
          position, createdById: r.createdById ?? employeeId, category: r.category, durationMin: r.durationMin, attendeeIds: people, area: r.area, targetNew: r.targetNew, recurrenceId: r.id },
        select: { id: true },
      });
      // The weeks of a weekly meeting are quiet: the series was told once; each week has its own reminder (gate M2).
      if (r.invite && r.plannedTime && people.length) {
        const appointmentId = await meetingFor(tx, employeeId, r.label, day, r.plannedTime, r.durationMin, people, true);
        await tx.salesPlanItem.update({ where: { id: item.id }, data: { appointmentId } });
      }
      await tx.salesPlanRecurrenceWeek.update({ where: { recurrenceId_weekStart: { recurrenceId: r.id, weekStart: periodStart } }, data: { itemId: item.id } });
      made++;
    }
  }
  return made;
}

/** A rule's generated items AFTER this week that are not done are taken off (their invitations cancelled), and their weeks freed. */
async function dropAhead(tx: Tx, rule: { id: string; employeeId: string }, today: string) {
  const after = new Date(`${periodStartOf("WEEK", today)}T00:00:00Z`);
  const items = await tx.salesPlanItem.findMany({ where: { recurrenceId: rule.id, periodStart: { gt: after }, checkedAt: null }, select: { id: true, appointmentId: true } });
  if (items.some((i) => i.appointmentId)) {
    const { cancelPlanMeeting } = await import("@/lib/workspace/server/appointments");
    // Quiet: the colleagues get one notice for the change or the end of the series (gate M2).
    for (const i of items) if (i.appointmentId) await cancelPlanMeeting(tx, rule.employeeId, i.appointmentId, new Date(), { silent: true });
  }
  await tx.salesPlanItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
  await tx.salesPlanRecurrenceWeek.deleteMany({ where: { recurrenceId: rule.id, weekStart: { gt: after } } });
}

async function ownRule(tx: Tx, employeeId: string, id: string) {
  const rule = await tx.salesPlanRecurrence.findUnique({ where: { id }, select: { id: true, employeeId: true, stoppedAt: true, invite: true, startWeek: true, label: true, weekday: true, plannedTime: true, attendeeIds: true } });
  if (!rule || rule.employeeId !== employeeId) throw new PlanError(404, "غير موجود.", "Not found.");
  if (rule.stoppedAt) throw new PlanError(409, "هذا التكرار موقوف.", "This repeat is stopped.", "STOPPED");
  return rule;
}

/**
 * «عدّل المتكرر»: the weekday, the time and the end — from NEXT week (this week's item stays as it is; the rep changes it on
 * its own). The weeks ahead are generated again with the new values.
 */
export async function editRecurrence(tx: Tx, employeeId: string, id: string, input: { weekday?: unknown; plannedTime?: unknown; untilDay?: unknown; label?: unknown }, today: string) {
  const rule = await ownRule(tx, employeeId, id);
  const data: { weekday?: number; plannedTime?: string | null; untilDay?: Date | null; label?: string } = {};
  // Abu Fahd: the name too, from next week like the time.
  if (input.label !== undefined) {
    const l = cleanText(input.label);
    if (l.length < 2 || l.length > 200) throw new PlanError(400, "اكتب الاسم (حرفين على الأقل).", "Write the name (2–200 characters).");
    data.label = l;
  }
  if (input.weekday !== undefined) data.weekday = intIn(input.weekday, 0, 6, "اختر اليوم.", "Choose the day.") ?? (() => { throw new PlanError(400, "اختر اليوم.", "Choose the day."); })();
  if (input.plannedTime !== undefined) data.plannedTime = cleanTime(input.plannedTime, "any");
  if (rule.invite && data.plannedTime === null) throw new PlanError(400, "الاجتماع المرسل يحتاج وقت.", "An invited meeting needs a time.", "INVITE_NEEDS_TIME");
  if (input.untilDay !== undefined) {
    const u = input.untilDay === null || input.untilDay === "" ? null : String(input.untilDay);
    if (u !== null && (!ISO.test(u) || u < today)) throw new PlanError(400, "النهاية لازم تكون اليوم أو بعده.", "The end must be today or later.");
    data.untilDay = u ? new Date(`${u}T00:00:00Z`) : null;
  }
  // A colleague no longer active is dropped from the rule here (the edit sheet shows «زميل ما عاد نشط», gate B2).
  const people = await activeOf(tx, rule.attendeeIds);
  await dropAhead(tx, rule, today);
  await tx.salesPlanRecurrence.update({ where: { id }, data: { ...data, attendeeIds: people } });
  await generateRecurring(tx, employeeId, today, id, { strict: true });
  if (rule.invite && people.length) {
    const { tellWeekly } = await import("@/lib/workspace/server/appointments");
    const next = await tx.salesPlanItem.findFirst({ where: { recurrenceId: id, appointmentId: { not: null } }, orderBy: { plannedDay: "desc" }, select: { appointmentId: true } });
    const wd = data.weekday ?? rule.weekday, time = data.plannedTime !== undefined ? data.plannedTime : rule.plannedTime;
    await tellWeekly(tx, employeeId, { ruleId: id, appointmentId: next?.appointmentId ?? null, title: data.label ?? rule.label, ...weeklyWhen(wd, time), stamp: `e${Date.now()}` }, people, "WEEKLY_CHANGED");
  }
}

/** «وقّفه»: no more weeks. This week's item stays; the ones generated ahead that are not done go (with their invitations). */
export async function stopRecurrence(tx: Tx, employeeId: string, id: string, today: string) {
  const rule = await ownRule(tx, employeeId, id);
  await dropAhead(tx, rule, today);
  await tx.salesPlanRecurrence.update({ where: { id }, data: { stoppedAt: new Date() } });
  if (rule.invite) {
    const { tellWeekly } = await import("@/lib/workspace/server/appointments");
    await tellWeekly(tx, employeeId, { ruleId: id, appointmentId: null, title: rule.label, ...weeklyWhen(rule.weekday, rule.plannedTime), stamp: "stop" }, await activeOf(tx, rule.attendeeIds), "WEEKLY_ENDED");
  }
}

/** «خطتي ← المتكرر»: the rep's running weekly rules. */
export async function listRecurrences(db: Pick<PrismaClient, "salesPlanRecurrence" | "employee">, employeeId: string, today: string) {
  const rules = await db.salesPlanRecurrence.findMany({
    where: { employeeId, stoppedAt: null, OR: [{ untilDay: null }, { untilDay: { gte: new Date(`${today}T00:00:00Z`) } }] },
    orderBy: [{ weekday: "asc" }, { createdAt: "asc" }],
    select: { id: true, category: true, label: true, weekday: true, plannedTime: true, durationMin: true, attendeeIds: true, invite: true, area: true, startWeek: true, untilDay: true },
  });
  const ids = [...new Set(rules.flatMap((r) => r.attendeeIds))];
  const people = new Map(ids.length ? (await db.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, active: true } })).map((e) => [e.id, e]) : []);
  // `active: false`: «زميل ما عاد نشط» — not invited any more; dropped from the rule on its next edit (gate B2).
  return rules.map((r) => ({ ...r, startWeek: isoDay(r.startWeek), untilDay: isoDay(r.untilDay),
    title: r.category === "MEETING" && r.label === MEETING_DEFAULT && r.attendeeIds.length
      ? `اجتماع مع ${r.attendeeIds.map((i) => displayName(people.get(i)?.name)).filter(Boolean).join(" و")}` : r.label,
    attendees: r.attendeeIds.map((i) => ({ id: i, name: people.get(i)?.name ?? "", active: people.get(i)?.active ?? false })).filter((a) => a.name) }));
}

/** «أرسل الدعوة» later, from the row: the rep's planned meeting (with a day, a time and colleagues) gets its appointment. */
export async function inviteItem(tx: Tx, employeeId: string, id: string, today: string) {
  const it = await tx.salesPlanItem.findUnique({ where: { id }, select: { employeeId: true, source: true, category: true, label: true, plannedDay: true, plannedTime: true, durationMin: true, attendeeIds: true, appointmentId: true, checkedAt: true } });
  if (!it || it.employeeId !== employeeId || it.category !== "MEETING") throw new PlanError(404, "غير موجود.", "Not found.");
  if (it.source === "ADMIN") throw new PlanError(403, "هذا من المشرف — الدعوة منه.", "Your supervisor put this here.", "ADMIN_ITEM");
  if (it.appointmentId) throw new PlanError(409, "الدعوة مرسلة من قبل.", "Already invited.", "ALREADY_INVITED");
  const day = isoDay(it.plannedDay);
  if (!it.attendeeIds.length) throw new PlanError(400, "ما فيه أحد معك في هالاجتماع.", "Nobody attends this meeting.", "INVITE_NEEDS_PEOPLE");
  if (!day || !it.plannedTime) throw new PlanError(400, "حط اليوم والوقت قبل ترسل الدعوة.", "Set the day and time before inviting.", "INVITE_NEEDS_TIME");
  if (day < today || it.checkedAt) throw new PlanError(400, "هذا الاجتماع فات.", "This meeting has passed.", "PAST_DAY");
  refusePastInvite(day, it.plannedTime);
  const appointmentId = await meetingFor(tx, employeeId, it.label ?? "اجتماع", day, it.plannedTime, it.durationMin, it.attendeeIds);
  await tx.salesPlanItem.update({ where: { id }, data: { appointmentId } });
  return appointmentId;
}

/**
 * «حطها في خطتي» (D17, owner decision b): a meeting a colleague invited this rep to goes in the rep's plan — by the rep, never
 * by itself. It stays the organiser's: it moves and is cancelled from their side; ticking it here does not close it.
 */
export async function addFromInvitation(tx: Tx, employeeId: string, appointmentId: string, today: string) {
  const a = await tx.workAppointment.findUnique({ where: { id: appointmentId }, select: { id: true, title: true, status: true, startAt: true, endAt: true, organizerId: true, participants: { select: { employeeId: true } } } });
  if (!a || a.organizerId === employeeId || !a.participants.some((p) => p.employeeId === employeeId)) throw new PlanError(404, "غير موجود.", "Not found.");
  if (a.status !== "SCHEDULED") throw new PlanError(409, "الاجتماع انلغى أو خلص.", "The meeting is cancelled or over.", "CLOSED");
  const local = new Date(a.startAt.getTime() + RIYADH);
  const day = isoOf(local.getTime());
  if (day < today) throw new PlanError(400, "هذا الاجتماع فات.", "This meeting has passed.", "PAST_DAY");
  if (await tx.salesPlanItem.findFirst({ where: { employeeId, appointmentId }, select: { id: true } })) throw new PlanError(409, "موجود في خطتك.", "Already in your plan.", "TWIN");
  const periodStart = new Date(`${periodStartOf("WEEK", day)}T00:00:00Z`);
  const position = await tx.salesPlanItem.count({ where: { employeeId, period: "WEEK", periodStart } });
  const minutes = Math.round((a.endAt.getTime() - a.startAt.getTime()) / 60_000);
  return tx.salesPlanItem.create({
    data: { employeeId, period: "WEEK", periodStart, source: "SELF", kind: "CHECK", category: "MEETING", label: a.title.slice(0, 200).padEnd(2, "."),
      plannedDay: new Date(`${day}T00:00:00Z`), plannedTime: local.toISOString().slice(11, 16), durationMin: minutes >= 15 && minutes <= 480 ? minutes : null,
      attendeeIds: [a.organizerId], appointmentId, position, createdById: employeeId },
    select: { id: true },
  });
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
