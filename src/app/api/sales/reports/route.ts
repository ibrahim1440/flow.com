import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { seesTeamReports } from "@/lib/services/sales/scope";
import { toCsv } from "@/lib/services/sales/csv";
import { monthKey } from "@/lib/services/sales/performance";
import { Decimal, ZERO, roundMoney, riyadhMonthStart, riyadhMonthEnd } from "@/lib/services/commissions/engine";

/** The blocks of the reports screen and the CSV sections each one exports (`?report=`). */
const REPORT_SECTIONS: Record<string, string[]> = {
  summary: ["Leads", "Pipeline", "Closed", "Sales cycle"],
  stages: ["Pipeline", "Pipeline stage"],
  sources: ["Lead source"],
  lost: ["Lost reason"],
  cycle: ["Sales cycle"],
  closed: ["Closed"],
};

/**
 * GET /api/sales/reports — the four numbers a sales meeting actually asks for.
 *
 * ── Conversion rate is computed from LeadConversion rows, not from counts ──
 * The obvious implementation — leads created this month, deals created this month, divide
 * — measures nothing when the two sets are unrelated, which they always are: a lead from
 * March converts in May. `LeadConversion` exists precisely so the question "of the leads
 * that arrived in this window, how many became deals" has a real answer, and that is what
 * is computed here.
 *
 * ── Pipeline duration comes from stage events ──
 * Not from `updatedAt`, which moves whenever anybody edits a note.
 *
 * The whole endpoint is the team's: it needs `seesTeamReports` (sales › lead_assign, or the
 * admin role). A rep's own performance is GET /api/sales/performance.
 */
