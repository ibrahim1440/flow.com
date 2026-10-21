import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { acknowledgeRevocationReview } from "@/lib/hr/services/permission-change";
import { errorResponse } from "../../_shared";

/** Post-hoc review of an immediate revocation, by another account editor (another person). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(await acknowledgeRevocationReview(user, id, body));
  } catch (e) {
    return errorResponse(e);
  }
}
