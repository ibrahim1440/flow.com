import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody, qp } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireFaRead, requireFaWrite, faCan } from "@/lib/accounting/fixed-assets/http";
import { listAssets, createAsset } from "@/lib/accounting/fixed-assets/assets";

/** «الأصول الثابتة» — the register (?status=DRAFT|ACTIVE|FULLY_DEPRECIATED|DISPOSED|ALL, ?categoryId, ?branchId, ?q, ?page, ?size). */
export async function GET(request: Request) {
  const { user, error } = await requireFaRead();
  if (error) return error;
  try {
    const size = Math.min(Math.max(Number(qp(request, "size") ?? 25) || 25, 5), 200), page = Math.max(Number(qp(request, "page") ?? 1) || 1, 1);
    const r = await listAssets({ status: qp(request, "status"), categoryId: qp(request, "categoryId"), branchId: qp(request, "branchId"), search: qp(request, "q"), take: size, skip: (page - 1) * size });
    return NextResponse.json({ ...r, page, size, can: faCan(user.permissions) });
  } catch (err) {
    return acctError(err);
  }
}

/** A new DRAFT asset (nothing reaches the books until it is activated). */
export async function POST(request: Request) {
  const { user, error } = await requireFaWrite();
  if (error) return error;
  try {
    return NextResponse.json(await createAsset(await jsonBody(request), auditFromRequest(request, user.id)), { status: 201 });
  } catch (err) {
    return acctError(err);
  }
}
