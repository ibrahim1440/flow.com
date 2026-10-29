// ONE capacity per purchase-invoice EXPENSE line (council F1, integration gate): the amount the line put on its expense
// account — its net, plus its VAT when that VAT is not recoverable — is used ONCE, by either register:
//   «الأصول الثابتة»  capitalisation (an asset out of DRAFT that names the line, and a POSTED capital addition)
//   «قوالب التأجيل»   a deferral schedule made from the line (any status but CANCELLED)
//   remaining = capacity − Σ live capitalisations − Σ live deferral schedules
// Both registers check it under the SAME row lock (`SELECT … FROM "SupplierInvoiceLine" WHERE id = … FOR UPDATE`), so
// two concurrent uses of one line are serialised and the second sees the first.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { Decimal, ZERO } from "./money";
import { dayText } from "./dates";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;
const dec = (d: Decimal | Prisma.Decimal | string | number | null | undefined) => new Decimal(d ?? 0);

export type CapacityLine = { net: Prisma.Decimal | Decimal | string; vat: Prisma.Decimal | Decimal | string; taxSnapshot: Prisma.JsonValue; taxCategory: { inputVatTreatment: string | null } | null };

/** What an EXPENSE line put on its expense account: its net, and its VAT when that VAT is not recoverable. */
export function lineCapacity(l: CapacityLine): Decimal {
  const t = (l.taxSnapshot as { inputVatTreatment?: string | null } | null)?.inputVatTreatment ?? l.taxCategory?.inputVatTreatment ?? null;
  return dec(l.net).plus(t === "NON_RECOVERABLE" ? dec(l.vat) : ZERO);
}

export type LineUsage = { fixedAssets: Decimal; deferrals: Decimal };

/** What each line already carries in each register. */
export async function lineUsage(db: Db, lineIds: string[]): Promise<Map<string, LineUsage>> {
  const out = new Map<string, LineUsage>();
  if (!lineIds.length) return out;
  const [assets, additions, schedules] = await Promise.all([
    db.fixedAsset.groupBy({ by: ["supplierInvoiceLineId"], where: { supplierInvoiceLineId: { in: lineIds }, status: { not: "DRAFT" } }, _sum: { cost: true } }),
    db.fixedAssetAddition.groupBy({ by: ["supplierInvoiceLineId"], where: { supplierInvoiceLineId: { in: lineIds }, status: "POSTED" }, _sum: { amount: true } }),
    db.deferralSchedule.groupBy({ by: ["sourceId"], where: { sourceType: "SUPPLIER_INVOICE_LINE", sourceId: { in: lineIds }, status: { not: "CANCELLED" } }, _sum: { totalAmount: true } }),
  ]);
  const at = (id: string) => { let u = out.get(id); if (!u) { u = { fixedAssets: ZERO, deferrals: ZERO }; out.set(id, u); } return u; };
  for (const r of assets) if (r.supplierInvoiceLineId) at(r.supplierInvoiceLineId).fixedAssets = at(r.supplierInvoiceLineId).fixedAssets.plus(dec(r._sum.cost));
  for (const r of additions) if (r.supplierInvoiceLineId) at(r.supplierInvoiceLineId).fixedAssets = at(r.supplierInvoiceLineId).fixedAssets.plus(dec(r._sum.amount));
  for (const r of schedules) if (r.sourceId) at(r.sourceId).deferrals = at(r.sourceId).deferrals.plus(dec(r._sum.totalAmount));
  return out;
}

const LINE_SELECT = {
  id: true, kind: true, lineNo: true, description: true, net: true, vat: true, taxSnapshot: true,
  taxCategory: { select: { inputVatTreatment: true } },
  expenseCategory: { select: { accountId: true, nameAr: true, account: { select: { code: true } } } },
  invoice: { select: { id: true, status: true, number: true, supplierRef: true, invoiceDate: true, journalEntryId: true, supplierId: true, supplier: { select: { id: true, name: true } } } },
} satisfies Prisma.SupplierInvoiceLineSelect;
export type LockedLine = Prisma.SupplierInvoiceLineGetPayload<{ select: typeof LINE_SELECT }>;

/**
 * Lock the line (FOR UPDATE — the one lock both registers take) and read its capacity and what is used. Returns null
 * when the line does not exist. The caller checks the line's kind / status and `amount ≤ remaining`.
 */
export async function lockLineCapacity(tx: Tx, id: string): Promise<null | { line: LockedLine; capacity: Decimal; used: LineUsage; remaining: Decimal }> {
  await tx.$queryRaw`SELECT "id" FROM "SupplierInvoiceLine" WHERE "id" = ${id} FOR UPDATE`;
  const line = await tx.supplierInvoiceLine.findUnique({ where: { id }, select: LINE_SELECT });
  if (!line) return null;
  const capacity = lineCapacity(line);
  const used = (await lineUsage(tx, [id])).get(id) ?? { fixedAssets: ZERO, deferrals: ZERO };
  return { line, capacity, used, remaining: capacity.minus(used.fixedAssets).minus(used.deferrals) };
}

/**
 * The EXPENSE lines of posted purchase invoices that still have capacity (newest first) — the pickers of both registers
 * («مستخدم في: أصل ثابت / تأجيل» from `usedIn`).
 */
export async function linesWithCapacity(opts: { supplierId?: string | null } = {}) {
  const ls = await prisma.supplierInvoiceLine.findMany({
    where: { kind: "EXPENSE", invoice: { status: "POSTED", ...(opts.supplierId ? { supplierId: opts.supplierId } : {}) } },
    orderBy: [{ invoice: { invoiceDate: "desc" } }, { lineNo: "asc" }], take: 300, select: LINE_SELECT,
  });
  const used = await lineUsage(prisma, ls.map((l) => l.id));
  return ls.map((l) => {
    const cap = lineCapacity(l), u = used.get(l.id) ?? { fixedAssets: ZERO, deferrals: ZERO };
    const remaining = cap.minus(u.fixedAssets).minus(u.deferrals);
    return {
      lineId: l.id, lineNo: l.lineNo, description: l.description, category: l.expenseCategory?.nameAr ?? null, account: l.expenseCategory?.account.code ?? null,
      capacity: cap.toFixed(2), capitalised: u.fixedAssets.toFixed(2), deferred: u.deferrals.toFixed(2), remaining: remaining.toFixed(2),
      usedIn: { fixedAssets: u.fixedAssets.toFixed(2), deferrals: u.deferrals.toFixed(2) },
      invoice: { id: l.invoice.id, number: l.invoice.number, supplierRef: l.invoice.supplierRef, invoiceDate: dayText(l.invoice.invoiceDate), inBooks: !!l.invoice.journalEntryId, supplier: l.invoice.supplier },
    };
  }).filter((l) => dec(l.remaining).gt(0));
}
