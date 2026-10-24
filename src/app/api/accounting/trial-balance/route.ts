import { acctCsvCell } from "@/lib/accounting/csv";
import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { rangeOf, trialBalance } from "@/lib/accounting/reports";

// A5 council fix: formulas neutralised (CWE-1236), numbers kept (src/lib/accounting/csv.ts).
const csvCell = (v: string | null) => acctCsvCell(v);

/** «ميزان المراجعة» for any date range: opening, movement and closing debit / credit per account, posted only. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const { from, to } = rangeOf(qp(request, "from"), qp(request, "to"));
    const tb = await trialBalance(from, to, { includeZero: qp(request, "includeZero") === "1" });
    if (qp(request, "format") === "csv") {
      const head = "code,name_ar,name_en,opening_debit,opening_credit,period_debit,period_credit,closing_debit,closing_credit";
      const body = tb.rows.map((r) => [r.code, r.nameAr, r.nameEn, r.openingDebit, r.openingCredit, r.periodDebit, r.periodCredit, r.closingDebit, r.closingCredit].map(csvCell).join(","));
      const t = tb.totals;
      body.push(["TOTAL", "", "", t.openingDebit, t.openingCredit, t.periodDebit, t.periodCredit, t.closingDebit, t.closingCredit].join(","));
      return new NextResponse("﻿" + [head, ...body].join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="trial-balance-${tb.from}-${tb.to}.csv"` } });
    }
    return NextResponse.json(tb);
  } catch (err) {
    return acctError(err);
  }
}
