import { NextResponse } from "@/lib/api-response";
import { acctError } from "@/lib/accounting/http";
import { requireFaRead, faCan } from "@/lib/accounting/fixed-assets/http";
import { faFormOptions } from "@/lib/accounting/fixed-assets/options";

/** What the forms choose from: categories, branches, suppliers, custodians, payment / proceeds accounts. */
export async function GET() {
  const { user, error } = await requireFaRead();
  if (error) return error;
  try {
    return NextResponse.json({ ...(await faFormOptions()), can: faCan(user.permissions) });
  } catch (err) {
    return acctError(err);
  }
}
