import { NextResponse } from "@/lib/api-response";
import { requireModule } from "@/lib/auth-server";
import { acctError } from "@/lib/accounting/http";
import { getRun } from "@/lib/accounting/deferrals";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { error } = await requireModule("accounting");
  if (error) return error;
  const { id } = await params;
  try {
    return NextResponse.json(await getRun(id));
  } catch (err) {
    return acctError(err);
  }
}
