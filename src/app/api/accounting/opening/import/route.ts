import { NextResponse } from "@/lib/api-response";
import { requireSub } from "@/lib/auth-server";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { getOpening, parseOpeningCsv, replaceOpeningLines } from "@/lib/accounting/opening";
import { auditFromRequest } from "@/lib/accounting/audit";

/**
 * CSV import of the opening grid: `{ csv, apply? }`. Without `apply` (or with problems) it previews — the parsed
 * lines and the per-row problems; with `apply: true` and no problem it REPLACES the grid.
 */
export async function POST(request: Request) {
  const { user, error } = await requireSub("accounting", "opening_balance");
  if (error) return error;
  try {
    const body = await jsonBody(request);
    const parsed = await parseOpeningCsv(String(body.csv ?? ""));
    if (body.apply !== true || parsed.problems.length) return NextResponse.json({ applied: false, ...parsed });
    await replaceOpeningLines(parsed.lines, auditFromRequest(request, user.id, "opening balances CSV import"));
    return NextResponse.json({ applied: true, problems: [], opening: await getOpening() });
  } catch (err) {
    return acctError(err);
  }
}
