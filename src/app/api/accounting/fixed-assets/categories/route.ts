import { NextResponse } from "@/lib/api-response";
import { acctError, jsonBody, qp } from "@/lib/accounting/http";
import { auditFromRequest } from "@/lib/accounting/audit";
import { requireFaRead, requireFaWrite, faCan } from "@/lib/accounting/fixed-assets/http";
import { listCategories, saveCategory } from "@/lib/accounting/fixed-assets/assets";

/** The fixed-asset categories (?all=1 with the inactive ones) and the default role accounts. */
export async function GET(request: Request) {
  const { user, error } = await requireFaRead();
  if (error) return error;
  try {
    return NextResponse.json({ ...(await listCategories({ all: qp(request, "all") === "1" })), can: faCan(user.permissions) });
  } catch (err) {
    return acctError(err);
  }
}

/** Create or edit a category — { id?, code, nameAr, nameEn, usefulLifeMonths, method, decliningRatePercent, residualPercent, *AccountId, zakatDeductible, isActive }. */
export async function POST(request: Request) {
  const { user, error } = await requireFaWrite();
  if (error) return error;
  try {
    return NextResponse.json(await saveCategory(await jsonBody(request), auditFromRequest(request, user.id)));
  } catch (err) {
    return acctError(err);
  }
}
