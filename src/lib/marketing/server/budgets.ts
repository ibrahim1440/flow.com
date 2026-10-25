import "server-only";
import { prisma, TX_OPTS } from "@/lib/db";
import { MktError, notFound, str, oneOf, num, type Actor, can, denied, dn } from "./http";
import { audit, userActor } from "./audit";
import { isValidPeriod, pacing, periodSpan } from "../budget";
import { periodMetrics } from "./metrics";
import { PLATFORM } from "../platforms";
import { dayLabel, localMidnightOf, sumN } from "../kpi";

/**
 * Budget lines and their pacing. Actual spend is what the metrics report (API/IMPORT/MANUAL, one row
 * per object and day) plus the cost of WhatsApp messages where Meta billed it — never an estimate.
 */

export async function listBudgets(period: string, today = new Date()) {
  if (!isValidPeriod(period)) throw new MktError("الفترة بصيغة YYYY-MM أو YYYY-Qn.", "period must be YYYY-MM or YYYY-Qn.");
  const span = periodSpan(period);
  const lines = await prisma.mktBudget.findMany({ where: { period }, include: { campaign: { select: { id: true, name: true } } }, orderBy: [{ scope: "asc" }, { createdAt: "asc" }] });
  // span holds day labels (the period's calendar days at UTC midnight): the DATE rows are matched on them as they
  // are, and the instants (message costs) run from the first day's Riyadh midnight to the next period's.
  const from = localMidnightOf(span.start), to = localMidnightOf(span.end);
  const all = await periodMetrics({ from, to, days: { gte: span.start, lt: span.end } });
  const msgCost = await prisma.mktMessage.aggregate({ where: { sentAt: { gte: from, lt: to }, cost: { not: null } }, _sum: { cost: true }, _count: { _all: true } });
  const spendOf = (filter: (r: (typeof all.rows)[number]) => boolean) => sumN(all.rows.filter(filter).map((r) => dn(r.spend)));
  const totalAds = spendOf(() => true);
  const messaging = msgCost._count._all > 0 ? dn(msgCost._sum.cost) : null;
  const totalActual = sumN([totalAds, messaging]);
  const out = lines.map((l) => {
    let actual: number | null = null;
    if (l.scope === "TOTAL") actual = totalActual;
    else if (l.scope === "PLATFORM") actual = spendOf((r) => r.platform === l.scopeRef);
    else if (l.scope === "CAMPAIGN") actual = spendOf((r) => r.campaignId === l.campaignId);
    else if (l.scope === "PRODUCT") actual = null; // spend is not reported per product by the platforms; shown as not available
    return {
      id: l.id, period: l.period, scope: l.scope, scopeRef: l.scopeRef, campaign: l.campaign, planned: dn(l.planned)!, dailyCap: dn(l.dailyCap),
      maxAutoIncreasePct: dn(l.maxAutoIncreasePct), currency: l.currency, note: l.note,
      pacing: pacing(dn(l.planned)!, actual, span, dayLabel(today)),
    };
  });
  const allocated = out.filter((l) => l.scope !== "TOTAL").reduce((n, l) => n + l.planned, 0);
  const total = out.find((l) => l.scope === "TOTAL") ?? null;
  return {
    period, span, lines: out, actual: { ads: totalAds, messaging, total: totalActual }, lastUpdated: all.lastUpdated, sources: all.sources,
    allocation: { total: total?.planned ?? null, allocated, unallocated: total ? total.planned - allocated : null, overAllocated: !!total && allocated > total.planned },
  };
}

export async function saveBudget(body: Record<string, unknown>, actor: Actor, id?: string) {
  if (!can(actor, "budget_manage")) throw denied();
  const period = str(body.period, "الفترة", { required: true })!;
  if (!isValidPeriod(period)) throw new MktError("الفترة بصيغة YYYY-MM أو YYYY-Qn.", "Invalid period.");
  const scope = oneOf(body.scope, ["TOTAL", "PLATFORM", "CAMPAIGN", "PRODUCT"] as const, "النطاق");
  const scopeRef = scope === "PLATFORM" || scope === "PRODUCT" ? str(body.scopeRef, "المرجع", { required: true }) : null;
  if (scope === "PLATFORM" && !PLATFORM[scopeRef!]) throw new MktError("منصة غير معروفة.", "Unknown platform.");
  const campaignId = scope === "CAMPAIGN" ? str(body.campaignId, "الحملة", { required: true }) : null;
  const pct = num(body.maxAutoIncreasePct, "الحد الأقصى للزيادة التلقائية %", { min: 0, max: 100 });
  const data = {
    period, scope, scopeRef, campaignId,
    planned: num(body.planned, "المبلغ المخطط", { min: 0 }) ?? (() => { throw new MktError("المبلغ المخطط مطلوب.", "planned is required."); })(),
    dailyCap: num(body.dailyCap, "الحد اليومي", { min: 0 }),
    maxAutoIncreasePct: pct === null ? null : pct / 100,
    note: str(body.note, "ملاحظة", { max: 500 }),
  };
  return prisma.$transaction(async (tx) => {
    const before = id ? await tx.mktBudget.findUnique({ where: { id } }) : null;
    if (id && !before) throw notFound();
    const row = id ? await tx.mktBudget.update({ where: { id }, data }) : await tx.mktBudget.create({ data: { ...data, createdById: actor.id } });
    await audit(tx, userActor(actor), id ? "budget.updated" : "budget.created", "MktBudget", row.id, { before, after: row });
    return row;
  }, TX_OPTS);
}

export async function deleteBudget(id: string, actor: Actor) {
  if (!can(actor, "budget_manage")) throw denied();
  return prisma.$transaction(async (tx) => {
    const before = await tx.mktBudget.findUnique({ where: { id } });
    if (!before) throw notFound();
    await tx.mktBudget.delete({ where: { id } });
    await audit(tx, userActor(actor), "budget.deleted", "MktBudget", id, { before });
  }, TX_OPTS);
}
