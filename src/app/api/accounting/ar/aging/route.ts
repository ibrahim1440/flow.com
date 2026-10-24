import { acctCsvCell } from "@/lib/accounting/csv";
import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { canViewInvoices } from "@/lib/services/invoicing/access";
import { scopedCustomerIds } from "@/lib/services/invoicing/http";
import { agingReport } from "@/lib/services/invoicing/ar";
import { AGING_BUCKETS } from "@/lib/services/invoicing/ar-math";
import { invError, refuseInv } from "@/lib/services/invoicing/refusals";
import { m2 } from "@/lib/services/invoicing/pricing";

/**
 * GET /api/accounting/ar/aging?asOf=YYYY-MM-DD[&format=csv] — «أعمار الذمم»: each customer's open invoices by days
 * past due (current · 1–30 · 31–60 · 61–90 · 90+), unapplied credit and net balance. accounting › ar sees every
 * customer; an invoices viewer the customers in their scope.
 */
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canViewInvoices(user.permissions)) return forbidden();
  try {
    const q = new URL(request.url).searchParams;
    const asOf = q.get("asOf") ?? undefined;
    if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw refuseInv("BAD_INPUT", "asOf is YYYY-MM-DD.", "التاريخ بصيغة YYYY-MM-DD.");
    const r = await agingReport(prisma, await scopedCustomerIds(user), asOf);
    const keys = [...AGING_BUCKETS.map((b) => b.key), "totalOpen", "unappliedCredit", "balance", "overdue"] as const;
    const row = (a: Record<string, unknown>) => Object.fromEntries(keys.map((k) => [k, m2(a[k] as never)]));
    if (q.get("format") === "csv") {
      const head = ["customer", ...keys].join(",");
      // A5 council fix: the customer name is user text — formulas neutralised (CWE-1236).
      const lines = r.rows.map((x) => [acctCsvCell(x.customer?.nameAr || x.customer?.name || x.customerId), ...keys.map((k) => m2(x.aging[k] as never))].join(","));
      return new NextResponse(`﻿${[head, ...lines].join("\n")}\n`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="ar-aging-${r.asOf}.csv"` } });
    }
    return NextResponse.json({
      asOf: r.asOf, buckets: AGING_BUCKETS.map((b) => ({ key: b.key, ar: b.ar, en: b.en })),
      rows: r.rows.map((x) => ({ customerId: x.customerId, customer: x.customer ? { ...x.customer, creditLimit: x.customer.creditLimit ? m2(x.customer.creditLimit) : null } : null, ...row(x.aging as never), oldestOverdueDays: x.aging.oldestOverdueDays })),
      totals: row(r.totals as never),
    });
  } catch (err) {
    return invError(err);
  }
}
