import { NextResponse } from "@/lib/api-response";
import { requireAuth } from "@/lib/auth-server";
import { listMfaResets, requestMfaReset } from "@/lib/hr/services/mfa-reset";
import { errorResponse } from "../permission-requests/_shared";

/** Owner security decision: second-person MFA resets (account editors). */
export async function GET() {
  const { user, error } = await requireAuth();
  if (error) return error;
  try {
    return NextResponse.json({ resets: await listMfaResets(user) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(await requestMfaReset(user, body), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
