import { NextResponse } from "@/lib/api-response";
import { acctError } from "@/lib/accounting/http";
import { requireFaRead, faCan } from "@/lib/accounting/fixed-assets/http";
import { getRun } from "@/lib/accounting/fixed-assets/runs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { user, error } = await requireFaRead();
  if (error) return error;
  try {
    return NextResponse.json({ ...(await getRun((await params).id)), can: faCan(user.permissions) });
  } catch (err) {
    return acctError(err);
  }
}
