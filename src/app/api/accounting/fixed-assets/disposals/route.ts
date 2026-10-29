import { NextResponse } from "@/lib/api-response";
import { acctError, qp } from "@/lib/accounting/http";
import { requireFaRead, faCan } from "@/lib/accounting/fixed-assets/http";
import { listDisposals } from "@/lib/accounting/fixed-assets/assets";
import { parseBusinessDay } from "@/lib/accounting/dates";

const d = (v: string | null) => { try { return v ? parseBusinessDay(v) : null; } catch { return null; } };

/** «الاستبعادات» — sales and scraps (?from&to). */
export async function GET(request: Request) {
  const { user, error } = await requireFaRead();
  if (error) return error;
  try {
    return NextResponse.json({ rows: await listDisposals({ from: d(qp(request, "from")), to: d(qp(request, "to")) }), can: faCan(user.permissions) });
  } catch (err) {
    return acctError(err);
  }
}
