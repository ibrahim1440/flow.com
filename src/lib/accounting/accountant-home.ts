// «لوحة المتابعة» — the accountant workspace's landing page (Qoyod-parity program, phase 1). Qoyod's widgets, fed from
// our real data. EVERY figure is read from an existing report or service; this file only selects, groups by month
// and orders what those return. Read-only.
//
//   widget                          source (the report it ties to)
//   حالة الدفعات · فواتير المبيعات   agingReport (AR sub-ledger)  = «أعمار الذمم» /api/accounting/ar/aging: totals.totalOpen, totals.overdue
//   حالة الدفعات · فواتير المشتريات  apAging (AP sub-ledger)      = «أعمار الدائنين» /api/accounting/ap/aging: total, total − buckets.current
//   الإيرادات والمصروفات (شهريًا)    incomeStatement per month    = «قائمة الدخل»: revenue, and expenses = revenue − net profit
//                                   (the location filter: the branches the chosen sites map to — «الموقع», WP-B)
//   أعلى 5 عملاء عليهم مستحقات       agingReport rows (by balance) = the AR aging rows
//   أعلى 5 موردين لهم مستحقات        apAging suppliers (by total)  = the AP aging rows
//   العملاء (شهريًا)                 arItems (the AR statement items): أنشئت = invoices + debit notes issued in the month,
//                                   دفعت = approved receipts collected in the month (less reversals), مستحقة = what is
//                                   still open today of the invoices DUE in that month (openOf)
//   الموردين (شهريًا)                أنشئت = POSTED supplier invoices by invoice date (apAging's population), دفعت = POSTED
//                                   supplier payments by payment date, مستحقة = apAging items still open, by due date
//   سجل النشاطات                     the latest documents: sales invoices / notes issued, receipts approved, supplier
//                                   invoices posted, supplier payments, journals posted by hand (an AUTO entry is its document's)
//   تفاصيل المعاملات المتكررة       recurringWidget (src/lib/accounting/recurring/widget.ts) — fetched by the page itself from
//                                   /api/accounting/recurring/widget (its own tabs and paging); the failed-runs badge
//   تنبيه المؤجلات المتأخرة          deferralBacklog (src/lib/accounting/deferrals.ts) = «قوالب التأجيل»'s backlog: shown
//                                   when overdueCount > 0 (council F6)
//   حالة مخزون المنتج               lowBySite (= «تحت حد إعادة الطلب» /api/inventory/reorder-points/low) per selected
//                                   location; the value at cost per location (listLocations withValue) only for canReadCost
//
// Permissions (the same gates as the reports above, per widget — a widget the viewer may not read is `null`):
//   the page: the accounting module (route guard and requireModule) · AR widgets: canViewInvoices, scoped as the AR
//   aging route scopes them · AP and the P&L: the accounting module · stock: inventory / packaging / production /
//   purchases (the low-stock route) · stock value: canReadCost.
import { prisma } from "@/lib/db";
import { Decimal, ZERO, fix2 } from "./money";
import { dayText } from "./dates";
import { incomeStatement } from "./statements";
import { postingRef } from "./posting-engine";
import { apAging } from "./ops/ap";
import { agingReport, arItems } from "@/lib/services/invoicing/ar";
import { openOf } from "@/lib/services/invoicing/ar-math";
import { lowBySite } from "@/lib/services/stock-reorder";
import { listLocations } from "@/lib/services/stock-locations";
import { deferralBacklog } from "./deferrals";
import { schedulerState } from "./standing-auth";
import type { BranchFilter } from "./locations";

export type HomeInput = {
  from: string; to: string; locationIds: string[];
  can: { ar: boolean; arScope: string[] | null; ap: boolean; gl: boolean; stock: boolean; cost: boolean };
};

import { monthsOf } from "./accountant-home-range";
export { monthsOf, parseRange, defaultRange } from "./accountant-home-range";
const monthKey = (d: string) => d.slice(0, 7);

export async function accountantHome(input: HomeInput) {
  const { from, to, can } = input;
  const months = monthsOf(from, to);
  const [ar, ap, gl, stock, activity, deferrals] = await Promise.all([
    can.ar ? arWidgets(can.arScope, from, to, months) : null,
    can.ap ? apWidgets(from, to, months) : null,
    can.gl ? glTrend(months, to, await branchesOfSites(input.locationIds)) : null,
    can.stock ? stockWidget(input.locationIds, can.cost) : null,
    recentActivity(can),
    // Whether the scheduler recognises deferrals (a live StandingAuthorisation, batch 22 WP-A): the alert says so.
    can.gl ? Promise.all([deferralBacklog(), schedulerState()]).then(([b, st]) => ({ ...b, scheduler: st.DEFERRAL_RECOGNITION.state })) : null,
  ]);
  return { range: { from, to }, months, ar, ap, gl, stock, activity, deferrals };
}

