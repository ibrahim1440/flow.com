import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { decideIdentityRequest } from "@/lib/hr/services/identity-verification";
import { errorResponse } from "../../../../permission-requests/_shared";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAuth();
  if (error) return error;
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(await decideIdentityRequest(user, id, body));
  } catch (e) {
    return errorResponse(e);
  }
}
