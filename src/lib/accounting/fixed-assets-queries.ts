// Read models for the fixed-asset and year-end screens (stage 5). Amounts as 2-decimal strings.
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { dateStr, todayAccountingDate } from "./dates";
import { dec } from "./money";
import { assetSchedule, computeRun } from "./fixed-assets-service";

const fa = (n: number) => `FA-${String(n).padStart(4, "0")}`;

async function accountLabels(ids: (string | null | undefined)[]) {
  const rows = await prisma.account.findMany({ where: { id: { in: ids.filter(Boolean) as string[] } } });
  return new Map(rows.map((a) => [a.id, { code: a.code, name: a.nameAr ?? a.nameEn }]));
}
async function names(ids: (string | null | undefined)[]) {
  const rows = await prisma.employee.findMany({ where: { id: { in: ids.filter(Boolean) as string[] } }, select: { id: true, name: true } });
  return new Map(rows.map((e) => [e.id, e.name]));
}

export async function faClasses() {
  const cls = await prisma.faClass.findMany({ include: { policies: { orderBy: { version: "desc" } } }, orderBy: { code: "asc" } });
  const acc = await accountLabels(cls.flatMap((c) => [c.costAccountId, c.accumAccountId, c.expenseAccountId]));
  const who = await names(cls.flatMap((c) => c.policies.flatMap((p) => [p.preparedBy, p.approvedBy])));
  return cls.map((c) => ({
    id: c.id, code: c.code, name: c.name, nameAr: c.nameAr, isActive: c.isActive,
    cost: acc.get(c.costAccountId), accum: acc.get(c.accumAccountId), expense: acc.get(c.expenseAccountId),
    policies: c.policies.map((p) => ({
      id: p.id, version: p.version, status: p.status, method: p.method, usefulLifeMonths: p.usefulLifeMonths, residualPercent: p.residualPercent.toFixed(2),
      decliningFactor: p.decliningFactor?.toFixed(2) ?? null, startConvention: p.startConvention, disposalConvention: p.disposalConvention,
      capitalisationThreshold: p.capitalisationThreshold.toFixed(2), note: p.note, preparedBy: p.preparedBy, preparedByName: who.get(p.preparedBy) ?? null,
      approvedByName: p.approvedBy ? who.get(p.approvedBy) ?? null : null, approvedAt: p.approvedAt,
    })),
  }));
}