async function arWidgets(scope: string[] | null, from: string, to: string, months: string[]) {
  const [aging, items] = await Promise.all([agingReport(prisma, scope, to), arItems(prisma, scope)]);
  const created = new Map<string, Decimal>(), paid = new Map<string, Decimal>(), due = new Map<string, Decimal>();
  const add = (m: Map<string, Decimal>, k: string, v: Decimal) => m.set(k, (m.get(k) ?? ZERO).plus(v));
  for (const b of items.byCustomer.values()) {
    for (const mv of b.moves) {
      const k = monthKey(mv.date);
      if (mv.kind === "INVOICE" || mv.kind === "DEBIT_NOTE") add(created, k, mv.debit);
      else if (mv.kind === "RECEIPT") add(paid, k, mv.credit);
      else if (mv.kind === "RECEIPT_REVERSED") add(paid, k, mv.debit.negated());
    }
    for (const d of b.debits) if (d.dueDate && openOf(d).gt(0)) add(due, monthKey(d.dueDate), openOf(d));
  }
  return {
    asOf: aging.asOf,
    open: fix2(aging.totals.totalOpen), overdue: fix2(aging.totals.overdue), notDue: fix2(aging.totals.totalOpen.minus(aging.totals.overdue)),
    top: aging.rows.filter((r) => r.aging.balance.gt(0)).slice(0, 5).map((r) => ({ id: r.customerId, name: r.customer?.nameAr || r.customer?.name || r.customerId, nameEn: r.customer?.name ?? null, amount: fix2(r.aging.balance), overdue: fix2(r.aging.overdue) })),
    monthly: months.map((m) => ({ month: m, created: fix2(created.get(m) ?? ZERO), paid: fix2(paid.get(m) ?? ZERO), due: fix2(due.get(m) ?? ZERO) })),
    range: { from, to },
  };
}

async function apWidgets(from: string, to: string, months: string[]) {
  const aging = await apAging(to, null);
  const start = new Date(`${months[0]}-01T00:00:00Z`);
  const end = new Date(`${to}T23:59:59.999Z`);
  const [invoices, payments] = await Promise.all([
    prisma.supplierInvoice.findMany({ where: { status: "POSTED", invoiceDate: { gte: start, lte: end } }, select: { invoiceDate: true, grossTotal: true } }),
    prisma.supplierPayment.findMany({ where: { status: "POSTED", paymentDate: { gte: start, lte: end } }, select: { paymentDate: true, amount: true } }),
  ]);
  const created = new Map<string, Decimal>(), paid = new Map<string, Decimal>(), due = new Map<string, Decimal>();
  const add = (m: Map<string, Decimal>, k: string, v: string | Decimal) => m.set(k, (m.get(k) ?? ZERO).plus(v));
  for (const i of invoices) add(created, monthKey(dayText(i.invoiceDate)), String(i.grossTotal));
  for (const p of payments) add(paid, monthKey(dayText(p.paymentDate)), String(p.amount));
  for (const it of aging.items) add(due, monthKey(it.dueDate), it.open);
  const total = new Decimal(aging.total), current = new Decimal(aging.buckets.current);
  return {
    asOf: aging.asOf,
    open: aging.total, overdue: fix2(total.minus(current)), notDue: aging.buckets.current,
    top: aging.suppliers.filter((s) => new Decimal(s.total).gt(0)).slice(0, 5).map((s) => ({ id: s.supplierId, name: s.name, nameEn: null, amount: s.total, overdue: fix2(new Decimal(s.total).minus(s.buckets.current)) })),
    monthly: months.map((m) => ({ month: m, created: fix2(created.get(m) ?? ZERO), paid: fix2(paid.get(m) ?? ZERO), due: fix2(due.get(m) ?? ZERO) })),
    range: { from, to },
  };
}

/**
 * «الموقع» (BATCH22 WP-B): the page's location picker names stock sites; the ledger's location is their branch. The
 * revenue / expense trend reads the lines of the branches the chosen sites map to (none chosen: the whole company; sites
 * with no branch: nothing).
 */
async function branchesOfSites(locationIds: string[]): Promise<BranchFilter> {
  if (!locationIds.length) return null;
  const rows = await prisma.stockLocation.findMany({ where: { id: { in: locationIds } }, select: { finBranchId: true } });
  const ids = [...new Set(rows.map((r) => r.finBranchId).filter((x): x is string => !!x))];
  return { ids: ids.length ? ids : ["-"], unassigned: false };
}

/** Revenue and expenses per month, each month one income statement (the report's own totals). */
async function glTrend(months: string[], to: string, branches: BranchFilter = null) {
  const [settings, accounts] = await Promise.all([
    prisma.accountingSettings.findUnique({ where: { id: "singleton" }, select: { accountingActive: true } }),
    prisma.account.count(),
  ]);
  const rows = [];
  for (const m of months) {
    const y = Number(m.slice(0, 4)), n = Number(m.slice(5, 7));
    const last = new Date(Date.UTC(y, n, 0));
    const toDay = dayText(last) > to ? new Date(`${to}T00:00:00Z`) : last;
    const pl = await incomeStatement({ from: new Date(Date.UTC(y, n - 1, 1)), to: toDay, label: m }, null, { branches });
    const revenue = new Decimal(pl.totals.revenue[0]);
    rows.push({ month: m, revenue: fix2(revenue), expenses: fix2(revenue.minus(pl.totals.netProfit[0])), netProfit: pl.totals.netProfit[0] });
  }
  return { active: !!settings?.accountingActive, accounts, rows };
}

