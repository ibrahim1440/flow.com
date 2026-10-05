// Gross margin per sales document for a period (stage 4b), complete by construction.
//
// Rows: every invoice and credit note whose revenue moved in the posted ledger in the period
// (posting, reversal, credit), read from the revenue accounts by entry date — so a service
// invoice, a price credit and a reversal all appear, not only documents that moved stock.
// Cost: what the inventory documents of that sale put through cost of sales in the period (issues,
// cost moved back on reversal, physical returns, and later cost adjustments traced to the sale).
// A row whose costing is not finished says so (costStatus + reason) and makes the report
// incomplete; its cost is never shown as if it were zero and final.
// Reconciliation: report totals against the revenue, returns and cost-of-sales accounts, with
// every difference itemised (revenue not from sales documents, cost of sales not from sales:
// café internal use, adjustments on stock no longer traceable to a sale, manual journals,
// inventory documents whose journal is waiting).
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ZERO, dec } from "./money";

type D = Prisma.Decimal;
const DONE = new Set(["COSTED", "NOT_REQUIRED", "UNCOSTED", "CANCELLED"]);

export async function grossMargin(from: Date, to: Date) {
  // 1. Revenue per sales document from the ledger (credit − debit on revenue accounts).
  const rev = await prisma.$queryRaw<{ doc: string | null; module: string | null; manual: boolean; account: string; amount: string }[]>`
    SELECT e."sourceDocumentId" AS doc, e."sourceModule" AS module, (e."originEventId" IS NULL) AS manual, a."code" AS account,
           SUM(l."credit" - l."debit")::text AS amount
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId" JOIN "Account" a ON a."id" = l."accountId"
     WHERE a."type" = 'REVENUE' AND e."status" IN ('POSTED', 'REVERSED') AND e."entryDate" BETWEEN ${from} AND ${to}
     GROUP BY 1, 2, 3, 4`;
  const salesDocIds = [...new Set(rev.filter((r) => r.module === "receivables" && r.doc).map((r) => r.doc!))];
  const docs = new Map((await prisma.salesInvoice.findMany({ where: { id: { in: salesDocIds } }, include: { customer: { select: { name: true, nameAr: true } } } })).map((d) => [d.id, d]));
  const revenueBy = new Map<string, D>();
  const returnsAccount = (await prisma.accountMapping.findUnique({ where: { role: "SALES_RETURNS" }, include: { account: true } }))?.account.code ?? "4900";
  let returnsReport = ZERO;
  for (const r of rev) {
    if (r.module !== "receivables" || !r.doc || !docs.has(r.doc)) continue;
    revenueBy.set(r.doc, (revenueBy.get(r.doc) ?? ZERO).add(dec(r.amount)));
    if (r.account === returnsAccount) returnsReport = returnsReport.add(dec(r.amount));
  }

  // 2. Cost of sales per sales document from inventory moves dated in the period.
  const costDocs = await prisma.invDocument.findMany({ where: { status: "POSTED", OR: [{ salesInvoiceId: { not: null } }, { sourceType: "CUSTOMER_RETURN" }] }, select: { id: true, type: true, salesInvoiceId: true, sourceType: true, sourceId: true } });
  const returnsById = new Map((await prisma.customerReturn.findMany({ where: { documentId: { in: costDocs.map((d) => d.id) } } })).map((r) => [r.documentId!, r]));
  const creditFor = new Map((await prisma.salesInvoice.findMany({ where: { customerReturnId: { in: [...returnsById.values()].map((r) => r.id) }, status: "POSTED" }, select: { id: true, customerReturnId: true } })).map((c) => [c.customerReturnId!, c.id]));
  // A physical return belongs to its credit note once there is one, to the invoice until then.
  const saleOf = (d: (typeof costDocs)[number]) => {
    const r = returnsById.get(d.id);
    return r ? creditFor.get(r.id) ?? r.invoiceId : d.salesInvoiceId;
  };
  const docSale = new Map(costDocs.map((d) => [d.id, saleOf(d)] as const));
  const moves = await prisma.invMove.findMany({ where: { date: { gte: from, lte: to }, OR: [
    { documentId: { in: costDocs.map((d) => d.id) }, kind: { in: ["IN", "OUT"] } },
    { kind: "EXPENSED", role: "COGS", traceDocumentId: { in: costDocs.map((d) => d.id) } },
  ] } });
  const cogsBy = new Map<string, D>(), cogsByInvDoc = new Map<string, D>();
  for (const m of moves) {
    const saleDoc = m.kind === "EXPENSED" ? m.traceDocumentId! : m.documentId;
    const sale = docSale.get(saleDoc);
    if (!sale) continue;
    const v = m.kind === "EXPENSED" ? dec(m.value) : dec(m.value).neg();
    cogsBy.set(sale, (cogsBy.get(sale) ?? ZERO).add(v));
    cogsByInvDoc.set(m.documentId, (cogsByInvDoc.get(m.documentId) ?? ZERO).add(v));
  }
  // Sales documents with cost in the period but no revenue movement in it (cost booked late, or a
  // return credited in the period) are rows too.
  for (const id of cogsBy.keys()) if (!docs.has(id)) { const d = await prisma.salesInvoice.findUnique({ where: { id }, include: { customer: { select: { name: true, nameAr: true } } } }); if (d) docs.set(id, d); }

  // 3. Cost status per row. Late costing (DECISION: booked on the first day it can be, the day it
  // happened kept): in the invoice's period the row is "booked later", never a silent zero; in the
  // period where the cost was booked the row says it belongs to an earlier invoice.
  const costing = new Map((await prisma.invCosting.findMany({ where: { invoiceId: { in: [...docs.keys()] } } })).map((c) => [c.invoiceId, c]));
  const lateDocs = await prisma.invDocument.findMany({ where: { salesInvoiceId: { in: [...docs.keys()] }, status: "POSTED", originalDate: { not: null } }, select: { salesInvoiceId: true, docDate: true, originalDate: true } });
  const bookedAfter = new Map<string, Date>(), bookedFromEarlier = new Set<string>();
  for (const l of lateDocs) {
    if (l.originalDate! <= to && l.docDate > to) bookedAfter.set(l.salesInvoiceId!, l.docDate);
    if (l.originalDate! < from && l.docDate >= from && l.docDate <= to) bookedFromEarlier.add(l.salesInvoiceId!);
  }
  const rows = [...docs.values()].map((d) => {
    const revenue = revenueBy.get(d.id) ?? ZERO, cogs = cogsBy.get(d.id) ?? ZERO;
    let costStatus: string, costReason: string | null = null, late = false;
    if (d.kind === "INVOICE") {
      const c = costing.get(d.id);
      costStatus = c?.status ?? "PENDING"; costReason = c?.lastError ?? (c ? null : "No costing record yet."); late = !!c?.late;
      if (bookedAfter.has(d.id)) { costStatus = "BOOKED_LATER"; costReason = `Its cost of sales was booked late, on ${bookedAfter.get(d.id)!.toISOString().slice(0, 10)}, after this period.`; }
      else if (bookedFromEarlier.has(d.id)) costReason = "Cost booked in this period for an invoice of an earlier period (late costing).";
    } else if (d.creditType === "RETURN_OF_GOODS") costStatus = "COSTED";
    else if (d.creditType === "PRICE_ADJUSTMENT") costStatus = "NOT_REQUIRED";
    else { costStatus = "UNCLASSIFIED"; costReason = "A credit note from before stage 4b: it does not say whether goods came back."; }
    const complete = DONE.has(costStatus);
    return {
      invoiceId: d.id, kind: d.kind, no: d.invoiceNo, customer: d.customer.nameAr ?? d.customer.name, date: d.issueDate, status: d.status, creditType: d.creditType,
      revenue: revenue.toFixed(2), cogs: cogs.toFixed(2), margin: complete ? revenue.sub(cogs).toFixed(2) : null,
      marginPercent: complete && !revenue.isZero() ? revenue.sub(cogs).div(revenue).mul(100).toFixed(1) : null,
      costStatus, costReason, costComplete: complete, late,
    };
  }).sort((a, b) => a.date.getTime() - b.date.getTime() || a.no - b.no);
  const sum = (f: (r: (typeof rows)[number]) => string | null) => rows.reduce((s, r) => s.add(dec(f(r) ?? "0")), ZERO);
  const pending = rows.filter((r) => !r.costComplete);

  // 4. Reconciliation to the ledger.
  const revenueLedger = rev.reduce((s, r) => s.add(dec(r.amount)), ZERO);
  const revenueOther = new Map<string, D>();
  for (const r of rev) if (!(r.module === "receivables" && r.doc && docs.has(r.doc))) {
    const k = r.manual ? `manual journals on ${r.account}` : `${r.module ?? "other"} postings on ${r.account}`;
    revenueOther.set(k, (revenueOther.get(k) ?? ZERO).add(dec(r.amount)));
  }
  const returnsLedger = rev.filter((r) => r.account === returnsAccount).reduce((s, r) => s.add(dec(r.amount)), ZERO);

  const cogsAcc = (await prisma.accountMapping.findUnique({ where: { role: "COGS" } }))?.accountId;
  const gl = cogsAcc ? await prisma.$queryRaw<{ doc: string | null; module: string | null; amount: string }[]>`
    SELECT e."sourceDocumentId" AS doc, e."sourceModule" AS module, SUM(l."debit" - l."credit")::text AS amount
      FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e."id" = l."journalEntryId"
     WHERE l."accountId" = ${cogsAcc} AND e."status" IN ('POSTED', 'REVERSED') AND e."entryDate" BETWEEN ${from} AND ${to}
     GROUP BY 1, 2` : [];
  const cogsLedger = gl.reduce((s, r) => s.add(dec(r.amount)), ZERO);
  const glByDoc = new Map(gl.filter((r) => r.module === "inventory" && r.doc).map((r) => [r.doc!, dec(r.amount)]));
  const invDocs = new Map((await prisma.invDocument.findMany({ where: { id: { in: [...new Set([...glByDoc.keys(), ...cogsByInvDoc.keys()])] } }, select: { id: true, type: true, issueReason: true, docNo: true } })).map((d) => [d.id, d]));
  const explained = new Map<string, D>();
  const add = (k: string, v: D) => { if (!v.isZero()) explained.set(k, (explained.get(k) ?? ZERO).add(v)); };
  for (const r of gl) if (!(r.module === "inventory" && r.doc)) add(r.module ? `${r.module} postings` : "manual journals", dec(r.amount));
  for (const [id, glv] of glByDoc) {
    const d = invDocs.get(id);
    const diff = glv.sub(cogsByInvDoc.get(id) ?? ZERO);
    if (diff.isZero()) continue;
    const label = d?.type === "ISSUE" ? "café and internal use issues" : ["LANDED_COST", "BILL_MATCH", "SUPPLIER_CREDIT"].includes(d?.type ?? "") ? "cost adjustments on goods sold, not traceable to one sale (stage 4 postings)" : `${d?.type?.toLowerCase().replace("_", " ") ?? "inventory"} documents not tied to a sale`;
    add(label, diff);
  }
  for (const [id, v] of cogsByInvDoc) if (!glByDoc.has(id)) add(`inventory documents whose journal is waiting (${invDocs.get(id) ? `#${invDocs.get(id)!.docNo}` : id})`, v.neg());
  const cogsReport = sum((r) => r.cogs);
  const explainedTotal = [...explained.values()].reduce((s, v) => s.add(v), ZERO);

  return {
    from, to, rows,
    totals: { revenue: sum((r) => r.revenue).toFixed(2), cogs: cogsReport.toFixed(2), margin: sum((r) => r.margin).toFixed(2),
      pendingDocuments: pending.length, pendingRevenue: pending.reduce((s, r) => s.add(r.revenue), ZERO).toFixed(2) },
    complete: pending.length === 0,
    reconciliation: {
      revenue: { report: sum((r) => r.revenue).toFixed(2), ledger: revenueLedger.toFixed(2),
        explained: [...revenueOther].map(([label, v]) => ({ label, amount: v.toFixed(2) })),
        difference: revenueLedger.sub(sum((r) => r.revenue)).sub([...revenueOther.values()].reduce((s, v) => s.add(v), ZERO)).toFixed(2) },
      returns: { report: returnsReport.toFixed(2), ledger: returnsLedger.toFixed(2), difference: returnsLedger.sub(returnsReport).toFixed(2) },
      cogs: { report: cogsReport.toFixed(2), ledger: cogsLedger.toFixed(2),
        explained: [...explained].map(([label, v]) => ({ label, amount: v.toFixed(2) })),
        difference: cogsLedger.sub(cogsReport).sub(explainedTotal).toFixed(2) },
    },
  };
}
