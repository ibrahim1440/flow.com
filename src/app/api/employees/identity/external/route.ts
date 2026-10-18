import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-server";
import { requestExternalChange } from "@/lib/hr/services/identity-verification";
import { errorResponse } from "../../permission-requests/_shared";

export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(await requestExternalChange(user, body), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
