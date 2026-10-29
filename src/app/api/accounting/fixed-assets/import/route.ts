import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireFaRead, requireFaImport, faCan } from "@/lib/accounting/fixed-assets/http";
import { commitImport, importTieOut, listImports } from "@/lib/accounting/fixed-assets/import";

/** «استيراد الأصول من قيود»: the imports so far and the tie-out to the opening grid (the accounting module). */
export async function GET() {
  const { user, error } = await requireFaRead();
  if (error) return error;
  try {
    return NextResponse.json({ imports: await listImports(), tieOut: await importTieOut(), can: faCan(user.permissions) });
  } catch (err) {
    return acctError(err);
  }
}

/** Import the file (all or nothing; the same file again replays): fixed_assets + opening_balance, step-up. */
export async function POST(request: Request) {
  const { user, error } = await requireFaImport({ stepUp: true });
  if (error) return error;
  try {
    const body = await jsonBody(request);
    const r = await commitImport(body, auditFromRequest(request, user.id, "fixed-asset import from Qoyod"));
    return NextResponse.json(r, { status: r.replayed ? 200 : 201 });
  } catch (err) {
    return acctError(err);
  }
}