export async function assetDetail(id: string) {
  const a = await prisma.faAsset.findUnique({ where: { id }, include: { class: true, classPolicy: true, sources: { orderBy: { lineNo: "asc" } }, depLines: { include: { run: true }, orderBy: { run: { periodEnd: "asc" } } }, disposals: { orderBy: { preparedAt: "desc" } } } });
  if (!a) throw new AccountingError("Asset not found.", 404);
  const acc = await accountLabels([a.class.costAccountId, a.class.accumAccountId, a.class.expenseAccountId, a.openingAccumCounterAccountId, ...a.sources.map((s) => s.counterAccountId), ...a.disposals.map((d) => d.proceedsAccountId)]);
  const who = await names([a.preparedBy, a.approvedBy, ...a.disposals.flatMap((d) => [d.preparedBy, d.approvedBy, d.reversalRequestedBy])]);
  const bills = await prisma.supplierBillLine.findMany({ where: { id: { in: a.sources.map((s) => s.billLineId).filter(Boolean) as string[] } }, include: { bill: { include: { supplier: true } } } });
  const billBy = new Map(bills.map((b) => [b.id, b]));
  const policy = await prisma.faClassPolicy.findFirst({ where: { classId: a.classId, status: "APPROVED" } });
  const posted = a.depLines.filter((l) => ["POSTED", "REVERSAL_REQUESTED"].includes(l.run.status));
  const accumulated = dec(a.openingAccumulated).add(posted.reduce((s, l) => s.add(l.amount), dec(0)));
  const events = await prisma.accountingEvent.findMany({ where: { sourceModule: "fixed_assets", sourceDocumentId: { in: [a.id, ...a.disposals.map((d) => d.id)] } }, orderBy: { createdAt: "asc" } });
  return {
    id: a.id, assetNo: a.assetNo, number: fa(a.assetNo), name: a.name, status: a.status, branchId: a.branchId, costCenterId: a.costCenterId,
    class: { id: a.class.id, code: a.class.code, name: a.class.nameAr ?? a.class.name, cost: acc.get(a.class.costAccountId), accum: acc.get(a.class.accumAccountId), expense: acc.get(a.class.expenseAccountId) },
    policy: policy ? { version: policy.version, method: policy.method, usefulLifeMonths: policy.usefulLifeMonths, residualPercent: policy.residualPercent.toFixed(2), decliningFactor: policy.decliningFactor?.toFixed(2) ?? null } : null,
    capitalisedUnder: a.classPolicy ? a.classPolicy.version : null,
    inServiceDate: dateStr(a.inServiceDate), cost: a.cost.toFixed(2), residualValue: a.residualValue.toFixed(2), method: a.method, usefulLifeMonths: a.usefulLifeMonths,
    decliningFactor: a.decliningFactor?.toFixed(2) ?? null, startConvention: a.startConvention, disposalConvention: a.disposalConvention, deviationReason: a.deviationReason,
    openingAccumulated: a.openingAccumulated.toFixed(2), openingMonths: a.openingMonths, openingCounter: a.openingAccumCounterAccountId ? acc.get(a.openingAccumCounterAccountId) : null,
    preparedBy: a.preparedBy, preparedByName: who.get(a.preparedBy) ?? null, approvedByName: a.approvedBy ? who.get(a.approvedBy) ?? null : null, capitalisedAt: a.capitalisedAt ? dateStr(a.capitalisedAt) : null,
    cancelReason: a.cancelReason, accumulated: accumulated.toFixed(2), nbv: dec(a.cost).sub(accumulated).toFixed(2),
    sources: a.sources.map((s) => {
      const bl = s.billLineId ? billBy.get(s.billLineId) : null;
      const counter = s.counterAccountId ? acc.get(s.counterAccountId) ?? null : null;
      return {
        lineNo: s.lineNo, kind: s.kind, amount: s.amount.toFixed(2), description: s.description, billLineId: s.billLineId, counterAccountId: s.counterAccountId,
        reference: bl ? `${bl.bill.supplier.name} · ${bl.bill.supplierInvoiceNo} · line ${bl.lineNo}` : s.description,
        counter, postsOnCapitalisation: s.kind !== "IN_LEDGER" && s.counterAccountId !== a.class.costAccountId,
      };
    }),
    depreciation: a.depLines.map((l) => ({ runId: l.runId, runNo: l.run.runNo, period: dateStr(l.run.periodEnd).slice(0, 7), status: l.run.status, amount: l.amount.toFixed(2), months: l.months, accumulatedAfter: l.accumulatedAfter.toFixed(2), nbvAfter: l.nbvAfter.toFixed(2), note: l.note })),
    schedule: ["CAPITALISED", "SUBMITTED", "DRAFT"].includes(a.status) ? await assetSchedule(a.id, 6) : [],
    disposals: a.disposals.map((d) => ({
      id: d.id, status: d.status, disposalDate: dateStr(d.disposalDate), kind: d.kind, proceeds: d.proceeds.toFixed(2), proceedsAccount: d.proceedsAccountId ? acc.get(d.proceedsAccountId) ?? null : null,
      reason: d.reason, cost: d.cost?.toFixed(2) ?? null, accumulated: d.accumulated?.toFixed(2) ?? null, nbv: d.nbv?.toFixed(2) ?? null, gainLoss: d.gainLoss?.toFixed(2) ?? null,
      preparedBy: d.preparedBy, preparedByName: who.get(d.preparedBy) ?? null, approvedByName: d.approvedBy ? who.get(d.approvedBy) ?? null : null,
      reversalRequestedBy: d.reversalRequestedBy, reversalReason: d.reversalReason,
    })),
    ledger: events.map((e) => ({ eventType: e.eventType, status: e.status, message: e.errorMessage, journalEntryId: e.journalEntryId })),
  };
}