export async function GET(request: Request) {
  const { user, error } = await requireModule("sales");
  if (error) return error;

  const url = new URL(request.url);
  const monthParam = url.searchParams.get("month");
  const at = monthParam ? new Date(`${monthParam}-15T00:00:00Z`) : new Date();
  if (Number.isNaN(at.getTime())) {
    return NextResponse.json({ error: "month must look like 2026-09." }, { status: 400 });
  }
  const periodStart = riyadhMonthStart(at);
  const periodEnd = riyadhMonthEnd(at);

  // Team reports are the sales manager's and the admin's (owner decision, batch Sales B): a rep
  // gets 403 for the JSON and for every CSV. A rep's own figures are on «لوحة الأداء».
  if (!seesTeamReports(user.permissions, user.role)) {
    return NextResponse.json(
      { error: "تقارير المبيعات لمدير المبيعات والمسؤول فقط.", errorEn: "Sales reports are for the sales manager and the admin only." },
      { status: 403 },
    );
  }
  const mine = {};

  // A spreadsheet of the same figures, for the meeting nobody runs from a browser tab.
  // The same team figures as the screen, under the same gate.
  const asCsv = url.searchParams.get("format") === "csv";

  try {
    const [
      leadsCreated,
      leadsInWindow,
      stageRows,
      wonDeals,
      lostDeals,
      openDeals,
      lostReasons,
      sourceRows,
      recentEvents,
    ] = await Promise.all([
      prisma.lead.count({ where: { ...mine, createdAt: { gte: periodStart, lt: periodEnd } } }),

      // The cohort: leads that ARRIVED in this window, with their conversion if it has
      // happened — whenever it happened.
      prisma.lead.findMany({
        where: { ...mine, createdAt: { gte: periodStart, lt: periodEnd } },
        select: { id: true, source: true, conversion: { select: { convertedAt: true, customerCreated: true } } },
      }),

      prisma.opportunity.groupBy({
        by: ["stageId"],
        where: { ...mine, outcome: "OPEN" },
        _count: { _all: true },
        _sum: { amount: true },
      }),

      prisma.opportunity.findMany({
        where: { ...mine, outcome: "WON", closedAt: { gte: periodStart, lt: periodEnd } },
        select: { id: true, amount: true, createdAt: true, closedAt: true },
      }),
      prisma.opportunity.findMany({
        where: { ...mine, outcome: "LOST", closedAt: { gte: periodStart, lt: periodEnd } },
        select: { id: true, amount: true, createdAt: true, closedAt: true, lostReason: true },
      }),
      prisma.opportunity.aggregate({
        where: { ...mine, outcome: "OPEN" },
        _count: { _all: true },
        _sum: { amount: true },
      }),

      prisma.opportunity.groupBy({
        by: ["lostReason"],
        where: { ...mine, outcome: "LOST", closedAt: { gte: periodStart, lt: periodEnd } },
        _count: { _all: true },
      }),

      prisma.lead.groupBy({
        by: ["source"],
        where: { ...mine, createdAt: { gte: periodStart, lt: periodEnd } },
        _count: { _all: true },
      }),

      prisma.collectionEvent.findMany({
        where: { status: "RECORDED", collectedAt: { gte: periodStart, lt: periodEnd } },
        select: { sourceSystem: true },
        take: 500,
      }),
    ]);

    const stages = await prisma.pipelineStage.findMany({
      orderBy: { position: "asc" },
      select: { id: true, code: true, nameEn: true, nameAr: true, position: true, isActive: true },
    });
    const stageById = new Map(stages.map((s) => [s.id, s]));

    const converted = leadsInWindow.filter((l) => l.conversion !== null);
    const conversionRate =
      leadsInWindow.length === 0
        ? ZERO
        : new Decimal(converted.length).times(100).dividedBy(leadsInWindow.length).toDecimalPlaces(1);

    // Days from creation to close, for the deals that closed in this window. The median as
    // well as the mean, because one nine-month deal drags an average nobody recognises.
    const durations = [...wonDeals, ...lostDeals]
      .filter((d) => d.closedAt)
      .map((d) => Math.round((d.closedAt!.getTime() - d.createdAt.getTime()) / 86400_000))
      .sort((a, b) => a - b);
    const median =
      durations.length === 0
        ? null
        : durations.length % 2 === 1
          ? durations[(durations.length - 1) / 2]
          : Math.round((durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2);
    const mean =
      durations.length === 0
        ? null
        : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);

    const sumAmount = (rows: { amount: Decimal }[]) =>
      roundMoney(rows.reduce((acc, r) => acc.plus(r.amount), ZERO));

    const wonValue = sumAmount(wonDeals);
    const lostValue = sumAmount(lostDeals);
    const closedCount = wonDeals.length + lostDeals.length;
    const winRate =
      closedCount === 0
        ? ZERO
        : new Decimal(wonDeals.length).times(100).dividedBy(closedCount).toDecimalPlaces(1);

    const sources = [...new Set(recentEvents.map((e) => e.sourceSystem))];

    const payload = {
      periodStart,
      periodEnd,
      scope: "all",

      leads: {
        created: leadsCreated,
        converted: converted.length,
        // Of the leads that ARRIVED in this window — a cohort rate, not a ratio of
        // unrelated counts.
        // toFixed, not toString: a Decimal rounded to one place renders "50" when the
        // tenth is zero, so a client writing `${rate}%` gets "50%" one month and "49.5%"
        // the next. One decimal place, always.
        conversionRatePercent: conversionRate.toFixed(1),
        newCustomersCreated: converted.filter((l) => l.conversion?.customerCreated).length,
        bySource: sourceRows
          .map((r) => ({ source: r.source, count: r._count._all }))
          .sort((a, b) => b.count - a.count),
      },

      pipeline: {
        openCount: openDeals._count._all,
        openValue: roundMoney(openDeals._sum.amount ?? ZERO).toFixed(2),
        byStage: stageRows
          .map((r) => ({
            stageId: r.stageId,
            code: stageById.get(r.stageId)?.code ?? "?",
            nameEn: stageById.get(r.stageId)?.nameEn ?? "Unknown",
            nameAr: stageById.get(r.stageId)?.nameAr ?? "غير معروف",
            position: stageById.get(r.stageId)?.position ?? 999,
            count: r._count._all,
            value: roundMoney(r._sum.amount ?? ZERO).toFixed(2),
          }))
          .sort((a, b) => a.position - b.position),
      },

      closed: {
        won: wonDeals.length,
        wonValue: wonValue.toFixed(2),
        lost: lostDeals.length,
        lostValue: lostValue.toFixed(2),
        winRatePercent: winRate.toFixed(1),
        lostReasons: lostReasons
          .map((r) => ({ reason: r.lostReason ?? "(none recorded)", count: r._count._all }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10),
      },

      duration: {
        // Named for what it is. "Average sales cycle" with no sample size beside it is a
        // number people quote for years.
        sampleSize: durations.length,
        medianDays: median,
        meanDays: mean,
      },

      collectionSources: sources,
      sandbox: sources.length > 0 && sources.every((s) => s === "SANDBOX"),
    };

    if (!asCsv) return NextResponse.json(payload);

    // One flat table rather than several: a reader opening this in Excel wants to read
    // down a column, and a file with four differently-shaped blocks in it cannot be
    // sorted, filtered or pasted into anything.
    // The Riyadh month (periodStart is 21:00 UTC of the day before, so its UTC date is a month early).
    const month = monthKey(periodStart);
    const rows: unknown[][] = [
      ["Leads", "Created", payload.leads.created, ""],
      ["Leads", "Converted", payload.leads.converted, ""],
      ["Leads", "Conversion rate %", payload.leads.conversionRatePercent,
        "of the leads that arrived in this month"],
      ["Leads", "New customers created", payload.leads.newCustomersCreated, ""],
      ...payload.leads.bySource.map((s) => ["Lead source", s.source, s.count, ""]),
      ["Pipeline", "Open deals", payload.pipeline.openCount, ""],
      ["Pipeline", "Open value", payload.pipeline.openValue, "SAR"],
      ...payload.pipeline.byStage.map((s) => ["Pipeline stage", s.nameEn, s.count, s.value + " SAR"]),
      ["Closed", "Won", payload.closed.won, payload.closed.wonValue + " SAR"],
      ["Closed", "Lost", payload.closed.lost, payload.closed.lostValue + " SAR"],
      ["Closed", "Win rate %", payload.closed.winRatePercent, ""],
      ...payload.closed.lostReasons.map((r) => ["Lost reason", r.reason, r.count, ""]),
      ["Sales cycle", "Median days", payload.duration.medianDays ?? "", `from ${payload.duration.sampleSize} closed deals`],
      ["Sales cycle", "Mean days", payload.duration.meanDays ?? "", `from ${payload.duration.sampleSize} closed deals`],
    ];

    // `report=` narrows the file to one block of the screen (GX A-P04: each report exports on
    // its own). The rows are the same rows, filtered by their Section; no value changes.
    const report = url.searchParams.get("report");
    const sections = report && Object.hasOwn(REPORT_SECTIONS, report) ? REPORT_SECTIONS[report] : null;
    if (report && !sections) {
      return NextResponse.json(
        { error: `report must be one of: ${Object.keys(REPORT_SECTIONS).join(", ")}.` },
        { status: 400 },
      );
    }
    const picked = sections ? rows.filter((r) => sections.includes(String(r[0]))) : rows;

    if (payload.sandbox) {
      // The caveat travels with the file. A spreadsheet outlives the screen that explained it.
      picked.push(["Note", "Collection source", "SANDBOX",
        "No real payment has been received; these figures are synthetic."]);
    }

    return new NextResponse(toCsv(["Section", "Measure", "Value", "Note"], picked), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="sales-report-${report ? `${report}-` : ""}all-${month}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
