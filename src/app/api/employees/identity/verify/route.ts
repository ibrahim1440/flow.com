import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { requestVerification } from "@/lib/hr/services/identity-verification";
import { errorResponse } from "../../permission-requests/_shared";

export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(await requestVerification(user, body), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
