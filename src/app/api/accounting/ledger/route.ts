import { acctCsvCell } from "@/lib/accounting/csv";
import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError, qp } from "@/lib/accounting/http";
import { generalLedger, rangeOf } from "@/lib/accounting/reports";
import { refuse } from "@/lib/accounting/refusals";

// A5 council fix: formulas neutralised (CWE-1236), numbers kept (src/lib/accounting/csv.ts).
const csvCell = (v: string | null) => acctCsvCell(v);

/** «دفتر الأستاذ» of an account (a header account: with its sub-accounts), with the running balance. */
export async function GET(request: Request) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  try {
    const accountId = qp(request, "accountId");
    if (!accountId) throw refuse("BAD_INPUT", "accountId is required.");
    const { from, to } = rangeOf(qp(request, "from"), qp(request, "to"));
    const csv = qp(request, "format") === "csv";
    const gl = await generalLedger(accountId, from, to, csv ? { limit: 2000 } : { limit: Number(qp(request, "limit")) || 500, offset: Number(qp(request, "offset")) || 0 });
    if (csv) {
      const head = "date,entry,memo,source_type,source_id,debit,credit,balance";
      const rows = [["", "", "Opening balance", "", "", "", "", gl.opening].join(","), ...gl.lines.map((l) => [l.entryDate, l.ref, l.lineMemo ?? l.memo, l.sourceType, l.sourceId, l.debit, l.credit, l.balance].map(csvCell).join(",")), ["", "", "Closing balance", "", "", gl.periodDebit, gl.periodCredit, gl.closing].join(",")];
      return new NextResponse("﻿" + [head, ...rows].join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="ledger-${gl.account.code}-${gl.from}-${gl.to}.csv"` } });
    }
    return NextResponse.json(gl);
  } catch (err) {
    return acctError(err);
  }
}