export async function runsList() {
  const runs = await prisma.faDepRun.findMany({ orderBy: [{ periodEnd: "desc" }, { runNo: "desc" }], take: 60 });
  const who = await names(runs.flatMap((r) => [r.preparedBy, r.approvedBy, r.reversalRequestedBy]));
  const events = await prisma.accountingEvent.findMany({ where: { sourceModule: "fixed_assets", sourceDocumentId: { in: runs.map((r) => r.id) } } });
  const entries = await prisma.journalEntry.findMany({ where: { id: { in: events.map((e) => e.journalEntryId).filter(Boolean) as string[] } }, select: { id: true, entryNo: true } });
  const entryNo = new Map(entries.map((e) => [e.id, e.entryNo]));
  return runs.map((r) => {
    const ev = events.filter((e) => e.sourceDocumentId === r.id);
    return {
      id: r.id, runNo: r.runNo, period: dateStr(r.periodEnd).slice(0, 7), status: r.status, total: r.total.toFixed(2),
      preparedBy: r.preparedBy, preparedByName: who.get(r.preparedBy) ?? null, approvedByName: r.approvedBy ? who.get(r.approvedBy) ?? null : null,
      reversalRequestedBy: r.reversalRequestedBy, reversalReason: r.reversalReason,
      ledger: ev.map((e) => ({ eventType: e.eventType, status: e.status, message: e.errorMessage, entryNo: e.journalEntryId ? entryNo.get(e.journalEntryId) ?? null : null })),
    };
  });
}

export async function runDetail(id: string) {
  const r = await prisma.faDepRun.findUnique({ where: { id }, include: { lines: { include: { asset: { include: { class: true } } } } } });
  if (!r) throw new AccountingError("Run not found.", 404);
  const period = await prisma.fiscalPeriod.findUnique({ where: { id: r.fiscalPeriodId } });
  const [base] = (await runsList()).filter((x) => x.id === id);
  const acc = await accountLabels(r.lines.flatMap((l) => [l.asset.class.expenseAccountId, l.asset.class.accumAccountId]));
  const journal = new Map<string, { account: { code: string; name: string } | undefined; debit: number; credit: number }>();
  for (const l of r.lines) {
    for (const [aid, side] of [[l.asset.class.expenseAccountId, "debit"], [l.asset.class.accumAccountId, "credit"]] as const) {
      const j = journal.get(aid + side) ?? { account: acc.get(aid), debit: 0, credit: 0 };
      j[side] = Number(dec(j[side]).add(l.amount).toFixed(2)); journal.set(aid + side, j);
    }
  }
  return {
    ...(base ?? { id: r.id, runNo: r.runNo, period: dateStr(r.periodEnd).slice(0, 7), status: r.status, total: r.total.toFixed(2) }),
    periodStatus: period?.status ?? null, periodEnd: dateStr(r.periodEnd),
    lines: r.lines.sort((a, b) => a.asset.assetNo - b.asset.assetNo).map((l) => ({ assetId: l.assetId, number: fa(l.asset.assetNo), name: l.asset.name, classCode: l.asset.class.code, method: l.asset.method, amount: l.amount.toFixed(2), months: l.months, accumulatedAfter: l.accumulatedAfter.toFixed(2), nbvAfter: l.nbvAfter.toFixed(2), note: l.note })),
    journal: [...journal.values()].map((j) => ({ ...j, debit: j.debit.toFixed(2), credit: j.credit.toFixed(2) })),
  };
}

