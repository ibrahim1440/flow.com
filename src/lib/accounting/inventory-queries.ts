// Read models for the inventory screens (list, detail, pickers). Figures come from the cost
// moves of posted documents and from the journal they produced; nothing is estimated for a posted
// document. Drafts show what can be known before posting (receipt values, landed-cost amounts).
import { Prisma, type InvDocStatus, type InvDocType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AccountingError } from "./errors";
import { ZERO, dec } from "./money";
import { KIND_ROLE, ISSUE_ROLE, YIELDING } from "./inventory-rules";

const TYPES = new Set(["RECEIPT", "SUPPLIER_RETURN", "ISSUE", "TRANSFER", "PRODUCTION", "SALE_ISSUE", "CUSTOMER_RETURN", "LANDED_COST", "BILL_MATCH", "COUNT"]);

export async function listInvDocs(q: URLSearchParams) {
  const where: Prisma.InvDocumentWhereInput = {};
  const type = q.get("type");
  if (type && TYPES.has(type)) where.type = type as InvDocType;
  if (type === "RETURNS") where.type = { in: ["SUPPLIER_RETURN", "CUSTOMER_RETURN"] };
  if (type === "ISSUES") where.type = { in: ["ISSUE", "TRANSFER"] };
  if (q.get("supplierId")) where.supplierId = q.get("supplierId")!;
  const st = q.get("status");
  if (st === "PENDING") where.status = { in: ["SUBMITTED", "APPROVED"] };
  else if (st && ["DRAFT", "SUBMITTED", "APPROVED", "POSTED"].includes(st)) where.status = st as InvDocStatus;
  const text = q.get("q")?.trim();
  if (text) {
    const n = Number(text.replace(/^#/, ""));
    where.OR = [{ description: { contains: text, mode: "insensitive" } }, { lines: { some: { item: { OR: [{ code: { contains: text, mode: "insensitive" } }, { name: { contains: text, mode: "insensitive" } }, { nameAr: { contains: text } }] } } } }, ...(Number.isInteger(n) && n > 0 ? [{ docNo: n }] : [])];
  }
  const page = Math.max(Number(q.get("page")) || 1, 1), pageSize = Math.min(Math.max(Number(q.get("pageSize")) || 25, 10), 100);
  const [rows, total, counts] = await Promise.all([
    prisma.invDocument.findMany({ where, orderBy: { docNo: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { lines: { include: { item: { select: { code: true, name: true, nameAr: true, baseUnit: true, kind: true, yieldPerUnit: true } } }, orderBy: { lineNo: "asc" } } } }),
    prisma.invDocument.count({ where }),
    prisma.invDocument.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const values = new Map((await prisma.invMove.groupBy({ by: ["documentId"], where: { documentId: { in: rows.map((r) => r.id) }, kind: { in: ["IN", "REVALUE", "EXPENSED"] } }, _sum: { value: true } })).map((v) => [v.documentId, dec(v._sum.value)]));
  const outs = new Map((await prisma.invMove.groupBy({ by: ["documentId"], where: { documentId: { in: rows.map((r) => r.id) }, kind: "OUT" }, _sum: { value: true } })).map((v) => [v.documentId, dec(v._sum.value).neg()]));
  const locations = new Map((await prisma.invLocation.findMany()).map((l) => [l.id, l]));
  const events = new Map((await prisma.accountingEvent.findMany({ where: { idempotencyKey: { in: rows.map((r) => `inventory:${r.id}:inv.document.posted`) } }, select: { sourceDocumentId: true, status: true, errorMessage: true, journalEntryId: true } })).map((e) => [e.sourceDocumentId, e]));
  // Figma ACC-47 (approval cards): the loss of a production document and the journal rows that
  // posting will produce (expected accounts; amounts only where known before costing) or produced.
  const journals = new Map((await prisma.journalEntry.findMany({ where: { id: { in: [...events.values()].map((e) => e.journalEntryId).filter(Boolean) as string[] } }, select: { id: true, entryNo: true, lines: { select: { debit: true, credit: true, account: { select: { code: true, nameAr: true, nameEn: true } } }, orderBy: { lineNo: "asc" } } } })).map((j) => [j.id, j]));
  const bands = new Map((await prisma.invLossBand.findMany({ where: { id: { in: rows.map((r) => r.lossBandId).filter(Boolean) as string[] } } })).map((b) => [b.id, b]));
  const roleAccounts = new Map((await prisma.accountMapping.findMany({ include: { account: { select: { code: true, nameAr: true, nameEn: true } } } })).map((m) => [m.role, m.account]));
  const acct = (role: string) => { const a = roleAccounts.get(role); return { role, code: a?.code ?? null, name: a ? a.nameAr ?? a.nameEn : null, nameEn: a?.nameEn ?? null }; };
  return {
    total, page, pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    rows: rows.map((r) => ({
      id: r.id, docNo: r.docNo, type: r.type, status: r.status, docDate: r.docDate, issueReason: r.issueReason, description: r.description, rejectedReason: r.rejectedReason, provisional: r.provisional,
      location: locations.get(r.locationId)?.code ?? "", toLocation: r.toLocationId ? locations.get(r.toLocationId)?.code ?? "" : null, createdBy: r.createdBy,
      lines: r.lines.map((l) => ({ item: l.item.code, name: l.item.nameAr ?? l.item.name, qty: dec(l.baseQty).toFixed(4), unit: l.item.baseUnit, role: l.role })),
      // Value: what entered stock (receipts, outputs, returns, revaluations) or else what left it.
      value: r.status === "POSTED" ? ((values.get(r.id) ?? ZERO).isZero() ? (outs.get(r.id) ?? ZERO) : values.get(r.id)!).toFixed(2) : r.type === "RECEIPT" ? r.lines.reduce((s, l) => s.add(dec(l.baseQty).mul(dec(l.unitCost)).toDecimalPlaces(2)), ZERO).toFixed(2) : r.amount ? dec(r.amount).toFixed(2) : null,
      ledger: events.get(r.id) ? { status: events.get(r.id)!.status, reason: events.get(r.id)!.errorMessage } : null,
      supplierId: r.supplierId, lossBandId: r.lossBandId,
      production: r.type === "PRODUCTION" ? productionSummary(r, r.lossBandId ? bands.get(r.lossBandId) ?? null : null, r.status === "POSTED" ? { in: outs.get(r.id) ?? null, out: values.get(r.id) ?? null } : null) : null,
      journal: (() => {
        const je = events.get(r.id)?.journalEntryId ? journals.get(events.get(r.id)!.journalEntryId!) : undefined;
        return je ? { entryNo: je.entryNo, lines: je.lines.map((l) => ({ code: l.account.code, name: l.account.nameAr ?? l.account.nameEn, nameEn: l.account.nameEn, debit: dec(l.debit).toFixed(2), credit: dec(l.credit).toFixed(2) })) } : null;
      })(),
      expected: r.status === "POSTED" ? null : expectedJournal(r, acct),
    })),
  };
}

type ListDoc = { type: InvDocType; issueReason: string | null; amount: Prisma.Decimal | null; lossBandPercent: Prisma.Decimal | null;
  lines: { role: string; baseQty: Prisma.Decimal; unitCost: Prisma.Decimal | null; item: { kind: keyof typeof KIND_ROLE; yieldPerUnit: Prisma.Decimal } }[] };

/** Production loss from the document's lines: yield in vs out, against the loss band. */
function productionSummary(d: ListDoc, band: { code: string; name: string; nameAr: string | null; maxLossPercent: Prisma.Decimal; status: string } | null, posted: { in: Prisma.Decimal | null; out: Prisma.Decimal | null } | null) {
  const yieldOf = (l: ListDoc["lines"][number]) => dec(l.baseQty).mul(dec(l.item.yieldPerUnit));
  const yieldIn = d.lines.filter((l) => l.role === "INPUT" && YIELDING.has(l.item.kind)).reduce((s, l) => s.add(yieldOf(l)), ZERO);
  const yieldOut = d.lines.filter((l) => l.role === "OUTPUT").reduce((s, l) => s.add(yieldOf(l)), ZERO);
  const pct = d.lossBandPercent ? dec(d.lossBandPercent) : band ? dec(band.maxLossPercent) : null;
  const lossPercent = yieldIn.gt(0) ? yieldIn.sub(yieldOut).mul(100).div(yieldIn).toDecimalPlaces(2) : null;
  const expected = pct !== null && yieldIn.gt(0) ? yieldIn.mul(new Prisma.Decimal(100).sub(pct)).div(100).toDecimalPlaces(4) : null;
  const abnormalQty = expected && yieldOut.lt(expected) ? expected.sub(yieldOut) : ZERO;
  return {
    yieldIn: yieldIn.toFixed(4), yieldOut: yieldOut.toFixed(4), lossQty: yieldIn.sub(yieldOut).toFixed(4), lossPercent: lossPercent?.toFixed(2) ?? null,
    band: band ? { code: band.code, name: band.nameAr ?? band.name, nameEn: band.name, status: band.status } : null, bandPercent: pct?.toFixed(2) ?? null,
    expectedYield: expected?.toFixed(4) ?? null, abnormalQty: abnormalQty.toFixed(4),
    abnormalPercent: yieldIn.gt(0) ? abnormalQty.mul(100).div(yieldIn).toDecimalPlaces(2).toFixed(2) : null,
    // Values exist only once the document has posted (moves are costed at posting).
    inputValue: posted?.in ? posted.in.toFixed(2) : null, outputValue: posted?.out ? posted.out.toFixed(2) : null,
    abnormalValue: posted?.in && posted.out ? posted.in.sub(posted.out).toFixed(2) : null,
  };
}

/**
 * Accounts a document will post to (same rule as translators/inventory.ts), before posting. The
 * amount is given only where it is known without costing (receipt values, landed-cost amount);
 * otherwise it is null ("value on posting"). EITHER: the side depends on the counted difference.
 */
function expectedJournal(d: ListDoc, acct: (role: string) => { role: string; code: string | null; name: string | null; nameEn: string | null }) {
  const invRoles = (lines: ListDoc["lines"]) => [...new Set(lines.map((l) => KIND_ROLE[l.item.kind]))];
  type Side = "DEBIT" | "CREDIT" | "EITHER";
  const row = (side: Side, role: string, amount: Prisma.Decimal | null = null) => ({ side, ...acct(role), amount: amount ? amount.toFixed(2) : null });
  switch (d.type) {
    case "RECEIPT": {
      const by = new Map<string, Prisma.Decimal>();
      for (const l of d.lines) by.set(KIND_ROLE[l.item.kind], (by.get(KIND_ROLE[l.item.kind]) ?? ZERO).add(dec(l.baseQty).mul(dec(l.unitCost)).toDecimalPlaces(2)));
      const tot = [...by.values()].reduce((s, v) => s.add(v), ZERO);
      return [...[...by].map(([role, v]) => row("DEBIT", role, v)), row("CREDIT", "GRNI", tot)];
    }
    case "SUPPLIER_RETURN": return [row("DEBIT", "GRNI"), ...invRoles(d.lines).map((r) => row("CREDIT", r))];
    case "ISSUE": return d.issueReason ? [row("DEBIT", ISSUE_ROLE[d.issueReason as keyof typeof ISSUE_ROLE]), ...invRoles(d.lines).map((r) => row("CREDIT", r))] : [];
    case "TRANSFER": return [];
    case "PRODUCTION": return [...invRoles(d.lines.filter((l) => l.role === "OUTPUT")).map((r) => row("DEBIT", r)), row("DEBIT", "ABNORMAL_LOSS"), ...invRoles(d.lines.filter((l) => l.role === "INPUT")).map((r) => row("CREDIT", r))];
    case "SALE_ISSUE": return [row("DEBIT", "COGS"), ...invRoles(d.lines).map((r) => row("CREDIT", r))];
    case "CUSTOMER_RETURN": return [...invRoles(d.lines).map((r) => row("DEBIT", r)), row("CREDIT", "COGS")];
    case "LANDED_COST": return [...invRoles(d.lines).map((r) => row("DEBIT", r)), row("CREDIT", "GRNI", d.amount ? dec(d.amount) : null)];
    case "COUNT": case "ADJUSTMENT": return [...invRoles(d.lines).map((r) => row("EITHER", r)), row("EITHER", "INVENTORY_VARIANCE")];
    case "BILL_MATCH": case "SUPPLIER_CREDIT": return [...invRoles(d.lines).map((r) => row("EITHER", r)), row("EITHER", "GRNI")];
    default: return [];
  }
}

export async function invDocDetail(id: string) {
  const d = await prisma.invDocument.findUnique({ where: { id }, include: { lines: { include: { item: { include: { units: true } } }, orderBy: { lineNo: "asc" } }, moves: { orderBy: { seq: "asc" } } } });
  if (!d) throw new AccountingError("Document not found.", 404);
  const locations = new Map((await prisma.invLocation.findMany()).map((l) => [l.id, l]));
  const users = new Map((await prisma.employee.findMany({ where: { id: { in: [d.createdBy, d.submittedBy, d.approvedBy, d.postedBy, d.rejectedBy].filter(Boolean) as string[] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const name = (u: string | null) => (!u ? null : u.startsWith("system:") ? "النظام" : users.get(u) ?? u);
  const ev = await prisma.accountingEvent.findUnique({ where: { idempotencyKey: `inventory:${d.id}:inv.document.posted` } });
  const journal = ev?.journalEntryId ? await prisma.journalEntry.findUnique({ where: { id: ev.journalEntryId }, include: { lines: { include: { account: { select: { code: true, nameAr: true, nameEn: true } } }, orderBy: { lineNo: "asc" } } } }) : null;
  const band = d.lossBandId ? await prisma.invLossBand.findUnique({ where: { id: d.lossBandId } }) : null;
  const supplier = d.supplierId ? await prisma.supplier.findUnique({ where: { id: d.supplierId }, select: { name: true } }) : null;
  const customer = d.customerId ? await prisma.customer.findUnique({ where: { id: d.customerId }, select: { name: true, nameAr: true } }) : null;
  const billLine = d.billLineId ? await prisma.supplierBillLine.findUnique({ where: { id: d.billLineId }, include: { bill: { select: { billNo: true, supplierInvoiceNo: true, supplier: { select: { name: true } } } } } }) : null;
  const audit = await prisma.finAuditLog.findMany({ where: { entityType: "accounting.inv_document", entityId: d.id }, orderBy: { createdAt: "asc" }, take: 50 }).catch(() => []);

  const byLine = new Map<string, { qty: Prisma.Decimal; value: Prisma.Decimal; expensed: Prisma.Decimal }>();
  for (const m of d.moves) {
    const e = byLine.get(m.lineId ?? "") ?? { qty: ZERO, value: ZERO, expensed: ZERO };
    if (m.kind === "EXPENSED") e.expensed = e.expensed.add(dec(m.value)); else { e.qty = e.qty.add(dec(m.qty)); e.value = e.value.add(dec(m.value)); }
    byLine.set(m.lineId ?? "", e);
  }
  // Production: the loss calculation, from the posted moves and the band copied at posting.
  let production = null;
  if (d.type === "PRODUCTION") {
    const yieldOf = (l: (typeof d.lines)[number]) => (YIELDING.has(l.item.kind) || l.role === "OUTPUT" ? dec(l.baseQty).mul(dec(l.item.yieldPerUnit)) : ZERO);
    const ins = d.lines.filter((l) => l.role === "INPUT"), outs = d.lines.filter((l) => l.role === "OUTPUT");
    const yieldIn = ins.reduce((s, l) => s.add(YIELDING.has(l.item.kind) ? yieldOf(l) : ZERO), ZERO), yieldOut = outs.reduce((s, l) => s.add(yieldOf(l)), ZERO);
    const pct = d.lossBandPercent ? dec(d.lossBandPercent) : band ? dec(band.maxLossPercent) : null;
    const expected = pct !== null && yieldIn.gt(0) ? yieldIn.mul(new Prisma.Decimal(100).sub(pct)).div(100).toDecimalPlaces(4) : null;
    const inputValue = ins.reduce((s, l) => s.add(byLine.get(l.id)?.value.neg() ?? ZERO), ZERO), outputValue = outs.reduce((s, l) => s.add(byLine.get(l.id)?.value ?? ZERO), ZERO);
    production = { yieldIn: yieldIn.toFixed(4), yieldOut: yieldOut.toFixed(4), bandPercent: pct?.toFixed(2) ?? null, band: band ? { code: band.code, name: band.nameAr ?? band.name, status: band.status } : null,
      expectedYield: expected?.toFixed(4) ?? null, lossQty: yieldIn.sub(yieldOut).toFixed(4), abnormalQty: expected && yieldOut.lt(expected) ? expected.sub(yieldOut).toFixed(4) : "0.0000",
      inputValue: d.status === "POSTED" ? inputValue.toFixed(2) : null, outputValue: d.status === "POSTED" ? outputValue.toFixed(2) : null, abnormalValue: d.status === "POSTED" ? inputValue.sub(outputValue).toFixed(2) : null };
  }
  // Preview of the journal before posting, where the amounts are known without costing.
  let preview: { role: string; debit: string; credit: string }[] | null = null;
  if (d.status !== "POSTED") {
    if (d.type === "RECEIPT") {
      const by = new Map<string, Prisma.Decimal>();
      for (const l of d.lines) by.set(KIND_ROLE[l.item.kind], (by.get(KIND_ROLE[l.item.kind]) ?? ZERO).add(dec(l.baseQty).mul(dec(l.unitCost)).toDecimalPlaces(2)));
      const tot = [...by.values()].reduce((s, v) => s.add(v), ZERO);
      preview = [...[...by].map(([role, v]) => ({ role, debit: v.toFixed(2), credit: "" })), { role: "GRNI", debit: "", credit: tot.toFixed(2) }];
    } else if (d.type === "ISSUE" && d.issueReason) preview = [{ role: ISSUE_ROLE[d.issueReason], debit: "cost", credit: "" }, ...[...new Set(d.lines.map((l) => KIND_ROLE[l.item.kind]))].map((role) => ({ role, debit: "", credit: "cost" }))];
  }
  const roles = new Map((await prisma.accountMapping.findMany({ include: { account: { select: { code: true, nameAr: true, nameEn: true } } } })).map((m) => [m.role, m.account]));
  return {
    ...d, amount: d.amount?.toFixed(2) ?? null, lossBandPercent: d.lossBandPercent?.toFixed(2) ?? null,
    location: locations.get(d.locationId) ?? null, toLocation: d.toLocationId ? locations.get(d.toLocationId) ?? null : null, supplier: supplier?.name ?? null, customer: customer ? customer.nameAr ?? customer.name : null,
    billLine: billLine ? { id: billLine.id, billNo: billLine.bill.billNo, invoiceNo: billLine.bill.supplierInvoiceNo, supplier: billLine.bill.supplier.name, description: billLine.description, net: dec(billLine.net).toFixed(2) } : null,
    names: { createdBy: name(d.createdBy), submittedBy: name(d.submittedBy), approvedBy: name(d.approvedBy), postedBy: name(d.postedBy), rejectedBy: name(d.rejectedBy) },
    lines: d.lines.map((l) => ({ id: l.id, lineNo: l.lineNo, role: l.role, itemId: l.itemId, item: { code: l.item.code, name: l.item.nameAr ?? l.item.name, kind: l.item.kind, baseUnit: l.item.baseUnit, yieldPerUnit: dec(l.item.yieldPerUnit).toString() },
      quantity: dec(l.quantity).toFixed(4), unit: l.unit, factor: dec(l.factor).toString(), baseQty: dec(l.baseQty).toFixed(4), unitCost: l.unitCost ? dec(l.unitCost).toFixed(4) : null, countedQty: l.countedQty ? dec(l.countedQty).toFixed(4) : null, targetLineId: l.targetLineId, description: l.description,
      posted: byLine.has(l.id) ? { qty: byLine.get(l.id)!.qty.toFixed(4), value: byLine.get(l.id)!.value.toFixed(2), expensed: byLine.get(l.id)!.expensed.toFixed(2), unitCost: byLine.get(l.id)!.qty.isZero() ? null : byLine.get(l.id)!.value.div(byLine.get(l.id)!.qty).abs().toFixed(4) } : null })),
    moves: d.moves.map((m) => ({ id: m.id, lineId: m.lineId, kind: m.kind, qty: dec(m.qty).toFixed(4), value: dec(m.value).toFixed(2), location: locations.get(m.locationId)?.code ?? "" })),
    production,
    ledger: ev ? { status: ev.status, reason: ev.errorMessage, entryNo: journal?.entryNo ?? null, provisional: journal?.isProvisional ?? null,
      lines: journal?.lines.map((l) => ({ account: `${l.account.code} · ${l.account.nameAr ?? l.account.nameEn}`, debit: dec(l.debit).toFixed(2), credit: dec(l.credit).toFixed(2) })) ?? [] } : null,
    preview: preview?.map((p) => ({ account: roles.get(p.role) ? `${roles.get(p.role)!.code} · ${roles.get(p.role)!.nameAr ?? roles.get(p.role)!.nameEn}` : p.role, debit: p.debit, credit: p.credit })) ?? null,
    audit: audit.map((a) => ({ action: a.action, at: a.createdAt, by: name(a.userId), reason: (a as unknown as { reason?: string }).reason ?? null })),
  };
}

/** Receipt lines that can be the target of a landed cost, bill match or supplier return (posted, with what is left). */
export async function receiptLines(supplierId?: string | null) {
  const lines = await prisma.invDocLine.findMany({ where: { document: { type: "RECEIPT", status: "POSTED", ...(supplierId ? { supplierId } : {}) } }, include: { document: { select: { docNo: true, docDate: true, supplierId: true } }, item: { select: { code: true, name: true, nameAr: true, baseUnit: true } } }, orderBy: { document: { docNo: "desc" } }, take: 300 });
  const moves = new Map((await prisma.invMove.findMany({ where: { kind: "IN", lineId: { in: lines.map((l) => l.id) } } })).map((m) => [m.lineId!, m]));
  const layers = new Map((await prisma.invLayer.findMany({ where: { moveId: { in: [...moves.values()].map((m) => m.id) } } })).map((l) => [l.moveId, l]));
  const matched = new Set((await prisma.invDocLine.findMany({ where: { document: { type: "BILL_MATCH", status: { not: "DRAFT" } } }, select: { targetLineId: true } })).map((m) => m.targetLineId));
  const suppliers = new Map((await prisma.supplier.findMany({ where: { id: { in: lines.map((l) => l.document.supplierId!).filter(Boolean) } } })).map((s) => [s.id, s.name]));
  return lines.map((l) => { const m = moves.get(l.id); const ly = m ? layers.get(m.id) : undefined;
    return { id: l.id, docNo: l.document.docNo, date: l.document.docDate, supplier: suppliers.get(l.document.supplierId ?? "") ?? "", itemId: l.itemId, item: `${l.item.code} · ${l.item.nameAr ?? l.item.name}`, baseUnit: l.item.baseUnit,
      qty: dec(l.baseQty).toFixed(4), value: m ? dec(m.value).toFixed(2) : "0.00", qtyLeft: ly ? dec(ly.qtyLeft).toFixed(4) : "0.0000", valueLeft: ly ? dec(ly.valueLeft).toFixed(2) : "0.00", billMatched: matched.has(l.id) }; });
}

/** Posted supplier-bill stock lines not yet matched or used by a landed cost. */
export async function openBillStockLines() {
  const used = new Set((await prisma.invDocument.findMany({ where: { billLineId: { not: null } }, select: { billLineId: true } })).map((d) => d.billLineId));
  const lines = await prisma.supplierBillLine.findMany({ where: { kind: "STOCK_RECEIPT", bill: { status: "POSTED" } }, include: { bill: { select: { billNo: true, billDate: true, supplierInvoiceNo: true, supplierId: true, supplier: { select: { name: true } } } } }, orderBy: { bill: { billNo: "desc" } }, take: 300 });
  return lines.filter((l) => !used.has(l.id)).map((l) => ({ id: l.id, billNo: l.bill.billNo, date: l.bill.billDate, supplierId: l.bill.supplierId, supplier: l.bill.supplier.name, invoiceNo: l.bill.supplierInvoiceNo, description: l.description, qty: dec(l.quantity).toFixed(4), net: dec(l.net).toFixed(2) }));
}

/** Posted cost-of-sales lines a customer return can refer to (with what can still come back). */
export async function saleLines(customerId?: string | null) {
  const lines = await prisma.invDocLine.findMany({ where: { document: { type: "SALE_ISSUE", status: "POSTED", ...(customerId ? { customerId } : {}) } }, include: { document: { select: { docNo: true, docDate: true, description: true } }, item: { select: { code: true, name: true, nameAr: true, baseUnit: true } } }, orderBy: { document: { docNo: "desc" } }, take: 300 });
  const back = await prisma.invDocLine.findMany({ where: { targetLineId: { in: lines.map((l) => l.id) }, document: { type: "CUSTOMER_RETURN", status: "POSTED" } } });
  return lines.map((l) => ({ id: l.id, docNo: l.document.docNo, date: l.document.docDate, text: l.document.description, itemId: l.itemId, item: `${l.item.code} · ${l.item.nameAr ?? l.item.name}`, baseUnit: l.item.baseUnit,
    qty: dec(l.baseQty).toFixed(4), returnable: dec(l.baseQty).sub(back.filter((b) => b.targetLineId === l.id).reduce((s, b) => s.add(dec(b.baseQty)), ZERO)).toFixed(4) }));
}

/** Operational records that can become draft documents (not yet used). */
export async function operationalSources() {
  const usedRb = new Set((await prisma.invDocument.findMany({ where: { sourceType: "ROASTING_BATCH" }, select: { sourceId: true } })).map((d) => d.sourceId));
  const usedPr = new Set((await prisma.invDocument.findMany({ where: { sourceType: "PURCHASE_RECORD" }, select: { sourceId: true } })).map((d) => d.sourceId));
  const batches = await prisma.roastingBatch.findMany({ where: { isBlend: false, greenBeanId: { not: null }, productId: { not: null } }, orderBy: { date: "desc" }, take: 50, select: { id: true, batchNumber: true, date: true, greenBeanQuantity: true, roastedBeanQuantity: true, status: true } });
  const purchases = await prisma.purchaseRecord.findMany({ orderBy: { purchaseDate: "desc" }, take: 50, include: { supplier: { select: { name: true } } } });
  return {
    roastingBatches: batches.filter((b) => !usedRb.has(b.id)).map((b) => ({ ...b, greenBeanQuantity: String(b.greenBeanQuantity), roastedBeanQuantity: String(b.roastedBeanQuantity) })),
    purchases: purchases.filter((p) => !usedPr.has(p.id)).map((p) => ({ id: p.id, date: p.purchaseDate, supplier: p.supplier.name, type: p.type, quantity: String(p.quantity), costPerUnit: String(p.costPerUnit) })),
  };
}

export async function inventoryMasters() {
  const [items, locations, bands, settings] = await Promise.all([
    prisma.invItem.findMany({ orderBy: [{ kind: "asc" }, { code: "asc" }], include: { units: true } }),
    prisma.invLocation.findMany({ orderBy: { code: "asc" } }),
    prisma.invLossBand.findMany({ orderBy: [{ status: "asc" }, { code: "asc" }] }),
    prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { inventoryCostMethod: true, inventoryPriceDifference: true } }),
  ]);
  const people = new Map((await prisma.employee.findMany({ where: { id: { in: bands.flatMap((b) => [b.createdBy, b.approvedBy]).filter(Boolean) as string[] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const policy = await prisma.accountingPolicy.findFirst({ where: { key: "inventory.costing" }, orderBy: { version: "desc" }, select: { status: true, version: true } });
  const posted = await prisma.invDocument.count({ where: { status: "POSTED" } });
  const roles = new Map((await prisma.accountMapping.findMany({ include: { account: { select: { code: true } } } })).map((m) => [m.role, m.account.code]));
  return {
    settings: { costMethod: settings?.inventoryCostMethod ?? null, priceDifference: settings?.inventoryPriceDifference ?? null, locked: posted > 0, policy: policy ?? null },
    items: items.map((i) => ({ id: i.id, code: i.code, name: i.nameAr ?? i.name, nameEn: i.name, kind: i.kind, account: roles.get(KIND_ROLE[i.kind]) ?? null, baseUnit: i.baseUnit, yieldPerUnit: dec(i.yieldPerUnit).toString(), isActive: i.isActive,
      units: i.units.map((u) => ({ unit: u.unit, factor: dec(u.factor).toString() })), links: { greenBeanId: i.greenBeanId, coffeeProductId: i.coffeeProductId, materialItemId: i.materialItemId, productSkuId: i.productSkuId } })),
    locations,
    bands: bands.map((b) => ({ ...b, maxLossPercent: dec(b.maxLossPercent).toFixed(2), createdByName: people.get(b.createdBy) ?? b.createdBy, approvedByName: b.approvedBy ? people.get(b.approvedBy) ?? b.approvedBy : null })),
  };
}
