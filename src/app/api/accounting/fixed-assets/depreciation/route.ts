import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody, qp } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireFaRead, requireFaWrite, faCan } from "@/lib/accounting/fixed-assets/http";
import { listRuns, runDepreciationForMonth } from "@/lib/accounting/fixed-assets/runs";

/** «الإهلاك» — the depreciation runs (?year). */
export async function GET(request: Request) {
  const { user, error } = await requireFaRead();
  if (error) return error;
  try {
    const y = Number(qp(request, "year"));
    return NextResponse.json({ rows: await listRuns({ year: Number.isInteger(y) && y > 0 ? y : null }), can: faCan(user.permissions) });
  } catch (err) {
    return acctError(err);
  }
}

/** Post the month's depreciation — { year, month }: one balanced entry; idempotent per (asset, month). Step-up. */
export async function POST(request: Request) {
  const { user, error } = await requireFaWrite({ duty: "journal_post" });
  if (error) return error;
  try {
    const b = await jsonBody(request);
    const r = await runDepreciationForMonth(b.year, b.month, auditFromRequest(request, user.id));
    return NextResponse.json(r, { status: r.status === "posted" ? 201 : 200 });
  } catch (err) {
    return acctError(err);
  }
}