/** What a run for this period would contain right now (for the "compute" preview). */
export async function runPreview(periodId: string) {
  const p = await prisma.fiscalPeriod.findUnique({ where: { id: periodId } });
  if (!p) throw new AccountingError("Fiscal period not found.", 404);
  const lines = await computeRun(prisma, p.endDate);
  return { period: dateStr(p.endDate).slice(0, 7), periodStatus: p.status, total: lines.reduce((s, l) => s.add(l.amount), dec(0)).toFixed(2), lines: lines.map((l) => ({ ...l, number: fa(l.assetNo), amount: l.amount.toFixed(2), accumulatedAfter: l.accumulatedAfter.toFixed(2), nbvAfter: l.nbvAfter.toFixed(2) })) };
}

export async function faPickers(what: string | null) {
  if (what === "bill-lines") {
    const used = new Set((await prisma.faAssetSource.findMany({ where: { billLineId: { not: null }, asset: { status: { not: "CANCELLED" } } }, select: { billLineId: true } })).map((s) => s.billLineId));
    const lines = await prisma.supplierBillLine.findMany({ where: { bill: { kind: "BILL", status: "POSTED" }, account: { type: "ASSET" } }, include: { bill: { include: { supplier: true } }, account: true }, orderBy: { bill: { billDate: "desc" } }, take: 200 });
    return lines.filter((l) => !used.has(l.id)).map((l) => ({ id: l.id, label: `${l.bill.supplier.name} · ${l.bill.supplierInvoiceNo} · line ${l.lineNo} · ${l.description ?? ""}`, net: l.net.toFixed(2), account: `${l.account.code} · ${l.account.nameAr ?? l.account.nameEn}`, billDate: dateStr(l.bill.billDate) }));
  }
  if (what === "accounts") {
    const rows = await prisma.account.findMany({ where: { isActive: true, allowPosting: true, children: { none: {} } }, orderBy: { code: "asc" } });
    return rows.map((a) => ({ id: a.id, code: a.code, name: a.nameAr ?? a.nameEn, type: a.type, controlKind: a.controlKind }));
  }
  if (what === "periods") {
    const rows = await prisma.fiscalPeriod.findMany({ orderBy: { startDate: "desc" }, take: 36 });
    return rows.map((p) => ({ id: p.id, label: `${p.year}-${String(p.periodNo).padStart(2, "0")}`, start: dateStr(p.startDate), end: dateStr(p.endDate), status: p.status, year: p.year }));
  }
  if (what === "branches") return prisma.finBranch.findMany({ where: { active: true }, select: { id: true, code: true, nameEn: true, nameAr: true }, orderBy: { code: "asc" } });
  if (what === "years") {
    const rows = await prisma.fiscalPeriod.groupBy({ by: ["year"], _min: { startDate: true }, _max: { endDate: true }, orderBy: { year: "desc" } });
    return rows.map((r) => ({ year: r.year, start: r._min.startDate ? dateStr(r._min.startDate) : null, end: r._max.endDate ? dateStr(r._max.endDate) : null, ended: r._max.endDate ? r._max.endDate < todayAccountingDate() : false }));
  }
  return [];
}

export async function yearEndCloses(year: number) {
  const rows = await prisma.yearEndClose.findMany({ where: { year }, orderBy: { preparedAt: "desc" } });
  const who = await names(rows.flatMap((c) => [c.preparedBy, c.approvedBy, c.reversalRequestedBy, c.reversedBy]));
  const events = await prisma.accountingEvent.findMany({ where: { sourceModule: "closing", sourceDocumentId: { in: rows.map((r) => r.id) } } });
  return rows.map((c) => ({
    id: c.id, status: c.status, netIncome: c.netIncome.toFixed(2), preparedBy: c.preparedBy, preparedByName: who.get(c.preparedBy) ?? null, preparedAt: c.preparedAt,
    approvedByName: c.approvedBy ? who.get(c.approvedBy) ?? null : null, postedAt: c.postedAt, reversalRequestedBy: c.reversalRequestedBy, reversalReason: c.reversalReason,
    snapshot: c.snapshot, ledger: events.filter((e) => e.sourceDocumentId === c.id).map((e) => ({ eventType: e.eventType, status: e.status, message: e.errorMessage })),
  }));
}