async function stockWidget(locationIds: string[], cost: boolean) {
  const [locations, lows] = await Promise.all([
    listLocations({ withValue: cost }),
    locationIds.length === 0 ? lowBySite(null) : Promise.all(locationIds.map((id) => lowBySite(id))).then((x) => x.flat()),
  ]);
  const shown = locationIds.length ? locations.filter((l) => locationIds.includes(l.id)) : locations;
  return {
    locations: shown.filter((l) => !l.isTransit).map((l) => ({ id: l.id, nameAr: l.nameAr, nameEn: l.nameEn, ...(cost ? { value: (l as { valueEstimate?: number }).valueEstimate ?? 0 } : {}) })),
    low: lows.map((r) => ({ locationId: r.locationId, location: r.locationNameAr, locationEn: r.locationNameEn, kind: r.itemKind, code: r.code, name: r.nameAr || r.name, nameEn: r.name, unit: r.unit, qty: r.qty, reorderPoint: r.reorderPoint, out: r.qty <= 0 })),
    costShown: cost,
  };
}

type Act = { at: string; kind: string; ref: string; amount: string | null; href: string | null; party: string | null };

async function recentActivity(can: HomeInput["can"]): Promise<Act[]> {
  const take = 8;
  const [inv, rec, sinv, spay, je] = await Promise.all([
    can.ar ? prisma.salesInvoice.findMany({ where: { status: "ISSUED", ...(can.arScope ? { customerId: { in: can.arScope } } : {}) }, orderBy: { issuedAt: "desc" }, take, select: { id: true, kind: true, number: true, grandTotal: true, issuedAt: true, customerId: true } }) : [],
    can.ar ? prisma.salesCollection.findMany({ where: { status: "APPROVED", ...(can.arScope ? { customerId: { in: can.arScope } } : {}) }, orderBy: { decidedAt: "desc" }, take, select: { id: true, referenceNumber: true, amountGross: true, decidedAt: true, collectedAt: true } }) : [],
    can.ap ? prisma.supplierInvoice.findMany({ where: { status: "POSTED" }, orderBy: { postedAt: "desc" }, take, select: { id: true, number: true, grossTotal: true, postedAt: true, supplier: { select: { name: true } } } }) : [],
    can.ap ? prisma.supplierPayment.findMany({ where: { status: "POSTED" }, orderBy: { createdAt: "desc" }, take, select: { id: true, number: true, amount: true, createdAt: true, supplier: { select: { name: true } } } }) : [],
    can.gl ? prisma.journalEntry.findMany({ where: { status: "POSTED", type: { not: "AUTO" } }, orderBy: { postedAt: "desc" }, take, select: { id: true, postingYear: true, postingSeq: true, entryNo: true, totalDebit: true, postedAt: true, createdAt: true, type: true } }) : [],
  ]);
  const custIds = [...new Set(inv.map((x) => x.customerId))];
  const names = new Map((custIds.length ? await prisma.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, name: true, nameAr: true } }) : []).map((c) => [c.id, c.nameAr || c.name]));
  const out: Act[] = [
    ...inv.map((x) => ({ at: (x.issuedAt ?? new Date(0)).toISOString(), kind: `SALES_${x.kind}`, ref: x.number ?? "", amount: fix2(new Decimal(String(x.grandTotal))), href: `/dashboard/sales/invoices/${x.id}`, party: names.get(x.customerId) ?? null })),
    ...rec.map((x) => ({ at: (x.decidedAt ?? x.collectedAt).toISOString(), kind: "RECEIPT", ref: x.referenceNumber || x.id.slice(-6), amount: fix2(new Decimal(String(x.amountGross))), href: "/dashboard/sales/collections", party: null })),
    ...sinv.map((x) => ({ at: (x.postedAt ?? new Date(0)).toISOString(), kind: "SUPPLIER_INVOICE", ref: x.number, amount: fix2(new Decimal(String(x.grossTotal))), href: `/dashboard/purchases/invoices/${x.id}`, party: x.supplier.name })),
    ...spay.map((x) => ({ at: x.createdAt.toISOString(), kind: "SUPPLIER_PAYMENT", ref: x.number, amount: fix2(new Decimal(String(x.amount))), href: "/dashboard/accounting/ap?view=payments", party: x.supplier.name })),
    ...je.map((x) => ({ at: (x.postedAt ?? x.createdAt).toISOString(), kind: `JOURNAL_${String(x.type)}`, ref: postingRef(x) ?? `#${x.entryNo}`, amount: fix2(new Decimal(String(x.totalDebit))), href: `/dashboard/accounting/journals/${x.id}`, party: null })),
  ];
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
}
