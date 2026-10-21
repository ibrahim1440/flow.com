import { NextResponse } from "@/lib/api-response";
import { requireAnySub } from "@/lib/auth-server";
import { handleDomainError } from "@/lib/api-error";
import { cancelCountSession, getCountSession } from "@/lib/services/inventory-counts";

type Params = { params: Promise<{ id: string }> };

/** Abandon an OPEN sheet; nothing is booked. inventory › receive or › adjust. */
export async function POST(_request: Request, { params }: Params) {
  const { user, error } = await requireAnySub("inventory", ["receive", "adjust"]);
  if (error) return error;
  const { id } = await params;
  try {
    await cancelCountSession(user, id);
    return NextResponse.json(await getCountSession(id));
  } catch (err) {
    return handleDomainError(err);
  }
}
